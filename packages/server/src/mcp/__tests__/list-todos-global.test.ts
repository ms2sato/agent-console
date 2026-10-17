/**
 * `list_todos({ global: true })` tests (successor session catching up on its
 * predecessor's `global` items, team-wide like `GET /api/todos?scope=global`).
 *
 * Drives the REAL `createMcpApp` handler chain via `callTool`, backed by a real
 * `SqliteTodoRepository` against an in-memory DB.
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
import { SqliteTodoRepository } from '../../repositories/sqlite-todo-repository.js';
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
import type { AppServerMessage, Todo } from '@agent-console/shared';
import { repositoryLookupFromSlug } from '../../__tests__/utils/repository-lookup-mock.js';

const TEST_CONFIG_DIR = '/test/config-list-todos-global';
const TEST_REPO_PATH = '/test/repo-list-todos-global';
const TEST_REPO_ID = 'repo-list-todos-global';

describe('list_todos global', () => {
  const ptyFactory = createMockPtyFactory();
  let app: Hono;
  let sessionManager: SessionManager;
  let repositoryManager: RepositoryManager;
  let agentManager: AgentManager;
  let userRepository: SqliteUserRepository;
  let artifactRepository: SqliteArtifactRepository;
  let todoRepository: SqliteTodoRepository;
  let testJobQueue: JobQueue;
  let mcpSessionId: string;
  let nextId: number;
  let worktreeService: WorktreeService;
  let agentDirectory: AgentDirectory;

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
      bookmarkRepository: new SqliteBookmarkRepository(getDatabase()),
      todoRepository,
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
    todoRepository = new SqliteTodoRepository(db);

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
    username: string = 'todo-owner',
  ): Promise<{ sessionId: string; userId: string; workerId: string }> {
    const owner = await userRepository.upsertByOsUid(osUid, username, `/home/${username}`);
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: TEST_REPO_PATH },
      { createdBy: owner.id },
    );
    return { sessionId: session.id, userId: owner.id, workerId: session.workers.find((w) => w.type === 'agent')!.id };
  }

  async function listViaTool(args: Record<string, unknown>, headers?: Record<string, string>) {
    return callTool(app, mcpSessionId, 'list_todos', args, nextId++, headers);
  }

  async function toolError(response: Awaited<ReturnType<typeof callTool>>): Promise<string> {
    expect(response.result?.isError).toBe(true);
    return (parseToolResult(response) as { error: string }).error;
  }

  /** Written straight to the repository, oldest first (a pause keeps created_at strictly increasing). */
  async function seed(
    who: { sessionId: string; workerId: string },
    id: string,
    scope: 'session' | 'global',
    assigneeUserId: string | null = null,
  ): Promise<void> {
    await todoRepository.create({
      id,
      kind: 'action',
      scope,
      title: id,
      body: 'b',
      sessionId: who.sessionId,
      createdBy: { workerId: who.workerId },
      assigneeUserId,
    });
    await new Promise((r) => setTimeout(r, 3));
  }

  async function idsOf(response: Awaited<ReturnType<typeof callTool>>): Promise<string[]> {
    expect(response.result?.isError).toBeUndefined();
    return (parseToolResult(response) as { todos: Todo[] }).todos.map((t) => t.id);
  }

  async function twoSessionsWithFourItems() {
    const a = await createOwnedSession(8801, 'global-owner-a');
    const b = await createOwnedSession(8802, 'global-owner-b');
    await seed(a, 'a-global', 'global');
    await seed(a, 'a-session', 'session');
    await seed(b, 'b-global', 'global');
    await seed(b, 'b-session', 'session');
    return { a, b };
  }

  it('without the flag, another session\'s global item is absent (the polarity pin)', async () => {
    const { b } = await twoSessionsWithFourItems();

    const ids = await idsOf(await listViaTool({ sessionId: b.sessionId, workerId: b.workerId }));

    expect(ids).toEqual(['b-session', 'b-global']);
    expect(ids).not.toContain('a-global');
  });

  it('global: true lists every session\'s global items, newest first, and no session-scoped item', async () => {
    const { b } = await twoSessionsWithFourItems();

    const ids = await idsOf(await listViaTool({ global: true, sessionId: b.sessionId, workerId: b.workerId }));

    expect(ids).toEqual(['b-global', 'a-global']);
  });

  it('global: true composes with status: a dismissed item of the caller drops out', async () => {
    const { b } = await twoSessionsWithFourItems();
    await todoRepository.dismiss('b-global');

    const ids = await idsOf(await listViaTool({ global: true, status: 'open', sessionId: b.sessionId }));

    expect(ids).toEqual(['a-global']);
  });

  it('global: true composes with mine: only global items assigned to the caller\'s user', async () => {
    const a = await createOwnedSession(8803, 'global-owner-c');
    const b = await createOwnedSession(8804, 'global-owner-d');
    await seed(a, 'for-b', 'global', b.userId);
    await seed(a, 'for-a', 'global', a.userId);
    await seed(a, 'for-anyone', 'global');

    const ids = await idsOf(await listViaTool({ global: true, mine: true, sessionId: b.sessionId }));

    expect(ids).toEqual(['for-b']);
  });

  it('global: true with scope: global is accepted (redundant)', async () => {
    const { b } = await twoSessionsWithFourItems();

    const ids = await idsOf(await listViaTool({ global: true, scope: 'global', sessionId: b.sessionId }));

    expect(ids).toEqual(['b-global', 'a-global']);
  });

  it('global: true with scope: session is refused', async () => {
    const { b } = await twoSessionsWithFourItems();

    const error = await toolError(await listViaTool({ global: true, scope: 'session', sessionId: b.sessionId }));

    expect(error).toBe("global: true lists global items only; scope 'session' cannot be combined");
  });

  it('global: true with no global item anywhere is an empty list', async () => {
    const a = await createOwnedSession(8805, 'global-owner-e');
    await seed(a, 'only-session', 'session');

    expect(await idsOf(await listViaTool({ global: true, sessionId: a.sessionId }))).toEqual([]);
  });

  it('global: true still needs the caller\'s own session to exist and be owned (identity gate unchanged)', async () => {
    expect(await toolError(await listViaTool({ global: true, sessionId: 'nope' }))).toContain('nope');
    expect(await toolError(await listViaTool({ global: true }))).toContain('requires sessionId');
  });

  it('enforce mode: a token for another session\'s owner is refused even with global: true', async () => {
    const registry = new McpTokenRegistry();
    await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });
    const a = await createOwnedSession(8806, 'global-owner-f');
    const token = registry.mint({ sessionId: a.sessionId, workerId: a.workerId, userId: 'some-other-user' });
    await seed(a, 'a-global', 'global');

    const response = await listViaTool({ global: true }, { Authorization: `Bearer ${token}` });

    expect(response.result?.isError).toBe(true);
  });
});
