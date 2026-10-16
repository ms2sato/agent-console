import { describe, it, expect } from 'bun:test';
import { makeTodo } from '../../../test/todo-fixtures';
import { usernameOf, creatorLabel } from '../todo-labels';

const USERS = [{ id: 'user-bob', username: 'bob' }];

// Mutation: dropping the 'unknown user' fallback -> 'falls back ...' fails;
// treating every creator as a user -> 'labels an agent creator' fails.
describe('todo-labels', () => {
  it('resolves a user id to its username', () => {
    expect(usernameOf(USERS, 'user-bob')).toBe('bob');
  });

  it('falls back to "unknown user" for an id outside the directory', () => {
    expect(usernameOf(USERS, 'user-gone')).toBe('unknown user');
  });

  it('labels a human creator by username', () => {
    expect(creatorLabel(makeTodo({ createdBy: { userId: 'user-bob' } }), USERS)).toBe('bob');
  });

  it('labels an agent creator as an agent', () => {
    expect(creatorLabel(makeTodo({ createdBy: { workerId: 'worker-1' } }), USERS)).toBe('an agent');
  });
});
