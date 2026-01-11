import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import { createInboundEventNotification } from '../inbound-event-notification-repository.js';
import type { Database } from '../../database/schema.js';

const BASE_NOTIFICATION = {
  job_id: 'job-1',
  session_id: 'session-1',
  worker_id: 'worker-1',
  handler_id: 'handler-1',
  event_type: 'ci:failed',
  event_summary: 'CI failed',
  notified_at: '2024-01-01T00:00:00Z',
} as const;

describe('createInboundEventNotification', () => {
  let bunDb: BunDatabase;
  let db: Kysely<Database>;

  beforeEach(async () => {
    bunDb = new BunDatabase(':memory:');
    db = new Kysely<Database>({
      dialect: new BunSqliteDialect({ database: bunDb }),
    });

    await db.schema
      .createTable('inbound_event_notifications')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('job_id', 'text', (col) => col.notNull())
      .addColumn('session_id', 'text', (col) => col.notNull())
      .addColumn('worker_id', 'text', (col) => col.notNull())
      .addColumn('handler_id', 'text', (col) => col.notNull())
      .addColumn('event_type', 'text', (col) => col.notNull())
      .addColumn('event_summary', 'text', (col) => col.notNull())
      .addColumn('notified_at', 'text', (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex('uniq_inbound_event_notifications_delivery')
      .on('inbound_event_notifications')
      .columns(['job_id', 'session_id', 'worker_id', 'handler_id'])
      .unique()
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
    bunDb.close();
  });

  it('deduplicates notifications for the same delivery target', async () => {
    await createInboundEventNotification({
      id: 'notification-1',
      ...BASE_NOTIFICATION,
    }, db);

    await createInboundEventNotification({
      id: 'notification-2',
      ...BASE_NOTIFICATION,
    }, db);

    const rows = await db
      .selectFrom('inbound_event_notifications')
      .selectAll()
      .execute();

    expect(rows).toHaveLength(1);
  });
});
