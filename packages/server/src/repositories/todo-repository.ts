import type { Kysely } from 'kysely';
import type {
  Todo,
  TodoActivity,
  TodoActivityActor,
  TodoCommentActivity,
  TodoCreator,
  TodoKind,
  TodoMoveActivity,
  TodoScope,
  TodoStatus,
} from '@agent-console/shared';
import type { Database } from '../database/schema.js';

/**
 * Optional executor on every write: pass the `Transaction` of an enclosing
 * unit of work (like `SessionRepository.delete(id, trx)`) so the write
 * commits or rolls back with it. Absent: the repository's own handle.
 */
export type TodoExecutor = Kysely<Database>;

export interface CreateTodoParams {
  id: string;
  kind: TodoKind;
  scope: TodoScope;
  title: string;
  body: string;
  /** The item's session; the CHECK constraints require it for scope 'session' and for an agent creator. */
  sessionId: string | null;
  createdBy: TodoCreator;
  assigneeUserId: string | null;
}

export interface TodoListFilters {
  status?: TodoStatus;
  scope?: TodoScope;
  assigneeUserId?: string;
  sessionId?: string;
  /**
   * The default human view: only items assigned to `userId`, created by `userId`, or belonging to one of
   * `sessionIds`. Combines with the other filters (AND). An empty `sessionIds` drops the third branch.
   */
  visibleTo?: { userId: string; sessionIds: string[] };
}

/** Editable fields of an open item. An omitted key is left unchanged. */
export interface UpdateTodoParams {
  title?: string;
  body?: string;
  assigneeUserId?: string | null;
  scope?: TodoScope;
  sessionId?: string | null;
}

/** The session and worker an open item is re-targeted to by {@link TodoRepository.adopt}. */
export interface AdoptTodoParams {
  sessionId: string;
  /**
   * The worker that hears the resolution. Null is valid ONLY for a human-created item: the update
   * never reads it there (it keeps `created_worker_id` NULL). For an agent-created item the CHECK
   * `todos_creator_check` would fire, so the caller guarantees a worker.
   */
  workerId: string | null;
  /**
   * The `session_id` the caller read the item under (null for a session-less item).
   * The write applies only while the item is still there, so a concurrent adoption
   * is never overwritten.
   */
  expectedSessionId: string | null;
  /** Who moved the item; recorded on the `todo_moves` row written with the update. */
  actor: TodoActivityActor;
  /** The human's quoted instruction, when the move was made on one. Omitted: stored NULL. */
  statement?: string;
  /** The user whose words `statement` is. Valid only together with `statement` (CHECK `todo_moves_attribution_check`). */
  statedBy?: string;
}

/** What {@link TodoRepository.addComment} writes. `text` must be non-empty (CHECK). */
export interface AddTodoCommentParams {
  todoId: string;
  actor: TodoActivityActor;
  text: string;
}

/** What {@link TodoRepository.addMove} writes. `statement` must be non-empty when present (CHECK). */
export interface AddTodoMoveParams {
  todoId: string;
  actor: TodoActivityActor;
  /** The item's session before the move; null when it had none. */
  fromSessionId: string | null;
  toSessionId: string;
  statement: string | null;
  /** Whose words `statement` is; null when not attributed. Non-null only with a statement. */
  attributedUserId: string | null;
}

export interface ResolveTodoParams {
  /** Empty or omitted leaves any stored resolution text untouched. */
  text?: string;
  /** The human whose decision this is; null when an agent records a statement for a session with no owner. */
  resolvedByUserId: string | null;
  /** Set when an agent worker records a human's statement; omitted (stored null) for a human's own resolution. */
  resolvedByWorkerId?: string;
}

/** What {@link TodoRepository.resolveManyOpen} writes: one resolution applied to several items of ONE session. */
export interface ResolveManyOpenParams extends ResolveTodoParams {
  /** Only open items of this session are resolved. */
  sessionId: string;
}

/**
 * Thrown by {@link TodoRepository.createSuperseding} when the superseded item
 * is not an open item of the new item's session. Nothing is written.
 */
export class TodoSupersedeRefusedError extends Error {
  constructor(public readonly supersededId: string) {
    super(`Cannot supersede ${supersededId}: it is not an open item of this session`);
    this.name = 'TodoSupersedeRefusedError';
  }
}

/**
 * Thrown by {@link TodoRepository.resolveManyOpen} when some ids are not open
 * items of the session (unknown, not open, or another session's). Nothing is
 * written.
 */
export class TodoResolveRefusedError extends Error {
  constructor(public readonly refusedIds: string[]) {
    super(`Cannot resolve ${refusedIds.join(', ')}: not an open item of this session. Nothing was changed`);
    this.name = 'TodoResolveRefusedError';
  }
}

/** Separator between successive resolution texts of one item. */
export const TODO_RESOLUTION_SEPARATOR = '\n\n---\n\n';

export interface TodoRepository {
  create(params: CreateTodoParams, executor?: TodoExecutor): Promise<Todo>;

  /**
   * Create an item and mark `supersededId` superseded in ONE transaction.
   * Throws {@link TodoSupersedeRefusedError} (and writes nothing) unless
   * `supersededId` is an open item whose session is `params.sessionId`.
   */
  createSuperseding(params: CreateTodoParams, supersededId: string, executor?: TodoExecutor): Promise<Todo>;

  findById(id: string, executor?: TodoExecutor): Promise<Todo | null>;

  /** Matching items, newest first. No filters: every item. */
  list(filters: TodoListFilters, executor?: TodoExecutor): Promise<Todo[]>;

  /** Update the given fields of an OPEN item. Null when the item does not exist or is not open. */
  update(id: string, patch: UpdateTodoParams, executor?: TodoExecutor): Promise<Todo | null>;

  /**
   * Re-target an OPEN item to another session: `session_id` always;
   * `created_worker_id` only when the item is agent-created, so the creator's
   * kind never changes (CHECK `todos_creator_check`). Null when the item does
   * not exist, is not open, or no longer has `params.expectedSessionId` (compare-and-set).
   *
   * A successful move also writes its `todo_moves` row (from `expectedSessionId`,
   * to `params.sessionId`) in the SAME transaction: both happen or neither does.
   * A refused (null) adopt writes nothing.
   */
  adopt(id: string, params: AdoptTodoParams, executor?: TodoExecutor): Promise<Todo | null>;

  /**
   * Record a resolution: status becomes `done`. A second resolution appends
   * its text after {@link TODO_RESOLUTION_SEPARATOR}, moves `resolvedAt`, and
   * the status stays `done`. Null when the item does not exist or is neither
   * `open` nor `done`. `resolvedByWorkerId` is replaced on every resolution
   * (absent clears it): the latest resolver is the record.
   */
  resolve(id: string, params: ResolveTodoParams, executor?: TodoExecutor): Promise<Todo | null>;

  /**
   * Resolve every item of `ids` (deduplicated) in ONE transaction and return
   * the updated rows. Throws {@link TodoResolveRefusedError} (and writes
   * nothing) unless every id is an `open` item of `params.sessionId`. An empty
   * list is a no-op returning `[]`.
   */
  resolveManyOpen(ids: string[], params: ResolveManyOpenParams, executor?: TodoExecutor): Promise<Todo[]>;

  /** `open` to `dismissed`. Null when the item does not exist or is not open. */
  dismiss(id: string, executor?: TodoExecutor): Promise<Todo | null>;

  /**
   * Add a comment to an item, in ONE conditional statement: written only while the item exists and
   * is `open` or `done`. Null when it does not (deleted, or closed since the caller read it): nothing
   * is written, and the caller re-reads the item to say which.
   */
  addComment(params: AddTodoCommentParams, executor?: TodoExecutor): Promise<TodoCommentActivity | null>;

  /** Record a move of an item. The item must exist (foreign key). {@link adopt} writes its own. */
  addMove(params: AddTodoMoveParams, executor?: TodoExecutor): Promise<TodoMoveActivity>;

  /**
   * The item's timeline: comments and moves in ONE ordered query (UNION ALL),
   * ascending by `created_at`, then `kind` ('comment' before 'moved'), then
   * `id`. Empty for an item with none or an unknown id.
   */
  listActivities(todoId: string, executor?: TodoExecutor): Promise<TodoActivity[]>;

  /**
   * The timelines of several items in ONE ordered query per chunk of 500 ids (same UNION ALL as
   * {@link listActivities}, leading with `todo_id`). Every requested id is a key, with `[]` when it
   * has no activity. An empty list returns an empty Map without querying.
   */
  listActivitiesForTodos(todoIds: string[], executor?: TodoExecutor): Promise<Map<string, TodoActivity[]>>;

  /** Hard delete; the item's comments and moves go with it (foreign key cascade). True when a row was removed. */
  delete(id: string, executor?: TodoExecutor): Promise<boolean>;

  /** `open` to `superseded` for an item of `sessionId`. True when a row changed. */
  markSuperseded(id: string, sessionId: string, executor?: TodoExecutor): Promise<boolean>;

  /**
   * Session deletion: every open `session`-scoped item of `sessionId` becomes
   * `withdrawn` in one UPDATE. `global` items and non-open rows are untouched.
   * Returns the number of rows changed (0 for a session with no items).
   */
  withdrawOpenSessionScoped(sessionId: string, executor?: TodoExecutor): Promise<number>;
}
