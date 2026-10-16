import type { Kysely } from 'kysely';
import type { Todo, TodoCreator, TodoKind, TodoScope, TodoStatus } from '@agent-console/shared';
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
}

/** Editable fields of an open item. An omitted key is left unchanged. */
export interface UpdateTodoParams {
  title?: string;
  body?: string;
  assigneeUserId?: string | null;
  scope?: TodoScope;
  sessionId?: string | null;
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
 * Thrown by a caller of {@link TodoRepository.resolveManyOpen} when some ids
 * were not open items of the session; throwing inside the transaction rolls
 * the whole resolution back.
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
   * Record a resolution: status becomes `done`. A second resolution appends
   * its text after {@link TODO_RESOLUTION_SEPARATOR}, moves `resolvedAt`, and
   * the status stays `done`. Null when the item does not exist or is neither
   * `open` nor `done`. `resolvedByWorkerId` is replaced on every resolution
   * (absent clears it): the latest resolver is the record.
   */
  resolve(id: string, params: ResolveTodoParams, executor?: TodoExecutor): Promise<Todo | null>;

  /**
   * Resolve every item of `ids` that is `open` and belongs to `params.sessionId`
   * in the caller's transaction, and return the rows actually updated. Any
   * other id (unknown, not open, another session's) is silently skipped, so
   * the caller refuses when `rows.length !== ids.length` (after deduplicating)
   * and lets its transaction roll back.
   */
  resolveManyOpen(ids: string[], params: ResolveManyOpenParams, executor: TodoExecutor): Promise<Todo[]>;

  /** Run `fn` in ONE transaction: it commits when `fn` resolves and rolls back when it throws. */
  inTransaction<T>(fn: (trx: TodoExecutor) => Promise<T>): Promise<T>;

  /** `open` to `dismissed`. Null when the item does not exist or is not open. */
  dismiss(id: string, executor?: TodoExecutor): Promise<Todo | null>;

  /** Hard delete. True when a row was removed. */
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
