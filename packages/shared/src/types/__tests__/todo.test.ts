import { describe, it, expect } from 'bun:test';
import { TODO_ACTIVITY_KINDS, TODO_KINDS, TODO_SCOPES, TODO_STATUSES } from '../todo.js';

describe('closed lists', () => {
  it('pin the exact members the SQL CHECK constraints allow', () => {
    expect([...TODO_KINDS]).toEqual(['question', 'action']);
    expect([...TODO_SCOPES]).toEqual(['session', 'global']);
    expect([...TODO_STATUSES]).toEqual(['open', 'done', 'superseded', 'dismissed', 'withdrawn']);
  });
});

describe('TODO_ACTIVITY_KINDS', () => {
  it('lists one kind per activity table: comment (todo_comments) and moved (todo_moves)', () => {
    expect([...TODO_ACTIVITY_KINDS]).toEqual(['comment', 'moved']);
  });
});
