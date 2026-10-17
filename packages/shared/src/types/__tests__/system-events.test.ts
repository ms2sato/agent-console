import { describe, it, expect } from 'bun:test';
import { PTY_NOTIFICATION_KINDS } from '../system-events.js';

describe('PTY_NOTIFICATION_KINDS', () => {
  it('includes the todo notification kinds, in order after the worker-interrupted kind', () => {
    const kinds = [...PTY_NOTIFICATION_KINDS];
    const interrupted = kinds.indexOf('internal-worker-interrupted');
    expect(kinds.slice(interrupted + 1)).toEqual(['internal-todo-resolved', 'internal-todo-comment']);
  });

  it('has no duplicate kind', () => {
    expect(new Set(PTY_NOTIFICATION_KINDS).size).toBe(PTY_NOTIFICATION_KINDS.length);
  });
});
