import { describe, it, expect } from 'bun:test';
import type { AppServerMessage } from '@agent-console/shared';
import { emitTodosUpdated } from '../todo-triggers.js';

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
