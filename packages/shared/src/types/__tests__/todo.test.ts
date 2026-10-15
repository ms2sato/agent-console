import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import { TODO_KINDS, TODO_SCOPES, TODO_STATUSES } from '../todo.js';
import { TodoSchema, type TodoSchemaOutput } from '../../schemas/todo.js';
import type { Todo } from '../todo.js';

// Type-level pin: the schema's output and the `Todo` interface stay mutually
// assignable. `Assert<T extends true>` genuinely fails `tsc` when false (a
// `declare const x: never` pin would be inert; see workflow.md "pins include
// type-level assertions").
type Assert<T extends true> = T;
type _SchemaOutputIsTodo = Assert<TodoSchemaOutput extends Todo ? true : false>;
type _TodoIsSchemaOutput = Assert<Todo extends TodoSchemaOutput ? true : false>;
export type { _SchemaOutputIsTodo, _TodoIsSchemaOutput };

describe('closed lists', () => {
  it('pin the exact members the SQL CHECK constraints allow', () => {
    expect([...TODO_KINDS]).toEqual(['question', 'action']);
    expect([...TODO_SCOPES]).toEqual(['session', 'global']);
    expect([...TODO_STATUSES]).toEqual(['open', 'done', 'superseded', 'dismissed', 'withdrawn']);
  });

  it('are exactly what TodoSchema accepts', () => {
    const base = {
      id: 'i', kind: 'action', scope: 'session', title: 't', body: 'b', sessionId: 's',
      createdBy: { userId: 'u' }, assigneeUserId: null, status: 'open', resolutionText: null,
      resolvedByUserId: null, resolvedAt: null, createdAt: 'c', updatedAt: 'u',
    };
    for (const kind of TODO_KINDS) expect(v.safeParse(TodoSchema, { ...base, kind }).success).toBe(true);
    for (const scope of TODO_SCOPES) expect(v.safeParse(TodoSchema, { ...base, scope }).success).toBe(true);
    for (const status of TODO_STATUSES) expect(v.safeParse(TodoSchema, { ...base, status }).success).toBe(true);
  });
});
