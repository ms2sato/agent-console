/**
 * `adopt_todo` MCP tool tests (human TODO list: a successor session takes over
 * an open item so the resolution notification reaches the live session).
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
import { deliverTodoResolution } from '../../lib/todo-triggers.js';
import { McpTokenRegistry, type McpAuthMode } from '../mcp-auth.js';
import { AgentDirectory } from '../../services/agent-directory.js';
import { createWorktreeWithSession } from '../../services/worktree-creation-service.js';
import { deleteWorktree } from '../../services/worktree-deletion-service.js';
import { initializeMcp, callTool, parseToolResult } from './mcp-protocol-test-helpers.js';
import type { AppServerMessage, Todo } from '@agent-console/shared';
import { repositoryLookupFromSlug } from '../../__tests__/utils/repository-lookup-mock.js';

const TEST_CONFIG_DIR = '/test/config-adopt-todo';
const TEST_REPO_PATH = '/test/repo-adopt-todo';
const TEST_REPO_ID = 'repo-adopt-todo';

describe('adopt_todo', () => {
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

  /** A worktree session: unlike a quick session, it can be paused, leaving only its persisted row. */
  async function createPausableSession(
    osUid: number,
    username: string,
  ): Promise<{ sessionId: string; userId: string; workerId: string }> {
    const owner = await userRepository.upsertByOsUid(osUid, username, `/home/${username}`);
    const session = await sessionManager.createSession(
      { type: 'worktree', locationPath: TEST_REPO_PATH, repositoryId: TEST_REPO_ID, worktreeId: `wt-${username}`, agentId: 'claude-code-builtin' },
      { createdBy: owner.id },
    );
    return { sessionId: session.id, userId: owner.id, workerId: session.workers.find((w) => w.type === 'agent')!.id };
  }

  async function adoptViaTool(args: Record<string, unknown>, headers?: Record<string, string>) {
    return callTool(app, mcpSessionId, 'adopt_todo', args, nextId++, headers);
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

  /** Lets updated_at move past created_at (millisecond resolution). */
  const tick = () => new Promise((r) => setTimeout(r, 5));

  describe('happy path', () => {
    it('an agent-created item of A is adopted by B: session and creating worker move, nothing else does', async () => {
      const a = await createOwnedSession(9001, 'adopt-owner-a');
      const b = await createOwnedSession(9002, 'adopt-owner-b');
      const before = await seedAgentItem(a, 'agent-item', 'global');
      await tick();

      const response = await adoptViaTool({ id: 'agent-item', sessionId: b.sessionId, workerId: b.workerId });

      expect(response.result?.isError).toBeUndefined();
      const returned = (parseToolResult(response) as { todo: Todo }).todo;
      const stored = (await todoRepository.findById('agent-item'))!;
      expect(returned).toEqual(stored);
      expect(stored.sessionId).toBe(b.sessionId);
      expect(stored.createdBy).toEqual({ workerId: b.workerId });
      expect({ status: stored.status, scope: stored.scope, title: stored.title, body: stored.body, kind: stored.kind }).toEqual({
        status: 'open',
        scope: 'global',
        title: before.title,
        body: 'b',
        kind: 'action',
      });
      expect(stored.updatedAt > before.updatedAt).toBe(true);
      expect(stored.createdAt).toBe(before.createdAt);
    });

    it('a session-scoped open item is adoptable by id and keeps its scope', async () => {
      const a = await createOwnedSession(9003, 'adopt-owner-c');
      const b = await createOwnedSession(9004, 'adopt-owner-d');
      await seedAgentItem(a, 'scoped-item', 'session');

      const response = await adoptViaTool({ id: 'scoped-item', sessionId: b.sessionId, workerId: b.workerId });

      expect(response.result?.isError).toBeUndefined();
      expect(await todoRepository.findById('scoped-item')).toMatchObject({ sessionId: b.sessionId, scope: 'session', status: 'open' });
    });

    it('a human-created item moves to B but keeps its human creator (no worker is ever set)', async () => {
      const a = await createOwnedSession(9005, 'adopt-owner-e');
      const b = await createOwnedSession(9006, 'adopt-owner-f');
      await todoRepository.create({
        id: 'human-item',
        kind: 'action',
        scope: 'global',
        title: 'by a human',
        body: 'b',
        sessionId: a.sessionId,
        createdBy: { userId: a.userId },
        assigneeUserId: null,
      });

      const response = await adoptViaTool({ id: 'human-item', sessionId: b.sessionId, workerId: b.workerId });

      expect(response.result?.isError).toBeUndefined();
      const stored = (await todoRepository.findById('human-item'))!;
      expect(stored.sessionId).toBe(b.sessionId);
      expect(stored.createdBy).toEqual({ userId: a.userId });
    });

    it("adopts a global item whose creating session was deleted (nothing to compare the owner with)", async () => {
      const a = await createOwnedSession(9007, 'adopt-owner-g');
      const b = await createOwnedSession(9008, 'adopt-owner-h');
      await seedAgentItem(a, 'orphaned-global', 'global');
      expect(await sessionManager.deleteSession(a.sessionId)).toBe(true);
      expect(await sessionManager.getPersistedSession(a.sessionId)).toBeNull();

      const response = await adoptViaTool({ id: 'orphaned-global', sessionId: b.sessionId, workerId: b.workerId });

      expect(response.result?.isError).toBeUndefined();
      expect(await todoRepository.findById('orphaned-global')).toMatchObject({
        status: 'open',
        sessionId: b.sessionId,
        createdBy: { workerId: b.workerId },
      });
    });

    it('re-adopting the caller\'s own item succeeds, returns the row, and writes nothing', async () => {
      const a = await createOwnedSession(9009, 'adopt-owner-i');
      const b = await createOwnedSession(9010, 'adopt-owner-j');
      await seedAgentItem(a, 'again', 'global');
      await adoptViaTool({ id: 'again', sessionId: b.sessionId, workerId: b.workerId });
      const afterFirst = (await todoRepository.findById('again'))!;
      await tick();

      const response = await adoptViaTool({ id: 'again', sessionId: b.sessionId, workerId: b.workerId });

      expect(response.result?.isError).toBeUndefined();
      expect((parseToolResult(response) as { todo: Todo }).todo).toEqual(afterFirst);
      expect(await todoRepository.findById('again')).toEqual(afterFirst);
    });

    it("an item the caller's own session created is already its own: success, row untouched", async () => {
      const me = await createOwnedSession(9011, 'adopt-owner-k');
      const mine = await seedAgentItem(me, 'mine');
      await tick();

      const response = await adoptViaTool({ id: 'mine', sessionId: me.sessionId, workerId: me.workerId });

      expect(response.result?.isError).toBeUndefined();
      expect(await todoRepository.findById('mine')).toEqual(mine);
    });
  });

  describe('refusals write nothing', () => {
    it('refuses an unknown id', async () => {
      const b = await createOwnedSession(9020, 'adopt-owner-l');

      const error = await toolError(await adoptViaTool({ id: 'missing', sessionId: b.sessionId, workerId: b.workerId }));

      expect(error).toContain('missing');
      expect(error).toContain('not found');
    });

    it.each(['done', 'dismissed', 'withdrawn', 'superseded'] as const)('refuses a %s item, naming the status, and leaves it as it was', async (status) => {
      const a = await createOwnedSession(9021, 'adopt-owner-m');
      const b = await createOwnedSession(9022, 'adopt-owner-n');
      await seedAgentItem(a, 'closed-item');
      if (status === 'done') await todoRepository.resolve('closed-item', { text: 'ok', resolvedByUserId: a.userId });
      if (status === 'dismissed') await todoRepository.dismiss('closed-item');
      if (status === 'superseded') await todoRepository.markSuperseded('closed-item', a.sessionId);
      if (status === 'withdrawn') await sessionManager.deleteSession(a.sessionId);
      const before = (await todoRepository.findById('closed-item'))!;
      expect(before.status).toBe(status);

      const error = await toolError(await adoptViaTool({ id: 'closed-item', sessionId: b.sessionId, workerId: b.workerId }));

      expect(error).toContain(status);
      expect(await todoRepository.findById('closed-item')).toEqual(before);
    });

    it('an unknown caller session and an unknown caller worker are refused', async () => {
      const a = await createOwnedSession(9023, 'adopt-owner-o');
      const b = await createOwnedSession(9024, 'adopt-owner-p');
      await seedAgentItem(a, 'kept');

      expect(await toolError(await adoptViaTool({ id: 'kept', sessionId: 'nope', workerId: b.workerId }))).toContain('nope');
      expect(await toolError(await adoptViaTool({ id: 'kept', sessionId: b.sessionId, workerId: 'no-worker' }))).toContain('no-worker');
      expect(await todoRepository.findById('kept')).toMatchObject({ sessionId: a.sessionId, createdBy: { workerId: a.workerId } });
    });

    it('a terminal caller without a token must pass sessionId and workerId', async () => {
      const error = await toolError(await adoptViaTool({ id: 'x' }));
      expect(error).toContain('requires sessionId');
    });
  });

  describe('foreign owner', () => {
    async function enforceAs(caller: { sessionId: string; workerId: string; userId: string }) {
      const registry = new McpTokenRegistry();
      await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });
      return { Authorization: `Bearer ${registry.mint(caller)}` };
    }

    async function ownerAndCaller() {
      const owner = await createPausableSession(9031, 'foreign-owner');
      const caller = await createOwnedSession(9032, 'foreign-caller');
      return { owner, caller };
    }

    it("refuses an item of a PERSISTED (paused) session owned by another user, and the item stays where it was", async () => {
      const { owner, caller } = await ownerAndCaller();
      await seedAgentItem(owner, 'theirs', 'global');
      await sessionManager.pauseSession(owner.sessionId);
      expect(sessionManager.getSession(owner.sessionId)).toBeUndefined();
      const headers = await enforceAs(caller);

      const error = await toolError(await adoptViaTool({ id: 'theirs' }, headers));

      expect(error).toBe('Cannot adopt theirs: the item belongs to a session owned by another user');
      expect(await todoRepository.findById('theirs')).toMatchObject({ sessionId: owner.sessionId, createdBy: { workerId: owner.workerId } });
    });

    it('refuses an item of a LIVE session owned by another user', async () => {
      const { owner, caller } = await ownerAndCaller();
      await seedAgentItem(owner, 'theirs-live', 'global');
      const headers = await enforceAs(caller);

      const error = await toolError(await adoptViaTool({ id: 'theirs-live' }, headers));

      expect(error).toContain('owned by another user');
      expect(await todoRepository.findById('theirs-live')).toMatchObject({ sessionId: owner.sessionId });
    });

    it('control: an item of a persisted session owned by the SAME user is adopted (the check compares owners, it does not refuse paused sessions)', async () => {
      const predecessor = await createPausableSession(9033, 'same-owner');
      const successorSession = await sessionManager.createSession(
        { type: 'quick', locationPath: TEST_REPO_PATH },
        { createdBy: predecessor.userId },
      );
      const successor = { sessionId: successorSession.id, workerId: successorSession.workers.find((w) => w.type === 'agent')!.id, userId: predecessor.userId };
      await seedAgentItem(predecessor, 'handoff', 'global');
      await sessionManager.pauseSession(predecessor.sessionId);
      const headers = await enforceAs(successor);

      const response = await adoptViaTool({ id: 'handoff' }, headers);

      expect(response.result?.isError).toBeUndefined();
      expect(await todoRepository.findById('handoff')).toMatchObject({ sessionId: successor.sessionId, createdBy: { workerId: successor.workerId } });
    });

    it('without a bearer identity (auth off) the owner check cannot run and the adoption proceeds', async () => {
      const { owner, caller } = await ownerAndCaller();
      await seedAgentItem(owner, 'theirs-unchecked', 'global');

      const response = await adoptViaTool({ id: 'theirs-unchecked', sessionId: caller.sessionId, workerId: caller.workerId });

      expect(response.result?.isError).toBeUndefined();
      expect(await todoRepository.findById('theirs-unchecked')).toMatchObject({ sessionId: caller.sessionId });
    });

    it("enforce mode: claiming another session's id is refused by the ownership gate before any item check", async () => {
      const { owner, caller } = await ownerAndCaller();
      await seedAgentItem(owner, 'gate-first', 'global');
      const headers = await enforceAs(caller);

      const error = await toolError(await adoptViaTool({ id: 'gate-first', sessionId: owner.sessionId }, headers));

      expect(error).toContain('can only act as your own session');
      expect(await todoRepository.findById('gate-first')).toMatchObject({ sessionId: owner.sessionId });
    });
  });

  describe('broadcast and delivery', () => {
    it('emits exactly two trigger-only todos-updated frames: the previous session, then the new one', async () => {
      const a = await createOwnedSession(9041, 'adopt-owner-q');
      const b = await createOwnedSession(9042, 'adopt-owner-r');
      await seedAgentItem(a, 'moving', 'global');
      const broadcast = mock((_msg: AppServerMessage) => {});
      await mountMcpApp({ mcpAuthMode: 'off', broadcastToApp: broadcast });

      await adoptViaTool({ id: 'moving', sessionId: b.sessionId, workerId: b.workerId });

      expect(broadcast.mock.calls.map((c) => c[0])).toEqual([
        { type: 'todos-updated', sessionId: a.sessionId },
        { type: 'todos-updated', sessionId: b.sessionId },
      ]);
    });

    it('an idempotent re-adopt emits nothing', async () => {
      const a = await createOwnedSession(9043, 'adopt-owner-s');
      const b = await createOwnedSession(9044, 'adopt-owner-t');
      await seedAgentItem(a, 'steady', 'global');
      await adoptViaTool({ id: 'steady', sessionId: b.sessionId, workerId: b.workerId });
      const broadcast = mock((_msg: AppServerMessage) => {});
      await mountMcpApp({ mcpAuthMode: 'off', broadcastToApp: broadcast });

      const response = await adoptViaTool({ id: 'steady', sessionId: b.sessionId, workerId: b.workerId });

      expect(response.result?.isError).toBeUndefined();
      expect((parseToolResult(response) as { todo: Todo }).todo.sessionId).toBe(b.sessionId);
      expect(broadcast).not.toHaveBeenCalled();
    });

    it('a refused call emits nothing', async () => {
      const b = await createOwnedSession(9045, 'adopt-owner-u');
      const broadcast = mock((_msg: AppServerMessage) => {});
      await mountMcpApp({ mcpAuthMode: 'off', broadcastToApp: broadcast });

      const error = await toolError(await adoptViaTool({ id: 'missing', sessionId: b.sessionId, workerId: b.workerId }));

      expect(error).toContain('Todo not found');
      expect(broadcast).not.toHaveBeenCalled();
    });

    it('adopting delivers no notification (it is not a resolution), while the control resolution does', async () => {
      const a = await createOwnedSession(9046, 'adopt-owner-v');
      const b = await createOwnedSession(9047, 'adopt-owner-w');
      await seedAgentItem(a, 'quiet', 'global');
      const deliver = spyOn(sessionManager, 'deliverWorkerNotification');

      const response = await adoptViaTool({ id: 'quiet', sessionId: b.sessionId, workerId: b.workerId });

      expect(response.result?.isError).toBeUndefined();
      expect(deliver).not.toHaveBeenCalled();

      await deliverTodoResolution(sessionManager, (await todoRepository.findById('quiet'))!, 'answer');
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver.mock.calls[0]![0]).toBe(b.sessionId);
      expect(deliver.mock.calls[0]![1]).toBe(b.workerId);
    });
  });
});
