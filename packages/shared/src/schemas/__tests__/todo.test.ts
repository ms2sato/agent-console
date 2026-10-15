import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  TodoSchema,
  TodosListResponseSchema,
  TodoResponseSchema,
  CreateTodoRequestSchema,
  UpdateTodoRequestSchema,
  ResolveTodoRequestSchema,
} from '../todo.js';
import { TODO_KINDS, TODO_SCOPES, TODO_STATUSES } from '../../types/todo.js';
import type { Todo } from '../../types/todo.js';
import type { TodoSchemaOutput } from '../todo.js';

const humanTodo: Todo = {
  id: 'todo-1',
  kind: 'action',
  scope: 'session',
  title: 'Run the migration',
  body: '```terminal\nbun run migrate\n```',
  sessionId: 'session-1',
  createdBy: { userId: 'user-1' },
  assigneeUserId: null,
  status: 'open',
  resolutionText: null,
  resolvedByUserId: null,
  resolvedAt: null,
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T00:00:00.000Z',
};

describe('TodoSchema', () => {
  it('accepts a Todo constructed as the shared type (schema and type stay in sync)', () => {
    const result = v.safeParse(TodoSchema, humanTodo);
    expect(result.success).toBe(true);
    if (result.success) expect(result.output).toEqual(humanTodo);
  });

  it('accepts an agent creator, a global item with null sessionId, and the withdrawn status', () => {
    const agentTodo: Todo = {
      ...humanTodo,
      scope: 'global',
      sessionId: null,
      createdBy: { userId: 'user-1' },
      status: 'withdrawn',
    };
    expect(v.safeParse(TodoSchema, agentTodo).success).toBe(true);
    expect(v.safeParse(TodoSchema, { ...humanTodo, createdBy: { workerId: 'worker-1' } }).success).toBe(true);
  });

  it('rejects an unknown field (strict object)', () => {
    expect(v.safeParse(TodoSchema, { ...humanTodo, extra: 1 }).success).toBe(false);
  });

  it('rejects a creator carrying both or neither identity', () => {
    expect(v.safeParse(TodoSchema, { ...humanTodo, createdBy: { workerId: 'w', userId: 'u' } }).success).toBe(false);
    expect(v.safeParse(TodoSchema, { ...humanTodo, createdBy: {} }).success).toBe(false);
  });

  it.each([
    ['kind', { kind: 'reminder' }],
    ['scope', { scope: 'team' }],
    ['status', { status: 'expired' }],
  ])('rejects a %s outside its closed list', (_name, override) => {
    expect(v.safeParse(TodoSchema, { ...humanTodo, ...override }).success).toBe(false);
  });

  it('rejects a missing required field', () => {
    const { title: _title, ...withoutTitle } = humanTodo;
    expect(v.safeParse(TodoSchema, withoutTitle).success).toBe(false);
  });
});

describe('list / single response schemas', () => {
  it('accepts an empty list and a list of Todos', () => {
    expect(v.safeParse(TodosListResponseSchema, { todos: [] }).success).toBe(true);
    expect(v.safeParse(TodosListResponseSchema, { todos: [humanTodo] }).success).toBe(true);
  });

  it('rejects an extra key and accepts the single-item envelope', () => {
    expect(v.safeParse(TodosListResponseSchema, { todos: [], extra: true }).success).toBe(false);
    expect(v.safeParse(TodoResponseSchema, { todo: humanTodo }).success).toBe(true);
  });
});

describe('CreateTodoRequestSchema', () => {
  it('accepts the minimal request (scope, sessionId, assignee all optional)', () => {
    const result = v.safeParse(CreateTodoRequestSchema, { kind: 'action', title: ' Do it ', body: '' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.output.title).toBe('Do it');
  });

  it('accepts scope, sessionId and a null assignee', () => {
    expect(
      v.safeParse(CreateTodoRequestSchema, {
        kind: 'question', scope: 'session', title: 't', body: 'b', sessionId: 's', assigneeUserId: null,
      }).success,
    ).toBe(true);
  });

  it.each([
    ['empty title', { kind: 'action', title: '  ', body: 'b' }],
    ['overlong title', { kind: 'action', title: 'x'.repeat(201), body: 'b' }],
    ['unknown kind', { kind: 'note', title: 't', body: 'b' }],
    ['unknown scope', { kind: 'action', scope: 'team', title: 't', body: 'b' }],
    ['empty sessionId', { kind: 'action', title: 't', body: 'b', sessionId: '' }],
    ['unknown field', { kind: 'action', title: 't', body: 'b', status: 'done' }],
    ['missing body', { kind: 'action', title: 't' }],
  ])('rejects %s', (_name, input) => {
    expect(v.safeParse(CreateTodoRequestSchema, input).success).toBe(false);
  });
});

describe('UpdateTodoRequestSchema', () => {
  it('accepts an empty patch and every editable field', () => {
    expect(v.safeParse(UpdateTodoRequestSchema, {}).success).toBe(true);
    expect(
      v.safeParse(UpdateTodoRequestSchema, {
        title: 't', body: 'b', assigneeUserId: null, scope: 'global', sessionId: 's',
      }).success,
    ).toBe(true);
  });

  it('rejects status (resolution has its own endpoints) and an empty title', () => {
    expect(v.safeParse(UpdateTodoRequestSchema, { status: 'done' }).success).toBe(false);
    expect(v.safeParse(UpdateTodoRequestSchema, { title: ' ' }).success).toBe(false);
  });
});

describe('ResolveTodoRequestSchema', () => {
  it('accepts no text and a text; rejects other fields', () => {
    expect(v.safeParse(ResolveTodoRequestSchema, {}).success).toBe(true);
    expect(v.safeParse(ResolveTodoRequestSchema, { text: 'done' }).success).toBe(true);
    expect(v.safeParse(ResolveTodoRequestSchema, { status: 'done' }).success).toBe(false);
  });
});

// Type-level pin: the schema's output and the `Todo` interface stay mutually
// assignable. `Assert<T extends true>` genuinely fails `tsc` when false (a
// `declare const x: never` pin would be inert; see workflow.md "pins include
// type-level assertions").
type Assert<T extends true> = T;
type _SchemaOutputIsTodo = Assert<TodoSchemaOutput extends Todo ? true : false>;
type _TodoIsSchemaOutput = Assert<Todo extends TodoSchemaOutput ? true : false>;
export type { _SchemaOutputIsTodo, _TodoIsSchemaOutput };

describe('closed lists vs TodoSchema', () => {
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
