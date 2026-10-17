import * as v from 'valibot';
import { TODO_KINDS, TODO_SCOPES, TODO_STATUSES } from '../types/todo.js';

/** Maximum title length: one scannable line (same cap as bookmark / artifact titles). */
const MAX_TODO_TITLE_LENGTH = 200;

/**
 * Who created an item: an agent (the worker is the resolution
 * notification's target) or a human, never both.
 */
export const TodoCreatorSchema = v.union([
  v.strictObject({ workerId: v.pipe(v.string(), v.minLength(1)) }),
  v.strictObject({ userId: v.pipe(v.string(), v.minLength(1)) }),
]);

export type TodoCreator = v.InferOutput<typeof TodoCreatorSchema>;

/**
 * A TODO item as it crosses the wire, and the wire schema its `Todo` type is
 * derived from (the closed lists of `kind`, `scope` and `status` live in
 * `types/todo.ts`). `sessionId` is the item's session: required for
 * `scope = 'session'` and for an agent creator, provenance otherwise (a
 * `global` item may still carry it).
 *
 * Strict, so a server response that adds or drops a field fails to parse
 * instead of failing silently at the client (see
 * `.claude/rules/pre-pr-completeness.md` Q10).
 */
export const TodoSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  kind: v.picklist(TODO_KINDS),
  scope: v.picklist(TODO_SCOPES),
  title: v.string(),
  body: v.string(),
  sessionId: v.nullable(v.string()),
  createdBy: TodoCreatorSchema,
  assigneeUserId: v.nullable(v.string()),
  status: v.picklist(TODO_STATUSES),
  resolutionText: v.nullable(v.string()),
  // The human whose decision this is. For an agent-recorded resolution: the
  // person the agent attributes the quoted words to.
  resolvedByUserId: v.nullable(v.string()),
  // The agent worker that recorded a human's statement; null when a human
  // resolved the item in the UI.
  resolvedByWorkerId: v.nullable(v.string()),
  resolvedAt: v.nullable(v.string()),
  // Comments on the item, never moves; a derived count, not a stored column.
  commentCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  createdAt: v.string(),
  updatedAt: v.string(),
});

export type Todo = v.InferOutput<typeof TodoSchema>;

/** Wire schema for `GET /api/todos`'s list response. */
export const TodosListResponseSchema = v.strictObject({
  todos: v.array(TodoSchema),
});

export type TodosListResponse = v.InferOutput<typeof TodosListResponseSchema>;

/** Wire schema for the single-item responses (create, update, resolve, dismiss). */
export const TodoResponseSchema = v.strictObject({
  todo: TodoSchema,
});

export type TodoResponse = v.InferOutput<typeof TodoResponseSchema>;

/** Who acted: a human in the UI or an agent worker through MCP, never both. */
export const TodoActivityActorSchema = v.union([
  v.strictObject({ userId: v.pipe(v.string(), v.minLength(1)) }),
  v.strictObject({ workerId: v.pipe(v.string(), v.minLength(1)) }),
]);

export type TodoActivityActor = v.InferOutput<typeof TodoActivityActorSchema>;

/**
 * Words left on an item by a human (UI) or by an agent of the item's session
 * (MCP). Each kind of activity has its own table (`todo_comments`,
 * `todo_moves`) and its own member of {@link TodoActivitySchema}.
 */
export const TodoCommentActivitySchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  todoId: v.pipe(v.string(), v.minLength(1)),
  kind: v.literal('comment'),
  actor: TodoActivityActorSchema,
  text: v.string(),
  createdAt: v.string(),
});

export type TodoCommentActivity = v.InferOutput<typeof TodoCommentActivitySchema>;

/**
 * A change of the item's session. `statement` is the human's quoted
 * instruction when an agent moved the item on it (null when none was given);
 * `attributedUserId` names whose words they are and is set only with a
 * statement.
 */
export const TodoMoveActivitySchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  todoId: v.pipe(v.string(), v.minLength(1)),
  kind: v.literal('moved'),
  actor: TodoActivityActorSchema,
  // Null when the item had no session before the move.
  fromSessionId: v.nullable(v.string()),
  toSessionId: v.string(),
  statement: v.nullable(v.string()),
  attributedUserId: v.nullable(v.string()),
  createdAt: v.string(),
});

export type TodoMoveActivity = v.InferOutput<typeof TodoMoveActivitySchema>;

/**
 * One entry of an item's timeline, discriminated by `kind`
 * (`TODO_ACTIVITY_KINDS`, the client's exhaustiveness constant).
 */
export const TodoActivitySchema = v.variant('kind', [TodoCommentActivitySchema, TodoMoveActivitySchema]);

export type TodoActivity = v.InferOutput<typeof TodoActivitySchema>;

/**
 * Wire schema for the detail responses (`GET /api/todos/:id`,
 * `POST /api/todos/:id/comments`): the item and its timeline, already in the
 * database's order (created_at, then kind, then id). Clients do not sort.
 */
export const TodoDetailResponseSchema = v.strictObject({
  todo: TodoSchema,
  activities: v.array(TodoActivitySchema),
});

export type TodoDetailResponse = v.InferOutput<typeof TodoDetailResponseSchema>;

/** Maximum length of one comment (REST request schema and the `comment_todo` MCP tool). */
export const MAX_TODO_COMMENT_LENGTH = 4000;

/** Request body for `POST /api/todos/:id/comments`. */
export const CommentTodoRequestSchema = v.strictObject({
  text: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Comment text is required'),
    v.maxLength(MAX_TODO_COMMENT_LENGTH, `Comment must be at most ${MAX_TODO_COMMENT_LENGTH} characters`),
  ),
});

export type CommentTodoRequest = v.InferOutput<typeof CommentTodoRequestSchema>;

const TodoTitleSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, 'Title is required'),
  v.maxLength(MAX_TODO_TITLE_LENGTH, `Title must be at most ${MAX_TODO_TITLE_LENGTH} characters`),
);

/**
 * Request body for `POST /api/todos` (human create). `scope` is optional: the
 * server defaults it to `session` when `sessionId` is present and `global`
 * otherwise. `assigneeUserId` omitted or null means anyone on the team.
 */
export const CreateTodoRequestSchema = v.strictObject({
  kind: v.picklist(TODO_KINDS),
  scope: v.optional(v.picklist(TODO_SCOPES)),
  title: TodoTitleSchema,
  body: v.string(),
  sessionId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'sessionId must not be empty'))),
  assigneeUserId: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1)))),
});

export type CreateTodoRequest = v.InferOutput<typeof CreateTodoRequestSchema>;

/**
 * Request body for `PATCH /api/todos/:id` (open items only). `scope` and
 * `sessionId` implement re-scoping; the server enforces its refusals.
 * `assigneeUserId: null` clears the assignment.
 */
export const UpdateTodoRequestSchema = v.strictObject({
  title: v.optional(TodoTitleSchema),
  body: v.optional(v.string()),
  assigneeUserId: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1)))),
  scope: v.optional(v.picklist(TODO_SCOPES)),
  sessionId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'sessionId must not be empty'))),
});

export type UpdateTodoRequest = v.InferOutput<typeof UpdateTodoRequestSchema>;

/** Request body for `POST /api/todos/:id/resolve`. `text` is required for a question. */
export const ResolveTodoRequestSchema = v.strictObject({
  text: v.optional(v.string()),
});

export type ResolveTodoRequest = v.InferOutput<typeof ResolveTodoRequestSchema>;
