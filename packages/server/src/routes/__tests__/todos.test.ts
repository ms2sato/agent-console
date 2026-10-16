/**
 * Sibling test for the human TODO list routes: real in-memory sqlite DB,
 * production layering (appContext -> authMiddleware -> route).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import * as v from 'valibot';
import type { AppServerMessage, AuthUser, Session, Todo } from '@agent-console/shared';
import { TodoSchema, TodosListResponseSchema } from '@agent-console/shared';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteTodoRepository } from '../../repositories/sqlite-todo-repository.js';
import { TODO_RESOLUTION_SEPARATOR } from '../../repositories/todo-repository.js';
import { todos } from '../todos.js';
import { authMiddleware } from '../../middleware/auth.js';
import { onApiError } from '../../lib/error-handler.js';
import type { AppBindings, AppContext } from '../../app-context.js';
import type { UserMode, PtySpawnRequest } from '../../services/user-mode.js';
import type { PtyInstance } from '../../lib/pty-provider.js';
import type { SessionManager } from '../../services/session-manager.js';
import type { UserRepository } from '../../repositories/user-repository.js';

const ALICE: AuthUser = { id: 'alice-1', username: 'alice', homeDir: '/home/alice' };
const BOB: AuthUser = { id: 'bob-1', username: 'bob', homeDir: '/home/bob' };

const LIVE_SESSION_IDS = new Set(['session-1', 'session-2', 's']);
const PAUSED_SESSION_IDS = new Set(['paused-1']);
const KNOWN_USERS = [ALICE, BOB];

const deliverWorkerNotificationMock = mock<SessionManager['deliverWorkerNotification']>(async () => ({ ok: true }));

/** The lookups and the notification seam the todo routes use; a paused session exists only as a persisted row. */
const sessionManagerStub: Partial<SessionManager> = {
  deliverWorkerNotification: deliverWorkerNotificationMock,
  getSession: (id: string) => (LIVE_SESSION_IDS.has(id) ? ({ id } as Session) : undefined),
  getPersistedSession: async (id: string) => (PAUSED_SESSION_IDS.has(id) ? ({ id } as Session) : null),
};
const stubSessionManager = sessionManagerStub as SessionManager;

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
): Hono<AppBindings> {
  const partialContext: Partial<AppContext> = {
    todoRepository,
    sessionManager: stubSessionManager,
    userRepository: stubUserRepository,
    userMode: mockUserMode(user),
    broadcastToApp,
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

    it('404 for an unknown item, with no broadcast', async () => {
      expect((await app.request('/api/todos/missing', { method: 'DELETE' })).status).toBe(404);
      expect(broadcasts).toEqual([]);
    });
  });
});
