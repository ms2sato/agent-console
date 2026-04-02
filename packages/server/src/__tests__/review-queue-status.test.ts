import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Session } from '@agent-console/shared';
import { setupTestEnvironment, cleanupTestEnvironment, createTestApp } from './test-utils.js';
import { AnnotationService } from '../services/annotation-service.js';

describe('PATCH /api/review-queue/:workerId/status', () => {
  const SOURCE_SESSION_ID = 'source-session-1';
  const TARGET_SESSION_ID = 'target-session-1';
  const WORKER_ID = 'worker-1';
  const AGENT_WORKER_ID = 'agent-worker-1';

  let annotationService: AnnotationService;

  const mockWriteWorkerInput = mock((_sessionId: string, _workerId: string, _data: string) => true);

  const sourceSession = {
    id: SOURCE_SESSION_ID,
    title: 'Orchestrator Session',
    workers: [{ id: AGENT_WORKER_ID, type: 'agent' }],
  } as unknown as Session;

  const targetSession = {
    id: TARGET_SESSION_ID,
    title: 'Feature Session',
    workers: [],
  } as unknown as Session;

  function createMockSessionManager(sessions: Record<string, Session> = {}) {
    return {
      getSession: mock((id: string) => sessions[id]),
      writeWorkerInput: mockWriteWorkerInput,
    };
  }

  function setupAnnotations(comments: Array<{ file: string; line: number; body: string }> = []) {
    annotationService.setAnnotations(
      WORKER_ID,
      {
        annotations: [{ file: 'src/index.ts', startLine: 1, endLine: 5, reason: 'Review needed' }],
        summary: { totalFiles: 1, reviewFiles: 1, mechanicalFiles: 0, confidence: 'high' },
      },
      { sessionId: TARGET_SESSION_ID, sourceSessionId: SOURCE_SESSION_ID },
    );
    for (const comment of comments) {
      annotationService.addComment(WORKER_ID, comment);
    }
  }

  beforeEach(async () => {
    await setupTestEnvironment();
    annotationService = new AnnotationService();
    mockWriteWorkerInput.mockClear();
  });

  afterEach(async () => {
    await cleanupTestEnvironment();
  });

  it('sends PTY notification to source session agent worker on completed', async () => {
    setupAnnotations([
      { file: 'src/index.ts', line: 3, body: 'Consider refactoring' },
      { file: 'src/index.ts', line: 5, body: 'Add error handling' },
    ]);

    const sessionManager = createMockSessionManager({
      [SOURCE_SESSION_ID]: sourceSession,
      [TARGET_SESSION_ID]: targetSession,
    });
    const app = await createTestApp({ sessionManager: sessionManager as never, annotationService });

    const res = await app.request(`/api/review-queue/${WORKER_ID}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ workerId: WORKER_ID, status: 'completed' });

    // Verify writeWorkerInput was called with notification containing expected tag and fields
    expect(mockWriteWorkerInput).toHaveBeenCalled();
    const callArgs = mockWriteWorkerInput.mock.calls[0];
    expect(callArgs[0]).toBe(SOURCE_SESSION_ID);
    expect(callArgs[1]).toBe(AGENT_WORKER_ID);

    const notificationText = callArgs[2] as string;
    expect(notificationText).toContain('[internal:reviewed]');
    expect(notificationText).toContain('session=');
    expect(notificationText).toContain('Feature Session');
    expect(notificationText).toContain(`workerId=${WORKER_ID}`);
    expect(notificationText).toContain('status=completed');
    expect(notificationText).toContain('comments=2');
    expect(notificationText).toContain('intent=triage');
  });

  it('does not throw when source session has no agent worker', async () => {
    setupAnnotations();

    const sessionWithoutAgent = {
      ...sourceSession,
      workers: [{ id: 'terminal-1', type: 'terminal' }],
    } as unknown as Session;

    const sessionManager = createMockSessionManager({
      [SOURCE_SESSION_ID]: sessionWithoutAgent,
      [TARGET_SESSION_ID]: targetSession,
    });
    const app = await createTestApp({ sessionManager: sessionManager as never, annotationService });

    const res = await app.request(`/api/review-queue/${WORKER_ID}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });

    expect(res.status).toBe(200);
    expect(mockWriteWorkerInput).not.toHaveBeenCalled();
  });

  it('does not throw when source session does not exist', async () => {
    setupAnnotations();

    const sessionManager = createMockSessionManager({});
    const app = await createTestApp({ sessionManager: sessionManager as never, annotationService });

    const res = await app.request(`/api/review-queue/${WORKER_ID}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });

    expect(res.status).toBe(200);
    expect(mockWriteWorkerInput).not.toHaveBeenCalled();
  });
});
