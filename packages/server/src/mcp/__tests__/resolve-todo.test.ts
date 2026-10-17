/**
 * `resolve_todo` MCP tool tests (human TODO list, agent-recorded resolutions).
 *
 * Drives the REAL `createMcpApp` handler chain via `callTool` (mirrors
 * `create-bookmark.test.ts`), backed by a real `SqliteTodoRepository` against
 * an in-memory DB.
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
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
import { deliverTodoResolution } from '../../lib/todo-triggers.js';
import { McpTokenRegistry, type McpAuthMode } from '../mcp-auth.js';
import { AgentDirectory } from '../../services/agent-directory.js';
import { createWorktreeWithSession } from '../../services/worktree-creation-service.js';
import { deleteWorktree } from '../../services/worktree-deletion-service.js';
import { initializeMcp, callTool, parseToolResult } from './mcp-protocol-test-helpers.js';
import type { AppServerMessage, Todo } from '@agent-console/shared';
import { repositoryLookupFromSlug } from '../../__tests__/utils/repository-lookup-mock.js';

const TEST_CONFIG_DIR = '/test/config-resolve-todo';
const TEST_REPO_PATH = '/test/repo-resolve-todo';
const TEST_REPO_ID = 'repo-resolve-todo';

describe('resolve_todo', () => {
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

  async function createTodoViaTool(args: Record<string, unknown>, headers?: Record<string, string>) {
    return callTool(app, mcpSessionId, 'create_todo', args, nextId++, headers);
  }

  async function resolveViaTool(args: Record<string, unknown>, headers?: Record<string, string>) {
    return callTool(app, mcpSessionId, 'resolve_todo', args, nextId++, headers);
  }

  async function toolError(response: Awaited<ReturnType<typeof callTool>>): Promise<string> {
    expect(response.result?.isError).toBe(true);
    return (parseToolResult(response) as { error: string }).error;
  }

  /** Open items of the session, recorded by the agent through the real create_todo tool. */
  async function openItems(
    who: { sessionId: string; workerId: string },
    count: number,
    kind: 'question' | 'action' = 'question',
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const created = parseToolResult(
        await createTodoViaTool({ kind, title: `item ${i}`, body: 'b', sessionId: who.sessionId, workerId: who.workerId }),
      ) as { id: string };
      ids.push(created.id);
    }
    return ids;
  }

  /** Same items written straight to the repository, for tests whose MCP app enforces bearer tokens. */
  async function seedOpenItem(who: { sessionId: string; workerId: string }, id: string): Promise<string> {
    await todoRepository.create({
      id,
      kind: 'action',
      scope: 'session',
      title: id,
      body: 'b',
      sessionId: who.sessionId,
      createdBy: { workerId: who.workerId },
      assigneeUserId: null,
    });
    return id;
  }

  async function statusesOf(ids: string[]): Promise<string[]> {
    return Promise.all(ids.map(async (id) => (await todoRepository.findById(id))!.status));
  }

  describe('happy path', () => {
    it('three ids, one statement: all three become done, with the worker and the session user recorded', async () => {
      const me = await createOwnedSession();
      const ids = await openItems(me, 3);

      const response = await resolveViaTool({ ids, statement: '  all OK to merge  ', sessionId: me.sessionId, workerId: me.workerId });

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { todos: Todo[] };
      expect(data.todos.map((t) => t.id).sort()).toEqual([...ids].sort());
      for (const id of ids) {
        expect(await todoRepository.findById(id)).toMatchObject({
          status: 'done',
          resolutionText: 'all OK to merge',
          resolvedByUserId: me.userId,
          resolvedByWorkerId: me.workerId,
        });
      }
    });

    it("also covers a human-created item of the caller's session", async () => {
      const me = await createOwnedSession();
      const humanItem = await todoRepository.create({
        id: 'human-made',
        kind: 'action',
        scope: 'session',
        title: 'run it',
        body: 'b',
        sessionId: me.sessionId,
        createdBy: { userId: me.userId },
        assigneeUserId: null,
      });

      const response = await resolveViaTool({ ids: [humanItem.id], statement: 'I did it', sessionId: me.sessionId, workerId: me.workerId });

      expect(response.result?.isError).toBeUndefined();
      expect(await todoRepository.findById('human-made')).toMatchObject({ status: 'done', resolvedByWorkerId: me.workerId });
    });

    it('deduplicates ids: a repeated id is resolved once and does not make the call fail', async () => {
      const me = await createOwnedSession();
      const [a, b] = await openItems(me, 2);

      const response = await resolveViaTool({ ids: [a, b, a], statement: 'yes', sessionId: me.sessionId, workerId: me.workerId });

      expect(response.result?.isError).toBeUndefined();
      expect((parseToolResult(response) as { todos: Todo[] }).todos).toHaveLength(2);
      expect(await statusesOf([a!, b!])).toEqual(['done', 'done']);
    });

    it("statedBy names another member: that user's id is recorded instead of the session owner", async () => {
      const me = await createOwnedSession();
      const bob = await userRepository.upsertByOsUid(8501, 'bob-stated', '/home/bob-stated');
      const [id] = await openItems(me, 1);

      await resolveViaTool({ ids: [id], statement: 'bob said go', statedBy: 'bob-stated', sessionId: me.sessionId, workerId: me.workerId });

      expect(await todoRepository.findById(id!)).toMatchObject({ resolvedByUserId: bob.id, resolvedByWorkerId: me.workerId });
    });

    it('a session with no owner records a null user and still the worker', async () => {
      const session = await sessionManager.createSession({ type: 'quick', locationPath: TEST_REPO_PATH });
      const workerId = session.workers.find((w) => w.type === 'agent')!.id;
      const me = { sessionId: session.id, workerId };
      const [id] = await openItems(me, 1);

      const response = await resolveViaTool({ ids: [id], statement: 'ok', ...me });

      expect(response.result?.isError).toBeUndefined();
      expect(await todoRepository.findById(id!)).toMatchObject({ status: 'done', resolvedByUserId: null, resolvedByWorkerId: workerId });
    });
  });

  describe('refusals write nothing', () => {
    it('refuses empty ids', async () => {
      const me = await createOwnedSession();
      const [id] = await openItems(me, 1);

      const error = await toolError(await resolveViaTool({ ids: [], statement: 'ok', sessionId: me.sessionId, workerId: me.workerId }));

      expect(error).toContain('ids');
      expect(await statusesOf([id!])).toEqual(['open']);
    });

    it('refuses more than 50 ids, even when every one is a real open item', async () => {
      const me = await createOwnedSession();
      const ids = await openItems(me, 51, 'action');

      const error = await toolError(await resolveViaTool({ ids, statement: 'ok', sessionId: me.sessionId, workerId: me.workerId }));

      expect(error).toContain('50');
      expect((await statusesOf(ids)).every((s) => s === 'open')).toBe(true);
    });

    it('accepts exactly 50 ids (the boundary)', async () => {
      const me = await createOwnedSession();
      const ids = await openItems(me, 50, 'action');

      const response = await resolveViaTool({ ids, statement: 'ok', sessionId: me.sessionId, workerId: me.workerId });

      expect(response.result?.isError).toBeUndefined();
      expect((await statusesOf(ids)).every((s) => s === 'done')).toBe(true);
    });

    it('refuses a whitespace-only statement and an empty one', async () => {
      const me = await createOwnedSession();
      const [id] = await openItems(me, 1);

      await toolError(await resolveViaTool({ ids: [id], statement: '   \n ', sessionId: me.sessionId, workerId: me.workerId }));
      await toolError(await resolveViaTool({ ids: [id], statement: '', sessionId: me.sessionId, workerId: me.workerId }));

      expect(await statusesOf([id!])).toEqual(['open']);
    });

    it('refuses an unknown statedBy', async () => {
      const me = await createOwnedSession();
      const [id] = await openItems(me, 1);

      const error = await toolError(
        await resolveViaTool({ ids: [id], statement: 'ok', statedBy: 'nobody', sessionId: me.sessionId, workerId: me.workerId }),
      );

      expect(error).toContain('nobody');
      expect(await statusesOf([id!])).toEqual(['open']);
    });

    it('refuses an unknown id and leaves the valid ones open (atomic)', async () => {
      const me = await createOwnedSession();
      const [a, b] = await openItems(me, 2);

      const error = await toolError(await resolveViaTool({ ids: [a, 'missing', b], statement: 'ok', sessionId: me.sessionId, workerId: me.workerId }));

      expect(error).toContain('missing');
      expect(await statusesOf([a!, b!])).toEqual(['open', 'open']);
    });

    it('refuses an item that is not open (done, dismissed) and leaves the open ones open', async () => {
      const me = await createOwnedSession();
      const [open, done, dismissed] = await openItems(me, 3);
      await todoRepository.resolve(done!, { text: 'human answered', resolvedByUserId: me.userId });
      await todoRepository.dismiss(dismissed!);

      await toolError(await resolveViaTool({ ids: [open, done], statement: 'ok', sessionId: me.sessionId, workerId: me.workerId }));
      await toolError(await resolveViaTool({ ids: [open, dismissed], statement: 'ok', sessionId: me.sessionId, workerId: me.workerId }));

      expect(await statusesOf([open!, done!, dismissed!])).toEqual(['open', 'done', 'dismissed']);
      expect((await todoRepository.findById(done!))).toMatchObject({ resolutionText: 'human answered', resolvedByWorkerId: null });
    });

    it("another session's id refuses the WHOLE call, including the caller's own valid ids (atomic)", async () => {
      const a = await createOwnedSession(8601, 'resolve-owner-a');
      const b = await createOwnedSession(8602, 'resolve-owner-b');
      const [mine1, mine2] = await openItems(a, 2);
      const [theirs] = await openItems(b, 1);

      const error = await toolError(
        await resolveViaTool({ ids: [mine1, theirs, mine2], statement: 'ok', sessionId: a.sessionId, workerId: a.workerId }),
      );

      expect(error).toContain(theirs!);
      expect(await statusesOf([mine1!, mine2!, theirs!])).toEqual(['open', 'open', 'open']);
      expect(await todoRepository.list({ status: 'done' })).toEqual([]);
    });

    it('refuses an unknown session and an unknown worker', async () => {
      const me = await createOwnedSession();
      const [id] = await openItems(me, 1);

      expect(await toolError(await resolveViaTool({ ids: [id], statement: 'ok', sessionId: 'nope', workerId: me.workerId }))).toContain('nope');
      expect(await toolError(await resolveViaTool({ ids: [id], statement: 'ok', sessionId: me.sessionId, workerId: 'no-worker' }))).toContain('no-worker');
      expect(await statusesOf([id!])).toEqual(['open']);
    });

    it('a terminal caller without a token must pass sessionId and workerId', async () => {
      const error = await toolError(await resolveViaTool({ ids: ['x'], statement: 'ok' }));
      expect(error).toContain('requires sessionId');
    });
  });

  describe('no notification is delivered (the resolving session is the item\'s session)', () => {
    it('resolve_todo never calls deliverWorkerNotification, while the items do resolve', async () => {
      const me = await createOwnedSession();
      const ids = await openItems(me, 2);
      const deliver = spyOn(sessionManager, 'deliverWorkerNotification');

      const response = await resolveViaTool({ ids, statement: 'ok', sessionId: me.sessionId, workerId: me.workerId });

      expect(response.result?.isError).toBeUndefined();
      expect(await statusesOf(ids)).toEqual(['done', 'done']);
      expect(deliver).not.toHaveBeenCalled();
    });

    it('control: the same spy sees a delivery when a human resolves over REST (the routes test pins that path)', async () => {
      const me = await createOwnedSession();
      const [id] = await openItems(me, 1);
      const deliver = spyOn(sessionManager, 'deliverWorkerNotification');

      await deliverTodoResolution(sessionManager, (await todoRepository.findById(id!))!, 'answer');

      expect(deliver).toHaveBeenCalledTimes(1);
    });
  });

  describe('authorization (checkCallerOwnsSession)', () => {
    it('enforce mode: an embedded caller defaults to its own session and worker from the token', async () => {
      const registry = new McpTokenRegistry();
      await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });
      const me = await createOwnedSession(8701, 'resolve-owner-c');
      const token = registry.mint({ sessionId: me.sessionId, workerId: me.workerId, userId: me.userId });
      const id = await seedOpenItem(me, 'seeded-own');

      const response = await resolveViaTool({ ids: [id], statement: 'ok' }, { Authorization: `Bearer ${token}` });

      expect(response.result?.isError).toBeUndefined();
      expect(await todoRepository.findById(id!)).toMatchObject({ status: 'done', resolvedByWorkerId: me.workerId });
    });

    it("enforce mode: claiming another session's id is refused and the other session's item stays open", async () => {
      const registry = new McpTokenRegistry();
      await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });
      const a = await createOwnedSession(8702, 'resolve-owner-d');
      const b = await createOwnedSession(8703, 'resolve-owner-e');
      const theirs = await seedOpenItem(b, 'seeded-theirs');
      const token = registry.mint({ sessionId: a.sessionId, workerId: a.workerId, userId: a.userId });

      const error = await toolError(
        await resolveViaTool({ ids: [theirs], statement: 'ok', sessionId: b.sessionId }, { Authorization: `Bearer ${token}` }),
      );

      expect(error).toContain('can only act as your own session');
      expect(await statusesOf([theirs])).toEqual(['open']);
    });

    it('enforce mode: a token for the same session but a foreign owner is refused by the ownership gate', async () => {
      const registry = new McpTokenRegistry();
      await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });
      const me = await createOwnedSession(8704, 'resolve-owner-f');
      const id = await seedOpenItem(me, 'seeded-own');
      const token = registry.mint({ sessionId: me.sessionId, workerId: me.workerId, userId: 'some-other-user' });

      const response = await resolveViaTool({ ids: [id], statement: 'ok' }, { Authorization: `Bearer ${token}` });

      expect(response.result?.isError).toBe(true);
      expect(await statusesOf([id!])).toEqual(['open']);
    });
  });

  describe('broadcast', () => {
    it('emits exactly one trigger-only todos-updated with the session id for a bulk resolve', async () => {
      const me = await createOwnedSession();
      const ids = await openItems(me, 3);
      const broadcast = mock((_msg: AppServerMessage) => {});
      await mountMcpApp({ mcpAuthMode: 'off', broadcastToApp: broadcast });

      await resolveViaTool({ ids, statement: 'ok', sessionId: me.sessionId, workerId: me.workerId });

      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(broadcast).toHaveBeenCalledWith({ type: 'todos-updated', sessionId: me.sessionId });
    });

    it('emits nothing when the call is refused', async () => {
      const me = await createOwnedSession();
      const [id] = await openItems(me, 1);
      const broadcast = mock((_msg: AppServerMessage) => {});
      await mountMcpApp({ mcpAuthMode: 'off', broadcastToApp: broadcast });

      await resolveViaTool({ ids: [id, 'missing'], statement: 'ok', sessionId: me.sessionId, workerId: me.workerId });

      expect(broadcast).not.toHaveBeenCalled();
    });
  });

  describe('tool surface', () => {
    it('the list tools are adopt_todo, create_todo, list_todos and resolve_todo; there is still no dismiss or delete', async () => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': mcpSessionId },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: nextId++ }),
      });
      const text = await res.text();
      const names = [...text.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]);

      expect(names.filter((n) => n!.includes('todo')).sort()).toEqual(['adopt_todo', 'create_todo', 'list_todos', 'resolve_todo']);
    });
  });
});
