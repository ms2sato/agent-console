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

import {
  AppServerMessageSchema,
  TodoResponseSchema,
  TodosListResponseSchema,
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
    await post('/api/todos', { kind: 'action', title: 'a', body: '', sessionId: 'session-1' });
    await post('/api/todos', { kind: 'action', title: 'b', body: '' });

    const todoMessages = broadcasts.filter((m) => m.type === 'todos-updated');
    expect(todoMessages).toHaveLength(2);
    // Serialize as the WebSocket does, then parse with the client's parser.
    const parsed = todoMessages.map((m) => v.safeParse(AppServerMessageSchema, JSON.parse(JSON.stringify(m))));
    for (const result of parsed) expect(result.success).toBe(true);
    expect(parsed.map((r) => (r.success && r.output.type === 'todos-updated' ? r.output.sessionId : 'wrong'))).toEqual(['session-1', null]);
  });

  it('an empty list parses and a resolved item keeps its resolution across the wire', async () => {
    expect((await list()).todos).toEqual([]);

    const created = v.parse(TodoResponseSchema, await post('/api/todos', { kind: 'question', title: 'q', body: '', sessionId: 's' })).todo;
    const resolved = v.parse(TodoResponseSchema, await post(`/api/todos/${created.id}/resolve`, { text: 'the answer' })).todo;

    expect(resolved).toMatchObject({ status: 'done', resolutionText: 'the answer' });
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolvedByUserId).not.toBeNull();
  });
});
