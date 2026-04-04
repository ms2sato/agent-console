import type { Kysely } from 'kysely';
import type { TimerRepository, TimerRecord } from './timer-repository.js';
import type { Database, TimerRow } from '../database/schema.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('sqlite-timer-repository');

/**
 * Convert a database timer row (snake_case) to a domain record (camelCase).
 */
function toTimerRecord(row: TimerRow): TimerRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    workerId: row.worker_id,
    intervalSeconds: row.interval_seconds,
    action: row.action,
    createdAt: row.created_at,
  };
}

export class SqliteTimerRepository implements TimerRepository {
  constructor(private db: Kysely<Database>) {}

  async save(record: TimerRecord): Promise<void> {
    await this.db
      .insertInto('timers')
      .values({
        id: record.id,
        session_id: record.sessionId,
        worker_id: record.workerId,
        interval_seconds: record.intervalSeconds,
        action: record.action,
        created_at: record.createdAt,
      })
      .execute();

    logger.debug({ timerId: record.id, sessionId: record.sessionId }, 'Timer saved');
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('timers').where('id', '=', id).execute();
    logger.debug({ timerId: id }, 'Timer deleted');
  }

  async deleteBySessionId(sessionId: string): Promise<number> {
    const result = await this.db
      .deleteFrom('timers')
      .where('session_id', '=', sessionId)
      .executeTakeFirst();

    const count = Number(result.numDeletedRows);
    logger.debug({ sessionId, count }, 'Timers deleted by session');
    return count;
  }

  async findAll(): Promise<TimerRecord[]> {
    const rows = await this.db.selectFrom('timers').selectAll().execute();
    return rows.map(toTimerRecord);
  }
}
