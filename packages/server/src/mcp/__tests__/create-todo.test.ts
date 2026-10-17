/**
 * `create_todo` / `list_todos` MCP tool tests (human TODO list).
 *
 * Drives the REAL `createMcpApp` handler chain via `callTool` (mirrors
 * `create-bookmark.test.ts`), backed by a real `SqliteTodoRepository` against
 * an in-memory DB.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
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

const TEST_CONFIG_DIR = '/test/config-todo-tools';
const TEST_REPO_PATH = '/test/repo-todo-tools';
const TEST_REPO_ID = 'repo-todo-tools';

describe('create_todo / list_todos', () => {
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

  async function toolError(response: Awaited<ReturnType<typeof callTool>>): Promise<string> {
    expect(response.result?.isError).toBe(true);
    return (parseToolResult(response) as { error: string }).error;
  }

  describe('create_todo', () => {
    it('creates an open session-scoped item by default, attributed to the calling worker, and returns only its id', async () => {
      const { sessionId, workerId } = await createOwnedSession();

      const response = await createTodoViaTool({
        kind: 'question', title: 'Which port?', body: 'context and recommendation', sessionId, workerId,
      });

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as Record<string, unknown>;
      expect(Object.keys(data)).toEqual(['id']);
      const stored = (await todoRepository.findById(data.id as string))!;
      expect(stored).toMatchObject({
        kind: 'question',
        scope: 'session',
        title: 'Which port?',
        body: 'context and recommendation',
        sessionId,
        createdBy: { workerId },
        status: 'open',
        assigneeUserId: null,
      });
    });

    it('a second create_todo does not overwrite the first', async () => {
      const { sessionId, workerId } = await createOwnedSession();

      const first = parseToolResult(await createTodoViaTool({ kind: 'action', title: 'first', body: 'a', sessionId, workerId })) as { id: string };
      const second = parseToolResult(await createTodoViaTool({ kind: 'action', title: 'second', body: 'b', sessionId, workerId })) as { id: string };

      expect(second.id).not.toBe(first.id);
      expect((await todoRepository.findById(first.id))).toMatchObject({ title: 'first', body: 'a', status: 'open' });
      expect(await todoRepository.list({ sessionId })).toHaveLength(2);
    });

    it('a memo overwrite (write_memo twice) leaves the todo rows intact', async () => {
      const { sessionId, workerId } = await createOwnedSession();
      const created = parseToolResult(await createTodoViaTool({ kind: 'question', title: 'q', body: 'b', sessionId, workerId })) as { id: string };
      const before = await todoRepository.findById(created.id);

      const first = await callTool(app, mcpSessionId, 'write_memo', { sessionId, content: 'status v1' }, nextId++);
      const second = await callTool(app, mcpSessionId, 'write_memo', { sessionId, content: 'status v2' }, nextId++);

      expect(first.result?.isError).toBeUndefined();
      expect(second.result?.isError).toBeUndefined();
      expect(await todoRepository.findById(created.id)).toEqual(before);
      expect(await todoRepository.list({ sessionId })).toHaveLength(1);
    });

    it('accepts global scope for an action and keeps the session as provenance', async () => {
      const { sessionId, workerId } = await createOwnedSession();

      const response = await createTodoViaTool({ kind: 'action', scope: 'global', title: 'install X', body: 'on the host', sessionId, workerId });

      const stored = (await todoRepository.findById((parseToolResult(response) as { id: string }).id))!;
      expect(stored).toMatchObject({ scope: 'global', sessionId });
    });

    it('refuses a question with global scope and writes nothing', async () => {
      const { sessionId, workerId } = await createOwnedSession();

      const error = await toolError(await createTodoViaTool({ kind: 'question', scope: 'global', title: 'q', body: 'b', sessionId, workerId }));

      expect(error).toContain('session-scoped');
      expect(await todoRepository.list({})).toEqual([]);
    });

    it('rejects an empty or overlong title', async () => {
      const { sessionId, workerId } = await createOwnedSession();

      await toolError(await createTodoViaTool({ kind: 'action', title: '  ', body: 'b', sessionId, workerId }));
      await toolError(await createTodoViaTool({ kind: 'action', title: 'x'.repeat(201), body: 'b', sessionId, workerId }));

      expect(await todoRepository.list({})).toEqual([]);
    });

    it('resolves assigneeUsername to a user id server-side, and refuses an unknown username', async () => {
      const { sessionId, workerId } = await createOwnedSession();
      const bob = await userRepository.upsertByOsUid(8101, 'bob', '/home/bob');

      const ok = parseToolResult(await createTodoViaTool({ kind: 'action', title: 't', body: 'b', assigneeUsername: 'bob', sessionId, workerId })) as { id: string };
      expect((await todoRepository.findById(ok.id))!.assigneeUserId).toBe(bob.id);

      const error = await toolError(await createTodoViaTool({ kind: 'action', title: 't', body: 'b', assigneeUsername: 'nobody', sessionId, workerId }));
      expect(error).toContain('nobody');
      expect(await todoRepository.list({})).toHaveLength(1);
    });

    it('refuses an unknown session and an unknown worker', async () => {
      const { sessionId, workerId } = await createOwnedSession();

      expect(await toolError(await createTodoViaTool({ kind: 'action', title: 't', body: 'b', sessionId: 'nope', workerId }))).toContain('nope');
      expect(await toolError(await createTodoViaTool({ kind: 'action', title: 't', body: 'b', sessionId, workerId: 'no-worker' }))).toContain('no-worker');
      expect(await todoRepository.list({})).toEqual([]);
    });

    it('a terminal caller without a token must pass sessionId and workerId', async () => {
      const error = await toolError(await createTodoViaTool({ kind: 'action', title: 't', body: 'b' }));
      expect(error).toContain('requires sessionId');
    });

    describe('supersedes', () => {
      it('marks the earlier open item of the same session superseded in the same transaction as the new row', async () => {
        const { sessionId, workerId } = await createOwnedSession();
        const old = parseToolResult(await createTodoViaTool({ kind: 'question', title: 'old', body: 'b', sessionId, workerId })) as { id: string };

        const response = await createTodoViaTool({ kind: 'question', title: 'new', body: 'b', supersedes: old.id, sessionId, workerId });

        const created = parseToolResult(response) as { id: string };
        expect((await todoRepository.findById(old.id))!.status).toBe('superseded');
        expect((await todoRepository.findById(created.id))!.status).toBe('open');
      });

      it("refuses another session's item: nothing is created and the other item stays open", async () => {
        const a = await createOwnedSession(8201, 'todo-owner-a');
        const b = await createOwnedSession(8202, 'todo-owner-b');
        const other = parseToolResult(await createTodoViaTool({ kind: 'action', title: 'other', body: 'b', sessionId: b.sessionId, workerId: b.workerId })) as { id: string };

        const error = await toolError(await createTodoViaTool({ kind: 'action', title: 'mine', body: 'b', supersedes: other.id, sessionId: a.sessionId, workerId: a.workerId }));

        expect(error).toContain('not an open item of this session');
        expect((await todoRepository.findById(other.id))!.status).toBe('open');
        expect(await todoRepository.list({ sessionId: a.sessionId })).toEqual([]);
      });

      it('refuses a non-open item and an unknown id, creating nothing', async () => {
        const { sessionId, workerId } = await createOwnedSession();
        const old = parseToolResult(await createTodoViaTool({ kind: 'action', title: 'old', body: 'b', sessionId, workerId })) as { id: string };
        await todoRepository.dismiss(old.id);

        await toolError(await createTodoViaTool({ kind: 'action', title: 'new', body: 'b', supersedes: old.id, sessionId, workerId }));
        await toolError(await createTodoViaTool({ kind: 'action', title: 'new', body: 'b', supersedes: 'missing', sessionId, workerId }));

        expect(await todoRepository.list({ sessionId })).toHaveLength(1);
      });
    });

    describe('authorization (checkCallerOwnsSession)', () => {
      it('enforce mode: an embedded caller defaults to its own session and worker from the token', async () => {
        const registry = new McpTokenRegistry();
        await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });
        const { sessionId, userId, workerId } = await createOwnedSession(8301, 'todo-owner-c');
        const token = registry.mint({ sessionId, workerId, userId });

        const response = await createTodoViaTool({ kind: 'action', title: 't', body: 'b' }, { Authorization: `Bearer ${token}` });

        expect(response.result?.isError).toBeUndefined();
        const stored = (await todoRepository.findById((parseToolResult(response) as { id: string }).id))!;
        expect(stored).toMatchObject({ sessionId, createdBy: { workerId } });
      });

      it("enforce mode: claiming another session's id is refused and nothing is created", async () => {
        const registry = new McpTokenRegistry();
        await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });
        const a = await createOwnedSession(8302, 'todo-owner-d');
        const b = await createOwnedSession(8303, 'todo-owner-e');
        const token = registry.mint({ sessionId: a.sessionId, workerId: a.workerId, userId: a.userId });

        const error = await toolError(
          await createTodoViaTool({ kind: 'action', title: 't', body: 'b', sessionId: b.sessionId }, { Authorization: `Bearer ${token}` }),
        );

        expect(error).toContain('can only act as your own session');
        expect(await todoRepository.list({})).toEqual([]);
      });

      it('enforce mode: a token for the same session but a foreign owner is refused by the ownership gate', async () => {
        const registry = new McpTokenRegistry();
        await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });
        const { sessionId, workerId } = await createOwnedSession(8304, 'todo-owner-f');
        const token = registry.mint({ sessionId, workerId, userId: 'some-other-user' });

        const response = await createTodoViaTool({ kind: 'action', title: 't', body: 'b' }, { Authorization: `Bearer ${token}` });

        expect(response.result?.isError).toBe(true);
        expect(await todoRepository.list({})).toEqual([]);
      });
    });

    describe('broadcast', () => {
      it('emits exactly one trigger-only todos-updated with the session id after a create', async () => {
        const broadcast = mock((_msg: AppServerMessage) => {});
        await mountMcpApp({ mcpAuthMode: 'off', broadcastToApp: broadcast });
        const { sessionId, workerId } = await createOwnedSession();

        await createTodoViaTool({ kind: 'action', title: 't', body: 'b', sessionId, workerId });

        expect(broadcast).toHaveBeenCalledTimes(1);
        expect(broadcast).toHaveBeenCalledWith({ type: 'todos-updated', sessionId });
      });

      it('emits nothing when the create is refused', async () => {
        const broadcast = mock((_msg: AppServerMessage) => {});
        await mountMcpApp({ mcpAuthMode: 'off', broadcastToApp: broadcast });
        const { sessionId, workerId } = await createOwnedSession();

        await createTodoViaTool({ kind: 'action', title: 't', body: 'b', supersedes: 'missing', sessionId, workerId });

        expect(broadcast).not.toHaveBeenCalled();
      });
    });
  });

  describe('list_todos', () => {
    async function listTodos(args: Record<string, unknown>, headers?: Record<string, string>): Promise<Todo[]> {
      const response = await callTool(app, mcpSessionId, 'list_todos', args, nextId++, headers);
      expect(response.result?.isError).toBeUndefined();
      return (parseToolResult(response) as { todos: Todo[] }).todos;
    }

    it('returns an empty list, not an error, when the session has no items', async () => {
      const { sessionId } = await createOwnedSession();
      expect(await listTodos({ sessionId })).toEqual([]);
    });

    it("lists only this session's items, and filters by status and scope", async () => {
      const a = await createOwnedSession(8401, 'todo-owner-g');
      const b = await createOwnedSession(8402, 'todo-owner-h');
      const mine = parseToolResult(await createTodoViaTool({ kind: 'action', title: 'mine', body: 'b', sessionId: a.sessionId, workerId: a.workerId })) as { id: string };
      await createTodoViaTool({ kind: 'action', scope: 'global', title: 'mine-global', body: 'b', sessionId: a.sessionId, workerId: a.workerId });
      await createTodoViaTool({ kind: 'action', title: 'theirs', body: 'b', sessionId: b.sessionId, workerId: b.workerId });
      await todoRepository.dismiss(mine.id);

      expect((await listTodos({ sessionId: a.sessionId })).map((t) => t.title).sort()).toEqual(['mine', 'mine-global']);
      expect((await listTodos({ sessionId: a.sessionId, status: 'open' })).map((t) => t.title)).toEqual(['mine-global']);
      expect((await listTodos({ sessionId: a.sessionId, scope: 'session' })).map((t) => t.title)).toEqual(['mine']);
    });

    it("mine returns only items assigned to the session's user", async () => {
      const { sessionId, userId, workerId } = await createOwnedSession(8403, 'todo-owner-i');
      await userRepository.upsertByOsUid(8404, 'carol', '/home/carol');
      await createTodoViaTool({ kind: 'action', title: 'for-owner', body: 'b', assigneeUsername: 'todo-owner-i', sessionId, workerId });
      await createTodoViaTool({ kind: 'action', title: 'for-carol', body: 'b', assigneeUsername: 'carol', sessionId, workerId });
      await createTodoViaTool({ kind: 'action', title: 'for-anyone', body: 'b', sessionId, workerId });

      const mine = await listTodos({ sessionId, mine: true });

      expect(mine.map((t) => t.title)).toEqual(['for-owner']);
      expect(mine[0]!.assigneeUserId).toBe(userId);
    });

    it('enforce mode: listing another session is refused', async () => {
      const registry = new McpTokenRegistry();
      await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });
      const a = await createOwnedSession(8405, 'todo-owner-j');
      const b = await createOwnedSession(8406, 'todo-owner-k');
      const token = registry.mint({ sessionId: a.sessionId, workerId: a.workerId, userId: a.userId });

      const response = await callTool(app, mcpSessionId, 'list_todos', { sessionId: b.sessionId }, nextId++, { Authorization: `Bearer ${token}` });

      expect(response.result?.isError).toBe(true);
    });

    it('enforce mode: a token for the same session but a foreign owner is refused by the ownership gate', async () => {
      const registry = new McpTokenRegistry();
      await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });
      const { sessionId, workerId } = await createOwnedSession(8407, 'todo-owner-l');
      const token = registry.mint({ sessionId, workerId, userId: 'some-other-user' });

      const response = await callTool(app, mcpSessionId, 'list_todos', {}, nextId++, { Authorization: `Bearer ${token}` });

      expect(response.result?.isError).toBe(true);
    });

    it('an unknown session is an error', async () => {
      const response = await callTool(app, mcpSessionId, 'list_todos', { sessionId: 'nope' }, nextId++);
      expect(response.result?.isError).toBe(true);
    });
  });

  describe('agents have no way to dismiss, delete or re-scope', () => {
    it('the MCP surface registers only create_todo, list_todos, resolve_todo and adopt_todo for the list', async () => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': mcpSessionId },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: nextId++ }),
      });
      const text = await res.text();
      const names = [...text.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]);

      const todoTools = names.filter((n) => n!.includes('todo')).sort();
      expect(todoTools).toEqual(['adopt_todo', 'create_todo', 'list_todos', 'resolve_todo']);
    });
  });
});
