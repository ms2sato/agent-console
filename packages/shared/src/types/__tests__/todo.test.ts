import { describe, it, expect } from 'bun:test';
import { TODO_KINDS, TODO_SCOPES, TODO_STATUSES } from '../todo.js';

describe('closed lists', () => {
  it('pin the exact members the SQL CHECK constraints allow', () => {
    expect([...TODO_KINDS]).toEqual(['question', 'action']);
    expect([...TODO_SCOPES]).toEqual(['session', 'global']);
    expect([...TODO_STATUSES]).toEqual(['open', 'done', 'superseded', 'dismissed', 'withdrawn']);
  });
});
