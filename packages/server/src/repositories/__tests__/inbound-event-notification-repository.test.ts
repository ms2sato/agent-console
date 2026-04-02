import { describe, it, expect } from 'bun:test';
import type { Kysely } from 'kysely';
import {
  InboundEventNotificationRepository,
  NOTIFICATION_STATUS,
} from '../inbound-event-notification-repository.js';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';

const TEST_SESSION_ID = 'session-1';

const BASE_NOTIFICATION = {
  job_id: 'job-1',
  session_id: TEST_SESSION_ID,
  worker_id: 'worker-1',
  handler_id: 'handler-1',
  event_type: 'ci:failed',
  event_summary: 'CI failed',
  created_at: '2024-01-01T00:00:00Z',
} as const;

/**
 * Helper to create the required session for foreign key constraint.
 * The session_id column in inbound_event_notifications has a FK constraint
 * referencing sessions.id with CASCADE delete.
 */
async function createTestSession(db: Kysely<Database>, sessionId: string = TEST_SESSION_ID): Promise<void> {
  await db
    .insertInto('sessions')
    .values({
      id: sessionId,
      type: 'worktree',
      location_path: '/test/path',
      created_at: '2024-01-01T00:00:00Z',
      server_pid: null,
      initial_prompt: null,
      title: null,
      repository_id: null,
      worktree_id: null,
    })
    .execute();
}

describe('inbound-event-notification-repository', () => {
  const withDb = async <T>(handler: (db: Kysely<Database>, repo: InboundEventNotificationRepository) => Promise<T>): Promise<T> => {
    const db = await createDatabaseForTest();
    const repo = new InboundEventNotificationRepository(db);
    try {
      return await handler(db, repo);
    } finally {
      await db.destroy();
    }
  };

  describe('createPendingNotification', () => {
    it('creates notification with pending status and null notified_at', async () => {
      await withDb(async (db, repo) => {
        // Session required for FK constraint
        await createTestSession(db);

        await repo.createPendingNotification({
          id: 'notification-1',
          ...BASE_NOTIFICATION,
        });

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
      await withDb(async (db, repo) => {
        // Session required for FK constraint
        await createTestSession(db);

        await repo.createPendingNotification({
          id: 'notification-1',
          ...BASE_NOTIFICATION,
        });

        await repo.createPendingNotification({
          id: 'notification-2',
          ...BASE_NOTIFICATION,
        });

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
      await withDb(async (db, repo) => {
        // Session required for FK constraint
        await createTestSession(db);

        await repo.createPendingNotification({
          id: 'notification-1',
          ...BASE_NOTIFICATION,
        });

        await repo.markNotificationDelivered(
          BASE_NOTIFICATION.job_id,
          BASE_NOTIFICATION.session_id,
          BASE_NOTIFICATION.worker_id,
          BASE_NOTIFICATION.handler_id
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
      await withDb(async (_db, repo) => {
        const result = await repo.findInboundEventNotification(
          'non-existent-job',
          'session-1',
          'worker-1',
          'handler-1'
        );

        expect(result).toBeNull();
      });
    });

    it('returns notification when it exists', async () => {
      await withDb(async (db, repo) => {
        // Session required for FK constraint
        await createTestSession(db);

        await repo.createPendingNotification({
          id: 'notification-1',
          ...BASE_NOTIFICATION,
        });

        const result = await repo.findInboundEventNotification(
          BASE_NOTIFICATION.job_id,
          BASE_NOTIFICATION.session_id,
          BASE_NOTIFICATION.worker_id,
          BASE_NOTIFICATION.handler_id
        );

        expect(result).not.toBeNull();
        expect(result!.id).toBe('notification-1');
        expect(result!.status).toBe(NOTIFICATION_STATUS.PENDING);
      });
    });
  });

  describe('foreign key constraint', () => {
    it('rejects notifications with non-existent session_id', async () => {
      await withDb(async (_db, repo) => {
        // Do NOT create session - notification should fail FK constraint
        await expect(repo.createPendingNotification({
          id: 'notification-1',
          ...BASE_NOTIFICATION,
        })).rejects.toThrow('FOREIGN KEY constraint failed');
      });
    });

    it('cascades delete when session is deleted', async () => {
      await withDb(async (db, repo) => {
        await createTestSession(db);

        await repo.createPendingNotification({
          id: 'notification-1',
          ...BASE_NOTIFICATION,
        });

        // Verify notification exists
        let rows = await db
          .selectFrom('inbound_event_notifications')
          .selectAll()
          .execute();
        expect(rows).toHaveLength(1);

        // Delete the session
        await db.deleteFrom('sessions').where('id', '=', TEST_SESSION_ID).execute();

        // Notification should be cascade-deleted
        rows = await db
          .selectFrom('inbound_event_notifications')
          .selectAll()
          .execute();
        expect(rows).toHaveLength(0);
      });
    });
  });
});
