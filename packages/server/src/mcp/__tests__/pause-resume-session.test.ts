/**
 * `pause_session` / `resume_session` MCP tool tests, plus the `includePaused`
 * extension to `list_sessions` and the paused-session branch of
 * `get_session_status` (Issue #2315).
 *
 * The authorization helper (`checkPauseResumeRelationship`) is unit-tested
 * directly, in isolation, with no server harness, in the sibling
 * `pause-resume-authorization.test.ts`. Everything in this file drives the
 * REAL `createMcpApp` handler chain via `callTool` (real MCP JSON-RPC
 * transport), backed by a real `SqliteSessionRepository` and
 * `SqliteRepositoryRepository` against an in-memory DB -- mirrors
 * `orchestrator-session-designation.test.ts`'s harness, which this file
 * copies because `repository_orchestrator_sessions.session_id` is a real FK
 * to `sessions.id` (migration v41) and both pause/resume and the
 * designated-Orchestrator relationship need real session rows.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { JobQueue } from '../../jobs/job-queue.js';
import { registerJobHandlers } from '../../jobs/handlers.js';
import { WorkerOutputFileManager } from '../../lib/worker-output-file.js';
import { SessionManager } from '../../services/session-manager.js';
import { RepositoryManager } from '../../services/repository-manager.js';
import { AgentManager } from '../../services/agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { SqliteSessionRepository } from '../../repositories/sqlite-session-repository.js';
import { SqliteRepositoryRepository } from '../../repositories/sqlite-repository-repository.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
import { SqliteArtifactRepository } from '../../repositories/sqlite-artifact-repository.js';
import { SqliteBookmarkRepository } from '../../repositories/sqlite-bookmark-repository.js';
import { WorktreeService } from '../../services/worktree-service.js';
import { TimerManager } from '../../services/timer-manager.js';
import { ConditionalWakeupManager } from '../../services/conditional-wakeup-manager.js';
import { InteractiveProcessManager } from '../../services/interactive-process-manager.js';
import { AnnotationService } from '../../services/annotation-service.js';
import { InterSessionMessageService } from '../../services/inter-session-message-service.js';
import { SingleUserMode } from '../../services/user-mode.js';
import { EmbeddedAgentManager } from '../../services/embedded-agent-manager.js';
import { SqliteEmbeddedAgentRepository } from '../../repositories/sqlite-embedded-agent-repository.js';
import { createMcpApp } from '../mcp-server.js';
import { McpTokenRegistry, type McpAuthMode } from '../mcp-auth.js';
import { AgentDirectory } from '../../services/agent-directory.js';
import { createWorktreeWithSession } from '../../services/worktree-creation-service.js';
import { deleteWorktree } from '../../services/worktree-deletion-service.js';
import { initializeMcp, callTool, parseToolResult } from './mcp-protocol-test-helpers.js';
import { repositoryLookupFromSlug } from '../../__tests__/utils/repository-lookup-mock.js';

// ---------- MCP tool tests: full harness ----------

const TEST_CONFIG_DIR = '/test/config-2315-pause-resume';
const TEST_REPO_PATH = '/test/repo-2315-a';
const TEST_REPO_ID = 'repo-2315-a';
const TEST_REPO_PATH_2 = '/test/repo-2315-b';
const TEST_REPO_ID_2 = 'repo-2315-b';

describe('pause_session / resume_session (MCP tools)', () => {
  const ptyFactory = createMockPtyFactory();
  let app: Hono;
  let sessionManager: SessionManager;
  let repositoryManager: RepositoryManager;
  let agentManager: AgentManager;
  let userRepository: SqliteUserRepository;
  let artifactRepository: SqliteArtifactRepository;
  let bookmarkRepository: SqliteBookmarkRepository;
  let sessionRepository: SqliteSessionRepository;
  let testJobQueue: JobQueue;
  let mcpSessionId: string;
  let nextId: number;
  let worktreeService: WorktreeService;
  let agentDirectory: AgentDirectory;

  async function mountMcpApp(authOpts?: {
    mcpAuthMode?: McpAuthMode;
    mcpTokenRegistry?: McpTokenRegistry;
  }): Promise<void> {
    const mcpApp = createMcpApp({
      sessionManager,
      repositoryManager,
      agentManager,
      agentDirectory,
      timerManager: new TimerManager(() => {}),
      conditionalWakeupManager: new ConditionalWakeupManager(() => {}),
      interactiveProcessManager: new InteractiveProcessManager(() => {}, () => {}),
      worktreeService,
      annotationService: new AnnotationService(),
      interSessionMessageService: new InterSessionMessageService(),
      suggestSessionMetadata: async () => ({ branch: 'unused', title: 'unused' }),
      createWorktreeWithSession,
      deleteWorktree,
      userRepository,
      artifactRepository,
      bookmarkRepository,
      broadcastToApp: () => {},
      findOpenPullRequest: async () => null,
      fetchPullRequestUrl: async () => null,
      mcpAuthMode: authOpts?.mcpAuthMode,
      mcpTokenRegistry: authOpts?.mcpTokenRegistry,
    });
    app = new Hono();
    app.route('', mcpApp);

    let initializeHeaders: Record<string, string> | undefined;
    if (authOpts?.mcpAuthMode === 'enforce' && authOpts.mcpTokenRegistry) {
      const handshakeToken = authOpts.mcpTokenRegistry.mint({
        sessionId: 'test-harness-handshake-session',
        workerId: 'test-harness-handshake-worker',
        userId: 'test-harness-handshake-user',
      });
      initializeHeaders = { Authorization: `Bearer ${handshakeToken}` };
    }

    mcpSessionId = await initializeMcp(app, initializeHeaders);
  }

  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({
      [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      [`${TEST_REPO_PATH_2}/.git/HEAD`]: 'ref: refs/heads/main',
      // The data root must exist before any session-data writer runs: the
      // trusted-root walker verifies it and never creates it (production
      // creates it at boot; session-data-path.md section 2).
      [TEST_CONFIG_DIR]: null,
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    await initializeDatabase(':memory:');
    testJobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(testJobQueue, new WorkerOutputFileManager());

    resetProcessMock();
    mockProcess.markAlive(process.pid);
    ptyFactory.reset();
    resetGitMocks();

    const db = getDatabase();
    agentManager = await AgentManager.create(new SqliteAgentRepository(db));
    const embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(db));
    userRepository = new SqliteUserRepository(db);
    artifactRepository = new SqliteArtifactRepository(db);
    bookmarkRepository = new SqliteBookmarkRepository(db);

    // Session repository is SQLite-backed (not JSON): both pause/resume and
    // the designated-Orchestrator relationship read/write real session rows,
    // and `repository_orchestrator_sessions.session_id` is a real FK to
    // `sessions.id` (migration v41).
    sessionRepository = new SqliteSessionRepository(db);
    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager,
      embeddedAgentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      annotationService: new AnnotationService(),
      userRepository,
      repositoryLookup: repositoryLookupFromSlug(async (id: string) => repositoryManager?.getRepositorySlug(id)),
      repositoryEnvLookup: {
        getRepositoryInfo: (id: string) => {
          const r = repositoryManager?.getRepository(id);
          return r ? { name: r.name, path: r.path, envVars: r.envVars } : undefined;
        },
        getWorktreeIndexNumber: async () => 0,
      },
    });

    const sqliteRepoRepo = new SqliteRepositoryRepository(db);
    await sqliteRepoRepo.save({
      id: TEST_REPO_ID,
      name: 'test-repo-a',
      path: TEST_REPO_PATH,
      createdAt: new Date().toISOString(),
      orchestratorSessionIds: [],
      clonedSourceRepoPath: null,
    });
    await sqliteRepoRepo.save({
      id: TEST_REPO_ID_2,
      name: 'test-repo-b',
      path: TEST_REPO_PATH_2,
      createdAt: new Date().toISOString(),
      orchestratorSessionIds: [],
      clonedSourceRepoPath: null,
    });
    repositoryManager = await RepositoryManager.create({ repository: sqliteRepoRepo, jobQueue: testJobQueue });

    worktreeService = new WorktreeService({ db });
    agentDirectory = new AgentDirectory({ terminal: agentManager, embedded: embeddedAgentManager });

    await mountMcpApp({ mcpAuthMode: 'off' });
    nextId = 10;
  });

  afterEach(async () => {
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
    delete process.env.AGENT_CONSOLE_HOME;
  });

  async function createWorktreeSession(
    osUid: number,
    username: string,
    worktreeId: string,
    opts: { repositoryId?: string; parentSessionId?: string } = {},
  ): Promise<{ sessionId: string; userId: string; workerId: string }> {
    const owner = await userRepository.upsertByOsUid(osUid, username, `/home/${username}`);
    const repositoryId = opts.repositoryId ?? TEST_REPO_ID;
    const locationPath = repositoryId === TEST_REPO_ID_2 ? TEST_REPO_PATH_2 : TEST_REPO_PATH;
    const session = await sessionManager.createSession(
      {
        type: 'worktree',
        locationPath,
        repositoryId,
        worktreeId,
        agentId: 'claude-code-builtin',
        parentSessionId: opts.parentSessionId,
      },
      { createdBy: owner.id },
    );
    return {
      sessionId: session.id,
      userId: owner.id,
      workerId: session.workers.find((w) => w.type === 'agent')!.id,
    };
  }

  async function createQuickSession(
    osUid: number,
    username: string,
    opts: { parentSessionId?: string } = {},
  ): Promise<{ sessionId: string; userId: string }> {
    const owner = await userRepository.upsertByOsUid(osUid, username, `/home/${username}`);
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: TEST_REPO_PATH, parentSessionId: opts.parentSessionId },
      { createdBy: owner.id },
    );
    return { sessionId: session.id, userId: owner.id };
  }

  // ---------- pause_session ----------

  describe('pause_session', () => {
    it('parent pauses a live worktree child', async () => {
      const parent = await createWorktreeSession(9101, 'parent-pauser', 'main');
      const child = await createWorktreeSession(9102, 'child-pausee', 'feature', { parentSessionId: parent.sessionId });

      const spy = spyOn(sessionManager, 'pauseSession');
      const response = await callTool(
        app,
        mcpSessionId,
        'pause_session',
        { sessionId: child.sessionId, fromSessionId: parent.sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { sessionId: string; state: string; changed: boolean; pausedAt: string };
      expect(data.sessionId).toBe(child.sessionId);
      expect(data.state).toBe('paused');
      expect(data.changed).toBe(true);
      expect(data.pausedAt).toBeTruthy();
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();

      expect(sessionManager.getSession(child.sessionId)).toBeUndefined();
    });

    it('already paused: pauseSession is NOT called again, changed:false', async () => {
      const parent = await createWorktreeSession(9103, 'parent-pauser-2', 'main');
      const child = await createWorktreeSession(9104, 'child-pausee-2', 'feature', { parentSessionId: parent.sessionId });

      const first = await callTool(
        app,
        mcpSessionId,
        'pause_session',
        { sessionId: child.sessionId, fromSessionId: parent.sessionId },
        nextId++,
      );
      const firstData = parseToolResult(first) as { pausedAt: string };

      const spy = spyOn(sessionManager, 'pauseSession');
      const second = await callTool(
        app,
        mcpSessionId,
        'pause_session',
        { sessionId: child.sessionId, fromSessionId: parent.sessionId },
        nextId++,
      );

      expect(second.result?.isError).toBeUndefined();
      const secondData = parseToolResult(second) as { changed: boolean; pausedAt: string };
      expect(secondData.changed).toBe(false);
      expect(secondData.pausedAt).toBe(firstData.pausedAt);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('quick session target: error, pauseSession not called', async () => {
      const parent = await createWorktreeSession(9105, 'parent-pauser-3', 'main');
      const quick = await createQuickSession(9106, 'quick-target', { parentSessionId: parent.sessionId });

      const spy = spyOn(sessionManager, 'pauseSession');
      const response = await callTool(
        app,
        mcpSessionId,
        'pause_session',
        { sessionId: quick.sessionId, fromSessionId: parent.sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('Quick sessions cannot be paused');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('unknown id: error', async () => {
      const parent = await createWorktreeSession(9107, 'parent-pauser-4', 'main');

      const response = await callTool(
        app,
        mcpSessionId,
        'pause_session',
        { sessionId: 'does-not-exist', fromSessionId: parent.sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('does-not-exist');
    });

    it('unrelated caller: error, and pauseSession not called', async () => {
      const parent = await createWorktreeSession(9108, 'parent-pauser-5', 'main');
      const child = await createWorktreeSession(9109, 'child-pausee-5', 'feature', { parentSessionId: parent.sessionId });
      const unrelated = await createWorktreeSession(9110, 'unrelated-caller-5', 'other');

      const spy = spyOn(sessionManager, 'pauseSession');
      const response = await callTool(
        app,
        mcpSessionId,
        'pause_session',
        { sessionId: child.sessionId, fromSessionId: unrelated.sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('may not pause or resume');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();

      expect(sessionManager.getSession(child.sessionId)).not.toBeUndefined();
    });

    it("token-bearing caller whose userId differs from the target's createdBy: the ownership error", async () => {
      const parent = await createWorktreeSession(9111, 'parent-pauser-6', 'main');
      const child = await createWorktreeSession(9112, 'child-pausee-6', 'feature', { parentSessionId: parent.sessionId });

      const registry = new McpTokenRegistry();
      await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });
      // The token's own sessionId equals the parent (so resolveSelfIdentity's
      // own-pair check passes), but its userId does not own the child.
      const token = registry.mint({ sessionId: parent.sessionId, workerId: parent.workerId, userId: 'a-different-user-id' });

      const response = await callTool(
        app,
        mcpSessionId,
        'pause_session',
        { sessionId: child.sessionId },
        nextId++,
        { Authorization: `Bearer ${token}` },
      );

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('identity mismatch');
    });

    it('tokenless caller with fromSessionId omitted: the resolveSelfIdentity error', async () => {
      const parent = await createWorktreeSession(9113, 'parent-pauser-7', 'main');
      const child = await createWorktreeSession(9114, 'child-pausee-7', 'feature', { parentSessionId: parent.sessionId });

      const response = await callTool(app, mcpSessionId, 'pause_session', { sessionId: child.sessionId }, nextId++);

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('requires fromSessionId');
    });
  });

  // ---------- resume_session ----------

  describe('resume_session', () => {
    it('parent resumes a paused child: resumeSession called once, changed:true', async () => {
      const parent = await createWorktreeSession(9201, 'parent-resumer', 'main');
      const child = await createWorktreeSession(9202, 'child-resumee', 'feature', { parentSessionId: parent.sessionId });
      await sessionManager.pauseSession(child.sessionId);
      expect(sessionManager.getSession(child.sessionId)).toBeUndefined();

      const spy = spyOn(sessionManager, 'resumeSession');
      const response = await callTool(
        app,
        mcpSessionId,
        'resume_session',
        { sessionId: child.sessionId, fromSessionId: parent.sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { sessionId: string; state: string; changed: boolean; workers: unknown[] };
      expect(data.sessionId).toBe(child.sessionId);
      expect(data.state).toBe('active');
      expect(data.changed).toBe(true);
      expect(Array.isArray(data.workers)).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();

      expect(sessionManager.getSession(child.sessionId)).not.toBeUndefined();
    });

    it('target already live: resumeSession NOT called, changed:false', async () => {
      const parent = await createWorktreeSession(9203, 'parent-resumer-2', 'main');
      const child = await createWorktreeSession(9204, 'child-resumee-2', 'feature', { parentSessionId: parent.sessionId });

      const spy = spyOn(sessionManager, 'resumeSession');
      const response = await callTool(
        app,
        mcpSessionId,
        'resume_session',
        { sessionId: child.sessionId, fromSessionId: parent.sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { changed: boolean };
      expect(data.changed).toBe(false);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('resumeSession resolves null: error', async () => {
      const parent = await createWorktreeSession(9205, 'parent-resumer-3', 'main');
      const child = await createWorktreeSession(9206, 'child-resumee-3', 'feature', { parentSessionId: parent.sessionId });
      await sessionManager.pauseSession(child.sessionId);

      // Simulates the real null-producing cases (path gone / concurrent
      // resume in flight) without reproducing their setup, same convention
      // as the "throws SessionOrphanedError" case below reproducing its
      // real setup through the repository directly.
      const spy = spyOn(sessionManager, 'resumeSession').mockImplementation(async () => null);
      const response = await callTool(
        app,
        mcpSessionId,
        'resume_session',
        { sessionId: child.sessionId, fromSessionId: parent.sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('Failed to resume session');
      expect(data.error).toContain(child.sessionId);
      spy.mockRestore();
    });

    it('orphaned persisted row: error carrying SessionOrphanedError\'s message', async () => {
      const parent = await createWorktreeSession(9207, 'parent-resumer-4', 'main');
      const child = await createWorktreeSession(9208, 'child-resumee-4', 'feature', { parentSessionId: parent.sessionId });
      await sessionManager.pauseSession(child.sessionId);
      await sessionRepository.update(child.sessionId, { recoveryState: 'orphaned' });

      const response = await callTool(
        app,
        mcpSessionId,
        'resume_session',
        { sessionId: child.sessionId, fromSessionId: parent.sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('orphaned');
      expect(data.error).toContain(child.sessionId);
    });

    it('unrelated caller: error, and resumeSession not called', async () => {
      const parent = await createWorktreeSession(9209, 'parent-resumer-5', 'main');
      const child = await createWorktreeSession(9210, 'child-resumee-5', 'feature', { parentSessionId: parent.sessionId });
      await sessionManager.pauseSession(child.sessionId);
      const unrelated = await createWorktreeSession(9211, 'unrelated-caller-resume', 'other');

      const spy = spyOn(sessionManager, 'resumeSession');
      const response = await callTool(
        app,
        mcpSessionId,
        'resume_session',
        { sessionId: child.sessionId, fromSessionId: unrelated.sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('may not pause or resume');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("a designated Orchestrator of a DIFFERENT repository is refused", async () => {
      const parentA = await createWorktreeSession(9212, 'parent-repo-a', 'main', { repositoryId: TEST_REPO_ID });
      const child = await createWorktreeSession(9213, 'child-repo-a', 'feature', {
        repositoryId: TEST_REPO_ID,
        parentSessionId: parentA.sessionId,
      });
      await sessionManager.pauseSession(child.sessionId);

      const orchestratorB = await createWorktreeSession(9214, 'orchestrator-repo-b', 'main-b', {
        repositoryId: TEST_REPO_ID_2,
      });
      await callTool(app, mcpSessionId, 'set_orchestrator_session', { sessionId: orchestratorB.sessionId }, nextId++);

      const spy = spyOn(sessionManager, 'resumeSession');
      const response = await callTool(
        app,
        mcpSessionId,
        'resume_session',
        { sessionId: child.sessionId, fromSessionId: orchestratorB.sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('may not pause or resume');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("a designated Orchestrator of the target's OWN repository may resume a non-child session", async () => {
      const orchestrator = await createWorktreeSession(9215, 'orchestrator-repo-a', 'main-orch', {
        repositoryId: TEST_REPO_ID,
      });
      await callTool(app, mcpSessionId, 'set_orchestrator_session', { sessionId: orchestrator.sessionId }, nextId++);

      const unrelatedParent = await createWorktreeSession(9216, 'unrelated-parent-repo-a', 'main-parent', {
        repositoryId: TEST_REPO_ID,
      });
      const delegate = await createWorktreeSession(9217, 'delegate-repo-a', 'feature-delegate', {
        repositoryId: TEST_REPO_ID,
        parentSessionId: unrelatedParent.sessionId,
      });
      await sessionManager.pauseSession(delegate.sessionId);

      const response = await callTool(
        app,
        mcpSessionId,
        'resume_session',
        { sessionId: delegate.sessionId, fromSessionId: orchestrator.sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { changed: boolean };
      expect(data.changed).toBe(true);
    });
  });

  // ---------- M5 mutation-coverage tests: authorization before any idempotent answer ----------
  //
  // These two tests exist specifically to detect a mutation that moves the
  // authorization block (ownership + caller-exists + relationship) to AFTER
  // the isLive / already-paused idempotent-answer check (AC item A9, M5):
  // an unrelated caller must be refused even when the answer would otherwise
  // be a no-op (`changed: false`).

  describe('M5: authorization runs before the idempotent answer', () => {
    it('pause_session: an unrelated caller is refused against an ALREADY-PAUSED target (not a false changed:false)', async () => {
      const parent = await createWorktreeSession(9301, 'parent-pauser-m5', 'main');
      const child = await createWorktreeSession(9302, 'child-pausee-m5', 'feature', { parentSessionId: parent.sessionId });
      await sessionManager.pauseSession(child.sessionId);
      const unrelated = await createWorktreeSession(9303, 'unrelated-caller-m5', 'other');

      const response = await callTool(
        app,
        mcpSessionId,
        'pause_session',
        { sessionId: child.sessionId, fromSessionId: unrelated.sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('may not pause or resume');
    });

    it('resume_session: an unrelated caller is refused against an ALREADY-LIVE target (not a false changed:false)', async () => {
      const parent = await createWorktreeSession(9304, 'parent-resumer-m5', 'main');
      const child = await createWorktreeSession(9305, 'child-resumee-m5', 'feature', { parentSessionId: parent.sessionId });
      const unrelated = await createWorktreeSession(9306, 'unrelated-caller-resume-m5', 'other');

      const response = await callTool(
        app,
        mcpSessionId,
        'resume_session',
        { sessionId: child.sessionId, fromSessionId: unrelated.sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('may not pause or resume');
    });
  });

  // ---------- list_sessions: includePaused ----------

  describe('list_sessions includePaused', () => {
    it('default call: no paused session in the list, and getAllPausedSessions is NOT called', async () => {
      const parent = await createWorktreeSession(9401, 'parent-list-1', 'main');
      const child = await createWorktreeSession(9402, 'child-list-1', 'feature', { parentSessionId: parent.sessionId });
      await sessionManager.pauseSession(child.sessionId);

      const spy = spyOn(sessionManager, 'getAllPausedSessions');
      const response = await callTool(app, mcpSessionId, 'list_sessions', {}, nextId++);

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { sessions: Array<{ id: string }> };
      expect(data.sessions.map((s) => s.id)).not.toContain(child.sessionId);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('includePaused:true with zero paused sessions: unaffected', async () => {
      await createWorktreeSession(9403, 'parent-list-2', 'main');

      const response = await callTool(app, mcpSessionId, 'list_sessions', { includePaused: true }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { sessions: Array<{ id: string; paused?: boolean }> };
      expect(data.sessions.some((s) => s.paused)).toBe(false);
    });

    it('includePaused:true with one paused session: paused:true, pausedAt present, activityState unknown', async () => {
      const parent = await createWorktreeSession(9404, 'parent-list-3', 'main');
      const child = await createWorktreeSession(9405, 'child-list-3', 'feature', { parentSessionId: parent.sessionId });
      await sessionManager.pauseSession(child.sessionId);

      const response = await callTool(app, mcpSessionId, 'list_sessions', { includePaused: true }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as {
        sessions: Array<{ id: string; paused?: boolean; pausedAt?: string; workers: Array<{ activityState: string }> }>;
      };
      const pausedItem = data.sessions.find((s) => s.id === child.sessionId);
      expect(pausedItem).toBeDefined();
      expect(pausedItem!.paused).toBe(true);
      expect(pausedItem!.pausedAt).toBeTruthy();
      expect(pausedItem!.workers.every((w) => w.activityState === 'unknown')).toBe(true);
    });

    it('getAllPausedSessions throwing: the whole tool call errors (no silent live-only fallback)', async () => {
      await createWorktreeSession(9406, 'parent-list-4', 'main');
      const spy = spyOn(sessionManager, 'getAllPausedSessions').mockImplementation(async () => {
        throw new Error('boom');
      });

      const response = await callTool(app, mcpSessionId, 'list_sessions', { includePaused: true }, nextId++);

      expect(response.result?.isError).toBe(true);
      spy.mockRestore();
    });
  });

  // ---------- get_session_status ----------

  describe('get_session_status', () => {
    it('live session: paused:false', async () => {
      const { sessionId } = await createWorktreeSession(9501, 'status-live', 'main');

      const response = await callTool(app, mcpSessionId, 'get_session_status', { sessionId }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { paused: boolean; pausedAt?: string };
      expect(data.paused).toBe(false);
      expect(data.pausedAt).toBeUndefined();
    });

    it('paused session: paused:true, pausedAt present', async () => {
      const { sessionId } = await createWorktreeSession(9502, 'status-paused', 'main');
      await sessionManager.pauseSession(sessionId);

      const response = await callTool(app, mcpSessionId, 'get_session_status', { sessionId }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { paused: boolean; pausedAt?: string };
      expect(data.paused).toBe(true);
      expect(data.pausedAt).toBeTruthy();
    });

    it('unknown id: unchanged "Session not found" error', async () => {
      const response = await callTool(app, mcpSessionId, 'get_session_status', { sessionId: 'does-not-exist' }, nextId++);

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('does-not-exist');
    });
  });
});
