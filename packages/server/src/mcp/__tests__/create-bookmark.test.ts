/**
 * `create_bookmark` MCP tool tests (Issue #1390, agent registration over
 * MCP -- session bookmarks).
 *
 * Drives the REAL `createMcpApp` `create_bookmark` handler chain via
 * `callTool` (real MCP JSON-RPC transport, mirrors
 * `create-html-artifact.test.ts`'s pattern), backed by a real
 * `SqliteBookmarkRepository` against an in-memory DB.
 *
 * Unlike `create-html-artifact.test.ts`, bookmarks have no file-storage
 * component -- `AGENT_CONSOLE_HOME` points at a pure memfs path, no real
 * `os.tmpdir()` directory is needed.
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
import { JsonSessionRepository } from '../../repositories/index.js';
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

const TEST_CONFIG_DIR = '/test/config-1390-create';
const TEST_REPO_PATH = '/test/repo-1390';
const TEST_REPO_ID = 'repo-1390';

describe('create_bookmark', () => {
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

  async function mountMcpApp(authOpts?: { mcpAuthMode?: McpAuthMode; mcpTokenRegistry?: McpTokenRegistry }): Promise<void> {
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

    const sessionRepository = new JsonSessionRepository(`${process.env.AGENT_CONSOLE_HOME}/sessions.json`);
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

  async function createOwnedSession(
    osUid: number = 8001,
    username: string = 'bookmark-owner',
  ): Promise<{ sessionId: string; userId: string; workerId: string }> {
    const owner = await userRepository.upsertByOsUid(osUid, username, `/home/${username}`);
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: TEST_REPO_PATH },
      { createdBy: owner.id },
    );
    return { sessionId: session.id, userId: owner.id, workerId: session.workers[0].id };
  }

  // ---------- Attribution: session.createdBy, never getMcpCallerIdentity() ----------

  describe('attribution', () => {
    it("attributes the bookmark to the calling session's createdBy, with origin: 'agent'", async () => {
      const { sessionId, userId } = await createOwnedSession();

      const response = await callTool(
        app,
        mcpSessionId,
        'create_bookmark',
        { url: 'https://example.com', title: 'Example', sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { id: string; url: string; origin: string };
      expect(data.origin).toBe('agent');

      const stored = await bookmarkRepository.findById(data.id);
      expect(stored?.userId).toBe(userId);
      expect(stored?.origin).toBe('agent');
    });

    it('rejects with a loud error when the session has no createdBy (ownerless/legacy session)', async () => {
      const session = await sessionManager.createSession({ type: 'quick', locationPath: TEST_REPO_PATH });

      const response = await callTool(
        app,
        mcpSessionId,
        'create_bookmark',
        { url: 'https://example.com', sessionId: session.id },
        nextId++,
      );

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('has no createdBy');
      expect(data.error).toContain('ownerless');
    });

    it('rejects with a not-found error for an unknown sessionId', async () => {
      const response = await callTool(
        app,
        mcpSessionId,
        'create_bookmark',
        { url: 'https://example.com', sessionId: 'does-not-exist' },
        nextId++,
      );

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('does-not-exist');
    });
  });

  // ---------- Validation: single-writer CreateBookmarkRequestSchema ----------

  describe('validation (single-writer schema, no zod-level reimplementation)', () => {
    it('rejects a javascript: URL scheme (proves it routes through the shared valibot schema, not a zod-level check)', async () => {
      const { sessionId, userId } = await createOwnedSession();

      const response = await callTool(
        app,
        mcpSessionId,
        'create_bookmark',
        { url: 'javascript:alert(1)', sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toBeDefined();

      // No bookmark was created for the rejected scheme, for the session's actual owner.
      expect(await bookmarkRepository.findByUserId(userId)).toHaveLength(0);
    });

    it('accepts a title exactly at the 200-character cap', async () => {
      const { sessionId, userId } = await createOwnedSession();
      const title = 'a'.repeat(200);

      const response = await callTool(
        app,
        mcpSessionId,
        'create_bookmark',
        { url: 'https://example.com', title, sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBeUndefined();
      const owned = await bookmarkRepository.findByUserId(userId);
      expect(owned[0]?.title).toBe(title);
    });

    it('rejects a title one character over the 200-character cap', async () => {
      const { sessionId } = await createOwnedSession();
      const title = 'a'.repeat(201);

      const response = await callTool(
        app,
        mcpSessionId,
        'create_bookmark',
        { url: 'https://example.com', title, sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBe(true);
    });

    it('stores an omitted title as null', async () => {
      const { sessionId, userId } = await createOwnedSession();

      const response = await callTool(
        app,
        mcpSessionId,
        'create_bookmark',
        { url: 'https://example.com', sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { title: string | null };
      expect(data.title).toBeNull();

      const owned = await bookmarkRepository.findByUserId(userId);
      expect(owned[0]?.title).toBeNull();
    });
  });

  // ---------- Authorization: checkCallerOwnsSession (session-claiming tool) ----------

  describe('authorization (checkCallerOwnsSession)', () => {
    it(
      'enforce mode: a caller whose verified identity belongs to a DIFFERENT session is rejected when claiming ' +
        "another user's sessionId (impersonation), and no bookmark is created",
      async () => {
        const registry = new McpTokenRegistry();
        await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });

        const { sessionId: sessionAId, userId: userAId, workerId: workerAId } = await createOwnedSession(8003, 'bookmark-owner-a');
        const { sessionId: sessionBId, userId: userBId } = await createOwnedSession(8004, 'bookmark-owner-b');
        expect(userAId).not.toBe(userBId);

        const token = registry.mint({ sessionId: sessionAId, workerId: workerAId, userId: userAId });

        const response = await callTool(
          app,
          mcpSessionId,
          'create_bookmark',
          { url: 'https://example.com', sessionId: sessionBId },
          nextId++,
          { Authorization: `Bearer ${token}` },
        );

        expect(response.result?.isError).toBe(true);
        const data = parseToolResult(response) as { error: string };
        expect(data.error).toContain('identity mismatch');
        expect(data.error).toContain(sessionBId);

        expect(await bookmarkRepository.findByUserId(userAId)).toHaveLength(0);
        expect(await bookmarkRepository.findByUserId(userBId)).toHaveLength(0);
      },
    );

    it('enforce mode: a caller claiming their OWN session succeeds', async () => {
      const registry = new McpTokenRegistry();
      await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });

      const { sessionId, userId, workerId } = await createOwnedSession(8005, 'bookmark-owner-c');
      const token = registry.mint({ sessionId, workerId, userId });

      const response = await callTool(
        app,
        mcpSessionId,
        'create_bookmark',
        { url: 'https://example.com', sessionId },
        nextId++,
        { Authorization: `Bearer ${token}` },
      );

      expect(response.result?.isError).toBeUndefined();
      const owned = await bookmarkRepository.findByUserId(userId);
      expect(owned).toHaveLength(1);
    });
  });
});
