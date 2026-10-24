import { sql, type Kysely } from 'kysely';
import type {
  DeferredWorkerNotificationRecord,
  DeferredWorkerNotificationRepository,
  NewDeferredWorkerNotification,
} from './deferred-worker-notification-repository.js';
import type { Database, DeferredWorkerNotificationRow } from '../database/schema.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('sqlite-deferred-worker-notification-repository');

function toRecord(row: DeferredWorkerNotificationRow): DeferredWorkerNotificationRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    workerId: row.worker_id,
    kind: row.kind,
    sourceId: row.source_id,
    paramsJson: row.params_json,
    replyToSessionId: row.reply_to_session_id,
    createdAt: row.created_at,
  };
}

export class SqliteDeferredWorkerNotificationRepository implements DeferredWorkerNotificationRepository {
  constructor(private db: Kysely<Database>) {}

  async insert(row: NewDeferredWorkerNotification, cap: number): Promise<void> {
    const dropped = await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('deferred_worker_notifications')
        .values({
          id: row.id,
          session_id: row.sessionId,
          worker_id: row.workerId,
          kind: row.kind,
          source_id: row.sourceId,
          params_json: row.paramsJson,
          reply_to_session_id: row.replyToSessionId,
          created_at: row.createdAt,
        })
        .execute();

      const { count } = await trx
        .selectFrom('deferred_worker_notifications')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('session_id', '=', row.sessionId)
        .executeTakeFirstOrThrow();
      const excess = Number(count) - cap;
      if (excess <= 0) return [];

      const oldest = await trx
        .selectFrom('deferred_worker_notifications')
        .select(['id', 'kind'])
        .where('session_id', '=', row.sessionId)
        .orderBy('created_at', 'asc')
        .orderBy(sql`rowid`, 'asc')
        .limit(excess)
        .execute();
      await trx
        .deleteFrom('deferred_worker_notifications')
        .where('id', 'in', oldest.map((r) => r.id))
        .execute();
      return oldest;
    });

    for (const d of dropped) {
      logger.warn(
        { sessionId: row.sessionId, droppedId: d.id, droppedKind: d.kind, cap },
        'Deferred notification cap reached; dropped the oldest entry',
      );
    }
    logger.debug({ id: row.id, sessionId: row.sessionId, kind: row.kind }, 'Deferred notification stored');
  }

  async listBySession(sessionId: string): Promise<DeferredWorkerNotificationRecord[]> {
    const rows = await this.db
      .selectFrom('deferred_worker_notifications')
      .selectAll()
      .where('session_id', '=', sessionId)
      .orderBy('created_at', 'asc')
      .orderBy(sql`rowid`, 'asc')
      .execute();
    return rows.map(toRecord);
  }

  async deleteByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.db
      .deleteFrom('deferred_worker_notifications')
      .where('id', 'in', ids)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  async countBySession(sessionId: string): Promise<number> {
    const { count } = await this.db
      .selectFrom('deferred_worker_notifications')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('session_id', '=', sessionId)
      .executeTakeFirstOrThrow();
    return Number(count);
  }
}
