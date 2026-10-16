import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import type { Todo } from '@agent-console/shared';
import type { Database } from '../database/schema.js';
import { toTodo } from '../database/mappers.js';
import { createLogger } from '../lib/logger.js';
import {
  TODO_RESOLUTION_SEPARATOR,
  TodoResolveRefusedError,
  TodoSupersedeRefusedError,
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
    const row = await (executor ?? this.db)
      .selectFrom('todos')
      .where('id', '=', id)
      .selectAll()
      .executeTakeFirst();
    return row ? toTodo(row) : null;
  }

  async list(filters: TodoListFilters, executor?: TodoExecutor): Promise<Todo[]> {
    let query = (executor ?? this.db).selectFrom('todos').selectAll();
    if (filters.status) query = query.where('status', '=', filters.status);
    if (filters.scope) query = query.where('scope', '=', filters.scope);
    if (filters.assigneeUserId) query = query.where('assignee_user_id', '=', filters.assigneeUserId);
    if (filters.sessionId) query = query.where('session_id', '=', filters.sessionId);
    const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
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
        .returningAll()
        .execute();
      if (rows.length !== uniqueIds.length) {
        const resolvedIds = new Set(rows.map((row) => row.id));
        throw new TodoResolveRefusedError(uniqueIds.filter((id) => !resolvedIds.has(id)));
      }
      return rows.map(toTodo);
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
