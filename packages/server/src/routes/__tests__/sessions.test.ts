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
import { SingleUserMode } from '../../services/user-mode.js';
import { SessionManager } from '../../services/session-manager.js';
import { JsonSessionRepository } from '../../repositories/index.js';

// Test config directory
const TEST_CONFIG_DIR = '/test/config';

// Create mock PTY factory
const ptyFactory = createMockPtyFactory(20000);

describe('Sessions API - Pause/Resume', () => {
  let app: Hono<AppBindings>;
  let sessionManager: SessionManager;
  let testJobQueue: JobQueue;

  beforeEach(async () => {
    await closeDatabase();

    // Setup memfs with config directory structure
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    // Initialize in-memory database
    await initializeDatabase(':memory:');

    // Create job queue with the in-memory database
    testJobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(testJobQueue, new WorkerOutputFileManager());

    // Reset process mock and mark current process as alive
    resetProcessMock();
    mockProcess.markAlive(process.pid);

    // Reset PTY factory
    ptyFactory.reset();

    // Create AgentManager for dependency injection
    const db = getDatabase();
    const agentMgr = await AgentManager.create(new SqliteAgentRepository(db));

    // Create session repository
    const sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);

    // Create SessionManager directly using the factory pattern
    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager: agentMgr,
      repositoryLookup: { getRepositorySlug: () => 'test-repo' },
      repositoryEnvLookup: {
        getRepositoryInfo: () => ({ name: 'test-repo', path: '/test/repo' }),
        getWorktreeIndexNumber: async () => 0,
      },
    });

    // Create Hono app with error handler
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

  // ===========================================================================
  // POST /api/sessions/restart-all-agents
  // ===========================================================================

  describe('POST /api/sessions/restart-all-agents', () => {
    it('should restart all agent workers and return summary', async () => {
      // Create two sessions with agent workers
      await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path1',
        agentId: 'claude-code',
      });
      await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path2',
        agentId: 'claude-code',
      });

      const res = await app.request('/api/sessions/restart-all-agents', {
        method: 'POST',
      });

      expect(res.status).toBe(200);

      const body = (await res.json()) as { restarted: number; failed: number; results: unknown[] };
      expect(body.restarted).toBe(2);
      expect(body.failed).toBe(0);
      expect(body.results).toHaveLength(2);
    });

    it('should return empty results when no sessions exist', async () => {
      const res = await app.request('/api/sessions/restart-all-agents', {
        method: 'POST',
      });

      expect(res.status).toBe(200);

      const body = (await res.json()) as { restarted: number; failed: number; results: unknown[] };
      expect(body.restarted).toBe(0);
      expect(body.failed).toBe(0);
      expect(body.results).toHaveLength(0);
    });
  });
});

// ===========================================================================
// POST /api/sessions — repository_not_found mapping
// ===========================================================================
//
// The `RepositoryNotFoundError` carries `code: 'repository_not_found'` and a
// 404 status. This test exercises the full request → handler → error-handler
// pipeline so that any future change to either the route or the global error
// formatter will surface immediately.
// TODO: extract common setup into createTestApp helper; see PR #638 review
describe('Sessions API - POST /api/sessions (repository_not_found)', () => {
  let app: Hono<AppBindings>;
  let sessionManager: SessionManager;
  let testJobQueue: JobQueue;

  beforeEach(async () => {
    await closeDatabase();

    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
      // The session-create route validates the requested locationPath via
      // `validateSessionPath`, which calls `realpath` on the (mocked) fs.
      // The path must resolve, otherwise the route fails with 400 before
      // reaching the repository lookup we want to exercise here.
      ['/test/path/.keep']: '',
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
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager: agentMgr,
      // Repository lookup never resolves any id — every worktree-session create
      // must therefore fail fast with RepositoryNotFoundError.
      repositoryLookup: { getRepositorySlug: () => undefined },
      repositoryEnvLookup: {
        getRepositoryInfo: () => undefined,
        getWorktreeIndexNumber: async () => 0,
      },
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

  it('returns 404 with code=repository_not_found when the repository id is unknown', async () => {
    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'unknown-repo-id',
        worktreeId: 'main',
        agentId: 'claude-code',
      }),
    });

    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe('repository_not_found');
    // Message must mention the missing repository so operators can diagnose.
    expect(body.error).toContain('Repository not found');
    expect(body.error).toContain('unknown-repo-id');

    // No row may have been persisted as a side-effect.
    const persisted = await sessionManager.getSessionRepository().findAll();
    expect(persisted).toEqual([]);
  });
});

// ===========================================================================
// GET /api/sessions/:id — orphaned sessions surface recoveryState
// ===========================================================================
//
// Per docs/design/session-data-path.md §"Orphaned recovery state", an
// orphaned session is intentionally NOT hidden from clients — it is exposed
// with `recoveryState: 'orphaned'` so the UI can offer recovery actions.
// This route-level test guards against accidental filtering at the API
// boundary. The session is seeded directly into the persistence layer (no
// in-memory active session) and the route must surface it via the persisted
// fallback in `GET /api/sessions/:id`.
describe('Sessions API - GET /api/sessions/:id (orphaned visibility)', () => {
  let app: Hono<AppBindings>;
  let sessionManager: SessionManager;
  let testJobQueue: JobQueue;
  let sessionRepository: JsonSessionRepository;

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

    sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);

    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager: agentMgr,
      repositoryLookup: { getRepositorySlug: () => 'test-repo' },
      repositoryEnvLookup: {
        getRepositoryInfo: () => ({ name: 'test-repo', path: '/test/repo' }),
        getWorktreeIndexNumber: async () => 0,
      },
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

  it('returns the orphaned session with recoveryState=orphaned', async () => {
    // Seed the persistence layer directly (no in-memory session). serverPid
    // is null so the row is treated as paused/persisted-only.
    await sessionRepository.save({
      id: 'orphan-session-1',
      type: 'worktree',
      locationPath: '/some/missing/path',
      repositoryId: 'gone-repo',
      worktreeId: 'main',
      serverPid: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      workers: [],
      recoveryState: 'orphaned',
      orphanedAt: 1700000000000,
      orphanedReason: 'migration_unresolved_repository',
    });

    const res = await app.request('/api/sessions/orphan-session-1', {
      method: 'GET',
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      session: {
        id: string;
        recoveryState: 'healthy' | 'orphaned';
      };
    };
    expect(body.session.id).toBe('orphan-session-1');
    expect(body.session.recoveryState).toBe('orphaned');
  });
});
