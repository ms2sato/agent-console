/**
 * `delete_bookmark` MCP tool tests (Issue #1390, agent registration over
 * MCP -- session bookmarks).
 *
 * Drives the REAL `createMcpApp` `delete_bookmark` handler chain via
 * `callTool` (real MCP JSON-RPC transport), backed by a real
 * `SqliteBookmarkRepository` against an in-memory DB. Mirrors
 * `delete-html-artifact.test.ts`'s harness setup.
 *
 * The REST route (`DELETE /api/bookmarks/:id`) already covers owner-only
 * deletion at its own layer; this file protects the SEPARATE MCP tool code
 * path, which resolves ownership via `session.createdBy` rather than an
 * `authUser`.
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

const TEST_CONFIG_DIR = '/test/config-1390-delete';
const TEST_REPO_PATH = '/test/repo-1390-delete';
const TEST_REPO_ID = 'repo-1390-delete';

describe('delete_bookmark', () => {
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

    await mountMcpApp({ mcpAuthMode: 'off' });
    nextId = 10;
  });

  afterEach(async () => {
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
    delete process.env.AGENT_CONSOLE_HOME;
  });

  async function createOwnedSession(
    osUid: number,
    username: string,
  ): Promise<{ sessionId: string; userId: string; workerId: string }> {
    const owner = await userRepository.upsertByOsUid(osUid, username, `/home/${username}`);
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: TEST_REPO_PATH },
      { createdBy: owner.id },
    );
    return { sessionId: session.id, userId: owner.id, workerId: session.workers[0].id };
  }

  async function createBookmarkViaTool(sessionId: string, url = 'https://example.com/to-be-deleted'): Promise<string> {
    const response = await callTool(app, mcpSessionId, 'create_bookmark', { url, sessionId }, nextId++);
    expect(response.result?.isError).toBeUndefined();
    const data = parseToolResult(response) as { id: string };
    return data.id;
  }

  // ---------- (a) happy path: owner deletes their own bookmark ----------

  it('deletes a bookmark owned by the calling session', async () => {
    const { sessionId } = await createOwnedSession(9001, 'bookmark-deleter');
    const bookmarkId = await createBookmarkViaTool(sessionId);

    expect(await bookmarkRepository.findById(bookmarkId)).not.toBeNull();

    const response = await callTool(app, mcpSessionId, 'delete_bookmark', { bookmarkId, sessionId }, nextId++);

    expect(response.result?.isError).toBeUndefined();
    const data = parseToolResult(response) as { deleted: boolean; bookmarkId: string };
    expect(data.deleted).toBe(true);
    expect(data.bookmarkId).toBe(bookmarkId);

    expect(await bookmarkRepository.findById(bookmarkId)).toBeNull();
  });

  // ---------- (b) cross-owner rejection (the polarity case) ----------

  it(
    'rejects deletion when the calling session is owned by a DIFFERENT user than the bookmark owner, ' +
      'and the bookmark survives untouched',
    async () => {
      const { sessionId: sessionAId } = await createOwnedSession(9002, 'bookmark-owner-a');
      const { sessionId: sessionBId } = await createOwnedSession(9003, 'bookmark-owner-b');

      const bookmarkId = await createBookmarkViaTool(sessionBId, 'https://example.com/owned-by-b');

      const response = await callTool(
        app,
        mcpSessionId,
        'delete_bookmark',
        { bookmarkId, sessionId: sessionAId },
        nextId++,
      );

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('do not own');
      expect(data.error).toContain(bookmarkId);

      const stillThere = await bookmarkRepository.findById(bookmarkId);
      expect(stillThere).not.toBeNull();
      expect(stillThere?.id).toBe(bookmarkId);
    },
  );

  // ---------- (c) unknown bookmarkId ----------

  it('rejects with a not-found error for an unknown bookmarkId, without any false-success', async () => {
    const { sessionId } = await createOwnedSession(9004, 'bookmark-owner-c');

    const response = await callTool(
      app,
      mcpSessionId,
      'delete_bookmark',
      { bookmarkId: 'does-not-exist', sessionId },
      nextId++,
    );

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error).toContain('does-not-exist');
    expect(data.error.toLowerCase()).toContain('not found');
  });

  // ---------- (d) ownerless/legacy session ----------

  it('rejects with a loud error when the calling session has no createdBy (ownerless/legacy session)', async () => {
    const { sessionId: ownerSessionId } = await createOwnedSession(9005, 'bookmark-owner-d');
    const bookmarkId = await createBookmarkViaTool(ownerSessionId);

    const ownerlessSession = await sessionManager.createSession({ type: 'quick', locationPath: TEST_REPO_PATH });

    const response = await callTool(
      app,
      mcpSessionId,
      'delete_bookmark',
      { bookmarkId, sessionId: ownerlessSession.id },
      nextId++,
    );

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error).toContain('has no createdBy');
    expect(data.error).toContain('ownerless');

    expect(await bookmarkRepository.findById(bookmarkId)).not.toBeNull();
  });

  // ---------- (e) idempotent-not-found on a delete-mid-race ----------

  it('is idempotent-not-found (not a throw) when the same bookmark is deleted twice in a row', async () => {
    const { sessionId } = await createOwnedSession(9006, 'bookmark-owner-e');
    const bookmarkId = await createBookmarkViaTool(sessionId);

    const first = await callTool(app, mcpSessionId, 'delete_bookmark', { bookmarkId, sessionId }, nextId++);
    expect(first.result?.isError).toBeUndefined();
    expect((parseToolResult(first) as { deleted: boolean }).deleted).toBe(true);

    const second = await callTool(app, mcpSessionId, 'delete_bookmark', { bookmarkId, sessionId }, nextId++);
    expect(second.result?.isError).toBe(true);
    const data = parseToolResult(second) as { error: string };
    expect(data.error).toContain(bookmarkId);
    expect(data.error.toLowerCase()).toContain('not found');
  });

  // ---------- Authorization: checkCallerOwnsSession (session-claiming tool) ----------

  describe('authorization (checkCallerOwnsSession)', () => {
    it(
      'enforce mode: a caller whose verified identity belongs to a DIFFERENT session is rejected when claiming ' +
        "another user's sessionId (impersonation), and the bookmark is not deleted",
      async () => {
        const { sessionId: sessionAId, userId: userAId, workerId: workerAId } = await createOwnedSession(9007, 'bookmark-owner-f');
        const { sessionId: sessionBId } = await createOwnedSession(9008, 'bookmark-owner-g');
        const bookmarkId = await createBookmarkViaTool(sessionBId, 'https://example.com/owned-by-g');

        const registry = new McpTokenRegistry();
        await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });
        const token = registry.mint({ sessionId: sessionAId, workerId: workerAId, userId: userAId });

        const response = await callTool(
          app,
          mcpSessionId,
          'delete_bookmark',
          { bookmarkId, sessionId: sessionBId },
          nextId++,
          { Authorization: `Bearer ${token}` },
        );

        expect(response.result?.isError).toBe(true);
        const data = parseToolResult(response) as { error: string };
        expect(data.error).toContain('identity mismatch');
        expect(data.error).toContain(sessionBId);

        expect(await bookmarkRepository.findById(bookmarkId)).not.toBeNull();
      },
    );

    it('enforce mode: a caller claiming their OWN session, deleting their OWN bookmark, succeeds', async () => {
      const { sessionId, userId, workerId } = await createOwnedSession(9009, 'bookmark-owner-h');
      const bookmarkId = await createBookmarkViaTool(sessionId);

      const registry = new McpTokenRegistry();
      await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });
      const token = registry.mint({ sessionId, workerId, userId });

      const response = await callTool(
        app,
        mcpSessionId,
        'delete_bookmark',
        { bookmarkId, sessionId },
        nextId++,
        { Authorization: `Bearer ${token}` },
      );

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { deleted: boolean };
      expect(data.deleted).toBe(true);
      expect(await bookmarkRepository.findById(bookmarkId)).toBeNull();
    });
  });
});
