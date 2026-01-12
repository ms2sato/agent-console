import { describe, it, expect } from 'bun:test';
import type { Kysely } from 'kysely';
import {
  createInboundEventNotification,
  createPendingNotification,
  markNotificationDelivered,
  findInboundEventNotification,
  NOTIFICATION_STATUS,
} from '../inbound-event-notification-repository.js';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';

const BASE_NOTIFICATION = {
  job_id: 'job-1',
  session_id: 'session-1',
  worker_id: 'worker-1',
  handler_id: 'handler-1',
  event_type: 'ci:failed',
  event_summary: 'CI failed',
  created_at: '2024-01-01T00:00:00Z',
} as const;

describe('inbound-event-notification-repository', () => {
  const withDb = async <T>(handler: (db: Kysely<Database>) => Promise<T>): Promise<T> => {
    const db = await createDatabaseForTest();
    try {
      return await handler(db);
    } finally {
      await db.destroy();
    }
  };

  describe('createInboundEventNotification (deprecated)', () => {
    it('deduplicates notifications for the same delivery target', async () => {
      await withDb(async (db) => {
        await createInboundEventNotification({
          id: 'notification-1',
          ...BASE_NOTIFICATION,
          status: 'delivered',
          notified_at: '2024-01-01T00:00:00Z',
        }, db);

        await createInboundEventNotification({
          id: 'notification-2',
          ...BASE_NOTIFICATION,
          status: 'delivered',
          notified_at: '2024-01-01T00:00:00Z',
        }, db);

        const rows = await db
          .selectFrom('inbound_event_notifications')
          .selectAll()
          .execute();

        expect(rows).toHaveLength(1);
      });
    });
  });

  describe('createPendingNotification', () => {
    it('creates notification with pending status and null notified_at', async () => {
      await withDb(async (db) => {
        await createPendingNotification({
          id: 'notification-1',
          ...BASE_NOTIFICATION,
        }, db);

        const rows = await db
          .selectFrom('inbound_event_notifications')
          .selectAll()
          .execute();

        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe(NOTIFICATION_STATUS.PENDING);
        expect(rows[0].notified_at).toBeNull();
      });
    });

    it('ignores duplicate pending notifications', async () => {
      await withDb(async (db) => {
        await createPendingNotification({
          id: 'notification-1',
          ...BASE_NOTIFICATION,
        }, db);

        await createPendingNotification({
          id: 'notification-2',
          ...BASE_NOTIFICATION,
        }, db);

        const rows = await db
          .selectFrom('inbound_event_notifications')
          .selectAll()
          .execute();

        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe('notification-1');
      });
    });
  });

  describe('markNotificationDelivered', () => {
    it('updates status to delivered and sets notified_at', async () => {
      await withDb(async (db) => {
        await createPendingNotification({
          id: 'notification-1',
          ...BASE_NOTIFICATION,
        }, db);

        await markNotificationDelivered(
          BASE_NOTIFICATION.job_id,
          BASE_NOTIFICATION.session_id,
          BASE_NOTIFICATION.worker_id,
          BASE_NOTIFICATION.handler_id,
          db
        );

        const rows = await db
          .selectFrom('inbound_event_notifications')
          .selectAll()
          .execute();

        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe(NOTIFICATION_STATUS.DELIVERED);
        expect(rows[0].notified_at).not.toBeNull();
      });
    });
  });

  describe('findInboundEventNotification', () => {
    it('returns null when notification does not exist', async () => {
      await withDb(async (db) => {
        const result = await findInboundEventNotification(
          'non-existent-job',
          'session-1',
          'worker-1',
          'handler-1',
          db
        );

        expect(result).toBeNull();
      });
    });

    it('returns notification when it exists', async () => {
      await withDb(async (db) => {
        await createPendingNotification({
          id: 'notification-1',
          ...BASE_NOTIFICATION,
        }, db);

        const result = await findInboundEventNotification(
          BASE_NOTIFICATION.job_id,
          BASE_NOTIFICATION.session_id,
          BASE_NOTIFICATION.worker_id,
          BASE_NOTIFICATION.handler_id,
          db
        );

        expect(result).not.toBeNull();
        expect(result!.id).toBe('notification-1');
        expect(result!.status).toBe(NOTIFICATION_STATUS.PENDING);
      });
    });
  });
});
