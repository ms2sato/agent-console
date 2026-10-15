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
  resolvedByUserId: string;
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
   * `open` nor `done`.
   */
  resolve(id: string, params: ResolveTodoParams, executor?: TodoExecutor): Promise<Todo | null>;

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
