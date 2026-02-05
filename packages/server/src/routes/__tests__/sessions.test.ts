import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { onApiError } from '../../lib/error-handler.js';
import { api } from '../api.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { initializeDatabase, closeDatabase } from '../../database/connection.js';
import { initializeJobQueue, resetJobQueue } from '../../jobs/index.js';
import { resetSessionManager, SessionManager, setSessionManager } from '../../services/session-manager.js';
import { JsonSessionRepository } from '../../repositories/index.js';

// Test config directory
const TEST_CONFIG_DIR = '/test/config';

// Create mock PTY factory
const ptyFactory = createMockPtyFactory(20000);

describe('Sessions API - Pause/Resume', () => {
  let app: Hono;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    // Reset singletons
    resetSessionManager();
    await resetJobQueue();
    await closeDatabase();

    // Setup memfs with config directory structure
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    // Initialize in-memory database
    await initializeDatabase(':memory:');

    // Initialize the singleton job queue
    const testJobQueue = initializeJobQueue();

    // Reset process mock and mark current process as alive
    resetProcessMock();
    mockProcess.markAlive(process.pid);

    // Reset PTY factory
    ptyFactory.reset();

    // Create session repository
    const sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);

    // Create SessionManager directly using the factory pattern
    sessionManager = await SessionManager.create({
      ptyProvider: ptyFactory.provider,
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
    });

    // Set the singleton
    setSessionManager(sessionManager);

    // Create Hono app with error handler
    app = new Hono();
    app.onError(onApiError);
    app.route('/api', api);
  });

  afterEach(async () => {
    resetSessionManager();
    await resetJobQueue();
    await closeDatabase();
    cleanupMemfs();
    resetProcessMock();
  });

  // ===========================================================================
  // POST /api/sessions/:id/pause
  // ===========================================================================

  describe('POST /api/sessions/:id/pause', () => {
    it('should return 400 for quick session (quick sessions cannot be paused)', async () => {
      // Create a quick session
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const res = await app.request(`/api/sessions/${session.id}/pause`, {
        method: 'POST',
      });

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Quick sessions cannot be paused');
    });

    it('should return 404 for non-existent session', async () => {
      const res = await app.request('/api/sessions/non-existent-id/pause', {
        method: 'POST',
      });

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Session');
    });

    it('should successfully pause a worktree session', async () => {
      // Create a worktree session
      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      const res = await app.request(`/api/sessions/${session.id}/pause`, {
        method: 'POST',
      });

      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);

      // Session should no longer be in memory
      expect(sessionManager.getSession(session.id)).toBeUndefined();
    });

    it('should return 404 when trying to pause an already paused session', async () => {
      // Create and pause a worktree session
      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      // First pause should succeed
      const firstRes = await app.request(`/api/sessions/${session.id}/pause`, {
        method: 'POST',
      });
      expect(firstRes.status).toBe(200);

      // Second pause should return 404 (session not in memory)
      const secondRes = await app.request(`/api/sessions/${session.id}/pause`, {
        method: 'POST',
      });
      expect(secondRes.status).toBe(404);
    });
  });

  // ===========================================================================
  // POST /api/sessions/:id/resume
  // ===========================================================================

  describe('POST /api/sessions/:id/resume', () => {
    it('should return 404 for non-existent session', async () => {
      const res = await app.request('/api/sessions/non-existent-id/resume', {
        method: 'POST',
      });

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Session');
    });

    it('should successfully resume a paused session', async () => {
      // Create and pause a worktree session
      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });
      const sessionId = session.id;

      await sessionManager.pauseSession(sessionId);

      // Verify session is not in memory
      expect(sessionManager.getSession(sessionId)).toBeUndefined();

      // Resume the session
      const res = await app.request(`/api/sessions/${sessionId}/resume`, {
        method: 'POST',
      });

      expect(res.status).toBe(200);

      const body = (await res.json()) as { session: { id: string; type: string } };
      expect(body.session).toBeDefined();
      expect(body.session.id).toBe(sessionId);
      expect(body.session.type).toBe('worktree');

      // Session should be back in memory
      expect(sessionManager.getSession(sessionId)).toBeDefined();
    });

    it('should return session when resuming an already active session (idempotent)', async () => {
      // Create a worktree session (already active)
      const session = await sessionManager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      // Resume should return the active session
      const res = await app.request(`/api/sessions/${session.id}/resume`, {
        method: 'POST',
      });

      expect(res.status).toBe(200);

      const body = (await res.json()) as { session: { id: string } };
      expect(body.session.id).toBe(session.id);
    });
  });
});
