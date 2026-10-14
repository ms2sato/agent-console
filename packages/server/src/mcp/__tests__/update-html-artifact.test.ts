/**
 * `update_html_artifact` MCP tool tests (in-place artifact update,
 * docs/design/html-artifacts.md section 5.4).
 *
 * Drives the REAL `createMcpApp` `update_html_artifact` handler chain via
 * `callTool` (real MCP JSON-RPC transport), backed by a real
 * `SqliteArtifactRepository` against an in-memory DB. Mirrors
 * `create-html-artifact.test.ts`'s harness setup (see that file's header
 * for why `AGENT_CONSOLE_HOME` points at a REAL directory under
 * `os.tmpdir()`, not a memfs-only path).
 *
 * Ownership is resolved via `session.createdBy` (the same chain as
 * `delete_html_artifact`), never from the MCP caller identity.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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
import type { AppServerMessage } from '@agent-console/shared';
import { repositoryLookupFromSlug } from '../../__tests__/utils/repository-lookup-mock.js';

const TEST_CONFIG_DIR_PREFIX = 'agent-console-update-html-artifact-test-';
const TEST_REPO_PATH = '/test/repo-2076';
const TEST_REPO_ID = 'repo-2076';

describe('update_html_artifact', () => {
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
      // The data root must exist before any session-data writer runs: the
      // trusted-root walker verifies it and never creates it (production
      // creates it at boot; session-data-path.md section 2). It is created
      // in the memfs volume, which is what `fs/promises` resolves to here.
      [testConfigDir]: null,
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
      name: 'test-repo',
      path: TEST_REPO_PATH,
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
    return { sessionId: session.id, userId: owner.id, workerId: session.workers.find((w) => w.type === 'agent')!.id };
  }

  async function createArtifactViaTool(sessionId: string, content = '<html><head><title>Original</title></head><body>v1</body></html>'): Promise<string> {
    const response = await callTool(app, mcpSessionId, 'create_html_artifact', { content, sessionId }, nextId++);
    expect(response.result?.isError).toBeUndefined();
    const data = parseToolResult(response) as { artifactId: string };
    return data.artifactId;
  }

  async function updateViaTool(args: Record<string, unknown>) {
    return callTool(app, mcpSessionId, 'update_html_artifact', args, nextId++);
  }

  // ---------- happy path ----------

  it('replaces the content in place: same id, new bytes, updatedAt set, same result shape as create', async () => {
    const { sessionId, userId } = await createOwnedSession(7101, 'artifact-updater');
    const artifactId = await createArtifactViaTool(sessionId);
    const before = await artifactRepository.findById(artifactId);
    expect(before?.updatedAt).toBeNull();

    const newContent = '<html><head><title>Different</title></head><body>version two, longer</body></html>';
    const response = await updateViaTool({ artifactId, content: newContent, sessionId });

    expect(response.result?.isError).toBeUndefined();
    const data = parseToolResult(response) as { artifactId: string };
    expect(data.artifactId).toBe(artifactId);
    // Identical key set to create_html_artifact's result.
    const createResponse = await callTool(
      app, mcpSessionId, 'create_html_artifact', { content: '<p>x</p>', sessionId }, nextId++,
    );
    expect(Object.keys(data).sort()).toEqual(Object.keys(parseToolResult(createResponse) as object).sort());

    const after = await artifactRepository.findById(artifactId);
    expect(after?.updatedAt).not.toBeNull();
    expect(after?.createdAt).toBe(before!.createdAt);
    expect(after?.sizeBytes).toBe(Buffer.byteLength(newContent, 'utf-8'));
    expect(await readArtifactFile(userId, artifactId)).toBe(newContent);
  });

  it('keeps the stored title when no title is passed, even though the new document has a different <title>', async () => {
    const { sessionId } = await createOwnedSession(7102, 'artifact-title-keeper');
    const artifactId = await createArtifactViaTool(sessionId); // stored title: "Original"

    await updateViaTool({
      artifactId,
      content: '<html><head><title>Completely Different</title></head><body>v2</body></html>',
      sessionId,
    });

    expect((await artifactRepository.findById(artifactId))?.title).toBe('Original');
  });

  it('replaces the title when one is passed (plain text, markup stripped)', async () => {
    const { sessionId } = await createOwnedSession(7103, 'artifact-title-setter');
    const artifactId = await createArtifactViaTool(sessionId);

    await updateViaTool({ artifactId, content: '<p>v2</p>', title: '<b>Renamed</b> doc', sessionId });

    expect((await artifactRepository.findById(artifactId))?.title).toBe('Renamed doc');
  });

  it('keeps the stored title when the passed title is empty once sanitized (never falls back to deriving from the document)', async () => {
    const { sessionId } = await createOwnedSession(7104, 'artifact-empty-title');
    const artifactId = await createArtifactViaTool(sessionId);

    await updateViaTool({
      artifactId,
      content: '<html><head><title>Derived</title></head></html>',
      title: '<b></b>   ',
      sessionId,
    });

    expect((await artifactRepository.findById(artifactId))?.title).toBe('Original');
  });

  it('keeps the stored title when the passed title is whitespace only (title: \'   \')', async () => {
    const { sessionId } = await createOwnedSession(7114, 'artifact-blank-title');
    const artifactId = await createArtifactViaTool(sessionId);

    const response = await updateViaTool({ artifactId, content: '<p>v2</p>', title: '   ', sessionId });

    expect(response.result?.isError).toBeUndefined();
    expect((await artifactRepository.findById(artifactId))?.title).toBe('Original');
  });

  it('advances updatedAt on a second update', async () => {
    const { sessionId } = await createOwnedSession(7105, 'artifact-twice');
    const artifactId = await createArtifactViaTool(sessionId);

    await updateViaTool({ artifactId, content: '<p>v2</p>', sessionId });
    const first = (await artifactRepository.findById(artifactId))!.updatedAt!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await updateViaTool({ artifactId, content: '<p>v3</p>', sessionId });
    const second = (await artifactRepository.findById(artifactId))!.updatedAt!;

    expect(new Date(second).getTime()).toBeGreaterThan(new Date(first).getTime());
  });

  // ---------- authorization (the polarity case) ----------

  it('refuses a session owned by a DIFFERENT user and leaves the stored bytes, size and updatedAt unchanged', async () => {
    const { sessionId: sessionAId } = await createOwnedSession(7106, 'artifact-owner-a');
    const { sessionId: sessionBId, userId: userBId } = await createOwnedSession(7107, 'artifact-owner-b');
    const original = '<html><body>owned by B</body></html>';
    const artifactId = await createArtifactViaTool(sessionBId, original);
    const before = await artifactRepository.findById(artifactId);

    const response = await updateViaTool({ artifactId, content: '<p>hijacked</p>', sessionId: sessionAId });

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error).toContain('do not own');
    expect(data.error).toContain('update');
    expect(await readArtifactFile(userBId, artifactId)).toBe(original);
    const after = await artifactRepository.findById(artifactId);
    expect(after?.sizeBytes).toBe(before?.sizeBytes);
    expect(after?.updatedAt).toBeNull();
  });

  it('rejects an unknown artifactId with a not-found error', async () => {
    const { sessionId } = await createOwnedSession(7108, 'artifact-unknown');

    const response = await updateViaTool({ artifactId: 'does-not-exist', content: '<p>x</p>', sessionId });

    expect(response.result?.isError).toBe(true);
    const data = parseToolResult(response) as { error: string };
    expect(data.error.toLowerCase()).toContain('not found');
    expect(data.error).toContain('does-not-exist');
  });

  it('rejects an ownerless (legacy) calling session', async () => {
    const { sessionId: ownerSessionId } = await createOwnedSession(7109, 'artifact-owner-legacy');
    const artifactId = await createArtifactViaTool(ownerSessionId);
    const ownerless = await sessionManager.createSession({ type: 'quick', locationPath: TEST_REPO_PATH });

    const response = await updateViaTool({ artifactId, content: '<p>x</p>', sessionId: ownerless.id });

    expect(response.result?.isError).toBe(true);
    expect((parseToolResult(response) as { error: string }).error).toContain('has no createdBy');
    expect((await artifactRepository.findById(artifactId))?.updatedAt).toBeNull();
  });

  // ---------- size cap ----------

  it('enforces the same 5 MiB cap and message as create, leaving the artifact untouched', async () => {
    const { sessionId, userId } = await createOwnedSession(7110, 'artifact-cap');
    const original = '<p>small</p>';
    const artifactId = await createArtifactViaTool(sessionId, original);

    const response = await updateViaTool({ artifactId, content: 'x'.repeat(5 * 1024 * 1024 + 1), sessionId });

    expect(response.result?.isError).toBe(true);
    expect((parseToolResult(response) as { error: string }).error).toContain('exceeds the maximum artifact size');
    expect(await readArtifactFile(userId, artifactId)).toBe(original);
  });

  // ---------- realtime trigger ----------

  it('broadcasts artifact-updated for the OWNING session, not the calling session, when they differ', async () => {
    const broadcasts: AppServerMessage[] = [];
    await mountMcpApp({ mcpAuthMode: 'off', broadcastToApp: (msg) => broadcasts.push(msg) });
    const owner = await userRepository.upsertByOsUid(7111, 'artifact-shared-owner', '/home/artifact-shared-owner');
    const owningSession = await sessionManager.createSession(
      { type: 'quick', locationPath: TEST_REPO_PATH },
      { createdBy: owner.id },
    );
    const callingSession = await sessionManager.createSession(
      { type: 'quick', locationPath: TEST_REPO_PATH },
      { createdBy: owner.id },
    );
    const artifactId = await createArtifactViaTool(owningSession.id);
    broadcasts.length = 0;

    const response = await updateViaTool({ artifactId, content: '<p>v2</p>', sessionId: callingSession.id });

    expect(response.result?.isError).toBeUndefined();
    expect(broadcasts).toEqual([{ type: 'artifact-updated', sessionId: owningSession.id, artifactId }]);
  });

  it('does not broadcast when the update is refused', async () => {
    const broadcasts: AppServerMessage[] = [];
    await mountMcpApp({ mcpAuthMode: 'off', broadcastToApp: (msg) => broadcasts.push(msg) });
    const { sessionId: sessionAId } = await createOwnedSession(7112, 'artifact-no-bc-a');
    const { sessionId: sessionBId } = await createOwnedSession(7113, 'artifact-no-bc-b');
    const artifactId = await createArtifactViaTool(sessionBId);
    broadcasts.length = 0;

    await updateViaTool({ artifactId, content: '<p>nope</p>', sessionId: sessionAId });

    expect(broadcasts).toEqual([]);
  });
});
