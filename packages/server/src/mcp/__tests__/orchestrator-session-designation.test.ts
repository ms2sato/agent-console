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
    // `orchestrator_session_id` is a real FK to `sessions.id` (migration
    // v40). `JsonSessionRepository` (used elsewhere in this test family)
    // only persists to a JSON file, never populating that table -- matches
    // production's own wiring in app-context.ts, which uses
    // SqliteSessionRepository, not the JSON fallback.
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

  describe('happy path: set, move, clear', () => {
    it('sets, moves to a different session, then clears the designation', async () => {
      const { sessionId: sessionA } = await createWorktreeSession(9001, 'orchestrator-a', 'main');
      const { sessionId: sessionB } = await createWorktreeSession(9002, 'orchestrator-b', 'feature');

      const setResponse = await callTool(app, mcpSessionId, 'set_orchestrator_session', { sessionId: sessionA }, nextId++);
      expect(setResponse.result?.isError).toBeUndefined();
      let data = parseToolResult(setResponse) as { repositoryId: string; orchestratorSessionId: string };
      expect(data.repositoryId).toBe(TEST_REPO_ID);
      expect(data.orchestratorSessionId).toBe(sessionA);
      expect(repositoryManager.getRepository(TEST_REPO_ID)?.orchestratorSessionId).toBe(sessionA);

      const moveResponse = await callTool(app, mcpSessionId, 'set_orchestrator_session', { sessionId: sessionB }, nextId++);
      expect(moveResponse.result?.isError).toBeUndefined();
      data = parseToolResult(moveResponse) as { repositoryId: string; orchestratorSessionId: string };
      expect(data.orchestratorSessionId).toBe(sessionB);
      expect(repositoryManager.getRepository(TEST_REPO_ID)?.orchestratorSessionId).toBe(sessionB);

      const clearResponse = await callTool(app, mcpSessionId, 'clear_orchestrator_session', { sessionId: sessionB }, nextId++);
      expect(clearResponse.result?.isError).toBeUndefined();
      const clearData = parseToolResult(clearResponse) as { repositoryId: string; cleared: boolean };
      expect(clearData.cleared).toBe(true);
      expect(repositoryManager.getRepository(TEST_REPO_ID)?.orchestratorSessionId).toBeNull();
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

  describe('stale-clear no-op', () => {
    it('a stale clear from a superseded session is a no-op, distinguishable in the response', async () => {
      const { sessionId: sessionA } = await createWorktreeSession(9005, 'orchestrator-a-stale', 'main');
      const { sessionId: sessionB } = await createWorktreeSession(9006, 'orchestrator-b-stale', 'feature');

      await callTool(app, mcpSessionId, 'set_orchestrator_session', { sessionId: sessionA }, nextId++);
      // B takes over.
      await callTool(app, mcpSessionId, 'set_orchestrator_session', { sessionId: sessionB }, nextId++);

      // A's stale clear must not clobber B's designation.
      const response = await callTool(app, mcpSessionId, 'clear_orchestrator_session', { sessionId: sessionA }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { cleared: boolean };
      expect(data.cleared).toBe(false);
      expect(repositoryManager.getRepository(TEST_REPO_ID)?.orchestratorSessionId).toBe(sessionB);
    });
  });
});
