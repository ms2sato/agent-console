import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
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
import { SharedAccountRegistry } from '../../services/shared-account-registry.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
import { SessionManager } from '../../services/session-manager.js';
import { JsonSessionRepository } from '../../repositories/index.js';
import { TEST_AUTH_USER } from '../../__tests__/test-utils.js';

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

    it('should return 409 with code=session_orphaned when session is orphaned', async () => {
      // Seed an orphaned persisted session directly — no in-memory entry.
      const repo = sessionManager.getSessionRepository();
      await repo.save({
        id: 'orphan-resume-target',
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        serverPid: null,
        pausedAt: '2024-01-01T01:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        workers: [],
        recoveryState: 'orphaned',
        orphanedAt: 1700000000000,
        orphanedReason: 'path_resolution_failed',
      });

      const res = await app.request('/api/sessions/orphan-resume-target/resume', {
        method: 'POST',
      });

      expect(res.status).toBe(409);

      const body = (await res.json()) as { error: string; code?: string };
      expect(body.code).toBe('session_orphaned');
      // Message must identify the session so operators can diagnose.
      expect(body.error).toContain('orphan-resume-target');
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
// POST /api/sessions — embeddedAgentId pre-validation (Issue #1060)
// ===========================================================================
//
// Mirrors POST /api/repositories/:id/worktrees' pre-validation (see
// worktrees.test.ts "Issue #1038 embedded-agent selection"): a dangling
// embeddedAgentId must be rejected with a 400 before any async side effect
// (session creation) runs.
describe('Sessions API - POST /api/sessions (embeddedAgentId pre-validation)', () => {
  let app: Hono<AppBindings>;
  let sessionManager: SessionManager;
  let testJobQueue: JobQueue;

  beforeEach(async () => {
    await closeDatabase();

    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
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
      repositoryLookup: { getRepositorySlug: () => 'test-repo' },
      repositoryEnvLookup: {
        getRepositoryInfo: () => ({ name: 'test-repo', path: '/test/repo' }),
        getWorktreeIndexNumber: async () => 0,
      },
    });

    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', asAppContext({
        sessionManager,
        embeddedAgentManager: {
          getEmbeddedAgent: mock(() => undefined),
        } as unknown as Parameters<typeof asAppContext>[0]['embeddedAgentManager'],
      }));
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

  it('returns 400 when embeddedAgentId references an unknown embedded agent', async () => {
    const createSessionSpy = spyOn(sessionManager, 'createSession');

    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'quick',
        locationPath: '/test/path',
        embeddedAgentId: 'dangling-embedded-agent',
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Embedded agent not found: dangling-embedded-agent');

    // The pre-validation must short-circuit before sessionManager.createSession
    // is ever invoked -- no async side effect (session insertion, worker
    // creation) may have run.
    expect(createSessionSpy).not.toHaveBeenCalled();

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

// ===========================================================================
// POST /api/sessions — `shared: true` flag handling
// ===========================================================================
//
// Validates the route-level translation of `body.shared` into createdBy /
// initiatedBy ownership per docs/design/shared-orchestrator-session.md
// §"Session Creation Flow".
//
// Boundary cases (per .claude/rules/design-principles.md "Specify boundary
// values"):
//   - `shared` field absent → personal session (createdBy = authUser, initiatedBy undefined).
//   - `shared: false`       → personal session (same as absent).
//   - `shared: true` + disabled registry → 400 ValidationError.
//   - `shared: true` + enabled registry  → shared session (createdBy = shared,
//                                          initiatedBy = authUser).
//   - `shared: 'string'`    → 400 from schema validation.
describe('Sessions API - POST /api/sessions (shared sessions)', () => {
  let app: Hono<AppBindings>;
  let sessionManager: SessionManager;
  let testJobQueue: JobQueue;
  let sharedAccountRegistry: SharedAccountRegistry;

  async function setupCommon(opts: { sharedEnabled: boolean }): Promise<void> {
    await closeDatabase();
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
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
    const userRepository = new SqliteUserRepository(db);

    // Insert the test auth user so FK constraints (sessions.created_by → users.id) hold.
    await db
      .insertInto('users')
      .values({
        id: TEST_AUTH_USER.id,
        os_uid: null,
        username: TEST_AUTH_USER.username,
        home_dir: TEST_AUTH_USER.homeDir,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    if (opts.sharedEnabled) {
      sharedAccountRegistry = await SharedAccountRegistry.create({
        username: 'shared-user',
        userRepository,
        lookupOsUser: async () => ({ uid: 5050, homeDir: '/home/shared-user' }),
      });
    } else {
      sharedAccountRegistry = SharedAccountRegistry.createDisabled();
    }

    const sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);

    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, TEST_AUTH_USER),
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
      c.set('appContext', asAppContext({ sessionManager, sharedAccountRegistry }));
      await next();
    });
    app.onError(onApiError);
    app.route('/api', api);
  }

  afterEach(async () => {
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
    resetProcessMock();
  });

  it('omitted shared field → personal session (createdBy = authUser, initiatedBy undefined)', async () => {
    await setupCommon({ sharedEnabled: false });

    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { session: { id: string; createdBy?: string; initiatedBy?: string } };
    expect(body.session.createdBy).toBe(TEST_AUTH_USER.id);
    expect(body.session.initiatedBy).toBeUndefined();

    const persisted = await sessionManager.getSessionRepository().findById(body.session.id);
    expect(persisted!.createdBy).toBe(TEST_AUTH_USER.id);
    expect(persisted!.initiatedBy).toBeUndefined();
  });

  it('shared:false → personal session (same as omitted)', async () => {
    await setupCommon({ sharedEnabled: true });

    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
        shared: false,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { session: { id: string; createdBy?: string; initiatedBy?: string } };
    expect(body.session.createdBy).toBe(TEST_AUTH_USER.id);
    expect(body.session.initiatedBy).toBeUndefined();
  });

  it('shared:true + feature disabled → 400 ValidationError', async () => {
    await setupCommon({ sharedEnabled: false });

    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
        shared: true,
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Shared sessions are not enabled');
  });

  it('shared:true + feature enabled → 201 (createdBy = shared, initiatedBy = authUser)', async () => {
    await setupCommon({ sharedEnabled: true });

    const sharedUserId = sharedAccountRegistry.getDefaultUserId();
    expect(sharedUserId).not.toBeNull();

    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
        shared: true,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { session: { id: string; createdBy?: string; initiatedBy?: string } };
    expect(body.session.createdBy).toBe(sharedUserId!);
    expect(body.session.initiatedBy).toBe(TEST_AUTH_USER.id);

    const persisted = await sessionManager.getSessionRepository().findById(body.session.id);
    expect(persisted!.createdBy).toBe(sharedUserId!);
    expect(persisted!.initiatedBy).toBe(TEST_AUTH_USER.id);
  });

  it('shared:"string" → 400 from schema validation (boolean expected)', async () => {
    await setupCommon({ sharedEnabled: true });

    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
        shared: 'yes', // wrong type
      }),
    });

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// GET /api/sessions/:sessionId/branches (Issue #870)
//
// The route resolves the session's effective spawn user (via
// `resolveSpawnUsername(session.createdBy, userRepository)`) and threads it
// into `worktreeService.listBranches` so multi-user mode runs the git
// invocations as the OS user that owns the worktree. For shared sessions
// the spawn user is the shared account, NOT the authenticated viewer --
// using the viewer's identity would reintroduce dubious-ownership /
// missing-credential failures (CodeRabbit review on PR #874).
// ===========================================================================
describe('Sessions API - GET /api/sessions/:sessionId/branches', () => {
  let app: Hono<AppBindings>;
  const mockSessionManager = {
    getSession: mock((_id: string) => undefined as any),
  };
  type BranchesResult = { local: string[]; remote: string[]; defaultBranch: string | null };
  const mockWorktreeService = {
    listBranches: mock<
      (repoPath: string, requestUsername?: string | null) => Promise<BranchesResult>
    >(() => Promise.resolve({ local: [], remote: [], defaultBranch: null })),
  };
  // Minimal UserRepository stub: returns a user when findById is called with
  // an id we registered. Lets us drive resolveSpawnUsername deterministically
  // without spinning up a sqlite repo.
  const mockUserRepository: any = {
    findById: mock<(id: string) => Promise<{ id: string; username: string; homeDir: string } | null>>(
      () => Promise.resolve(null),
    ),
  };

  beforeEach(() => {
    mockSessionManager.getSession.mockReset();
    mockWorktreeService.listBranches.mockReset();
    mockWorktreeService.listBranches.mockImplementation(() =>
      Promise.resolve({ local: [], remote: [], defaultBranch: null }),
    );
    mockUserRepository.findById.mockReset();
    mockUserRepository.findById.mockImplementation(() => Promise.resolve(null));

    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set(
        'appContext',
        asAppContext({
          sessionManager: mockSessionManager as any,
          worktreeService: mockWorktreeService as any,
          userRepository: mockUserRepository,
        }),
      );
      await next();
    });
    app.onError(onApiError);
    app.route('/api', api);
  });

  it('forwards the session spawn username (resolved via createdBy) to worktreeService.listBranches', async () => {
    mockSessionManager.getSession.mockReturnValueOnce({
      id: 'session1',
      locationPath: '/worktree/wt-001-aaaa',
      createdBy: 'shared-account-id',
    });
    mockUserRepository.findById.mockImplementationOnce((id: string) =>
      id === 'shared-account-id'
        ? Promise.resolve({ id, username: 'sharedacct', homeDir: '/home/sharedacct' })
        : Promise.resolve(null),
    );
    mockWorktreeService.listBranches.mockImplementationOnce(() =>
      Promise.resolve({ local: ['main'], remote: ['origin/main'], defaultBranch: 'main' }),
    );

    const res = await app.request('/api/sessions/session1/branches');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      local: string[];
      remote: string[];
      defaultBranch: string | null;
    };
    expect(body.local).toEqual(['main']);
    expect(body.remote).toEqual(['origin/main']);
    expect(body.defaultBranch).toBe('main');

    expect(mockWorktreeService.listBranches).toHaveBeenCalledTimes(1);
    const [locationPath, requestUsername] = mockWorktreeService.listBranches.mock.calls[0];
    expect(locationPath).toBe('/worktree/wt-001-aaaa');
    // Critical: the shared-account spawn user, NOT the authenticated viewer.
    expect(requestUsername).toBe('sharedacct');
  });

  it('returns 404 when the session does not exist', async () => {
    mockSessionManager.getSession.mockReturnValueOnce(undefined);

    const res = await app.request('/api/sessions/missing/branches');
    expect(res.status).toBe(404);
    expect(mockWorktreeService.listBranches).toHaveBeenCalledTimes(0);
  });
});

// ===========================================================================
// GET /api/sessions/:sessionId/pr-link (Issue #885)
//
// The route MUST thread `authUser.username` into the `fetchPullRequestUrl`
// service so `gh pr view` runs as the requesting OS user under multi-user
// mode. In single-user mode the value is still forwarded; the underlying
// `runAsUser` bypasses elevation. This test guards the wiring.
// ===========================================================================
describe('Sessions API - GET /api/sessions/:sessionId/pr-link (Issue #885)', () => {
  let app: Hono<AppBindings>;
  const mockSessionManager = {
    getSession: mock((_id: string) => undefined as any),
  };
  const mockFetchPullRequestUrl = mock(
    async (_branch: string, _cwd: string, _requestUsername: string | null) =>
      null as string | null,
  );

  beforeEach(() => {
    mockSessionManager.getSession.mockReset();
    mockFetchPullRequestUrl.mockReset();
    mockFetchPullRequestUrl.mockImplementation(async () => 'https://github.com/owner/repo/pull/42');

    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set(
        'appContext',
        asAppContext({
          sessionManager: mockSessionManager as any,
          fetchPullRequestUrl: mockFetchPullRequestUrl,
        }),
      );
      await next();
    });
    app.onError(onApiError);
    app.route('/api', api);
  });

  it('forwards authUser.username to fetchPullRequestUrl as 3rd positional arg', async () => {
    mockSessionManager.getSession.mockReturnValueOnce({
      id: 'session1',
      type: 'worktree',
      worktreeId: 'feature-branch',
      locationPath: '/worktree/wt-001',
    });

    const res = await app.request('/api/sessions/session1/pr-link');
    expect(res.status).toBe(200);

    const body = (await res.json()) as { prUrl: string | null; branchName: string };
    expect(body.prUrl).toBe('https://github.com/owner/repo/pull/42');
    expect(body.branchName).toBe('feature-branch');

    expect(mockFetchPullRequestUrl).toHaveBeenCalledTimes(1);
    const [branch, cwd, requestUsername] = mockFetchPullRequestUrl.mock.calls[0];
    expect(branch).toBe('feature-branch');
    expect(cwd).toBe('/worktree/wt-001');
    // The default SingleUserMode used by asAppContext is constructed with
    // TEST_AUTH_USER (username='testuser'), so the route MUST forward
    // 'testuser' as the 3rd positional arg.
    expect(requestUsername).toBe('testuser');
  });

  it('returns 404 when the session does not exist', async () => {
    mockSessionManager.getSession.mockReturnValueOnce(undefined);

    const res = await app.request('/api/sessions/missing/pr-link');
    expect(res.status).toBe(404);
    expect(mockFetchPullRequestUrl).not.toHaveBeenCalled();
  });
});
