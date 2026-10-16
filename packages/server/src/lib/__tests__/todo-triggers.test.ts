import { describe, it, expect, mock } from 'bun:test';
import type { AppServerMessage, Todo } from '@agent-console/shared';
import type { SessionManager } from '../../services/session-manager.js';
import { deliverTodoResolution, emitTodosUpdated } from '../todo-triggers.js';

describe('emitTodosUpdated', () => {
  it('broadcasts a trigger-only todos-updated message carrying the session id', () => {
    const sent: AppServerMessage[] = [];
    emitTodosUpdated((msg) => sent.push(msg), 'session-1');
    expect(sent).toEqual([{ type: 'todos-updated', sessionId: 'session-1' }]);
  });

  it('carries null for an item that has no session', () => {
    const sent: AppServerMessage[] = [];
    emitTodosUpdated((msg) => sent.push(msg), null);
    expect(sent).toEqual([{ type: 'todos-updated', sessionId: null }]);
  });
});

describe('deliverTodoResolution', () => {
  const baseTodo: Todo = {
    id: 'todo-1',
    kind: 'question',
    scope: 'session',
    title: 'Which db?',
    body: '',
    sessionId: 'session-1',
    createdBy: { workerId: 'worker-1' },
    assigneeUserId: null,
    status: 'done',
    resolutionText: null,
    resolvedByUserId: 'user-1',
    resolvedByWorkerId: null,
    resolvedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  function makeDeps() {
    const deliverWorkerNotification = mock<SessionManager['deliverWorkerNotification']>(async () => ({ ok: true }));
    return { deliverWorkerNotification };
  }

  it('does not call the seam for a human-created item', async () => {
    const deps = makeDeps();
    const result = await deliverTodoResolution(deps, { ...baseTodo, createdBy: { userId: 'user-2' } }, 'text');
    expect(result).toBeUndefined();
    expect(deps.deliverWorkerNotification).not.toHaveBeenCalled();
  });

  it('calls the seam with the exact notification for an agent-created item and returns its result', async () => {
    const deps = makeDeps();
    const result = await deliverTodoResolution(deps, baseTodo, 'use sqlite');
    expect(result).toEqual({ ok: true });
    expect(deps.deliverWorkerNotification).toHaveBeenCalledTimes(1);
    expect(deps.deliverWorkerNotification).toHaveBeenCalledWith('session-1', 'worker-1', {
      kind: 'internal-todo-resolved',
      tag: 'internal:todo-resolved',
      fields: { todoId: 'todo-1', todoKind: 'question', title: 'Which db?', resolution: 'use sqlite' },
      intent: 'triage',
    });
  });

  function resolutionOf(deps: ReturnType<typeof makeDeps>): string {
    const params = deps.deliverWorkerNotification.mock.calls[0][2];
    if (!('resolution' in params.fields)) throw new Error('not a todo-resolved notification');
    return params.fields.resolution;
  }

  it('passes a 500-char resolution through unchanged', async () => {
    const deps = makeDeps();
    await deliverTodoResolution(deps, baseTodo, 'a'.repeat(500));
    expect(resolutionOf(deps)).toBe('a'.repeat(500));
    expect(resolutionOf(deps).length).toBe(500);
  });

  it('truncates a 501-char resolution to 500 chars plus "..."', async () => {
    const deps = makeDeps();
    await deliverTodoResolution(deps, baseTodo, 'a'.repeat(501));
    expect(resolutionOf(deps)).toBe(`${'a'.repeat(500)}...`);
    expect(resolutionOf(deps).length).toBe(503);
  });

  it('keeps an empty resolution as an empty string field', async () => {
    const deps = makeDeps();
    await deliverTodoResolution(deps, { ...baseTodo, kind: 'action' }, '');
    const params = deps.deliverWorkerNotification.mock.calls[0][2];
    expect(params).toMatchObject({ fields: { todoKind: 'action', resolution: '' } });
    expect('resolution' in (params as { fields: object }).fields).toBe(true);
  });
});
