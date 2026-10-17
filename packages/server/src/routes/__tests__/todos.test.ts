/**
 * Sibling test for the human TODO list routes: real in-memory sqlite DB,
 * production layering (appContext -> authMiddleware -> route).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import * as v from 'valibot';
import type { AppServerMessage, AuthUser, Session, Todo, Worker } from '@agent-console/shared';
import { TodoDetailResponseSchema, TodoSchema, TodosListResponseSchema } from '@agent-console/shared';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteTodoRepository } from '../../repositories/sqlite-todo-repository.js';
import { TODO_RESOLUTION_SEPARATOR } from '../../repositories/todo-repository.js';
import { todos } from '../todos.js';
import { authMiddleware } from '../../middleware/auth.js';
import { onApiError } from '../../lib/error-handler.js';
import { serverConfig } from '../../lib/server-config.js';
import type { SharedAccountRegistry } from '../../services/shared-account-registry.js';
import type { AppBindings, AppContext } from '../../app-context.js';
import type { UserMode, PtySpawnRequest } from '../../services/user-mode.js';
import type { PtyInstance } from '../../lib/pty-provider.js';
import type { SessionManager } from '../../services/session-manager.js';
import type { UserRepository } from '../../repositories/user-repository.js';

const ALICE: AuthUser = { id: 'alice-1', username: 'alice', homeDir: '/home/alice' };
const BOB: AuthUser = { id: 'bob-1', username: 'bob', homeDir: '/home/bob' };

const CAROL: AuthUser = { id: 'carol-1', username: 'carol', homeDir: '/home/carol' };
const SHARED_USER_ID = 'shared-user';

const KNOWN_USERS = [ALICE, BOB];

const deliverWorkerNotificationMock = mock<SessionManager['deliverWorkerNotification']>(async () => ({ ok: true }));

const worker = (id: string, type: 'agent' | 'terminal' | 'git-diff'): Worker => ({ id, type } as Worker);

/**
 * Live sessions the move route can target. `session-2` lists a git-diff worker FIRST, so "the first
 * worker that can receive notifications" is distinguishable from "the first worker".
 */
const LIVE_SESSIONS: Record<string, Pick<Session, 'createdBy' | 'workers'>> = {
  'session-1': { createdBy: ALICE.id, workers: [worker('worker-1', 'agent'), worker('worker-t1', 'terminal')] },
  'session-2': { createdBy: BOB.id, workers: [worker('git-2', 'git-diff'), worker('worker-2', 'agent')] },
  'session-bare': { createdBy: BOB.id, workers: [worker('git-bare', 'git-diff')] },
  'shared-s': { createdBy: SHARED_USER_ID, workers: [worker('worker-sh', 'agent')] },
  s: { createdBy: ALICE.id, workers: [worker('worker-s', 'agent')] },
};
/** Paused sessions exist only as persisted rows. */
const PAUSED_SESSIONS: Record<string, Pick<Session, 'createdBy'>> = {
  'paused-1': { createdBy: BOB.id },
  'paused-alice': { createdBy: ALICE.id },
};

const toLive = (id: string) => ({ id, ...LIVE_SESSIONS[id] }) as Session;
const toPaused = (id: string) => ({ id, ...PAUSED_SESSIONS[id] }) as Session;

/** The lookups and the notification seam the todo routes use. */
const sessionManagerStub: Partial<SessionManager> = {
  deliverWorkerNotification: deliverWorkerNotificationMock,
  getSession: (id: string) => (id in LIVE_SESSIONS ? toLive(id) : undefined),
  getPersistedSession: async (id: string) => (id in PAUSED_SESSIONS ? toPaused(id) : null),
  getAllSessions: () => Object.keys(LIVE_SESSIONS).map(toLive),
  getAllPersistedSessions: async () =>
    Object.keys(PAUSED_SESSIONS).map((id) => ({ id, ...PAUSED_SESSIONS[id] })) as Awaited<ReturnType<SessionManager['getAllPersistedSessions']>>,
};
const stubSessionManager = sessionManagerStub as SessionManager;

const stubSharedAccountRegistry = {
  isSharedUserId: (id: string) => id === SHARED_USER_ID,
} as Pick<SharedAccountRegistry, 'isSharedUserId'> as SharedAccountRegistry;

const stubUserRepository = {
  findById: async (id: string) => KNOWN_USERS.find((u) => u.id === id) ?? null,
} as Pick<UserRepository, 'findById'> as UserRepository;

function mockUserMode(user: AuthUser | null): UserMode {
  return {
    authenticate: () => user,
    login: async () => null,
    spawnPty: (_request: PtySpawnRequest): PtyInstance => {
      throw new Error('spawnPty not implemented in mock');
    },
  };
}

function buildApp(
  todoRepository: SqliteTodoRepository,
  user: AuthUser | null,
  broadcastToApp: (msg: AppServerMessage) => void = () => {},
  overrides: Partial<AppContext> = {},
): Hono<AppBindings> {
  const partialContext: Partial<AppContext> = {
    todoRepository,
    sessionManager: stubSessionManager,
    sharedAccountRegistry: stubSharedAccountRegistry,
    userRepository: stubUserRepository,
    userMode: mockUserMode(user),
    broadcastToApp,
    ...overrides,
  };
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('appContext', partialContext as AppContext);
    await next();
  });
  app.use('*', authMiddleware);
  app.onError(onApiError);
  app.route('/api/todos', todos);
  return app;
}

function json(method: string, body?: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) };
}

describe('Todo routes', () => {
  let db: Kysely<Database>;
  let repository: SqliteTodoRepository;
  let broadcasts: AppServerMessage[];
  let app: Hono<AppBindings>;

  beforeEach(async () => {
    deliverWorkerNotificationMock.mockReset();
    deliverWorkerNotificationMock.mockImplementation(async () => ({ ok: true }));
    db = await createDatabaseForTest();
    repository = new SqliteTodoRepository(db);
    broadcasts = [];
    app = buildApp(repository, ALICE, (msg) => broadcasts.push(msg));
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function post(body: unknown): Promise<Response> {
    return app.request('/api/todos', json('POST', body));
  }

  async function createTodo(body: Record<string, unknown>): Promise<Todo> {
    const res = await post(body);
    expect(res.status).toBe(201);
    return ((await res.json()) as { todo: Todo }).todo;
  }

  async function seedAgentItem(overrides: Partial<Parameters<SqliteTodoRepository['create']>[0]> = {}): Promise<Todo> {
    return repository.create({
      id: crypto.randomUUID(),
      kind: 'action',
      scope: 'session',
      title: 'agent item',
      body: '',
      sessionId: 'session-1',
      createdBy: { workerId: 'worker-1' },
      assigneeUserId: null,
      ...overrides,
    });
  }

  describe('authentication', () => {
    it('rejects an unauthenticated request', async () => {
      const unauthenticated = buildApp(repository, null);
      expect((await unauthenticated.request('/api/todos')).status).toBe(401);
      expect((await unauthenticated.request('/api/todos', json('POST', { kind: 'action', title: 't', body: '' }))).status).toBe(401);
    });
  });

  describe('reference existence (404)', () => {
    async function count(): Promise<number> {
      return (await repository.list({})).length;
    }

    it('POST with an unknown sessionId is 404 and writes nothing', async () => {
      const res = await post({ kind: 'action', title: 't', body: '', sessionId: 'nope' });
      expect(res.status).toBe(404);
      expect(await count()).toBe(0);
      expect(broadcasts).toEqual([]);
    });

    it('POST with a paused (persisted-only) session is accepted', async () => {
      const todo = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'paused-1' });
      expect(todo).toMatchObject({ scope: 'session', sessionId: 'paused-1' });
    });

    it('POST with an unknown assigneeUserId is 404 and writes nothing', async () => {
      const res = await post({ kind: 'action', title: 't', body: '', assigneeUserId: 'ghost' });
      expect(res.status).toBe(404);
      expect(await count()).toBe(0);
    });

    it('POST with a known assigneeUserId is accepted', async () => {
      const todo = await createTodo({ kind: 'action', title: 't', body: '', assigneeUserId: BOB.id });
      expect(todo.assigneeUserId).toBe(BOB.id);
    });

    it('keeps the 400 refusals ahead of the existence checks', async () => {
      const res = await post({ kind: 'question', scope: 'global', title: 't', body: '', sessionId: 'nope', assigneeUserId: 'ghost' });
      expect(res.status).toBe(400);
    });

    describe('PATCH', () => {
      it('re-scoping to session with an unknown sessionId is 404 and changes nothing', async () => {
        const todo = await createTodo({ kind: 'action', scope: 'global', title: 't', body: '' });
        broadcasts.length = 0;
        const res = await app.request(`/api/todos/${todo.id}`, json('PATCH', { scope: 'session', sessionId: 'nope', title: 'changed' }));
        expect(res.status).toBe(404);
        expect(await repository.findById(todo.id)).toMatchObject({ scope: 'global', sessionId: null, title: 't' });
        expect(broadcasts).toEqual([]);
      });

      it('re-scoping to session with a paused session is accepted', async () => {
        const todo = await createTodo({ kind: 'action', scope: 'global', title: 't', body: '' });
        const res = await app.request(`/api/todos/${todo.id}`, json('PATCH', { scope: 'session', sessionId: 'paused-1' }));
        expect(res.status).toBe(200);
        expect(((await res.json()) as { todo: Todo }).todo).toMatchObject({ scope: 'session', sessionId: 'paused-1' });
      });

      it('re-scoping to session with a stored provenance sessionId that no longer exists is 404', async () => {
        const todo = await seedAgentItem({ scope: 'global', sessionId: 'gone' });
        const res = await app.request(`/api/todos/${todo.id}`, json('PATCH', { scope: 'session' }));
        expect(res.status).toBe(404);
      });

      it('an unknown assigneeUserId is 404 and changes nothing', async () => {
        const todo = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });
        const res = await app.request(`/api/todos/${todo.id}`, json('PATCH', { title: 'changed', assigneeUserId: 'ghost' }));
        expect(res.status).toBe(404);
        expect(await repository.findById(todo.id)).toMatchObject({ title: 't', assigneeUserId: null });
      });

      it('a known assigneeUserId is accepted, and null clears without a lookup', async () => {
        const todo = await createTodo({ kind: 'action', title: 't', body: '' });
        const set = await app.request(`/api/todos/${todo.id}`, json('PATCH', { assigneeUserId: BOB.id }));
        expect(set.status).toBe(200);
        const cleared = await app.request(`/api/todos/${todo.id}`, json('PATCH', { assigneeUserId: null }));
        expect(cleared.status).toBe(200);
        expect(((await cleared.json()) as { todo: Todo }).todo.assigneeUserId).toBeNull();
      });

      it('keeps the 400 refusals ahead of the existence checks', async () => {
        const todo = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });
        const res = await app.request(`/api/todos/${todo.id}`, json('PATCH', { sessionId: 'nope' }));
        expect(res.status).toBe(400);
      });
    });
  });

  describe('POST /api/todos (human create)', () => {
    it('defaults scope to session when the request carries a sessionId', async () => {
      const todo = await createTodo({ kind: 'action', title: 'From the panel', body: 'b', sessionId: 'session-1' });

      expect(todo).toMatchObject({ scope: 'session', sessionId: 'session-1', status: 'open' });
    });

    it('defaults scope to global when the request carries no sessionId', async () => {
      const todo = await createTodo({ kind: 'action', title: 'From the global page', body: 'b' });

      expect(todo).toMatchObject({ scope: 'global', sessionId: null });
    });

    it('an explicit scope wins over the default (global action with session provenance)', async () => {
      const todo = await createTodo({ kind: 'action', scope: 'global', title: 't', body: 'b', sessionId: 'session-1' });

      expect(todo).toMatchObject({ scope: 'global', sessionId: 'session-1' });
    });

    it('records the human creator as {userId} and the optional assignee', async () => {
      const todo = await createTodo({ kind: 'question', title: 't', body: 'b', sessionId: 's', assigneeUserId: BOB.id });

      expect(todo.createdBy).toEqual({ userId: ALICE.id });
      expect(todo.assigneeUserId).toBe(BOB.id);
    });

    it('refuses a question with explicit global scope (400) and writes nothing', async () => {
      const res = await post({ kind: 'question', scope: 'global', title: 't', body: 'b', sessionId: 's' });

      expect(res.status).toBe(400);
      expect(await repository.list({})).toEqual([]);
      expect(broadcasts).toEqual([]);
    });

    it('refuses a question with no sessionId, whose default scope would be global (400)', async () => {
      expect((await post({ kind: 'question', title: 't', body: 'b' })).status).toBe(400);
    });

    it('refuses an explicit session scope without a sessionId (400)', async () => {
      expect((await post({ kind: 'action', scope: 'session', title: 't', body: 'b' })).status).toBe(400);
    });

    it('rejects an invalid body (400): empty title, unknown field', async () => {
      expect((await post({ kind: 'action', title: ' ', body: 'b' })).status).toBe(400);
      expect((await post({ kind: 'action', title: 't', body: 'b', status: 'done' })).status).toBe(400);
    });

    it('broadcasts a trigger-only todos-updated with the item sessionId, or null', async () => {
      await createTodo({ kind: 'action', title: 't', body: 'b', sessionId: 'session-1' });
      await createTodo({ kind: 'action', title: 't', body: 'b' });

      expect(broadcasts).toEqual([
        { type: 'todos-updated', sessionId: 'session-1' },
        { type: 'todos-updated', sessionId: null },
      ]);
    });
  });

  describe('GET /api/todos', () => {
    it('returns an empty list, not an error, for zero items', async () => {
      const res = await app.request('/api/todos');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ todos: [] });
    });

    it('returns items that strictly parse with the shared wire schema, including scope and withdrawn', async () => {
      await createTodo({ kind: 'action', title: 'a', body: '', sessionId: 'session-1' });
      await repository.withdrawOpenSessionScoped('session-1');

      const body = await (await app.request('/api/todos')).json();
      const parsed = v.parse(TodosListResponseSchema, body);

      expect(parsed.todos).toHaveLength(1);
      expect(parsed.todos[0]).toMatchObject({ scope: 'session', status: 'withdrawn' });
      expect(v.safeParse(TodoSchema, parsed.todos[0]).success).toBe(true);
    });

    it('filters by status, scope, assignee and sessionId', async () => {
      await createTodo({ kind: 'action', title: 'sess', body: '', sessionId: 'session-1', assigneeUserId: BOB.id });
      await createTodo({ kind: 'action', title: 'glob', body: '' });
      const dismissed = await createTodo({ kind: 'action', title: 'gone', body: '', sessionId: 'session-2' });
      await app.request(`/api/todos/${dismissed.id}/dismiss`, json('POST'));

      const titles = async (query: string) =>
        ((await (await app.request(`/api/todos?${query}`)).json()) as { todos: Todo[] }).todos.map((t) => t.title).sort();

      expect(await titles('status=dismissed')).toEqual(['gone']);
      expect(await titles('scope=global')).toEqual(['glob']);
      expect(await titles(`assignee=${BOB.id}`)).toEqual(['sess']);
      expect(await titles('sessionId=session-1')).toEqual(['sess']);
    });

    it('rejects an unknown status or scope value (400)', async () => {
      expect((await app.request('/api/todos?status=expired')).status).toBe(400);
      expect((await app.request('/api/todos?scope=team')).status).toBe(400);
    });

    it('team-tool authorization: any member sees every member\'s items', async () => {
      await createTodo({ kind: 'action', title: 'alice item', body: '' });

      const asBob = buildApp(repository, BOB);
      const list = (await (await asBob.request('/api/todos')).json()) as { todos: Todo[] };

      expect(list.todos.map((t) => t.title)).toEqual(['alice item']);
    });
  });

  describe('GET /api/todos/:id', () => {
    it('returns { todo, activities }, strictly parsing with the shared wire schema (no activities: empty list)', async () => {
      const created = await createTodo({ kind: 'action', title: 'one', body: 'details', sessionId: 'session-1' });

      const res = await app.request(`/api/todos/${created.id}`);

      expect(res.status).toBe(200);
      const parsed = v.parse(TodoDetailResponseSchema, await res.json());
      expect(parsed.todo).toMatchObject({ id: created.id, title: 'one', body: 'details', sessionId: 'session-1', commentCount: 0 });
      expect(parsed.activities).toEqual([]);
    });

    it('lists the item\'s comments and moves in timeline order, and counts only the comments', async () => {
      const item = await seedAgentItem();
      const comment = await repository.addComment({ todoId: item.id, actor: { userId: ALICE.id }, text: 'first' });
      await new Promise((r) => setTimeout(r, 5));
      const move = await repository.addMove({
        todoId: item.id,
        actor: { workerId: 'worker-2' },
        fromSessionId: 'session-1',
        toSessionId: 'session-2',
        statement: 'take it',
        attributedUserId: BOB.id,
      });

      const parsed = v.parse(TodoDetailResponseSchema, await (await app.request(`/api/todos/${item.id}`)).json());

      expect(parsed.activities).toEqual([comment!, move]);
      expect(parsed.todo.commentCount).toBe(1);
    });

    it('is 404 "Todo not found" for an unknown id', async () => {
      const res = await app.request('/api/todos/does-not-exist');

      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).toContain('Todo not found');
    });

    it('rejects an unauthenticated request (401)', async () => {
      const created = await createTodo({ kind: 'action', title: 'one', body: '' });
      const unauthenticated = buildApp(repository, null);

      expect((await unauthenticated.request(`/api/todos/${created.id}`)).status).toBe(401);
    });
  });

  describe('PATCH /api/todos/:id', () => {
    it('edits title, body and assignee of an open item and broadcasts', async () => {
      const todo = await createTodo({ kind: 'action', title: 'old', body: 'b', sessionId: 'session-1' });
      broadcasts.length = 0;

      const res = await app.request(`/api/todos/${todo.id}`, json('PATCH', { title: 'new', assigneeUserId: BOB.id }));

      expect(res.status).toBe(200);
      expect(((await res.json()) as { todo: Todo }).todo).toMatchObject({ title: 'new', assigneeUserId: BOB.id });
      expect(broadcasts).toEqual([{ type: 'todos-updated', sessionId: 'session-1' }]);
    });

    it('team-tool authorization: another member may edit an item they did not create', async () => {
      const todo = await createTodo({ kind: 'action', title: 'old', body: '' });

      const res = await buildApp(repository, BOB).request(`/api/todos/${todo.id}`, json('PATCH', { title: 'bob edit' }));

      expect(res.status).toBe(200);
    });

    it('404 for an unknown item', async () => {
      expect((await app.request('/api/todos/missing', json('PATCH', { title: 'x' }))).status).toBe(404);
    });

    describe('re-scoping', () => {
      it('session -> global keeps sessionId', async () => {
        const todo = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });

        const res = await app.request(`/api/todos/${todo.id}`, json('PATCH', { scope: 'global' }));

        expect(((await res.json()) as { todo: Todo }).todo).toMatchObject({ scope: 'global', sessionId: 'session-1' });
      });

      it('global -> session uses the stored provenance sessionId', async () => {
        const todo = await createTodo({ kind: 'action', scope: 'global', title: 't', body: '', sessionId: 'session-1' });

        const res = await app.request(`/api/todos/${todo.id}`, json('PATCH', { scope: 'session' }));

        expect(((await res.json()) as { todo: Todo }).todo).toMatchObject({ scope: 'session', sessionId: 'session-1' });
      });

      it('global -> session accepts a sessionId passed in the same PATCH and notifies both sessions', async () => {
        const todo = await createTodo({ kind: 'action', scope: 'global', title: 't', body: '', sessionId: 'session-1' });
        broadcasts.length = 0;

        const res = await app.request(`/api/todos/${todo.id}`, json('PATCH', { scope: 'session', sessionId: 'session-2' }));

        expect(((await res.json()) as { todo: Todo }).todo).toMatchObject({ scope: 'session', sessionId: 'session-2' });
        expect(broadcasts).toEqual([
          { type: 'todos-updated', sessionId: 'session-2' },
          { type: 'todos-updated', sessionId: 'session-1' },
        ]);
      });

      it('refuses global -> session with no stored and no passed sessionId (400), leaving the item global', async () => {
        const todo = await createTodo({ kind: 'action', title: 't', body: '' });

        const res = await app.request(`/api/todos/${todo.id}`, json('PATCH', { scope: 'session' }));

        expect(res.status).toBe(400);
        expect((await repository.findById(todo.id))!.scope).toBe('global');
      });

      it('refuses to re-scope a question in either direction (400)', async () => {
        const question = await createTodo({ kind: 'question', title: 'q', body: '', sessionId: 'session-1' });

        const res = await app.request(`/api/todos/${question.id}`, json('PATCH', { scope: 'global' }));

        expect(res.status).toBe(400);
        expect((await repository.findById(question.id))!.scope).toBe('session');
      });

      it('refuses to re-scope a non-open item (409)', async () => {
        const todo = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });
        await repository.dismiss(todo.id);

        const res = await app.request(`/api/todos/${todo.id}`, json('PATCH', { scope: 'global' }));

        expect(res.status).toBe(409);
        expect((await repository.findById(todo.id))!.scope).toBe('session');
      });

      it('a sessionId without a global -> session re-scope is refused (400)', async () => {
        const todo = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });

        expect((await app.request(`/api/todos/${todo.id}`, json('PATCH', { sessionId: 'session-2' }))).status).toBe(400);
        expect((await app.request(`/api/todos/${todo.id}`, json('PATCH', { scope: 'global', sessionId: 'session-2' }))).status).toBe(400);
      });

      it('restating the current scope is not a re-scope, even for a question', async () => {
        const question = await createTodo({ kind: 'question', title: 'q', body: '', sessionId: 'session-1' });

        const res = await app.request(`/api/todos/${question.id}`, json('PATCH', { scope: 'session', title: 'q2' }));

        expect(res.status).toBe(200);
      });
    });

    it('refuses to edit a non-open item (409)', async () => {
      const todo = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });
      await repository.dismiss(todo.id);

      expect((await app.request(`/api/todos/${todo.id}`, json('PATCH', { title: 'x' }))).status).toBe(409);
    });
  });

  describe('POST /api/todos/:id/resolve', () => {
    it('resolves an action without text and records the resolving user', async () => {
      const todo = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });
      broadcasts.length = 0;

      const res = await buildApp(repository, BOB, (m) => broadcasts.push(m)).request(`/api/todos/${todo.id}/resolve`, json('POST', {}));

      expect(res.status).toBe(200);
      expect(((await res.json()) as { todo: Todo }).todo).toMatchObject({
        status: 'done',
        resolutionText: null,
        resolvedByUserId: BOB.id,
        resolvedByWorkerId: null,
      });
      expect(broadcasts).toEqual([{ type: 'todos-updated', sessionId: 'session-1' }]);
    });

    it('refuses done on a question with empty or whitespace text (400) and leaves it open', async () => {
      const question = await createTodo({ kind: 'question', title: 'q', body: '', sessionId: 'session-1' });

      expect((await app.request(`/api/todos/${question.id}/resolve`, json('POST', {}))).status).toBe(400);
      expect((await app.request(`/api/todos/${question.id}/resolve`, json('POST', { text: '   ' }))).status).toBe(400);
      expect((await repository.findById(question.id))!.status).toBe('open');
    });

    it('a second resolve appends after a rule line, moves resolvedAt, and the status stays done', async () => {
      const question = await createTodo({ kind: 'question', title: 'q', body: '', sessionId: 'session-1' });
      const first = ((await (await app.request(`/api/todos/${question.id}/resolve`, json('POST', { text: 'one' }))).json()) as { todo: Todo }).todo;
      await new Promise((r) => setTimeout(r, 5));

      const second = ((await (await app.request(`/api/todos/${question.id}/resolve`, json('POST', { text: 'two' }))).json()) as { todo: Todo }).todo;

      expect(second.status).toBe('done');
      expect(second.resolutionText).toBe(`one${TODO_RESOLUTION_SEPARATOR}two`);
      expect(second.resolvedAt! > first.resolvedAt!).toBe(true);
    });

    it.each(['dismissed', 'withdrawn', 'superseded'] as const)('refuses a %s item (409)', async (status) => {
      const todo = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });
      if (status === 'dismissed') await repository.dismiss(todo.id);
      if (status === 'withdrawn') await repository.withdrawOpenSessionScoped('session-1');
      if (status === 'superseded') await repository.markSuperseded(todo.id, 'session-1');

      expect((await app.request(`/api/todos/${todo.id}/resolve`, json('POST', { text: 'x' }))).status).toBe(409);
      expect((await repository.findById(todo.id))!.status).toBe(status);
    });

    it('404 for an unknown item', async () => {
      expect((await app.request('/api/todos/missing/resolve', json('POST', {}))).status).toBe(404);
    });

    // Reach, measured by mutating the route/helper and naming the failing tests:
    // - removing the helper call fails "notifies ... once", both "keeps the response 200" tests,
    //   "a second resolve ...", "delivers an empty resolution" and "truncates a 501-char ...";
    // - dropping the human-creator guard fails "does not notify for a human-created item"
    //   (and the helper's own "does not call the seam for a human-created item");
    // - passing the item's accumulated resolution instead of this call's text fails only
    //   "a second resolve of a done item delivers again carrying only the second text".
    describe('resolution delivery to the creating worker', () => {
      const resolve = async (id: string, body: unknown): Promise<Response> =>
        app.request(`/api/todos/${id}/resolve`, json('POST', body));

      it('notifies the creating worker once with this call\'s trimmed text', async () => {
        const item = await seedAgentItem({ kind: 'question', title: 'Which db?' });

        const res = await resolve(item.id, { text: '  use sqlite  ' });

        expect(res.status).toBe(200);
        expect(deliverWorkerNotificationMock).toHaveBeenCalledTimes(1);
        expect(deliverWorkerNotificationMock).toHaveBeenCalledWith('session-1', 'worker-1', {
          kind: 'internal-todo-resolved',
          tag: 'internal:todo-resolved',
          fields: { todoId: item.id, todoKind: 'question', title: 'Which db?', resolution: 'use sqlite' },
          intent: 'triage',
        });
      });

      it('does not notify for a human-created item', async () => {
        const item = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });

        expect((await resolve(item.id, { text: 'done' })).status).toBe(200);

        expect(deliverWorkerNotificationMock).not.toHaveBeenCalled();
      });

      it('keeps the response 200 and the row done when the seam reports a failure', async () => {
        deliverWorkerNotificationMock.mockImplementation(async () => ({ ok: false, error: 'gone', reason: 'not-found' }));
        const item = await seedAgentItem();

        const res = await resolve(item.id, { text: 'x' });
        await new Promise((r) => setTimeout(r, 0));

        expect(res.status).toBe(200);
        expect(deliverWorkerNotificationMock).toHaveBeenCalledTimes(1);
        expect((await repository.findById(item.id))!.status).toBe('done');
      });

      it('keeps the response 200 and the row done when the seam rejects', async () => {
        deliverWorkerNotificationMock.mockImplementation(async () => {
          throw new Error('boom');
        });
        const item = await seedAgentItem();

        const res = await resolve(item.id, { text: 'x' });
        await new Promise((r) => setTimeout(r, 0));

        expect(res.status).toBe(200);
        expect(deliverWorkerNotificationMock).toHaveBeenCalledTimes(1);
        expect((await repository.findById(item.id))!.status).toBe('done');
      });

      it('keeps the response 200 when the seam throws synchronously', async () => {
        deliverWorkerNotificationMock.mockImplementation(() => {
          throw new Error('sync boom');
        });
        const item = await seedAgentItem();

        const res = await resolve(item.id, { text: 'x' });

        expect(res.status).toBe(200);
        expect((await repository.findById(item.id))!.status).toBe('done');
      });

      it('a second resolve of a done item delivers again carrying only the second text', async () => {
        const item = await seedAgentItem();
        await resolve(item.id, { text: 'one' });
        await resolve(item.id, { text: 'two' });

        expect(deliverWorkerNotificationMock).toHaveBeenCalledTimes(2);
        const secondParams = deliverWorkerNotificationMock.mock.calls[1][2];
        expect(secondParams).toMatchObject({ fields: { resolution: 'two' } });
      });

      it('delivers an empty resolution for an action resolved without text', async () => {
        const item = await seedAgentItem({ kind: 'action' });

        await resolve(item.id, {});

        const params = deliverWorkerNotificationMock.mock.calls[0][2];
        expect(params).toMatchObject({ fields: { todoKind: 'action', resolution: '' } });
      });

      it('truncates a 501-char resolution to 500 chars plus "..."', async () => {
        const item = await seedAgentItem();

        await resolve(item.id, { text: 'a'.repeat(501) });

        const params = deliverWorkerNotificationMock.mock.calls[0][2];
        const resolution = 'resolution' in params.fields ? params.fields.resolution : undefined;
        expect(resolution).toBe(`${'a'.repeat(500)}...`);
        expect(resolution?.length).toBe(503);
      });

      it('dismiss and delete never notify the creating worker', async () => {
        const dismissed = await seedAgentItem();
        const deleted = await seedAgentItem();

        expect((await app.request(`/api/todos/${dismissed.id}/dismiss`, json('POST'))).status).toBe(200);
        expect((await app.request(`/api/todos/${deleted.id}`, { method: 'DELETE' })).status).toBe(200);

        expect(deliverWorkerNotificationMock).not.toHaveBeenCalled();
      });
    });
  });

  describe('POST /api/todos/:id/comments', () => {
    const comment = async (id: string, body: unknown, target: Hono<AppBindings> = app): Promise<Response> =>
      target.request(`/api/todos/${id}/comments`, json('POST', body));

    it('adds a human comment and answers { todo, activities } with the refreshed commentCount', async () => {
      const item = await seedAgentItem({ kind: 'question' });

      const res = await comment(item.id, { text: '  which environment?  ' });

      expect(res.status).toBe(200);
      const parsed = v.parse(TodoDetailResponseSchema, await res.json());
      expect(parsed.todo).toMatchObject({ id: item.id, status: 'open', commentCount: 1 });
      expect(parsed.activities).toHaveLength(1);
      expect(parsed.activities[0]).toMatchObject({ kind: 'comment', actor: { userId: ALICE.id }, text: 'which environment?' });
      expect(await repository.listActivities(item.id)).toEqual(parsed.activities);
    });

    it('leaves the item\'s status alone, appends later comments after earlier ones, and any member may comment', async () => {
      const item = await seedAgentItem();
      await comment(item.id, { text: 'one' });
      await new Promise((r) => setTimeout(r, 5));

      const res = await comment(item.id, { text: 'two' }, buildApp(repository, BOB));

      const parsed = v.parse(TodoDetailResponseSchema, await res.json());
      expect(parsed.todo).toMatchObject({ status: 'open', commentCount: 2, resolutionText: null });
      expect(parsed.activities.map((a) => ('text' in a ? a.text : null))).toEqual(['one', 'two']);
      expect(parsed.activities[1]).toMatchObject({ actor: { userId: BOB.id } });
    });

    it('is accepted on a done item (a reply after the answer) and the item stays done', async () => {
      const item = await seedAgentItem();
      await repository.resolve(item.id, { text: 'ok', resolvedByUserId: ALICE.id });

      const res = await comment(item.id, { text: 'one more thing' });

      expect(res.status).toBe(200);
      expect(v.parse(TodoDetailResponseSchema, await res.json()).todo).toMatchObject({ status: 'done', commentCount: 1 });
    });

    it('broadcasts one trigger-only todos-updated for the item\'s session', async () => {
      const item = await seedAgentItem();
      broadcasts.length = 0;

      await comment(item.id, { text: 'hi' });

      expect(broadcasts).toEqual([{ type: 'todos-updated', sessionId: 'session-1' }]);
    });

    it('is 404 for an unknown item: nothing written, no broadcast, no delivery', async () => {
      const res = await comment('missing', { text: 'hi' });

      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).toContain('Todo not found');
      expect(broadcasts).toEqual([]);
      expect(deliverWorkerNotificationMock).not.toHaveBeenCalled();
      expect(await db.selectFrom('todo_comments').selectAll().execute()).toEqual([]);
    });

    it.each(['superseded', 'dismissed', 'withdrawn'] as const)('is 409 for a %s item, naming the status, and writes nothing', async (status) => {
      const item = await seedAgentItem();
      if (status === 'superseded') await repository.markSuperseded(item.id, 'session-1');
      if (status === 'dismissed') await repository.dismiss(item.id);
      if (status === 'withdrawn') await repository.withdrawOpenSessionScoped('session-1');
      expect((await repository.findById(item.id))!.status).toBe(status);
      broadcasts.length = 0;

      const res = await comment(item.id, { text: 'hi' });

      expect(res.status).toBe(409);
      expect(JSON.stringify(await res.json())).toContain(status);
      expect(await repository.listActivities(item.id)).toEqual([]);
      expect(broadcasts).toEqual([]);
      expect(deliverWorkerNotificationMock).not.toHaveBeenCalled();
    });

    it.each([
      ['empty text', { text: '' }],
      ['whitespace-only text', { text: '   \n ' }],
      ['4001 characters', { text: 'x'.repeat(4001) }],
      ['missing text', {}],
      ['an unknown field', { text: 'hi', kind: 'moved' }],
    ])('is 400 for %s and writes nothing', async (_name, body) => {
      const item = await seedAgentItem();
      broadcasts.length = 0;

      const res = await comment(item.id, body);

      expect(res.status).toBe(400);
      expect(await repository.listActivities(item.id)).toEqual([]);
      expect(broadcasts).toEqual([]);
      expect(deliverWorkerNotificationMock).not.toHaveBeenCalled();
    });

    it('accepts exactly 4000 characters', async () => {
      const item = await seedAgentItem();
      expect((await comment(item.id, { text: 'x'.repeat(4000) })).status).toBe(200);
    });

    // Reach (measured): reverting `addComment` to a plain INSERT turns the first into a 500 (the foreign
    // key fires) and the second into a stored comment on a dismissed item.
    it('an item deleted between the read and the write is a 404, not a 500', async () => {
      const item = await seedAgentItem();
      let deleted = false;
      const racing = Object.assign(Object.create(repository) as SqliteTodoRepository, {
        findById: async (id: string, executor?: Parameters<SqliteTodoRepository['findById']>[1]) => {
          const row = await repository.findById(id, executor);
          if (!deleted && id === item.id) {
            deleted = true;
            await repository.delete(id);
          }
          return row;
        },
      });
      broadcasts.length = 0;

      const res = await comment(item.id, { text: 'hi' }, buildApp(racing, ALICE, (m) => broadcasts.push(m)));

      expect(deleted).toBe(true);
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).toContain('Todo not found');
      expect(broadcasts).toEqual([]);
      expect(deliverWorkerNotificationMock).not.toHaveBeenCalled();
    });

    it('an item closed between the read and the write is a 409 naming its new status, and nothing is stored', async () => {
      const item = await seedAgentItem();
      let flipped = false;
      const racing = Object.assign(Object.create(repository) as SqliteTodoRepository, {
        findById: async (id: string, executor?: Parameters<SqliteTodoRepository['findById']>[1]) => {
          const row = await repository.findById(id, executor);
          if (!flipped && id === item.id) {
            flipped = true;
            await repository.dismiss(id);
          }
          return row;
        },
      });
      broadcasts.length = 0;

      const res = await comment(item.id, { text: 'hi' }, buildApp(racing, ALICE, (m) => broadcasts.push(m)));

      expect(flipped).toBe(true);
      expect(res.status).toBe(409);
      expect(JSON.stringify(await res.json())).toContain('dismissed');
      expect(await repository.listActivities(item.id)).toEqual([]);
      expect(broadcasts).toEqual([]);
      expect(deliverWorkerNotificationMock).not.toHaveBeenCalled();
    });

    it('rejects an unauthenticated request (401)', async () => {
      const item = await seedAgentItem();
      expect((await comment(item.id, { text: 'hi' }, buildApp(repository, null))).status).toBe(401);
      expect(await repository.listActivities(item.id)).toEqual([]);
    });

    // Reach (measured, restored between runs):
    // - dropping the creating-worker guard from `deliverTodoComment` fails "does not notify for a
    //   human-created item" here and "does not call the seam for a human-created item" in the
    //   helper's own test;
    // - skipping the helper call fails "notifies the creating worker once ...", "notifies for a
    //   comment on a done item as well", "truncates a 4000-char comment ..." and "keeps the
    //   response 200 and the comment stored ...".
    describe('delivery to the creating worker', () => {
      it('notifies the creating worker once with the author\'s username and the trimmed text', async () => {
        const item = await seedAgentItem({ kind: 'question', title: 'Which db?' });

        const res = await comment(item.id, { text: '  not that one  ' });

        expect(res.status).toBe(200);
        expect(deliverWorkerNotificationMock).toHaveBeenCalledTimes(1);
        expect(deliverWorkerNotificationMock).toHaveBeenCalledWith('session-1', 'worker-1', {
          kind: 'internal-todo-comment',
          tag: 'internal:todo-comment',
          fields: { todoId: item.id, todoKind: 'question', title: 'Which db?', author: 'alice', text: 'not that one' },
          intent: 'triage',
        });
      });

      it('does not notify for a human-created item', async () => {
        const item = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });

        expect((await comment(item.id, { text: 'hi' })).status).toBe(200);

        expect(deliverWorkerNotificationMock).not.toHaveBeenCalled();
      });

      it('notifies for a comment on a done item as well', async () => {
        const item = await seedAgentItem();
        await repository.resolve(item.id, { text: 'ok', resolvedByUserId: ALICE.id });

        expect((await comment(item.id, { text: 'follow-up' })).status).toBe(200);

        expect(deliverWorkerNotificationMock).toHaveBeenCalledTimes(1);
      });

      it('truncates a 4000-char comment to 500 chars plus "..." in the notification only', async () => {
        const item = await seedAgentItem();

        const parsed = v.parse(TodoDetailResponseSchema, await (await comment(item.id, { text: 'a'.repeat(4000) })).json());

        const fields = deliverWorkerNotificationMock.mock.calls[0][2].fields as { text: string };
        expect(fields.text).toBe(`${'a'.repeat(500)}...`);
        expect((parsed.activities[0] as { text: string }).text.length).toBe(4000);
      });

      it('keeps the response 200 and the comment stored when the seam reports a failure or rejects', async () => {
        const item = await seedAgentItem();
        deliverWorkerNotificationMock.mockImplementationOnce(async () => ({ ok: false, error: 'gone', reason: 'not-found' }));
        deliverWorkerNotificationMock.mockImplementationOnce(async () => {
          throw new Error('boom');
        });

        const first = await comment(item.id, { text: 'one' });
        const second = await comment(item.id, { text: 'two' });
        await new Promise((r) => setTimeout(r, 0));

        expect([first.status, second.status]).toEqual([200, 200]);
        expect(deliverWorkerNotificationMock).toHaveBeenCalledTimes(2);
        expect(await repository.listActivities(item.id)).toHaveLength(2);
      });
    });
  });

  describe('POST /api/todos/:id/move', () => {
    const move = async (id: string, body: unknown, target: Hono<AppBindings> = app): Promise<Response> =>
      target.request(`/api/todos/${id}/move`, json('POST', body));

    const movesOf = async (id: string) => (await repository.listActivities(id)).filter((a) => a.kind === 'moved');

    it('moves a human-created item: 200 { todo }, and GET /:id carries one moved activity by the human with no statement', async () => {
      const item = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });

      const res = await move(item.id, { sessionId: 'session-2' });

      expect(res.status).toBe(200);
      const { todo } = (await res.json()) as { todo: Todo };
      expect(todo).toMatchObject({ id: item.id, sessionId: 'session-2', status: 'open', createdBy: { userId: ALICE.id } });
      const detail = v.parse(TodoDetailResponseSchema, await (await app.request(`/api/todos/${item.id}`)).json());
      expect(detail.activities).toHaveLength(1);
      expect(detail.activities[0]).toMatchObject({
        kind: 'moved',
        actor: { userId: ALICE.id },
        statement: null,
        attributedUserId: null,
        fromSessionId: 'session-1',
        toSessionId: 'session-2',
      });
    });

    it('moves an agent-created item to the FIRST worker of the target that can receive notifications', async () => {
      const item = await seedAgentItem();

      const res = await move(item.id, { sessionId: 'session-2' });

      expect(res.status).toBe(200);
      expect(((await res.json()) as { todo: Todo }).todo).toMatchObject({ sessionId: 'session-2', createdBy: { workerId: 'worker-2' } });
      expect(await movesOf(item.id)).toHaveLength(1);
    });

    it('uses body.workerId for an agent-created item when it belongs to the target and can receive notifications', async () => {
      const item = await seedAgentItem();

      const res = await move(item.id, { sessionId: 'session-1', workerId: 'worker-t1' });

      expect(res.status).toBe(200);
      expect(((await res.json()) as { todo: Todo }).todo.createdBy).toEqual({ workerId: 'worker-t1' });
    });

    it('moves an item that has no session (a global item) and records a move from null', async () => {
      const item = await createTodo({ kind: 'action', title: 't', body: '' });
      broadcasts.length = 0;

      expect((await move(item.id, { sessionId: 'session-2' })).status).toBe(200);

      expect(await movesOf(item.id)).toMatchObject([{ fromSessionId: null, toSessionId: 'session-2' }]);
      expect(broadcasts).toEqual([
        { type: 'todos-updated', sessionId: null },
        { type: 'todos-updated', sessionId: 'session-2' },
      ]);
    });

    it('team-tool rule: another member may move an item of a session they do not own', async () => {
      const item = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });

      const res = await move(item.id, { sessionId: 'session-2' }, buildApp(repository, BOB));

      expect(res.status).toBe(200);
      expect(await movesOf(item.id)).toMatchObject([{ actor: { userId: BOB.id } }]);
    });

    it('is 404 for an unknown item, and writes and broadcasts nothing', async () => {
      const res = await move('missing', { sessionId: 'session-2' });

      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).toContain('Todo not found');
      expect(broadcasts).toEqual([]);
    });

    it('is 404 for an unknown target session (neither live nor paused), and the item stays put', async () => {
      const item = await seedAgentItem();
      broadcasts.length = 0;

      const res = await move(item.id, { sessionId: 'nope' });

      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).toContain('Session not found');
      expect((await repository.findById(item.id))!.sessionId).toBe('session-1');
      expect(broadcasts).toEqual([]);
    });

    it('is 409 for a paused target (persisted only) and says to resume it', async () => {
      const item = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });
      broadcasts.length = 0;

      const res = await move(item.id, { sessionId: 'paused-1' });

      expect(res.status).toBe(409);
      expect(JSON.stringify(await res.json())).toContain('Target session is paused; resume it first');
      expect((await repository.findById(item.id))!.sessionId).toBe('session-1');
      expect(await movesOf(item.id)).toEqual([]);
      expect(broadcasts).toEqual([]);
    });

    it.each(['done', 'dismissed'] as const)('is 409 naming the status for a %s item', async (status) => {
      const item = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });
      if (status === 'done') await repository.resolve(item.id, { text: 'ok', resolvedByUserId: ALICE.id });
      else await repository.dismiss(item.id);
      broadcasts.length = 0;

      const res = await move(item.id, { sessionId: 'session-2' });

      expect(res.status).toBe(409);
      const text = JSON.stringify(await res.json());
      expect(text).toContain('Only an open item can be moved');
      expect(text).toContain(status);
      expect(await movesOf(item.id)).toEqual([]);
      expect(broadcasts).toEqual([]);
    });

    it('an agent-created item cannot go to a session with no worker that can receive notifications (409), and stays put', async () => {
      const item = await seedAgentItem();
      broadcasts.length = 0;

      const res = await move(item.id, { sessionId: 'session-bare' });

      expect(res.status).toBe(409);
      expect(JSON.stringify(await res.json())).toContain('Target session has no worker that can receive notifications');
      expect((await repository.findById(item.id))!.sessionId).toBe('session-1');
      expect(broadcasts).toEqual([]);
    });

    it('a human-created item may go to a session with no notification-capable worker (it has no delivery worker)', async () => {
      const item = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });

      expect((await move(item.id, { sessionId: 'session-bare' })).status).toBe(200);
    });

    it('an explicit workerId that cannot receive notifications is 409 with create_todo\'s text', async () => {
      const item = await seedAgentItem();

      const res = await move(item.id, { sessionId: 'session-2', workerId: 'git-2' });

      expect(res.status).toBe(409);
      expect(JSON.stringify(await res.json())).toContain('cannot receive notifications: requires an agent, terminal, or embedded-agent worker');
      expect((await repository.findById(item.id))!.sessionId).toBe('session-1');
    });

    it('an explicit workerId of ANOTHER session is 409 (not found in the target session)', async () => {
      const item = await seedAgentItem();

      const res = await move(item.id, { sessionId: 'session-2', workerId: 'worker-1' });

      expect(res.status).toBe(409);
      expect(JSON.stringify(await res.json())).toContain('Worker worker-1 not found in session session-2');
      expect((await repository.findById(item.id))!.sessionId).toBe('session-1');
    });

    it('a human-created item with a workerId in the body is 400 and nothing is written', async () => {
      const item = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });
      broadcasts.length = 0;

      const res = await move(item.id, { sessionId: 'session-2', workerId: 'worker-2' });

      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain('a human-created item has no delivery worker');
      expect((await repository.findById(item.id))!.sessionId).toBe('session-1');
      expect(broadcasts).toEqual([]);
    });

    it('the human-created 400 comes after the target checks: an unknown target is 404 even with a workerId', async () => {
      const item = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });

      expect((await move(item.id, { sessionId: 'nope', workerId: 'w' })).status).toBe(404);
    });

    describe('the same session', () => {
      it('a human-created item is a read-only no-op: 200, no move row, updatedAt untouched, nothing emitted', async () => {
        const item = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });
        broadcasts.length = 0;

        const res = await move(item.id, { sessionId: 'session-1' });

        expect(res.status).toBe(200);
        expect(((await res.json()) as { todo: Todo }).todo).toEqual(item);
        expect(await movesOf(item.id)).toEqual([]);
        expect((await repository.findById(item.id))!.updatedAt).toBe(item.updatedAt);
        // same-session no-op emits nothing
        expect(broadcasts).toEqual([]);
      });

      it('an agent-created item whose worker is already the chosen one is a read-only no-op: 200, no emit', async () => {
        const item = await seedAgentItem();
        broadcasts.length = 0;

        const res = await move(item.id, { sessionId: 'session-1', workerId: 'worker-1' });

        expect(res.status).toBe(200);
        expect(await movesOf(item.id)).toEqual([]);
        expect((await repository.findById(item.id))!.updatedAt).toBe(item.updatedAt);
        expect(broadcasts).toEqual([]);
      });

      it('an agent-created item with a different worker of the same session: the row is updated, no move row, one todos-updated', async () => {
        const item = await seedAgentItem();
        broadcasts.length = 0;

        const res = await move(item.id, { sessionId: 'session-1', workerId: 'worker-t1' });

        expect(res.status).toBe(200);
        expect(((await res.json()) as { todo: Todo }).todo).toMatchObject({ sessionId: 'session-1', createdBy: { workerId: 'worker-t1' } });
        expect(await movesOf(item.id)).toEqual([]);
        expect(broadcasts).toEqual([{ type: 'todos-updated', sessionId: 'session-1' }]);
      });
    });

    it('broadcasts two todos-updated frames, the old session first and then the new one', async () => {
      const item = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });
      broadcasts.length = 0;

      expect((await move(item.id, { sessionId: 'session-2' })).status).toBe(200);

      expect(broadcasts).toEqual([
        { type: 'todos-updated', sessionId: 'session-1' },
        { type: 'todos-updated', sessionId: 'session-2' },
      ]);
    });

    it('delivers nothing to any worker: a move is not a resolution', async () => {
      const item = await seedAgentItem();

      expect((await move(item.id, { sessionId: 'session-2' })).status).toBe(200);
      await new Promise((r) => setTimeout(r, 0));

      expect(deliverWorkerNotificationMock).not.toHaveBeenCalled();
    });

    it('two concurrent same-session re-targets to DIFFERENT workers: exactly one wins (200), the other is refused (409), the row names the winner', async () => {
      // The creator is worker-gone (no longer in the session), so BOTH requests are real re-targets.
      const item = await seedAgentItem({ createdBy: { workerId: 'worker-gone' } });
      broadcasts.length = 0;

      const responses = await Promise.all([
        move(item.id, { sessionId: 'session-1', workerId: 'worker-1' }),
        move(item.id, { sessionId: 'session-1', workerId: 'worker-t1' }),
      ]);

      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = responses.findIndex((r) => r.status === 200) === 0 ? 'worker-1' : 'worker-t1';
      expect((await repository.findById(item.id))!.createdBy).toEqual({ workerId: winner });
      expect(JSON.stringify(await responses.find((r) => r.status === 409)!.json())).toContain('The item moved while you were moving it; reload');
      expect(broadcasts).toEqual([{ type: 'todos-updated', sessionId: 'session-1' }]);
    });

    describe('a concurrent change between the read and the write', () => {
      /** Runs `interfere` once, right after the route's first read of the item. */
      const racingApp = (itemId: string, interfere: () => Promise<unknown>): Hono<AppBindings> => {
        let done = false;
        const racing = Object.assign(Object.create(repository) as SqliteTodoRepository, {
          findById: async (id: string, executor?: Parameters<SqliteTodoRepository['findById']>[1]) => {
            const row = await repository.findById(id, executor);
            if (!done && id === itemId) {
              done = true;
              await interfere();
            }
            return row;
          },
        });
        return buildApp(racing, ALICE, (m) => broadcasts.push(m));
      };

      it('the item moved elsewhere: 409 "moved while you were moving it", and the winner\'s placement stands', async () => {
        const item = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });
        const target = racingApp(item.id, () =>
          repository.adopt(item.id, { sessionId: 's', workerId: null, actor: { userId: BOB.id }, expectedSessionId: 'session-1', expectedWorkerId: null }),
        );
        broadcasts.length = 0;

        const res = await move(item.id, { sessionId: 'session-2' }, target);

        expect(res.status).toBe(409);
        expect(JSON.stringify(await res.json())).toContain('The item moved while you were moving it; reload');
        expect((await repository.findById(item.id))!.sessionId).toBe('s');
        expect(await movesOf(item.id)).toHaveLength(1);
        expect(broadcasts).toEqual([]);
      });

      it('the item deleted: 404', async () => {
        const item = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });
        const target = racingApp(item.id, () => repository.delete(item.id));
        broadcasts.length = 0;

        const res = await move(item.id, { sessionId: 'session-2' }, target);

        expect(res.status).toBe(404);
        expect(JSON.stringify(await res.json())).toContain('Todo not found');
        expect(broadcasts).toEqual([]);
      });

      it('the item closed: 409 naming its new status', async () => {
        const item = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });
        const target = racingApp(item.id, () => repository.dismiss(item.id));
        broadcasts.length = 0;

        const res = await move(item.id, { sessionId: 'session-2' }, target);

        expect(res.status).toBe(409);
        expect(JSON.stringify(await res.json())).toContain('dismissed');
        expect(await movesOf(item.id)).toEqual([]);
        expect(broadcasts).toEqual([]);
      });
    });

    it.each([
      ['a missing sessionId', {}],
      ['an empty sessionId', { sessionId: '' }],
      ['an empty workerId', { sessionId: 'session-2', workerId: '' }],
      ['an unknown field', { sessionId: 'session-2', statement: 'because' }],
    ])('is 400 for %s and writes nothing', async (_name, body) => {
      const item = await seedAgentItem();
      broadcasts.length = 0;

      expect((await move(item.id, body)).status).toBe(400);

      expect((await repository.findById(item.id))!.sessionId).toBe('session-1');
      expect(broadcasts).toEqual([]);
    });

    it('rejects an unauthenticated request (401)', async () => {
      const item = await seedAgentItem();

      expect((await move(item.id, { sessionId: 'session-2' }, buildApp(repository, null))).status).toBe(401);
      expect((await repository.findById(item.id))!.sessionId).toBe('session-1');
    });
  });

  describe('GET /api/todos?view=mine-and-shared', () => {
    const originalAuthMode = serverConfig.AUTH_MODE;
    const setAuthMode = (mode: 'none' | 'multi-user') => {
      (serverConfig as { AUTH_MODE: string }).AUTH_MODE = mode;
    };
    afterEach(() => setAuthMode(originalAuthMode));

    const titlesFor = async (target: Hono<AppBindings>, query: string): Promise<string[]> =>
      ((await (await target.request(`/api/todos?${query}`)).json()) as { todos: Todo[] }).todos.map((t) => t.title).sort();

    /** Alice's view: nothing is hers except what the rows below say. */
    async function seedView(): Promise<void> {
      const item = (title: string, o: Partial<Parameters<SqliteTodoRepository['create']>[0]>) =>
        repository.create({
          id: crypto.randomUUID(), kind: 'action', scope: 'session', title, body: '', sessionId: null,
          createdBy: { userId: BOB.id }, assigneeUserId: null, ...o,
        });
      await item('assigned to me', { sessionId: 'session-2', assigneeUserId: ALICE.id });
      await item('created by me', { sessionId: 'session-2', createdBy: { userId: ALICE.id } });
      await item('in my session', { sessionId: 'session-1' });
      await item('in a shared session', { sessionId: 'shared-s' });
      await item('in my paused session', { sessionId: 'paused-alice' });
      await item('foreign', { sessionId: 'session-2' });
      await item('foreign in a foreign paused session', { sessionId: 'paused-1' });
      await item('foreign global', { scope: 'global' });
    }

    it('multi-user: shows items assigned to me, created by me, in my sessions (live or paused) or in a shared session; hides the rest', async () => {
      setAuthMode('multi-user');
      await seedView();

      expect(await titlesFor(app, 'view=mine-and-shared')).toEqual([
        'assigned to me',
        'created by me',
        'in a shared session',
        'in my paused session',
        'in my session',
      ]);
    });

    it('multi-user without view: every item, as before', async () => {
      setAuthMode('multi-user');
      await seedView();

      expect(await titlesFor(app, '')).toHaveLength(8);
    });

    it('multi-user: composes with scope=global (a foreign global item is hidden) and with status', async () => {
      setAuthMode('multi-user');
      await seedView();
      await createTodo({ kind: 'action', title: 'my global', body: '' });

      expect(await titlesFor(app, 'view=mine-and-shared&scope=global')).toEqual(['my global']);
      expect(await titlesFor(app, 'view=mine-and-shared&status=dismissed')).toEqual([]);
    });

    it('multi-user: a user who owns no session sees only what is assigned to them plus shared-session items', async () => {
      setAuthMode('multi-user');
      await seedView();
      await repository.create({
        id: crypto.randomUUID(), kind: 'action', scope: 'session', title: 'assigned to carol', body: '', sessionId: 'session-2',
        createdBy: { userId: BOB.id }, assigneeUserId: CAROL.id,
      });

      expect(await titlesFor(buildApp(repository, CAROL), 'view=mine-and-shared')).toEqual(['assigned to carol', 'in a shared session']);
    });

    it('multi-user with no session of mine or shared (empty sessionIds): my assigned and created items still come back, not a 500', async () => {
      setAuthMode('multi-user');
      await seedView();
      const noSessions = Object.assign(Object.create(stubSessionManager) as SessionManager, {
        getAllSessions: () => [],
        getAllPersistedSessions: async () => [],
      });

      const res = await buildApp(repository, ALICE, undefined, { sessionManager: noSessions }).request('/api/todos?view=mine-and-shared');

      expect(res.status).toBe(200);
      expect(((await res.json()) as { todos: Todo[] }).todos.map((t) => t.title).sort()).toEqual(['assigned to me', 'created by me']);
    });

    it('single-user: view is accepted and ignored, every item is listed', async () => {
      setAuthMode('none');
      await seedView();

      const res = await app.request('/api/todos?view=mine-and-shared');

      expect(res.status).toBe(200);
      expect(((await res.json()) as { todos: Todo[] }).todos).toHaveLength(8);
    });

    it('rejects an unknown view value (400)', async () => {
      expect((await app.request('/api/todos?view=everyone')).status).toBe(400);
    });
  });

  describe('POST /api/todos/:id/dismiss', () => {
    it('dismisses an open item, any member may', async () => {
      const todo = await createTodo({ kind: 'action', title: 't', body: '', sessionId: 'session-1' });
      broadcasts.length = 0;

      const res = await buildApp(repository, BOB, (m) => broadcasts.push(m)).request(`/api/todos/${todo.id}/dismiss`, json('POST'));

      expect(res.status).toBe(200);
      expect(((await res.json()) as { todo: Todo }).todo.status).toBe('dismissed');
      expect(broadcasts).toEqual([{ type: 'todos-updated', sessionId: 'session-1' }]);
    });

    it('refuses a non-open item (409) and an unknown one (404)', async () => {
      const todo = await createTodo({ kind: 'action', title: 't', body: '' });
      await repository.dismiss(todo.id);

      expect((await app.request(`/api/todos/${todo.id}/dismiss`, json('POST'))).status).toBe(409);
      expect((await app.request('/api/todos/missing/dismiss', json('POST'))).status).toBe(404);
    });
  });

  describe('DELETE /api/todos/:id', () => {
    it('hard-deletes an item of any status, notifying its session; any member may', async () => {
      const agentItem = await seedAgentItem();
      await repository.dismiss(agentItem.id);
      broadcasts.length = 0;

      const res = await buildApp(repository, BOB, (m) => broadcasts.push(m)).request(`/api/todos/${agentItem.id}`, { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(await repository.findById(agentItem.id)).toBeNull();
      expect(broadcasts).toEqual([{ type: 'todos-updated', sessionId: 'session-1' }]);
    });

    it('deletes the item\'s comments and moves with it (through the route)', async () => {
      const item = await seedAgentItem();
      await repository.addComment({ todoId: item.id, actor: { userId: ALICE.id }, text: 'x' });
      await repository.addMove({
        todoId: item.id,
        actor: { workerId: 'worker-2' },
        fromSessionId: 'session-1',
        toSessionId: 'session-2',
        statement: null,
        attributedUserId: null,
      });

      expect((await app.request(`/api/todos/${item.id}`, { method: 'DELETE' })).status).toBe(200);

      expect(await db.selectFrom('todo_comments').selectAll().execute()).toEqual([]);
      expect(await db.selectFrom('todo_moves').selectAll().execute()).toEqual([]);
    });

    it('404 for an unknown item, with no broadcast', async () => {
      expect((await app.request('/api/todos/missing', { method: 'DELETE' })).status).toBe(404);
      expect(broadcasts).toEqual([]);
    });
  });
});
