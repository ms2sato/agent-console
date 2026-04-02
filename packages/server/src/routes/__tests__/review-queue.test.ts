import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import type { AppBindings } from '../../app-context.js';
import { onApiError } from '../../lib/error-handler.js';
import { asAppContext } from '../../__tests__/test-utils.js';
import { AnnotationService } from '../../services/annotation-service.js';
import type { ReviewAnnotationInput, ReviewComment, ReviewQueueGroup } from '@agent-console/shared';

// Mock broadcastToApp to prevent WebSocket side effects in tests
const mockBroadcastToApp = mock(() => {});
mock.module('../../websocket/routes.js', () => ({
  broadcastToApp: mockBroadcastToApp,
}));

// Dynamically import the route after mocking
const { reviewQueue } = await import('../review-queue.js');

function validInput(): ReviewAnnotationInput {
  return {
    annotations: [
      {
        file: 'src/index.ts',
        startLine: 10,
        endLine: 20,
        reason: 'Complex logic needs review',
      },
    ],
    summary: {
      totalFiles: 5,
      reviewFiles: 2,
      mechanicalFiles: 3,
      confidence: 'high' as const,
    },
  };
}

function createMockSessionManager(sessions: Record<string, { title?: string; workers: { id: string; type: string }[] }> = {}) {
  return {
    getSession: (id: string) => sessions[id],
    writeWorkerInput: mock(() => true),
  };
}

describe('Review Queue API', () => {
  let app: Hono<AppBindings>;
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let annotationService: AnnotationService;

  beforeEach(() => {
    annotationService = new AnnotationService();

    mockBroadcastToApp.mockClear();

    mockSessionManager = createMockSessionManager({
      'sess-1': { title: 'Worker Session 1', workers: [{ id: 'worker-1', type: 'git-diff' }] },
      'sess-2': { title: 'Worker Session 2', workers: [{ id: 'worker-2', type: 'git-diff' }] },
      'orchestrator': {
        title: 'Orchestrator Session',
        workers: [{ id: 'agent-w', type: 'agent' }],
      },
    });

    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', asAppContext({ sessionManager: mockSessionManager as never, annotationService }));
      await next();
    });
    app.onError(onApiError);
    app.route('/api/review-queue', reviewQueue);
  });

  // ===========================================================================
  // GET /api/review-queue
  // ===========================================================================

  describe('GET /api/review-queue', () => {
    it('should return empty array when no pending reviews', async () => {
      const res = await app.request('/api/review-queue');
      expect(res.status).toBe(200);
      const body = await res.json() as ReviewQueueGroup[];
      expect(body).toEqual([]);
    });

    it('should return pending reviews grouped by source session', async () => {
      annotationService.setAnnotations('worker-1', validInput(), {
        sessionId: 'sess-1',
        sourceSessionId: 'orchestrator',
      });
      annotationService.setAnnotations('worker-2', validInput(), {
        sessionId: 'sess-2',
        sourceSessionId: 'orchestrator',
      });

      const res = await app.request('/api/review-queue');
      expect(res.status).toBe(200);
      const body = await res.json() as ReviewQueueGroup[];
      expect(body).toHaveLength(1);
      expect(body[0].sourceSessionId).toBe('orchestrator');
      expect(body[0].sourceSessionTitle).toBe('Orchestrator Session');
      expect(body[0].items).toHaveLength(2);
    });

    it('should exclude completed reviews', async () => {
      annotationService.setAnnotations('worker-1', validInput(), {
        sessionId: 'sess-1',
        sourceSessionId: 'orchestrator',
      });
      annotationService.updateStatus('worker-1', 'completed');

      const res = await app.request('/api/review-queue');
      expect(res.status).toBe(200);
      const body = await res.json() as ReviewQueueGroup[];
      expect(body).toEqual([]);
    });

    it('should not include annotations without sourceSessionId', async () => {
      annotationService.setAnnotations('worker-1', validInput(), { sessionId: 'sess-1' });

      const res = await app.request('/api/review-queue');
      expect(res.status).toBe(200);
      const body = await res.json() as ReviewQueueGroup[];
      expect(body).toEqual([]);
    });
  });

  // ===========================================================================
  // POST /api/review-queue/:workerId/comments
  // ===========================================================================

  describe('POST /api/review-queue/:workerId/comments', () => {
    it('should create comment and return 201', async () => {
      annotationService.setAnnotations('worker-1', validInput(), {
        sessionId: 'sess-1',
        sourceSessionId: 'orchestrator',
      });

      const res = await app.request('/api/review-queue/worker-1/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'src/index.ts', line: 15, body: 'Needs refactoring' }),
      });

      expect(res.status).toBe(201);
      const comment = await res.json() as ReviewComment;
      expect(comment.file).toBe('src/index.ts');
      expect(comment.line).toBe(15);
      expect(comment.body).toBe('Needs refactoring');
      expect(comment.id).toBeString();
      expect(comment.createdAt).toBeString();

      // Verify PTY notification was sent to source session's agent worker via writePtyNotification
      expect(mockSessionManager.writeWorkerInput).toHaveBeenCalledWith(
        'orchestrator', 'agent-w', expect.stringContaining('[internal:review-comment]'),
      );
      // Verify structured notification format includes key=value fields
      const notificationCall = (mockSessionManager.writeWorkerInput as ReturnType<typeof mock>).mock.calls[0];
      const notification = notificationCall[2] as string;
      expect(notification).toContain('session=');
      expect(notification).toContain('file=src/index.ts');
      expect(notification).toContain('line=15');
      expect(notification).toContain('intent=triage');

      // Verify broadcastToApp was called
      expect(mockBroadcastToApp).toHaveBeenCalledWith({ type: 'review-queue-updated' });
    });

    it('should return 404 for unknown worker', async () => {
      const res = await app.request('/api/review-queue/nonexistent/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'a.ts', line: 1, body: 'test' }),
      });

      expect(res.status).toBe(404);
    });

    it('should return 400 for non-review-queue item', async () => {
      annotationService.setAnnotations('worker-1', validInput());

      const res = await app.request('/api/review-queue/worker-1/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'a.ts', line: 1, body: 'test' }),
      });

      expect(res.status).toBe(400);
    });

    it('should validate request body - missing file', async () => {
      annotationService.setAnnotations('worker-1', validInput(), {
        sessionId: 'sess-1',
        sourceSessionId: 'orchestrator',
      });

      const res = await app.request('/api/review-queue/worker-1/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line: 1, body: 'test' }),
      });

      expect(res.status).toBe(400);
    });

    it('should validate request body - empty body', async () => {
      annotationService.setAnnotations('worker-1', validInput(), {
        sessionId: 'sess-1',
        sourceSessionId: 'orchestrator',
      });

      const res = await app.request('/api/review-queue/worker-1/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'a.ts', line: 1, body: '' }),
      });

      expect(res.status).toBe(400);
    });

    it('should validate request body - invalid line number', async () => {
      annotationService.setAnnotations('worker-1', validInput(), {
        sessionId: 'sess-1',
        sourceSessionId: 'orchestrator',
      });

      const res = await app.request('/api/review-queue/worker-1/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'a.ts', line: 0, body: 'test' }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ===========================================================================
  // PATCH /api/review-queue/:workerId/status
  // ===========================================================================

  describe('PATCH /api/review-queue/:workerId/status', () => {
    it('should update status to completed', async () => {
      annotationService.setAnnotations('worker-1', validInput(), {
        sessionId: 'sess-1',
        sourceSessionId: 'orchestrator',
      });

      const res = await app.request('/api/review-queue/worker-1/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { workerId: string; status: string };
      expect(body.workerId).toBe('worker-1');
      expect(body.status).toBe('completed');

      // Verify the status was actually updated
      const annotations = annotationService.getAnnotations('worker-1');
      expect(annotations!.status).toBe('completed');

      // Verify broadcastToApp was called
      expect(mockBroadcastToApp).toHaveBeenCalledWith({ type: 'review-queue-updated' });
    });

    it('should return 404 for unknown worker', async () => {
      const res = await app.request('/api/review-queue/nonexistent/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      });

      expect(res.status).toBe(404);
    });

    it('should return 400 for non-review-queue item', async () => {
      annotationService.setAnnotations('worker-1', validInput());

      const res = await app.request('/api/review-queue/worker-1/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      });

      expect(res.status).toBe(400);
    });

    it('should reject invalid status value', async () => {
      annotationService.setAnnotations('worker-1', validInput(), {
        sessionId: 'sess-1',
        sourceSessionId: 'orchestrator',
      });

      const res = await app.request('/api/review-queue/worker-1/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'invalid' }),
      });

      expect(res.status).toBe(400);
    });
  });
});
