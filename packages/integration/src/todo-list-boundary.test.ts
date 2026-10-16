/**
 * Server-to-client boundary test: the human TODO list.
 *
 * Exercises the real chain a client depends on: real `SessionManager` +
 * `SqliteTodoRepository` + real Hono `/api/todos` handlers -> JSON wire ->
 * the shared strict schemas (`TodosListResponseSchema`, `TodoResponseSchema`,
 * `AppServerMessageSchema`) -- the same parsers the client uses
 * (`.claude/rules/pre-pr-completeness.md` Q10). Server route tests assert raw
 * JSON and client tests inject mock objects; neither crosses the schema.
 *
 * Stashing `scope` or the `withdrawn` member from the shared schema, or the
 * `todos-updated` entry from `AppServerMessageSchema`, fails this file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as v from 'valibot';
import type { Hono } from 'hono';

import {
  createTestApp,
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppBindings, AppContext } from '@agent-console/server/src/app-context';
import { createMockPtyProvider } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { ApiError, fetchTodo } from '@agent-console/client/src/lib/api';

import { createFetchBridge } from './test-utils';

import {
  AppServerMessageSchema,
  TodoResponseSchema,
  TodosListResponseSchema,
  UsersListResponseSchema,
  type AppServerMessage,
} from '@agent-console/shared';

describe('Client-Server Boundary: human TODO list', () => {
  let ctx: AppContext;
  let app: Hono<AppBindings>;
  let broadcasts: AppServerMessage[];

  beforeEach(async () => {
    await setupTestEnvironment();
    broadcasts = [];
    ctx = await createTestContext({
      ptyProvider: createMockPtyProvider(),
      assertSpawnCwdFn: async () => {},
      broadcastToApp: (msg) => broadcasts.push(msg),
    });
    app = await createTestApp(ctx);
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  async function post(path: string, body: unknown): Promise<unknown> {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBeLessThan(300);
    return res.json();
  }

  async function list(query = '') {
    const res = await app.request(`/api/todos${query}`);
    expect(res.status).toBe(200);
    return v.parse(TodosListResponseSchema, await res.json());
  }

  it('survives populate -> serialize -> strict parse, with scope, both creator shapes and the withdrawn status', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'alice', '/home/alice');
    const session = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: 'claude-code-builtin' },
      { createdBy: owner.id },
    );
    const workerId = session.workers[0]!.id;

    // Human-created, through the real REST handler: scope defaults to session
    // because the request carries a sessionId, and to global without one.
    const humanQuestion = v.parse(
      TodoResponseSchema,
      await post('/api/todos', { kind: 'question', title: 'Which port?', body: 'context', sessionId: session.id }),
    ).todo;
    const humanGlobal = v.parse(
      TodoResponseSchema,
      await post('/api/todos', { kind: 'action', title: 'Install X', body: '```terminal\nbrew install x\n```' }),
    ).todo;
    // Agent-created, through the repository the MCP tool writes to.
    const agentGlobal = await ctx.todoRepository.create({
      id: 'agent-global',
      kind: 'action',
      scope: 'global',
      title: 'Agent global action',
      body: 'b',
      sessionId: session.id,
      createdBy: { workerId },
      assigneeUserId: null,
    });

    expect(humanQuestion).toMatchObject({ scope: 'session', sessionId: session.id, createdBy: { userId: expect.any(String) } });
    expect(humanGlobal).toMatchObject({ scope: 'global', sessionId: null });

    const before = await list();
    expect(before.todos).toHaveLength(3);
    expect(before.todos.find((t) => t.id === agentGlobal.id)!.createdBy).toEqual({ workerId });

    // Deleting the session withdraws its open session-scoped items through the
    // real SessionManager wiring; the global items stay open.
    expect(await ctx.sessionManager.deleteSession(session.id)).toBe(true);

    const after = await list();
    const byId = new Map(after.todos.map((t) => [t.id, t]));
    expect(byId.get(humanQuestion.id)).toMatchObject({ scope: 'session', status: 'withdrawn', sessionId: session.id });
    expect(byId.get(agentGlobal.id)).toMatchObject({ scope: 'global', status: 'open', sessionId: session.id });
    expect(byId.get(humanGlobal.id)).toMatchObject({ scope: 'global', status: 'open', sessionId: null });

    // Filters travel as query strings.
    expect((await list('?status=withdrawn')).todos.map((t) => t.id)).toEqual([humanQuestion.id]);
    expect((await list('?scope=global&status=open')).todos).toHaveLength(2);
  });

  it('the todos-updated trigger passes the strict app-message schema, with a session id and with null', async () => {
    const session = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: 'claude-code-builtin' },
    );
    await post('/api/todos', { kind: 'action', title: 'a', body: '', sessionId: session.id });
    await post('/api/todos', { kind: 'action', title: 'b', body: '' });

    const todoMessages = broadcasts.filter((m) => m.type === 'todos-updated');
    expect(todoMessages).toHaveLength(2);
    // Serialize as the WebSocket does, then parse with the client's parser.
    const parsed = todoMessages.map((m) => v.safeParse(AppServerMessageSchema, JSON.parse(JSON.stringify(m))));
    for (const result of parsed) expect(result.success).toBe(true);
    expect(parsed.map((r) => (r.success && r.output.type === 'todos-updated' ? r.output.sessionId : 'wrong'))).toEqual([session.id, null]);
  });

  it('an empty list parses and a resolved item keeps its resolution across the wire', async () => {
    expect((await list()).todos).toEqual([]);

    const session = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: 'claude-code-builtin' },
    );
    const created = v.parse(TodoResponseSchema, await post('/api/todos', { kind: 'question', title: 'q', body: '', sessionId: session.id })).todo;
    const resolved = v.parse(TodoResponseSchema, await post(`/api/todos/${created.id}/resolve`, { text: 'the answer' })).todo;

    expect(resolved).toMatchObject({ status: 'done', resolutionText: 'the answer' });
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolvedByUserId).not.toBeNull();
  });

  it('an agent-recorded resolution (worker set) survives populate -> serialize -> strict parse; a human one reads null', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'alice', '/home/alice');
    const session = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: 'claude-code-builtin' },
      { createdBy: owner.id },
    );
    const workerId = session.workers[0]!.id;
    const agentCreated = await ctx.todoRepository.create({
      id: 'agent-item',
      kind: 'question',
      scope: 'session',
      title: 'May I merge?',
      body: 'b',
      sessionId: session.id,
      createdBy: { workerId },
      assigneeUserId: null,
    });
    await ctx.todoRepository.resolve(agentCreated.id, {
      text: 'yes, merge it',
      resolvedByUserId: owner.id,
      resolvedByWorkerId: workerId,
    });
    const humanResolved = v.parse(
      TodoResponseSchema,
      await post('/api/todos', { kind: 'action', title: 'a', body: '', sessionId: session.id }),
    ).todo;
    const humanDone = v.parse(TodoResponseSchema, await post(`/api/todos/${humanResolved.id}/resolve`, {})).todo;

    const byId = new Map((await list()).todos.map((t) => [t.id, t]));

    expect(byId.get('agent-item')).toMatchObject({
      status: 'done',
      resolutionText: 'yes, merge it',
      resolvedByUserId: owner.id,
      resolvedByWorkerId: workerId,
    });
    expect(humanDone.resolvedByWorkerId).toBeNull();
    expect(byId.get(humanResolved.id)!.resolvedByWorkerId).toBeNull();
  });

  it('the user directory survives populate -> serialize -> strict parse with only id and username', async () => {
    const alice = await ctx.userRepository.upsertByOsUid(54321, 'alice', '/home/alice');
    const bob = await ctx.userRepository.upsertByOsUid(54322, 'bob', '/home/bob');

    const res = await app.request('/api/users');
    expect(res.status).toBe(200);
    const parsed = v.parse(UsersListResponseSchema, await res.json());

    const byId = new Map(parsed.users.map((u) => [u.id, u]));
    expect(byId.get(alice.id)).toEqual({ id: alice.id, username: 'alice' });
    expect(byId.get(bob.id)).toEqual({ id: bob.id, username: 'bob' });
    const names = parsed.users.map((u) => u.username);
    expect(names).toEqual([...names].sort());
  });

  it('a known assignee is accepted and an unknown session or assignee is a 404 over the real wiring', async () => {
    const alice = await ctx.userRepository.upsertByOsUid(54321, 'alice', '/home/alice');
    const create = (body: unknown) =>
      app.request('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const ok = await create({ kind: 'action', title: 't', body: '', assigneeUserId: alice.id });
    expect(ok.status).toBe(201);
    expect(v.parse(TodoResponseSchema, await ok.json()).todo.assigneeUserId).toBe(alice.id);

    expect((await create({ kind: 'action', title: 't', body: '', assigneeUserId: 'ghost' })).status).toBe(404);
    expect((await create({ kind: 'action', title: 't', body: '', sessionId: 'ghost' })).status).toBe(404);
    expect((await list()).todos).toHaveLength(1);
  });

  it('fetchTodo reads one item through the real GET /api/todos/:id route and strict parse', async () => {
    const session = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: 'claude-code-builtin' },
    );
    const created = v.parse(
      TodoResponseSchema,
      await post('/api/todos', { kind: 'question', title: 'Which port?', body: 'context', sessionId: session.id }),
    ).todo;
    await post('/api/todos', { kind: 'action', title: 'another', body: '' });

    const bridge = createFetchBridge(app);
    try {
      const fetched = await fetchTodo(created.id);

      expect(fetched).toEqual(created);
      expect(bridge.capturedRequests.map((r) => `${r.method} ${new URL(r.url, 'http://localhost').pathname}`)).toEqual([
        `GET /api/todos/${created.id}`,
      ]);
    } finally {
      bridge.restore();
    }
  });

  it('fetchTodo rejects with an ApiError carrying the 404 message for a missing id', async () => {
    const bridge = createFetchBridge(app);
    try {
      const error = await fetchTodo('missing').then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ message: 'Todo not found', status: 404 });
    } finally {
      bridge.restore();
    }
  });
});
