/**
 * `comment_todo` MCP tool tests, and the `activities` that `list_todos` items
 * carry (human TODO list v3: an agent answers a human's reply on the same item).
 *
 * Drives the REAL `createMcpApp` handler chain via `callTool`, backed by a real
 * `SqliteTodoRepository` against an in-memory DB. The SessionManager is given
 * the same repository and database handle, so deleting a session withdraws its
 * session-scoped items through the real deletion path.
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
import { deliverTodoComment } from '../../lib/todo-triggers.js';
import { McpTokenRegistry, type McpAuthMode } from '../mcp-auth.js';
import { AgentDirectory } from '../../services/agent-directory.js';
import { createWorktreeWithSession } from '../../services/worktree-creation-service.js';
import { deleteWorktree } from '../../services/worktree-deletion-service.js';
import { initializeMcp, callTool, parseToolResult } from './mcp-protocol-test-helpers.js';
import type { AppServerMessage, Todo, TodoActivity } from '@agent-console/shared';
import { repositoryLookupFromSlug } from '../../__tests__/utils/repository-lookup-mock.js';

const TEST_CONFIG_DIR = '/test/config-comment-todo';
const TEST_REPO_PATH = '/test/repo-comment-todo';
const TEST_REPO_ID = 'repo-comment-todo';

describe('comment_todo', () => {
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
      db,
      todoRepository,
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

  async function commentViaTool(args: Record<string, unknown>, headers?: Record<string, string>) {
    return callTool(app, mcpSessionId, 'comment_todo', args, nextId++, headers);
  }

  async function listViaTool(args: Record<string, unknown>, headers?: Record<string, string>) {
    return callTool(app, mcpSessionId, 'list_todos', args, nextId++, headers);
  }

  async function toolError(response: Awaited<ReturnType<typeof callTool>>): Promise<string> {
    expect(response.result?.isError).toBe(true);
    return (parseToolResult(response) as { error: string }).error;
  }

  async function seedAgentItem(
    from: { sessionId: string; workerId: string },
    id: string,
    scope: 'session' | 'global' = 'session',
  ): Promise<Todo> {
    return todoRepository.create({
      id,
      kind: 'action',
      scope,
      title: `title of ${id}`,
      body: 'b',
      sessionId: from.sessionId,
      createdBy: { workerId: from.workerId },
      assigneeUserId: null,
    });
  }

  const tick = () => new Promise((r) => setTimeout(r, 5));

  type Detail = { todo: Todo; activities: TodoActivity[] };

  describe('happy path', () => {
    it("an agent comments on its own session's item: the comment is stored with the worker as actor, the status is untouched", async () => {
      const me = await createOwnedSession(9201, 'comment-owner-a');
      const before = await seedAgentItem(me, 'q', 'session');

      const response = await commentViaTool({ id: 'q', text: '  it is the staging one  ', sessionId: me.sessionId, workerId: me.workerId });

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as Detail;
      expect(data.todo).toMatchObject({ id: 'q', status: 'open', commentCount: 1, updatedAt: before.updatedAt });
      expect(data.activities).toHaveLength(1);
      expect(data.activities[0]).toMatchObject({
        kind: 'comment',
        todoId: 'q',
        actor: { workerId: me.workerId },
        text: 'it is the staging one',
      });
      expect(await todoRepository.listActivities('q')).toEqual(data.activities);
    });

    it('a done item takes a comment and stays done; a human-created item of the session does too', async () => {
      const me = await createOwnedSession(9202, 'comment-owner-b');
      await seedAgentItem(me, 'answered');
      await todoRepository.resolve('answered', { text: 'ok', resolvedByUserId: me.userId });
      await todoRepository.create({
        id: 'by-human',
        kind: 'action',
        scope: 'session',
        title: 'human item',
        body: 'b',
        sessionId: me.sessionId,
        createdBy: { userId: me.userId },
        assigneeUserId: null,
      });

      const done = await commentViaTool({ id: 'answered', text: 'thanks', sessionId: me.sessionId, workerId: me.workerId });
      const human = await commentViaTool({ id: 'by-human', text: 'noted', sessionId: me.sessionId, workerId: me.workerId });

      expect(done.result?.isError).toBeUndefined();
      expect(human.result?.isError).toBeUndefined();
      expect(await todoRepository.findById('answered')).toMatchObject({ status: 'done', commentCount: 1 });
      expect(await todoRepository.findById('by-human')).toMatchObject({ status: 'open', commentCount: 1 });
    });

    it('a second comment appends after the first', async () => {
      const me = await createOwnedSession(9203, 'comment-owner-c');
      await seedAgentItem(me, 'thread');
      await commentViaTool({ id: 'thread', text: 'one', sessionId: me.sessionId, workerId: me.workerId });
      await tick();

      const response = await commentViaTool({ id: 'thread', text: 'two', sessionId: me.sessionId, workerId: me.workerId });

      const data = parseToolResult(response) as Detail;
      expect(data.todo.commentCount).toBe(2);
      expect(data.activities.map((a) => ('text' in a ? a.text : null))).toEqual(['one', 'two']);
    });

    it('accepts exactly 4000 characters', async () => {
      const me = await createOwnedSession(9204, 'comment-owner-d');
      await seedAgentItem(me, 'long');

      const response = await commentViaTool({ id: 'long', text: 'x'.repeat(4000), sessionId: me.sessionId, workerId: me.workerId });

      expect(response.result?.isError).toBeUndefined();
    });
  });

  describe('refusals write nothing', () => {
    async function expectNothingWritten(): Promise<void> {
      expect(await getDatabase().selectFrom('todo_comments').selectAll().execute()).toEqual([]);
    }

    it('refuses an unknown id', async () => {
      const me = await createOwnedSession(9210, 'comment-owner-e');

      const error = await toolError(await commentViaTool({ id: 'missing', text: 'hi', sessionId: me.sessionId, workerId: me.workerId }));

      expect(error).toBe('Todo not found: missing');
      await expectNothingWritten();
    });

    it("refuses another session's item (also a global one), saying it is not an item of this session", async () => {
      const a = await createOwnedSession(9211, 'comment-owner-f');
      const b = await createOwnedSession(9212, 'comment-owner-g');
      await seedAgentItem(a, 'theirs-session', 'session');
      await seedAgentItem(a, 'theirs-global', 'global');

      const sessionError = await toolError(await commentViaTool({ id: 'theirs-session', text: 'hi', sessionId: b.sessionId, workerId: b.workerId }));
      const globalError = await toolError(await commentViaTool({ id: 'theirs-global', text: 'hi', sessionId: b.sessionId, workerId: b.workerId }));

      expect(sessionError).toBe('Cannot comment on theirs-session: it is not an item of this session');
      expect(globalError).toContain('not an item of this session');
      await expectNothingWritten();
    });

    it('refuses a session-less global item (it belongs to no session)', async () => {
      const me = await createOwnedSession(9213, 'comment-owner-h');
      await todoRepository.create({
        id: 'nowhere',
        kind: 'action',
        scope: 'global',
        title: 'no session',
        body: 'b',
        sessionId: null,
        createdBy: { userId: me.userId },
        assigneeUserId: null,
      });

      const error = await toolError(await commentViaTool({ id: 'nowhere', text: 'hi', sessionId: me.sessionId, workerId: me.workerId }));

      expect(error).toContain('not an item of this session');
      await expectNothingWritten();
    });

    it.each(['dismissed', 'superseded', 'withdrawn'] as const)('refuses a %s item, naming the status', async (status) => {
      const me = await createOwnedSession(9214, 'comment-owner-i');
      await seedAgentItem(me, 'closed-item');
      if (status === 'dismissed') await todoRepository.dismiss('closed-item');
      if (status === 'superseded') await todoRepository.markSuperseded('closed-item', me.sessionId);
      if (status === 'withdrawn') await todoRepository.withdrawOpenSessionScoped(me.sessionId);
      expect((await todoRepository.findById('closed-item'))!.status).toBe(status);

      const error = await toolError(await commentViaTool({ id: 'closed-item', text: 'hi', sessionId: me.sessionId, workerId: me.workerId }));

      expect(error).toBe(`Cannot comment on closed-item: its status is ${status}, only an open or done item takes a comment`);
      await expectNothingWritten();
    });

    it.each([
      ['empty text', ''],
      ['whitespace-only text', '  \n\t '],
    ])('refuses %s', async (_name, text) => {
      const me = await createOwnedSession(9215, 'comment-owner-j');
      await seedAgentItem(me, 'q');

      const error = await toolError(await commentViaTool({ id: 'q', text, sessionId: me.sessionId, workerId: me.workerId }));

      expect(error).toBe('text cannot be empty');
      await expectNothingWritten();
    });

    it('refuses more than 4000 characters (after trimming)', async () => {
      const me = await createOwnedSession(9216, 'comment-owner-k');
      await seedAgentItem(me, 'q');

      const error = await toolError(await commentViaTool({ id: 'q', text: 'x'.repeat(4001), sessionId: me.sessionId, workerId: me.workerId }));

      expect(error).toContain('4000');
      await expectNothingWritten();
    });

    it('an unknown caller session and an unknown caller worker are refused', async () => {
      const me = await createOwnedSession(9217, 'comment-owner-l');
      await seedAgentItem(me, 'q');

      expect(await toolError(await commentViaTool({ id: 'q', text: 'hi', sessionId: 'nope', workerId: me.workerId }))).toContain('nope');
      expect(await toolError(await commentViaTool({ id: 'q', text: 'hi', sessionId: me.sessionId, workerId: 'no-worker' }))).toContain('no-worker');
      await expectNothingWritten();
    });

    it('a terminal caller without a token must pass sessionId and workerId', async () => {
      const error = await toolError(await commentViaTool({ id: 'x', text: 'hi' }));
      expect(error).toContain('requires sessionId');
    });

    it("enforce mode: claiming another session's id is refused by the ownership gate before any item check", async () => {
      const owner = await createOwnedSession(9218, 'comment-owner-m');
      const caller = await createOwnedSession(9219, 'comment-owner-n');
      await seedAgentItem(owner, 'gate-first');
      const registry = new McpTokenRegistry();
      await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });
      const headers = { Authorization: `Bearer ${registry.mint(caller)}` };

      const error = await toolError(await commentViaTool({ id: 'gate-first', text: 'hi', sessionId: owner.sessionId }, headers));

      expect(error).toContain('can only act as your own session');
      await expectNothingWritten();
    });
  });

  describe('identity from the bearer token', () => {
    it('enforce mode: a caller with a token and no sessionId / workerId comments as itself', async () => {
      const me = await createOwnedSession(9220, 'comment-owner-o');
      await seedAgentItem(me, 'mine');
      const registry = new McpTokenRegistry();
      await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });
      const headers = { Authorization: `Bearer ${registry.mint(me)}` };

      const response = await commentViaTool({ id: 'mine', text: 'as myself' }, headers);

      expect(response.result?.isError).toBeUndefined();
      expect((await todoRepository.listActivities('mine'))[0]).toMatchObject({ actor: { workerId: me.workerId }, text: 'as myself' });
    });
  });

  describe('broadcast and delivery', () => {
    it('emits one trigger-only todos-updated frame for the item\'s session', async () => {
      const me = await createOwnedSession(9230, 'comment-owner-p');
      await seedAgentItem(me, 'q');
      const broadcast = mock((_msg: AppServerMessage) => {});
      await mountMcpApp({ mcpAuthMode: 'off', broadcastToApp: broadcast });

      await commentViaTool({ id: 'q', text: 'hi', sessionId: me.sessionId, workerId: me.workerId });

      expect(broadcast.mock.calls.map((c) => c[0])).toEqual([{ type: 'todos-updated', sessionId: me.sessionId }]);
    });

    it('a refused call emits nothing', async () => {
      const me = await createOwnedSession(9231, 'comment-owner-q');
      const broadcast = mock((_msg: AppServerMessage) => {});
      await mountMcpApp({ mcpAuthMode: 'off', broadcastToApp: broadcast });

      await toolError(await commentViaTool({ id: 'missing', text: 'hi', sessionId: me.sessionId, workerId: me.workerId }));

      expect(broadcast).not.toHaveBeenCalled();
    });

    it("an agent's comment delivers no notification to anyone, while the control (a human's comment) does", async () => {
      const me = await createOwnedSession(9232, 'comment-owner-r');
      const item = await seedAgentItem(me, 'quiet');
      const deliver = spyOn(sessionManager, 'deliverWorkerNotification');

      const response = await commentViaTool({ id: 'quiet', text: 'answer', sessionId: me.sessionId, workerId: me.workerId });

      expect(response.result?.isError).toBeUndefined();
      expect(deliver).not.toHaveBeenCalled();

      await deliverTodoComment(sessionManager, item, 'alice', 'a human replies');
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver.mock.calls[0]![0]).toBe(me.sessionId);
      expect(deliver.mock.calls[0]![1]).toBe(me.workerId);
    });
  });

  describe('list_todos items carry their activities', () => {
    it('an item with no activity has an empty list; commented and moved items list them oldest first', async () => {
      const me = await createOwnedSession(9240, 'comment-owner-s');
      const other = await createOwnedSession(9241, 'comment-owner-t');
      await seedAgentItem(me, 'bare');
      await seedAgentItem(me, 'threaded');
      await seedAgentItem(other, 'moved-in', 'global');
      await commentViaTool({ id: 'threaded', text: 'first', sessionId: me.sessionId, workerId: me.workerId });
      await tick();
      await callTool(app, mcpSessionId, 'adopt_todo', { id: 'moved-in', sessionId: me.sessionId, workerId: me.workerId }, nextId++);

      const response = await listViaTool({ sessionId: me.sessionId, workerId: me.workerId });

      const { todos } = parseToolResult(response) as { todos: Array<Todo & { activities: TodoActivity[] }> };
      const byId = Object.fromEntries(todos.map((t) => [t.id, t]));
      expect(byId['bare']!.activities).toEqual([]);
      expect(byId['threaded']!.commentCount).toBe(1);
      expect(byId['threaded']!.activities.map((a) => a.kind)).toEqual(['comment']);
      expect(byId['moved-in']!.commentCount).toBe(0);
      expect(byId['moved-in']!.activities.map((a) => a.kind)).toEqual(['moved']);
    });

    it("global: true lists other sessions' global items with their activities as well", async () => {
      const a = await createOwnedSession(9242, 'comment-owner-u');
      const b = await createOwnedSession(9243, 'comment-owner-v');
      await seedAgentItem(a, 'predecessor-global', 'global');
      await todoRepository.addComment({ todoId: 'predecessor-global', actor: { userId: a.userId }, text: 'from a human' });

      const response = await listViaTool({ global: true, sessionId: b.sessionId, workerId: b.workerId });

      const { todos } = parseToolResult(response) as { todos: Array<Todo & { activities: TodoActivity[] }> };
      expect(todos.find((t) => t.id === 'predecessor-global')!.activities).toMatchObject([{ kind: 'comment', text: 'from a human' }]);
    });
  });
});
