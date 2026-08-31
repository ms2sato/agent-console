/**
 * `delete_html_artifact` MCP tool tests (Issue #1371).
 *
 * Drives the REAL `createMcpApp` `delete_html_artifact` handler chain via
 * `callTool` (real MCP JSON-RPC transport), backed by a real
 * `SqliteArtifactRepository` against an in-memory DB. Mirrors
 * `create-html-artifact.test.ts`'s harness setup (see that file's header
 * for why `AGENT_CONSOLE_HOME` points at a REAL directory under
 * `os.tmpdir()`, not a memfs-only path).
 *
 * The REST route (`DELETE /api/artifacts/:id`) already covers owner-only
 * deletion at its own layer; this file protects the SEPARATE MCP tool code
 * path, which resolves ownership via `session.createdBy` rather than an
 * `authUser`.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { readArtifactFile } from '../../lib/artifact-storage.js';
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
import type { ArtifactRepository } from '../../repositories/artifact-repository.js';
import type { AppServerMessage } from '@agent-console/shared';

const TEST_CONFIG_DIR_PREFIX = 'agent-console-delete-html-artifact-test-';
const TEST_REPO_PATH = '/test/repo-1371';
const TEST_REPO_ID = 'repo-1371';

describe('delete_html_artifact', () => {
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
  const originalAgentConsoleHome = process.env.AGENT_CONSOLE_HOME;
  /** Real (non-memfs) directory; see create-html-artifact.test.ts's file header for why. */
  let testConfigDir: string | undefined;

  async function mountMcpApp(authOpts?: {
    mcpAuthMode?: McpAuthMode;
    mcpTokenRegistry?: McpTokenRegistry;
    broadcastToApp?: (msg: AppServerMessage) => void;
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
      broadcastToApp: authOpts?.broadcastToApp ?? (() => {}),
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
    testConfigDir = path.join(os.tmpdir(), `${TEST_CONFIG_DIR_PREFIX}${randomUUID()}`);
    setupMemfs({
      [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
    });
    process.env.AGENT_CONSOLE_HOME = testConfigDir;

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
    if (testConfigDir) {
      Bun.spawnSync(['rm', '-rf', testConfigDir]);
      testConfigDir = undefined;
    }
    if (originalAgentConsoleHome !== undefined) {
      process.env.AGENT_CONSOLE_HOME = originalAgentConsoleHome;
    } else {
      delete process.env.AGENT_CONSOLE_HOME;
    }
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

  async function createArtifactViaTool(sessionId: string, content = '<html><body>to be deleted</body></html>'): Promise<string> {
    const response = await callTool(app, mcpSessionId, 'create_html_artifact', { content, sessionId }, nextId++);
    expect(response.result?.isError).toBeUndefined();
    const data = parseToolResult(response) as { artifactId: string };
    return data.artifactId;
  }

  // ---------- (a) happy path: owner deletes their own artifact ----------

  it('deletes an artifact owned by the calling session, removing both the DB row and the backing file', async () => {
    const { sessionId } = await createOwnedSession(7001, 'artifact-deleter');
    const artifactId = await createArtifactViaTool(sessionId);

    // Confirm the artifact exists before deletion (both DB row and file).
    const beforeRecord = await artifactRepository.findById(artifactId);
    expect(beforeRecord).not.toBeNull();

    const response = await callTool(app, mcpSessionId, 'delete_html_artifact', { artifactId, sessionId }, nextId++);

    expect(response.result?.isError).toBeUndefined();
    const data = parseToolResult(response) as { deleted: boolean; artifactId: string };
    expect(data.deleted).toBe(true);
    expect(data.artifactId).toBe(artifactId);

    // DB row is gone.
    expect(await artifactRepository.findById(artifactId)).toBeNull();

    // Backing file is gone too: readArtifactFile is the same production
    // helper artifact-storage.ts uses to serve artifacts, so this exercises
    // the real on-disk layout rather than re-deriving the path scheme.
    expect(await readArtifactFile(beforeRecord!.userId, artifactId)).toBeNull();
  });

  // ---------- (b) cross-owner rejection (the polarity case) ----------

  it(
    'rejects deletion when the calling session is owned by a DIFFERENT user than the artifact owner, ' +
      'and the artifact survives untouched',
    async () => {
      const { sessionId: sessionAId } = await createOwnedSession(7002, 'artifact-owner-a');
      const { sessionId: sessionBId } = await createOwnedSession(7003, 'artifact-owner-b');

      // Artifact created via session B (owned by user B).
      const artifactId = await createArtifactViaTool(sessionBId, '<html><body>owned by B</body></html>');

      // Caller claims session A (owned by user A) and attempts to delete
      // user B's artifact.
      const response = await callTool(
        app,
        mcpSessionId,
        'delete_html_artifact',
        { artifactId, sessionId: sessionAId },
        nextId++,
      );

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('do not own');
      expect(data.error).toContain(artifactId);

      // The artifact still exists afterward -- no deletion occurred.
      const stillThere = await artifactRepository.findById(artifactId);
      expect(stillThere).not.toBeNull();
      expect(stillThere?.id).toBe(artifactId);
    },
  );

  // ---------- (c) unknown artifactId ----------

  it('rejects with a not-found error for an unknown artifactId, without any session-ownership false-success', async () => {
    const { sessionId } = await createOwnedSession(7004, 'artifact-owner-c');

    const response = await callTool(
      app,
      mcpSessionId,
      'delete_html_artifact',
      { artifactId: 'does-not-exist', sessionId },
      nextId++,
    );

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error).toContain('does-not-exist');
    expect(data.error.toLowerCase()).toContain('not found');
  });

  // ---------- (d) ownerless/legacy session ----------

  it('rejects with a loud error when the calling session has no createdBy (ownerless/legacy session)', async () => {
    const { sessionId: ownerSessionId } = await createOwnedSession(7005, 'artifact-owner-d');
    const artifactId = await createArtifactViaTool(ownerSessionId);

    const ownerlessSession = await sessionManager.createSession({ type: 'quick', locationPath: TEST_REPO_PATH });

    const response = await callTool(
      app,
      mcpSessionId,
      'delete_html_artifact',
      { artifactId, sessionId: ownerlessSession.id },
      nextId++,
    );

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error).toContain('has no createdBy');
    expect(data.error).toContain('ownerless');

    // No deletion occurred: the artifact survives.
    expect(await artifactRepository.findById(artifactId)).not.toBeNull();
  });

  // ---------- Authorization: checkCallerOwnsSession (session-claiming, seventh tool) ----------

  describe('authorization (checkCallerOwnsSession)', () => {
    it(
      'enforce mode: a caller whose verified identity belongs to a DIFFERENT session is rejected when claiming ' +
        "another user's sessionId (impersonation), and the artifact is not deleted",
      async () => {
        // Session A: the caller's OWN session/identity, minted into the bearer token.
        const { sessionId: sessionAId, userId: userAId, workerId: workerAId } = await createOwnedSession(7006, 'artifact-owner-e');
        // Session B: a DIFFERENT user's session -- the impersonation target, and also the artifact owner.
        const { sessionId: sessionBId } = await createOwnedSession(7007, 'artifact-owner-f');
        // Create the artifact under the default (off/warn) mount, BEFORE
        // switching the mount to enforce mode below -- the tool itself
        // requires a verified bearer token once enforce is active.
        const artifactId = await createArtifactViaTool(sessionBId, '<html><body>owned by f</body></html>');

        const registry = new McpTokenRegistry();
        await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });
        const token = registry.mint({ sessionId: sessionAId, workerId: workerAId, userId: userAId });

        const response = await callTool(
          app,
          mcpSessionId,
          'delete_html_artifact',
          { artifactId, sessionId: sessionBId },
          nextId++,
          { Authorization: `Bearer ${token}` },
        );

        expect(response.result?.isError).toBe(true);
        const data = parseToolResult(response) as { error: string };
        expect(data.error).toContain('identity mismatch');
        expect(data.error).toContain(sessionBId);

        // The authz gate ran BEFORE the artifact-ownership comparison and
        // the delete call: the artifact survives.
        expect(await artifactRepository.findById(artifactId)).not.toBeNull();
      },
    );

    it('enforce mode: a caller claiming their OWN session, deleting their OWN artifact, succeeds', async () => {
      const { sessionId, userId, workerId } = await createOwnedSession(7008, 'artifact-owner-g');
      // Create the artifact under the default (off/warn) mount, before
      // switching to enforce mode below.
      const artifactId = await createArtifactViaTool(sessionId);

      const registry = new McpTokenRegistry();
      await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });
      const token = registry.mint({ sessionId, workerId, userId });

      const response = await callTool(
        app,
        mcpSessionId,
        'delete_html_artifact',
        { artifactId, sessionId },
        nextId++,
        { Authorization: `Bearer ${token}` },
      );

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { deleted: boolean };
      expect(data.deleted).toBe(true);
      expect(await artifactRepository.findById(artifactId)).toBeNull();
    });
  });

  // ---------- Broadcast (realtime refresh trigger, Issue #1520) ----------

  describe('broadcast (realtime refresh trigger, Issue #1520)', () => {
    it('emits exactly one artifact-deleted trigger with the ruled payload shape after a successful delete', async () => {
      const mockBroadcastToApp = mock(() => {});
      await mountMcpApp({ mcpAuthMode: 'off', broadcastToApp: mockBroadcastToApp });
      const { sessionId } = await createOwnedSession(7009, 'artifact-owner-broadcast');
      const artifactId = await createArtifactViaTool(sessionId);
      mockBroadcastToApp.mockClear();

      const response = await callTool(app, mcpSessionId, 'delete_html_artifact', { artifactId, sessionId }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      expect(mockBroadcastToApp).toHaveBeenCalledTimes(1);
      expect(mockBroadcastToApp).toHaveBeenCalledWith({ type: 'artifact-deleted', sessionId, artifactId });
    });

    it(
      'cross-session delete: the trigger names the OWNING session (where the artifact was created), ' +
        'never the deleting call\'s own session -- this repo\'s own orchestrator-cleans-up-delegate-session ' +
        'pattern, not a rare edge case',
      async () => {
        const mockBroadcastToApp = mock(() => {});
        await mountMcpApp({ mcpAuthMode: 'off', broadcastToApp: mockBroadcastToApp });

        // One user, two sessions: sessionY creates the artifact (the owning
        // session), sessionX deletes it (a different session, same user --
        // ownership is per-user, not per-session, so this is legitimate).
        const owner = await userRepository.upsertByOsUid(7011, 'artifact-owner-cross-session', '/home/artifact-owner-cross-session');
        const sessionY = await sessionManager.createSession({ type: 'quick', locationPath: TEST_REPO_PATH }, { createdBy: owner.id });
        const sessionX = await sessionManager.createSession({ type: 'quick', locationPath: TEST_REPO_PATH }, { createdBy: owner.id });

        const artifactId = await createArtifactViaTool(sessionY.id);
        mockBroadcastToApp.mockClear();

        const response = await callTool(app, mcpSessionId, 'delete_html_artifact', { artifactId, sessionId: sessionX.id }, nextId++);

        expect(response.result?.isError).toBeUndefined();
        expect(mockBroadcastToApp).toHaveBeenCalledTimes(1);
        // The pin: sessionId is Y (owning/creating), NOT X (deleting).
        expect(mockBroadcastToApp).toHaveBeenCalledWith({ type: 'artifact-deleted', sessionId: sessionY.id, artifactId });
      },
    );

    it('emits no trigger when the repository write fails (negative half)', async () => {
      // Create the artifact via the normally-mounted app first (ownership
      // check must pass), THEN mount a second app instance whose `delete`
      // throws, targeting the real id -- exercising
      // "ownership-check-passes-then-write-fails" faithfully.
      const { sessionId } = await createOwnedSession(7010, 'artifact-owner-broadcast-fail');
      const artifactId = await createArtifactViaTool(sessionId);

      const mockBroadcastToApp = mock(() => {});
      // Bound wrappers, not `{ ...artifactRepository, delete: ... }`: the
      // real repository's methods live on the class prototype, so an
      // object spread would copy only own instance fields and silently
      // drop every other method this test needs (findById).
      const throwingArtifactRepository: ArtifactRepository = {
        create: artifactRepository.create.bind(artifactRepository),
        findById: artifactRepository.findById.bind(artifactRepository),
        findByUserId: artifactRepository.findByUserId.bind(artifactRepository),
        findByUserIdAndSourceSessionId: artifactRepository.findByUserIdAndSourceSessionId.bind(artifactRepository),
        delete: async () => {
          throw new Error('simulated disk failure');
        },
      };
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
        artifactRepository: throwingArtifactRepository,
        bookmarkRepository,
        broadcastToApp: mockBroadcastToApp,
        findOpenPullRequest: async () => null,
        fetchPullRequestUrl: async () => null,
      });
      const failApp = new Hono();
      failApp.route('', mcpApp);
      const failMcpSessionId = await initializeMcp(failApp);

      const response = await callTool(failApp, failMcpSessionId, 'delete_html_artifact', { artifactId, sessionId }, nextId++);

      expect(response.result?.isError).toBe(true);
      expect(mockBroadcastToApp).not.toHaveBeenCalled();
    });
  });
});
