import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  TodoSchema,
  TodosListResponseSchema,
  TodoResponseSchema,
  CreateTodoRequestSchema,
  UpdateTodoRequestSchema,
  ResolveTodoRequestSchema,
  TodoActivitySchema,
  TodoCommentActivitySchema,
  TodoMoveActivitySchema,
  TodoDetailResponseSchema,
  CommentTodoRequestSchema,
} from '../todo.js';
import { TODO_ACTIVITY_KINDS, TODO_KINDS, TODO_SCOPES, TODO_STATUSES } from '../../types/todo.js';
import type {
  Todo,
  TodoActivity,
  TodoCommentActivity,
  TodoMoveActivity,
} from '../../types/todo.js';
import type { TodoActivitySchemaOutput, TodoSchemaOutput } from '../todo.js';

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
  resolvedByWorkerId: null,
  resolvedAt: null,
  commentCount: 0,
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T00:00:00.000Z',
};

const comment: TodoCommentActivity = {
  id: 'c-1',
  todoId: 'todo-1',
  kind: 'comment',
  actor: { userId: 'user-1' },
  text: 'Which database?',
  createdAt: '2026-10-17T00:00:00.000Z',
};

const move: TodoMoveActivity = {
  id: 'm-1',
  todoId: 'todo-1',
  kind: 'moved',
  actor: { workerId: 'worker-1' },
  fromSessionId: 'session-1',
  toSessionId: 'session-2',
  statement: 'take it over',
  attributedUserId: 'user-1',
  createdAt: '2026-10-17T00:01:00.000Z',
};

describe('TodoSchema', () => {
  it('accepts a Todo constructed as the shared type (schema and type stay in sync)', () => {
    const result = v.safeParse(TodoSchema, humanTodo);
    expect(result.success).toBe(true);
    if (result.success) expect(result.output).toEqual(humanTodo);
  });

  it('accepts an agent creator, a global item with null sessionId, and the withdrawn status', () => {
    const globalHumanTodo: Todo = {
      ...humanTodo,
      scope: 'global',
      sessionId: null,
      createdBy: { userId: 'user-1' },
      status: 'withdrawn',
    };
    const globalAgentTodo: Todo = {
      ...humanTodo,
      scope: 'global',
      sessionId: 'session-1',
      createdBy: { workerId: 'worker-1' },
      status: 'withdrawn',
    };
    expect(v.safeParse(TodoSchema, globalHumanTodo).success).toBe(true);
    expect(v.safeParse(TodoSchema, globalAgentTodo).success).toBe(true);
    expect(v.safeParse(TodoSchema, { ...humanTodo, createdBy: { workerId: 'worker-1' } }).success).toBe(true);
  });

  it('accepts resolvedByWorkerId both null and set (an agent-recorded resolution)', () => {
    expect(v.safeParse(TodoSchema, { ...humanTodo, resolvedByWorkerId: null }).success).toBe(true);
    const recorded: Todo = {
      ...humanTodo,
      status: 'done',
      resolutionText: 'ok to merge',
      resolvedByUserId: 'user-1',
      resolvedByWorkerId: 'worker-9',
      resolvedAt: '2026-10-16T00:00:00.000Z',
    };
    const result = v.safeParse(TodoSchema, recorded);
    expect(result.success).toBe(true);
    if (result.success) expect(result.output.resolvedByWorkerId).toBe('worker-9');
  });

  it('rejects a payload missing resolvedByWorkerId (strict wire contract)', () => {
    const { resolvedByWorkerId: _worker, ...withoutWorker } = humanTodo;
    expect(v.safeParse(TodoSchema, withoutWorker).success).toBe(false);
  });

  it('rejects a non-string resolvedByWorkerId', () => {
    expect(v.safeParse(TodoSchema, { ...humanTodo, resolvedByWorkerId: 7 }).success).toBe(false);
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

  it('requires commentCount: a non-negative integer', () => {
    const { commentCount: _count, ...withoutCount } = humanTodo;
    expect(v.safeParse(TodoSchema, withoutCount).success).toBe(false);
    expect(v.safeParse(TodoSchema, { ...humanTodo, commentCount: 3 }).success).toBe(true);
    expect(v.safeParse(TodoSchema, { ...humanTodo, commentCount: -1 }).success).toBe(false);
    expect(v.safeParse(TodoSchema, { ...humanTodo, commentCount: 1.5 }).success).toBe(false);
    expect(v.safeParse(TodoSchema, { ...humanTodo, commentCount: '1' }).success).toBe(false);
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

describe('TodoActivitySchema', () => {
  it('accepts a comment and a move built as the shared types, and returns them unchanged', () => {
    for (const activity of [comment, move] satisfies TodoActivity[]) {
      const result = v.safeParse(TodoActivitySchema, activity);
      expect(result.success).toBe(true);
      if (result.success) expect(result.output).toEqual(activity);
    }
  });

  it('accepts a worker or user actor on either variant, and a move from no session without a statement', () => {
    expect(v.safeParse(TodoActivitySchema, { ...comment, actor: { workerId: 'w' } }).success).toBe(true);
    expect(v.safeParse(TodoActivitySchema, { ...move, actor: { userId: 'u' } }).success).toBe(true);
    expect(
      v.safeParse(TodoActivitySchema, { ...move, fromSessionId: null, statement: null, attributedUserId: null }).success,
    ).toBe(true);
  });

  // Variant polarity: `v.variant('kind', ...)` dispatches on the discriminant,
  // so a payload carrying the OTHER variant's field set is judged against its
  // own variant and rejected there (a plain union of loose objects would not).
  it('rejects a comment payload carrying toSessionId (strict: the move field set is not a comment)', () => {
    expect(v.safeParse(TodoActivitySchema, { ...comment, toSessionId: 'session-2' }).success).toBe(false);
    expect(v.safeParse(TodoCommentActivitySchema, { ...comment, toSessionId: 'session-2' }).success).toBe(false);
  });

  it('rejects a move payload missing toSessionId', () => {
    const { toSessionId: _to, ...withoutTo } = move;
    expect(v.safeParse(TodoActivitySchema, withoutTo).success).toBe(false);
    expect(v.safeParse(TodoMoveActivitySchema, withoutTo).success).toBe(false);
  });

  it('rejects a move payload carrying text, a comment payload missing text, and a null toSessionId', () => {
    expect(v.safeParse(TodoActivitySchema, { ...move, text: 'x' }).success).toBe(false);
    const { text: _text, ...withoutText } = comment;
    expect(v.safeParse(TodoActivitySchema, withoutText).success).toBe(false);
    expect(v.safeParse(TodoActivitySchema, { ...move, toSessionId: null }).success).toBe(false);
  });

  it('rejects an unknown kind, a missing kind, an actor with both or neither identity, and an unknown field', () => {
    expect(v.safeParse(TodoActivitySchema, { ...comment, kind: 'reply' }).success).toBe(false);
    const { kind: _kind, ...withoutKind } = comment;
    expect(v.safeParse(TodoActivitySchema, withoutKind).success).toBe(false);
    expect(v.safeParse(TodoActivitySchema, { ...comment, actor: { userId: 'u', workerId: 'w' } }).success).toBe(false);
    expect(v.safeParse(TodoActivitySchema, { ...comment, actor: {} }).success).toBe(false);
    expect(v.safeParse(TodoActivitySchema, { ...comment, extra: 1 }).success).toBe(false);
    expect(v.safeParse(TodoActivitySchema, { ...move, extra: 1 }).success).toBe(false);
  });

  it('accepts exactly the kinds of TODO_ACTIVITY_KINDS', () => {
    expect([...TODO_ACTIVITY_KINDS]).toEqual(['comment', 'moved']);
    const byKind = { comment, moved: move };
    for (const kind of TODO_ACTIVITY_KINDS) {
      expect(v.safeParse(TodoActivitySchema, byKind[kind]).success).toBe(true);
    }
  });
});

describe('TodoDetailResponseSchema', () => {
  it('accepts an item with no activities and with both kinds, in the order given', () => {
    expect(v.safeParse(TodoDetailResponseSchema, { todo: humanTodo, activities: [] }).success).toBe(true);
    const result = v.safeParse(TodoDetailResponseSchema, { todo: { ...humanTodo, commentCount: 1 }, activities: [move, comment] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.output.activities.map((a) => a.id)).toEqual(['m-1', 'c-1']);
  });

  it('rejects a missing activities key, an extra key, and an invalid activity', () => {
    expect(v.safeParse(TodoDetailResponseSchema, { todo: humanTodo }).success).toBe(false);
    expect(v.safeParse(TodoDetailResponseSchema, { todo: humanTodo, activities: [], extra: 1 }).success).toBe(false);
    expect(
      v.safeParse(TodoDetailResponseSchema, { todo: humanTodo, activities: [{ ...comment, toSessionId: 's' }] }).success,
    ).toBe(false);
  });
});

describe('CommentTodoRequestSchema', () => {
  it('trims the text and accepts up to 4000 characters', () => {
    const result = v.safeParse(CommentTodoRequestSchema, { text: '  need the staging DB  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.output.text).toBe('need the staging DB');
    expect(v.safeParse(CommentTodoRequestSchema, { text: 'x'.repeat(4000) }).success).toBe(true);
  });

  it.each([
    ['empty text', { text: '' }],
    ['whitespace-only text', { text: '  \n ' }],
    ['overlong text', { text: 'x'.repeat(4001) }],
    ['missing text', {}],
    ['non-string text', { text: 7 }],
    ['unknown field', { text: 'ok', kind: 'comment' }],
  ])('rejects %s', (_name, input) => {
    expect(v.safeParse(CommentTodoRequestSchema, input).success).toBe(false);
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

// The same pin for the activity union, in both directions, for the whole union
// and for each member separately (the whole-union form alone would accept a
// field that moved from one member to the other).
//
// Reach, measured by introducing each drift and reading `tsc --noEmit`
// (the failing pins, by name; none of these pins is inert):
//  - a field added to `TodoMoveActivity` only:
//      _ActivityOutputIsActivity and _MoveOutputIsMove (TS2344)
//  - `attributedUserId` dropped from `TodoMoveActivitySchema`:
//      _ActivityOutputIsActivity and _MoveOutputIsMove
//  - `TodoMoveActivity.toSessionId` widened to `string | null`:
//      _ActivityIsActivityOutput and _MoveIsMoveOutput
//  - `text` dropped from `TodoCommentActivitySchema`:
//      _ActivityOutputIsActivity and _CommentOutputIsComment
// The per-member pins are the ones that name which member drifted; the
// OutputIs* direction catches a field the type has and the schema lacks, the
// Is*Output direction catches a type the schema would reject.
type CommentOutput = Extract<TodoActivitySchemaOutput, { kind: 'comment' }>;
type MoveOutput = Extract<TodoActivitySchemaOutput, { kind: 'moved' }>;
type _ActivityOutputIsActivity = Assert<TodoActivitySchemaOutput extends TodoActivity ? true : false>;
type _ActivityIsActivityOutput = Assert<TodoActivity extends TodoActivitySchemaOutput ? true : false>;
type _CommentOutputIsComment = Assert<CommentOutput extends TodoCommentActivity ? true : false>;
type _CommentIsCommentOutput = Assert<TodoCommentActivity extends CommentOutput ? true : false>;
type _MoveOutputIsMove = Assert<MoveOutput extends TodoMoveActivity ? true : false>;
type _MoveIsMoveOutput = Assert<TodoMoveActivity extends MoveOutput ? true : false>;
export type {
  _ActivityOutputIsActivity,
  _ActivityIsActivityOutput,
  _CommentOutputIsComment,
  _CommentIsCommentOutput,
  _MoveOutputIsMove,
  _MoveIsMoveOutput,
};

describe('closed lists vs TodoSchema', () => {
  it('are exactly what TodoSchema accepts', () => {
    const base = {
      id: 'i', kind: 'action', scope: 'session', title: 't', body: 'b', sessionId: 's',
      createdBy: { userId: 'u' }, assigneeUserId: null, status: 'open', resolutionText: null,
      resolvedByUserId: null, resolvedByWorkerId: null, resolvedAt: null, commentCount: 0,
      createdAt: 'c', updatedAt: 'u',
    };
    for (const kind of TODO_KINDS) expect(v.safeParse(TodoSchema, { ...base, kind }).success).toBe(true);
    for (const scope of TODO_SCOPES) expect(v.safeParse(TodoSchema, { ...base, scope }).success).toBe(true);
    for (const status of TODO_STATUSES) expect(v.safeParse(TodoSchema, { ...base, status }).success).toBe(true);
  });
});
