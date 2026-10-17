import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import type { Todo, TodoActivity, TodoCommentActivity, TodoMoveActivity } from '@agent-console/shared';
import type { Database, TodoActivityRow } from '../database/schema.js';
import { toTodo, toTodoActivity } from '../database/mappers.js';
import { createLogger } from '../lib/logger.js';
import {
  TODO_RESOLUTION_SEPARATOR,
  TodoResolveRefusedError,
  TodoSupersedeRefusedError,
  type AddTodoCommentParams,
  type AddTodoMoveParams,
  type AdoptTodoParams,
  type CreateTodoParams,
  type ResolveManyOpenParams,
  type ResolveTodoParams,
  type TodoExecutor,
  type TodoListFilters,
  type TodoRepository,
  type UpdateTodoParams,
} from './todo-repository.js';

const logger = createLogger('sqlite-todo-repository');

function affectedRows(result: { numUpdatedRows?: bigint; numDeletedRows?: bigint }): bigint {
  return result.numUpdatedRows ?? result.numDeletedRows ?? 0n;
}

/** Ids per activity read: each is bound once per UNION branch, well under SQLite's variable limit. */
const ACTIVITY_ID_CHUNK = 500;

/**
 * The item select every read uses: all `todos` columns plus the derived
 * `comment_count`. It counts `todo_comments` only -- a move lives in its own
 * table, so moves can never be counted.
 */
function selectTodosWithCommentCount(handle: Kysely<Database>) {
  return handle
    .selectFrom('todos')
    .selectAll('todos')
    .select(
      sql<number>`(SELECT COUNT(*) FROM todo_comments WHERE todo_comments.todo_id = todos.id)`.as('comment_count'),
    );
}

export class SqliteTodoRepository implements TodoRepository {
  constructor(private db: Kysely<Database>) {}

  async create(params: CreateTodoParams, executor?: TodoExecutor): Promise<Todo> {
    const handle = executor ?? this.db;
    const now = new Date().toISOString();
    await handle
      .insertInto('todos')
      .values({
        id: params.id,
        kind: params.kind,
        scope: params.scope,
        title: params.title,
        body: params.body,
        session_id: params.sessionId,
        created_worker_id: 'workerId' in params.createdBy ? params.createdBy.workerId : null,
        created_user_id: 'userId' in params.createdBy ? params.createdBy.userId : null,
        assignee_user_id: params.assigneeUserId,
        created_at: now,
        updated_at: now,
      })
      .execute();

    logger.debug({ todoId: params.id, kind: params.kind, scope: params.scope }, 'Todo created');
    return (await this.findById(params.id, executor))!;
  }

  async createSuperseding(
    params: CreateTodoParams,
    supersededId: string,
    executor?: TodoExecutor,
  ): Promise<Todo> {
    const run = async (trx: Kysely<Database>): Promise<Todo> => {
      if (params.sessionId === null || !(await this.markSuperseded(supersededId, params.sessionId, trx))) {
        throw new TodoSupersedeRefusedError(supersededId);
      }
      return this.create(params, trx);
    };
    if (executor?.isTransaction) {
      return run(executor as Transaction<Database>);
    }
    return (executor ?? this.db).transaction().execute(run);
  }

  async findById(id: string, executor?: TodoExecutor): Promise<Todo | null> {
    const row = await selectTodosWithCommentCount(executor ?? this.db)
      .where('todos.id', '=', id)
      .executeTakeFirst();
    return row ? toTodo(row) : null;
  }

  async list(filters: TodoListFilters, executor?: TodoExecutor): Promise<Todo[]> {
    let query = selectTodosWithCommentCount(executor ?? this.db);
    if (filters.status) query = query.where('status', '=', filters.status);
    if (filters.scope) query = query.where('scope', '=', filters.scope);
    if (filters.assigneeUserId) query = query.where('assignee_user_id', '=', filters.assigneeUserId);
    if (filters.sessionId) query = query.where('session_id', '=', filters.sessionId);
    const rows = await query.orderBy('todos.created_at', 'desc').orderBy('todos.id', 'desc').execute();
    return rows.map(toTodo);
  }

  async update(id: string, patch: UpdateTodoParams, executor?: TodoExecutor): Promise<Todo | null> {
    const set: Record<string, string | null> = { updated_at: new Date().toISOString() };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.body !== undefined) set.body = patch.body;
    if (patch.assigneeUserId !== undefined) set.assignee_user_id = patch.assigneeUserId;
    if (patch.scope !== undefined) set.scope = patch.scope;
    if (patch.sessionId !== undefined) set.session_id = patch.sessionId;

    const result = await (executor ?? this.db)
      .updateTable('todos')
      .set(set)
      .where('id', '=', id)
      .where('status', '=', 'open')
      .executeTakeFirst();
    if (affectedRows(result) === 0n) return null;
    return this.findById(id, executor);
  }

  async adopt(id: string, params: AdoptTodoParams, executor?: TodoExecutor): Promise<Todo | null> {
    const run = async (trx: Kysely<Database>): Promise<Todo | null> => {
      const result = await trx
        .updateTable('todos')
        .set({
          session_id: params.sessionId,
          // A human-created item has no creating worker and must keep none (todos_creator_check).
          created_worker_id: sql<string | null>`CASE WHEN created_worker_id IS NULL THEN NULL ELSE ${params.workerId} END`,
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', id)
        .where('status', '=', 'open')
        // IS compares NULL as well as values, so a session-less item can be expected.
        .where(sql<boolean>`session_id IS ${params.expectedSessionId}`)
        .executeTakeFirst();
      if (affectedRows(result) === 0n) return null;

      // The compare-and-set above guarantees `expectedSessionId` is the session the item just left.
      // Re-adopting into the session it is already in changes no session, so there is no move to record.
      if (params.expectedSessionId !== params.sessionId) {
        await this.addMove(
          {
            todoId: id,
            actor: params.actor,
            fromSessionId: params.expectedSessionId,
            toSessionId: params.sessionId,
            statement: params.statement ?? null,
            attributedUserId: params.statedBy ?? null,
          },
          trx,
        );
      }
      return this.findById(id, trx);
    };
    // The update and its move row commit or roll back together.
    if (executor?.isTransaction) {
      return run(executor as Transaction<Database>);
    }
    return (executor ?? this.db).transaction().execute(run);
  }

  async resolve(id: string, params: ResolveTodoParams, executor?: TodoExecutor): Promise<Todo | null> {
    const now = new Date().toISOString();
    const text = params.text ?? '';
    // One statement: the append reads the stored text in the same write, so two
    // concurrent resolutions cannot overwrite each other.
    const resolutionText =
      text === ''
        ? sql<string | null>`resolution_text`
        : sql<string>`CASE WHEN resolution_text IS NULL OR resolution_text = '' THEN ${text} ELSE resolution_text || ${TODO_RESOLUTION_SEPARATOR} || ${text} END`;

    const result = await (executor ?? this.db)
      .updateTable('todos')
      .set({
        status: 'done',
        resolution_text: resolutionText,
        resolved_by_user_id: params.resolvedByUserId,
        resolved_by_worker_id: params.resolvedByWorkerId ?? null,
        resolved_at: now,
        updated_at: now,
      })
      .where('id', '=', id)
      .where('status', 'in', ['open', 'done'])
      .executeTakeFirst();
    if (affectedRows(result) === 0n) return null;
    return this.findById(id, executor);
  }

  async resolveManyOpen(ids: string[], params: ResolveManyOpenParams, executor?: TodoExecutor): Promise<Todo[]> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];
    const run = async (trx: Kysely<Database>): Promise<Todo[]> => {
      const now = new Date().toISOString();
      const text = params.text ?? '';
      const rows = await trx
        .updateTable('todos')
        .set({
          status: 'done',
          resolution_text: text === '' ? null : text,
          resolved_by_user_id: params.resolvedByUserId,
          resolved_by_worker_id: params.resolvedByWorkerId ?? null,
          resolved_at: now,
          updated_at: now,
        })
        .where('id', 'in', uniqueIds)
        .where('session_id', '=', params.sessionId)
        .where('status', '=', 'open')
        .returning('id')
        .execute();
      if (rows.length !== uniqueIds.length) {
        const resolvedIds = new Set(rows.map((row) => row.id));
        throw new TodoResolveRefusedError(uniqueIds.filter((id) => !resolvedIds.has(id)));
      }
      // Re-read inside the same transaction: the returned rows carry the derived comment count.
      const updated = await selectTodosWithCommentCount(trx)
        .where('todos.id', 'in', uniqueIds)
        .execute();
      const byId = new Map(updated.map((row) => [row.id, row]));
      return rows.map((row) => toTodo(byId.get(row.id)!));
    };
    if (executor?.isTransaction) {
      return run(executor as Transaction<Database>);
    }
    return (executor ?? this.db).transaction().execute(run);
  }

  async dismiss(id: string, executor?: TodoExecutor): Promise<Todo | null> {
    const result = await (executor ?? this.db)
      .updateTable('todos')
      .set({ status: 'dismissed', updated_at: new Date().toISOString() })
      .where('id', '=', id)
      .where('status', '=', 'open')
      .executeTakeFirst();
    if (affectedRows(result) === 0n) return null;
    return this.findById(id, executor);
  }

  async addComment(params: AddTodoCommentParams, executor?: TodoExecutor): Promise<TodoCommentActivity | null> {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    // One statement: the row is inserted only while the item exists and is open or done, the way
    // `adopt` is a compare-and-set. An item deleted or closed since the caller read it inserts
    // nothing (null), so the foreign key can only fire on a genuine bug.
    const result = await (executor ?? this.db)
      .insertInto('todo_comments')
      .columns(['id', 'todo_id', 'actor_user_id', 'actor_worker_id', 'text', 'created_at'])
      .expression((eb) =>
        eb
          .selectFrom('todos')
          .select([
            eb.val(id).as('id'),
            'todos.id as todo_id',
            eb.val('userId' in params.actor ? params.actor.userId : null).as('actor_user_id'),
            eb.val('workerId' in params.actor ? params.actor.workerId : null).as('actor_worker_id'),
            eb.val(params.text).as('text'),
            eb.val(createdAt).as('created_at'),
          ])
          .where('todos.id', '=', params.todoId)
          .where('todos.status', 'in', ['open', 'done']),
      )
      .executeTakeFirst();
    if ((result.numInsertedOrUpdatedRows ?? 0n) === 0n) return null;
    return { id, todoId: params.todoId, kind: 'comment', actor: params.actor, text: params.text, createdAt };
  }

  async addMove(params: AddTodoMoveParams, executor?: TodoExecutor): Promise<TodoMoveActivity> {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await (executor ?? this.db)
      .insertInto('todo_moves')
      .values({
        id,
        todo_id: params.todoId,
        actor_user_id: 'userId' in params.actor ? params.actor.userId : null,
        actor_worker_id: 'workerId' in params.actor ? params.actor.workerId : null,
        from_session_id: params.fromSessionId,
        to_session_id: params.toSessionId,
        statement: params.statement,
        attributed_user_id: params.attributedUserId,
        created_at: createdAt,
      })
      .execute();
    return {
      id,
      todoId: params.todoId,
      kind: 'moved',
      actor: params.actor,
      fromSessionId: params.fromSessionId,
      toSessionId: params.toSessionId,
      statement: params.statement,
      attributedUserId: params.attributedUserId,
      createdAt,
    };
  }

  async listActivities(todoId: string, executor?: TodoExecutor): Promise<TodoActivity[]> {
    return (await this.listActivitiesForTodos([todoId], executor)).get(todoId) ?? [];
  }

  async listActivitiesForTodos(todoIds: string[], executor?: TodoExecutor): Promise<Map<string, TodoActivity[]>> {
    const byTodo = new Map<string, TodoActivity[]>();
    const uniqueIds = [...new Set(todoIds)];
    if (uniqueIds.length === 0) return byTodo;
    for (const id of uniqueIds) byTodo.set(id, []);

    const handle = executor ?? this.db;
    // UNION ALL pairs columns by POSITION, so both branches list the same names in the same
    // order, padding the other branch's columns with NULL. The compound ORDER BY names result
    // columns, and every one of them is selected. The order is total -- `id` is the primary key
    // within a table and `kind` separates the tables -- and leads with `todo_id` so one pass
    // groups the rows; a later page of ONE item's thread can continue with a keyset predicate on
    // (created_at, kind, id). No LIMIT or cursor is taken here. Ids are read in chunks to stay
    // under SQLite's bound-parameter limit (each id is bound once per branch).
    for (let start = 0; start < uniqueIds.length; start += ACTIVITY_ID_CHUNK) {
      const chunk = uniqueIds.slice(start, start + ACTIVITY_ID_CHUNK);
      const comments = handle
        .selectFrom('todo_comments')
        .select([
          'id',
          'todo_id',
          sql<'comment' | 'moved'>`'comment'`.as('kind'),
          'actor_user_id',
          'actor_worker_id',
          sql<string | null>`todo_comments.text`.as('text'),
          sql<string | null>`NULL`.as('from_session_id'),
          sql<string | null>`NULL`.as('to_session_id'),
          sql<string | null>`NULL`.as('statement'),
          sql<string | null>`NULL`.as('attributed_user_id'),
          'created_at',
        ])
        .where('todo_id', 'in', chunk);
      const moves = handle
        .selectFrom('todo_moves')
        .select([
          'id',
          'todo_id',
          sql<'comment' | 'moved'>`'moved'`.as('kind'),
          'actor_user_id',
          'actor_worker_id',
          sql<string | null>`NULL`.as('text'),
          sql<string | null>`todo_moves.from_session_id`.as('from_session_id'),
          sql<string | null>`todo_moves.to_session_id`.as('to_session_id'),
          sql<string | null>`todo_moves.statement`.as('statement'),
          sql<string | null>`todo_moves.attributed_user_id`.as('attributed_user_id'),
          'created_at',
        ])
        .where('todo_id', 'in', chunk);
      const rows: TodoActivityRow[] = await comments
        .unionAll(moves)
        .orderBy('todo_id', 'asc')
        .orderBy('created_at', 'asc')
        .orderBy('kind', 'asc')
        .orderBy('id', 'asc')
        .execute();
      for (const row of rows) byTodo.get(row.todo_id)!.push(toTodoActivity(row));
    }
    return byTodo;
  }

  async delete(id: string, executor?: TodoExecutor): Promise<boolean> {
    const result = await (executor ?? this.db).deleteFrom('todos').where('id', '=', id).executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }

  async markSuperseded(id: string, sessionId: string, executor?: TodoExecutor): Promise<boolean> {
    const result = await (executor ?? this.db)
      .updateTable('todos')
      .set({ status: 'superseded', updated_at: new Date().toISOString() })
      .where('id', '=', id)
      .where('session_id', '=', sessionId)
      .where('status', '=', 'open')
      .executeTakeFirst();
    return affectedRows(result) > 0n;
  }

  async withdrawOpenSessionScoped(sessionId: string, executor?: TodoExecutor): Promise<number> {
    const result = await (executor ?? this.db)
      .updateTable('todos')
      .set({ status: 'withdrawn', updated_at: new Date().toISOString() })
      .where('session_id', '=', sessionId)
      .where('scope', '=', 'session')
      .where('status', '=', 'open')
      .executeTakeFirst();
    const count = Number(affectedRows(result));
    if (count > 0) {
      logger.debug({ sessionId, count }, 'Withdrew open session-scoped todos');
    }
    return count;
  }
}
