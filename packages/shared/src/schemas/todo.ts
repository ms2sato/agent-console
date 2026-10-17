import * as v from 'valibot';
import { TODO_KINDS, TODO_SCOPES, TODO_STATUSES } from '../types/todo.js';

/** Maximum title length: one scannable line (same cap as bookmark / artifact titles). */
const MAX_TODO_TITLE_LENGTH = 200;

const TodoCreatorSchema = v.union([
  v.strictObject({ workerId: v.pipe(v.string(), v.minLength(1)) }),
  v.strictObject({ userId: v.pipe(v.string(), v.minLength(1)) }),
]);

/**
 * Wire schema for the `Todo` shape. Mirrors `types/todo.ts`'s `Todo`
 * field-for-field so a server response that adds or drops a field fails to
 * parse instead of failing silently at the client (see
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
  resolvedByUserId: v.nullable(v.string()),
  resolvedByWorkerId: v.nullable(v.string()),
  resolvedAt: v.nullable(v.string()),
  commentCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  createdAt: v.string(),
  updatedAt: v.string(),
});

export type TodoSchemaOutput = v.InferOutput<typeof TodoSchema>;

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

const TodoActivityActorSchema = v.union([
  v.strictObject({ userId: v.pipe(v.string(), v.minLength(1)) }),
  v.strictObject({ workerId: v.pipe(v.string(), v.minLength(1)) }),
]);

/** Wire schema for a comment on an item. Mirrors `TodoCommentActivity` field-for-field. */
export const TodoCommentActivitySchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  todoId: v.pipe(v.string(), v.minLength(1)),
  kind: v.literal('comment'),
  actor: TodoActivityActorSchema,
  text: v.string(),
  createdAt: v.string(),
});

/** Wire schema for a change of an item's session. Mirrors `TodoMoveActivity` field-for-field. */
export const TodoMoveActivitySchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  todoId: v.pipe(v.string(), v.minLength(1)),
  kind: v.literal('moved'),
  actor: TodoActivityActorSchema,
  fromSessionId: v.nullable(v.string()),
  toSessionId: v.string(),
  statement: v.nullable(v.string()),
  attributedUserId: v.nullable(v.string()),
  createdAt: v.string(),
});

/** One entry of an item's timeline, discriminated by `kind` (`TODO_ACTIVITY_KINDS`). */
export const TodoActivitySchema = v.variant('kind', [TodoCommentActivitySchema, TodoMoveActivitySchema]);

export type TodoActivitySchemaOutput = v.InferOutput<typeof TodoActivitySchema>;

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
