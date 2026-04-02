import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { onApiError } from '../../lib/error-handler.js';
import { api } from '../api.js';
import type { AppBindings } from '../../app-context.js';
import { asAppContext } from '../../__tests__/test-utils.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { AgentManager } from '../../services/agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { JobQueue } from '../../jobs/job-queue.js';
import { registerJobHandlers } from '../../jobs/handlers.js';
import { WorkerOutputFileManager } from '../../lib/worker-output-file.js';
import { SessionManager } from '../../services/session-manager.js';
import { JsonSessionRepository } from '../../repositories/index.js';
import { MAX_MESSAGE_FILES, MAX_TOTAL_FILE_SIZE } from '@agent-console/shared';

const TEST_CONFIG_DIR = '/test/config';

const ptyFactory = createMockPtyFactory(20000);

describe('Workers API', () => {
  let app: Hono<AppBindings>;
  let sessionManager: SessionManager;
  let testJobQueue: JobQueue;

  beforeEach(async () => {
    await closeDatabase();

    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    await initializeDatabase(':memory:');

    testJobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(testJobQueue, new WorkerOutputFileManager());

    resetProcessMock();
    mockProcess.markAlive(process.pid);

    ptyFactory.reset();

    const db = getDatabase();
    const agentMgr = await AgentManager.create(new SqliteAgentRepository(db));

    const sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);

    sessionManager = await SessionManager.create({
      ptyProvider: ptyFactory.provider,
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager: agentMgr,
    });

    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', asAppContext({ sessionManager }));
      await next();
    });
    app.onError(onApiError);
    app.route('/api', api);
  });

  afterEach(async () => {
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
    resetProcessMock();
  });

  // ===========================================================================
  // GET /api/sessions/:sessionId/workers
  // ===========================================================================

  describe('GET /api/sessions/:sessionId/workers', () => {
    it('should return 404 for non-existent session', async () => {
      const res = await app.request('/api/sessions/non-existent-id/workers', {
        method: 'GET',
      });

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Session');
    });

    it('should return empty worker list for a new session', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const res = await app.request(`/api/sessions/${session.id}/workers`, {
        method: 'GET',
      });

      expect(res.status).toBe(200);

      const body = (await res.json()) as { workers: unknown[] };
      expect(body.workers).toBeArray();
    });
  });

  // ===========================================================================
  // POST /api/sessions/:sessionId/messages — Security-critical
  // ===========================================================================

  describe('POST /api/sessions/:sessionId/messages', () => {
    it('should return 404 when sending to non-existent session', async () => {
      const formData = new FormData();
      formData.append('toWorkerId', 'some-worker-id');
      formData.append('content', 'hello');

      const res = await app.request('/api/sessions/non-existent-id/messages', {
        method: 'POST',
        body: formData,
      });

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Session');
    });

    it('should return 400 when message has no content and no files', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Need a real worker ID for toWorkerId validation
      const formData = new FormData();
      formData.append('toWorkerId', 'some-worker-id');
      formData.append('content', '');

      const res = await app.request(`/api/sessions/${session.id}/messages`, {
        method: 'POST',
        body: formData,
      });

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('content or at least one file');
    });

    it('should return 400 when too many files are attached', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const formData = new FormData();
      formData.append('toWorkerId', 'some-worker-id');
      formData.append('content', 'hello');

      // Attach more than MAX_MESSAGE_FILES
      for (let i = 0; i < MAX_MESSAGE_FILES + 1; i++) {
        const file = new File(['content'], `file-${i}.txt`, { type: 'text/plain' });
        formData.append('files', file);
      }

      const res = await app.request(`/api/sessions/${session.id}/messages`, {
        method: 'POST',
        body: formData,
      });

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Too many files');
    });

    it('should return 400 when total file size exceeds limit', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const formData = new FormData();
      formData.append('toWorkerId', 'some-worker-id');
      formData.append('content', 'hello');

      // Create a file that exceeds MAX_TOTAL_FILE_SIZE
      const largeContent = new Uint8Array(MAX_TOTAL_FILE_SIZE + 1);
      const file = new File([largeContent], 'large-file.bin', { type: 'application/octet-stream' });
      formData.append('files', file);

      const res = await app.request(`/api/sessions/${session.id}/messages`, {
        method: 'POST',
        body: formData,
      });

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Total file size exceeds limit');
    });

    it('should sanitize path traversal in filenames', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Create a worker so the message can be delivered
      const worker = await sessionManager.createWorker(session.id, {
        type: 'agent',
        agentId: 'claude-code',
      });
      expect(worker).not.toBeNull();

      const formData = new FormData();
      formData.append('toWorkerId', worker!.id);
      formData.append('content', 'test message');

      // Attach a file with a path traversal filename
      const maliciousFile = new File(['malicious content'], '../../etc/passwd', {
        type: 'text/plain',
      });
      formData.append('files', maliciousFile);

      const res = await app.request(`/api/sessions/${session.id}/messages`, {
        method: 'POST',
        body: formData,
      });

      // The request should succeed (201) because the filename is sanitized
      expect(res.status).toBe(201);

      const body = (await res.json()) as { message: { filePaths?: string[] } };
      expect(body.message).toBeDefined();

      // Verify the saved file path does not contain directory traversal sequences
      if (body.message.filePaths && body.message.filePaths.length > 0) {
        for (const filePath of body.message.filePaths) {
          expect(filePath).not.toContain('..');
          expect(filePath).not.toMatch(/[/\\]\.\.[/\\]/);
        }
      }
    });

    it('should validate session exists before writing files to disk', async () => {
      // Sending to a non-existent session with files should return 404
      // without writing any files to disk (session check happens before file write)
      const formData = new FormData();
      formData.append('toWorkerId', 'some-worker-id');
      formData.append('content', 'hello');

      const file = new File(['test content'], 'test.txt', { type: 'text/plain' });
      formData.append('files', file);

      const res = await app.request('/api/sessions/non-existent-id/messages', {
        method: 'POST',
        body: formData,
      });

      // Session validation happens BEFORE file writing, so we get 404
      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Session');
    });
  });

  // ===========================================================================
  // POST /api/sessions/:sessionId/workers — Create worker
  // ===========================================================================

  describe('POST /api/sessions/:sessionId/workers', () => {
    it('should return 404 for non-existent session', async () => {
      const res = await app.request('/api/sessions/non-existent-id/workers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'terminal' }),
      });

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Session');
    });

    it('should create a terminal worker successfully', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const res = await app.request(`/api/sessions/${session.id}/workers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'terminal' }),
      });

      expect(res.status).toBe(201);

      const body = (await res.json()) as { worker: { id: string; type: string } };
      expect(body.worker).toBeDefined();
      expect(body.worker.id).toBeString();
      expect(body.worker.type).toBe('terminal');
    });
  });

  // ===========================================================================
  // DELETE /api/sessions/:sessionId/workers/:workerId
  // ===========================================================================

  describe('DELETE /api/sessions/:sessionId/workers/:workerId', () => {
    it('should return 404 for non-existent session', async () => {
      const res = await app.request('/api/sessions/non-existent-id/workers/some-worker-id', {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Session');
    });

    it('should return 404 for non-existent worker in existing session', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const res = await app.request(`/api/sessions/${session.id}/workers/non-existent-worker`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Worker');
    });
  });

  // ===========================================================================
  // POST /api/sessions/:sessionId/workers/:workerId/restart
  // ===========================================================================

  describe('POST /api/sessions/:sessionId/workers/:workerId/restart', () => {
    it('should return 404 for non-existent worker', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const res = await app.request(
        `/api/sessions/${session.id}/workers/non-existent-worker/restart`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Worker');
    });
  });
});
