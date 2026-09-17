/**
 * `set_orchestrator_session` / `clear_orchestrator_session` MCP tool tests
 * (labeled-Issue webhook routing to a designated Orchestrator session).
 *
 * Drives the REAL `createMcpApp` handler chain via `callTool` (real MCP
 * JSON-RPC transport, mirrors `create-bookmark.test.ts`'s pattern), backed
 * by a real `SqliteRepositoryRepository` against an in-memory DB. Memfs-based
 * (like `create-bookmark.test.ts`, unlike `create-html-artifact.test.ts`) --
 * these tools have no file-storage component.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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
import { McpTokenRegistry } from '../mcp-auth.js';
import { AgentDirectory } from '../../services/agent-directory.js';
import { createWorktreeWithSession } from '../../services/worktree-creation-service.js';
import { deleteWorktree } from '../../services/worktree-deletion-service.js';
import { initializeMcp, callTool, parseToolResult } from './mcp-protocol-test-helpers.js';

const TEST_CONFIG_DIR = '/test/config-1643-orchestrator-designation';
const TEST_REPO_PATH = '/test/repo-1643';
const TEST_REPO_ID = 'repo-1643';

describe('set_orchestrator_session / clear_orchestrator_session', () => {
  const ptyFactory = createMockPtyFactory();
  let app: Hono;
  let sessionManager: SessionManager;
  let repositoryManager: RepositoryManager;
  let agentManager: AgentManager;
  let userRepository: SqliteUserRepository;
  let artifactRepository: SqliteArtifactRepository;
  let bookmarkRepository: SqliteBookmarkRepository;
  let testJobQueue: JobQueue;
  let mcpSessionId: string;
  let nextId: number;
  let worktreeService: WorktreeService;
  let agentDirectory: AgentDirectory;

  async function mountMcpApp(): Promise<void> {
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
    });
    app = new Hono();
    app.route('', mcpApp);
    mcpSessionId = await initializeMcp(app);
  }

  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({
      [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
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

    // Unlike sibling MCP test harnesses (e.g. create-bookmark.test.ts), this
    // suite needs sessions that actually exist in the SQL `sessions` table:
    // `repository_orchestrator_sessions.session_id` is a real FK to
    // `sessions.id` (migration v41). `JsonSessionRepository` (used
    // elsewhere in this test family) only persists to a JSON file, never
    // populating that table -- matches production's own wiring in
    // app-context.ts, which uses SqliteSessionRepository, not the JSON
    // fallback.
    const sessionRepository = new SqliteSessionRepository(db);
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
      repositoryLookup: { getRepositorySlug: async (id: string) => repositoryManager?.getRepositorySlug(id) },
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
      name: 'test-repo',
      path: TEST_REPO_PATH,
      createdAt: new Date().toISOString(),
      orchestratorSessionIds: [],
      clonedSourceRepoPath: null,
    });
    repositoryManager = await RepositoryManager.create({ repository: sqliteRepoRepo, jobQueue: testJobQueue });

    worktreeService = new WorktreeService({ db });
    agentDirectory = new AgentDirectory({ terminal: agentManager, embedded: embeddedAgentManager });

    await mountMcpApp();
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
  ): Promise<{ sessionId: string; userId: string }> {
    const owner = await userRepository.upsertByOsUid(osUid, username, `/home/${username}`);
    const session = await sessionManager.createSession(
      {
        type: 'worktree',
        locationPath: TEST_REPO_PATH,
        repositoryId: TEST_REPO_ID,
        worktreeId,
      },
      { createdBy: owner.id },
    );
    return { sessionId: session.id, userId: owner.id };
  }

  async function createQuickSession(osUid: number, username: string): Promise<{ sessionId: string }> {
    const owner = await userRepository.upsertByOsUid(osUid, username, `/home/${username}`);
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: TEST_REPO_PATH },
      { createdBy: owner.id },
    );
    return { sessionId: session.id };
  }

  describe('happy path: add, add-second, remove-one, remove-last (Issue #1716)', () => {
    it('adds two sessions to the set, then removes one, then removes the other', async () => {
      const { sessionId: sessionA } = await createWorktreeSession(9001, 'orchestrator-a', 'main');
      const { sessionId: sessionB } = await createWorktreeSession(9002, 'orchestrator-b', 'feature');

      const addAResponse = await callTool(app, mcpSessionId, 'set_orchestrator_session', { sessionId: sessionA }, nextId++);
      expect(addAResponse.result?.isError).toBeUndefined();
      let data = parseToolResult(addAResponse) as { repositoryId: string; orchestratorSessionIds: string[] };
      expect(data.repositoryId).toBe(TEST_REPO_ID);
      expect(data.orchestratorSessionIds).toEqual([sessionA]);
      expect(repositoryManager.getRepository(TEST_REPO_ID)?.orchestratorSessionIds).toEqual([sessionA]);

      const addBResponse = await callTool(app, mcpSessionId, 'set_orchestrator_session', { sessionId: sessionB }, nextId++);
      expect(addBResponse.result?.isError).toBeUndefined();
      data = parseToolResult(addBResponse) as { repositoryId: string; orchestratorSessionIds: string[] };
      // Adding B does not move or remove A -- both are designated at once.
      // Set membership only, not array order: two real consecutive calls
      // can legitimately land the same millisecond `created_at`, at which
      // point the ordering tiebreak is session_id (a random UUID) --
      // exact-order semantics are pinned precisely elsewhere, with
      // explicit distinct `created_at` values
      // (`sqlite-repository-repository.test.ts`).
      expect(new Set(data.orchestratorSessionIds)).toEqual(new Set([sessionA, sessionB]));
      expect(new Set(repositoryManager.getRepository(TEST_REPO_ID)?.orchestratorSessionIds)).toEqual(new Set([sessionA, sessionB]));

      const removeAResponse = await callTool(app, mcpSessionId, 'clear_orchestrator_session', { sessionId: sessionA }, nextId++);
      expect(removeAResponse.result?.isError).toBeUndefined();
      const removeAData = parseToolResult(removeAResponse) as { repositoryId: string; removed: boolean; orchestratorSessionIds: string[] };
      expect(removeAData.removed).toBe(true);
      expect(removeAData.orchestratorSessionIds).toEqual([sessionB]);
      expect(repositoryManager.getRepository(TEST_REPO_ID)?.orchestratorSessionIds).toEqual([sessionB]);

      const removeBResponse = await callTool(app, mcpSessionId, 'clear_orchestrator_session', { sessionId: sessionB }, nextId++);
      expect(removeBResponse.result?.isError).toBeUndefined();
      const removeBData = parseToolResult(removeBResponse) as { repositoryId: string; removed: boolean; orchestratorSessionIds: string[] };
      expect(removeBData.removed).toBe(true);
      expect(removeBData.orchestratorSessionIds).toEqual([]);
      expect(repositoryManager.getRepository(TEST_REPO_ID)?.orchestratorSessionIds).toEqual([]);
    });

    it('add is idempotent: adding the same session twice returns the same one-element set', async () => {
      const { sessionId } = await createWorktreeSession(9007, 'orchestrator-idempotent-add', 'main');

      await callTool(app, mcpSessionId, 'set_orchestrator_session', { sessionId }, nextId++);
      const secondResponse = await callTool(app, mcpSessionId, 'set_orchestrator_session', { sessionId }, nextId++);

      expect(secondResponse.result?.isError).toBeUndefined();
      const data = parseToolResult(secondResponse) as { orchestratorSessionIds: string[] };
      expect(data.orchestratorSessionIds).toEqual([sessionId]);
    });

    it('clear is idempotent: clearing a session that is not designated reports removed:false', async () => {
      const { sessionId: sessionA } = await createWorktreeSession(9008, 'orchestrator-idempotent-clear-a', 'main');
      const { sessionId: sessionB } = await createWorktreeSession(9009, 'orchestrator-idempotent-clear-b', 'feature');
      await callTool(app, mcpSessionId, 'set_orchestrator_session', { sessionId: sessionA }, nextId++);

      const response = await callTool(app, mcpSessionId, 'clear_orchestrator_session', { sessionId: sessionB }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { removed: boolean; orchestratorSessionIds: string[] };
      expect(data.removed).toBe(false);
      expect(data.orchestratorSessionIds).toEqual([sessionA]);
    });
  });

  describe('no-repository rejection', () => {
    it('rejects set_orchestrator_session from a quick session (no repositoryId)', async () => {
      const { sessionId } = await createQuickSession(9003, 'quick-user');

      const response = await callTool(app, mcpSessionId, 'set_orchestrator_session', { sessionId }, nextId++);

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('has no repository');
    });

    it('rejects clear_orchestrator_session from a quick session (no repositoryId)', async () => {
      const { sessionId } = await createQuickSession(9004, 'quick-user-2');

      const response = await callTool(app, mcpSessionId, 'clear_orchestrator_session', { sessionId }, nextId++);

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('has no repository');
    });

    it('rejects with a not-found error for an unknown sessionId', async () => {
      const response = await callTool(app, mcpSessionId, 'set_orchestrator_session', { sessionId: 'does-not-exist' }, nextId++);

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('does-not-exist');
    });
  });

  describe('no holder check: a second session designating itself never supersedes the first', () => {
    it("B's add does not clobber A's designation -- A remains genuinely removable (removed: true), not stale", async () => {
      const { sessionId: sessionA } = await createWorktreeSession(9005, 'orchestrator-a-stale', 'main');
      const { sessionId: sessionB } = await createWorktreeSession(9006, 'orchestrator-b-stale', 'feature');

      await callTool(app, mcpSessionId, 'set_orchestrator_session', { sessionId: sessionA }, nextId++);
      // Unlike the pre-#1716 single-session pointer, B's add does NOT move
      // the flag away from A -- both are designated at once.
      await callTool(app, mcpSessionId, 'set_orchestrator_session', { sessionId: sessionB }, nextId++);
      // Set membership, not array order -- see the sibling test's comment
      // on why two real consecutive calls can share a `created_at` tick.
      expect(new Set(repositoryManager.getRepository(TEST_REPO_ID)?.orchestratorSessionIds)).toEqual(new Set([sessionA, sessionB]));

      // A's clear is a genuine removal (removed: true), not a no-op --
      // there is no "stale" state under the set model, since nobody's
      // designation is silently moved by someone else's add.
      const response = await callTool(app, mcpSessionId, 'clear_orchestrator_session', { sessionId: sessionA }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { removed: boolean; orchestratorSessionIds: string[] };
      expect(data.removed).toBe(true);
      expect(data.orchestratorSessionIds).toEqual([sessionB]);
      expect(repositoryManager.getRepository(TEST_REPO_ID)?.orchestratorSessionIds).toEqual([sessionB]);
    });
  });
});
