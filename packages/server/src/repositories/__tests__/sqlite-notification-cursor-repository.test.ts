/**
 * Sibling test for `SqliteNotificationCursorRepository` (Notification
 * Center Phase 1, Issue #1353, R2).
 *
 * Core contract under test: `advance` is a conditional upsert -- a
 * backward or equal move is a no-op by construction, proven by a
 * subsequent `getCursor` read-back, not by asserting the SQL shape alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Kysely } from 'kysely';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteNotificationCursorRepository } from '../sqlite-notification-cursor-repository.js';

describe('SqliteNotificationCursorRepository', () => {
  let db: Kysely<Database>;
  let repository: SqliteNotificationCursorRepository;

  beforeEach(async () => {
    db = await createDatabaseForTest();
    repository = new SqliteNotificationCursorRepository(db);

    // `user_notification_cursor.user_id` carries a real FK to `users.id`.
    const now = new Date().toISOString();
    await db
      .insertInto('users')
      .values({ id: 'user-1', os_uid: null, username: 'user-1', home_dir: '/home/user-1', created_at: now, updated_at: now })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('getCursor', () => {
    it('returns null when the user has never set a cursor', async () => {
      expect(await repository.getCursor('user-1')).toBeNull();
    });
  });

  describe('advance', () => {
    it('inserts and returns the value on first call', async () => {
      const result = await repository.advance('user-1', '2026-08-18T00:00:00.000Z');
      expect(result).toBe('2026-08-18T00:00:00.000Z');
      expect(await repository.getCursor('user-1')).toBe('2026-08-18T00:00:00.000Z');
    });

    it('updates and returns the value when strictly newer than the stored cursor', async () => {
      await repository.advance('user-1', '2026-08-18T00:00:00.000Z');
      const result = await repository.advance('user-1', '2026-08-18T01:00:00.000Z');
      expect(result).toBe('2026-08-18T01:00:00.000Z');
      expect(await repository.getCursor('user-1')).toBe('2026-08-18T01:00:00.000Z');
    });

    it('is a no-op when the new value is OLDER than the stored cursor, returning the unchanged existing value', async () => {
      await repository.advance('user-1', '2026-08-18T02:00:00.000Z');
      const result = await repository.advance('user-1', '2026-08-18T01:00:00.000Z');

      // Returns the CURRENT (unchanged) stored cursor, not the older value
      // just attempted -- R2's idempotent-no-op contract.
      expect(result).toBe('2026-08-18T02:00:00.000Z');
      // Read-back proves the value did not move backward.
      expect(await repository.getCursor('user-1')).toBe('2026-08-18T02:00:00.000Z');
    });

    it('is a no-op when the new value EQUALS the stored cursor (equal is not "newer")', async () => {
      await repository.advance('user-1', '2026-08-18T02:00:00.000Z');
      const result = await repository.advance('user-1', '2026-08-18T02:00:00.000Z');

      expect(result).toBe('2026-08-18T02:00:00.000Z');
      expect(await repository.getCursor('user-1')).toBe('2026-08-18T02:00:00.000Z');
    });

    it('throws when given a non-canonical (non-UTC-Z) ISO timestamp', async () => {
      // Valid ISO 8601, but not the canonical `new Date(x).toISOString()`
      // form -- monotonicity comparisons upstream (SQL WHERE and
      // NotificationService's lexical `>`) are only sound when every
      // caller passes canonical UTC. See R-a, notification-center.md.
      await expect(
        repository.advance('user-1', '2026-08-18T09:00:00+03:00')
      ).rejects.toThrow(/canonical UTC ISO string/);
    });

    it('does not throw and behaves normally for a canonical UTC ISO timestamp', async () => {
      const result = await repository.advance('user-1', '2026-08-18T09:00:00.000Z');
      expect(result).toBe('2026-08-18T09:00:00.000Z');
    });

    it('two concurrent-shaped advances (simulated sequentially, either order) converge to the max value', async () => {
      const now = new Date().toISOString();

      // Order A: older then newer.
      const dbA = await createDatabaseForTest();
      try {
        const repoA = new SqliteNotificationCursorRepository(dbA);
        await dbA
          .insertInto('users')
          .values({ id: 'user-a', os_uid: null, username: 'user-a', home_dir: '/home/user-a', created_at: now, updated_at: now })
          .execute();
        await repoA.advance('user-a', '2026-08-18T00:00:00.000Z');
        await repoA.advance('user-a', '2026-08-18T05:00:00.000Z');
        expect(await repoA.getCursor('user-a')).toBe('2026-08-18T05:00:00.000Z');
      } finally {
        await dbA.destroy();
      }

      // Order B: newer then older -- same max, opposite call order.
      const dbB = await createDatabaseForTest();
      try {
        const repoB = new SqliteNotificationCursorRepository(dbB);
        await dbB
          .insertInto('users')
          .values({ id: 'user-b', os_uid: null, username: 'user-b', home_dir: '/home/user-b', created_at: now, updated_at: now })
          .execute();
        await repoB.advance('user-b', '2026-08-18T05:00:00.000Z');
        await repoB.advance('user-b', '2026-08-18T00:00:00.000Z');
        expect(await repoB.getCursor('user-b')).toBe('2026-08-18T05:00:00.000Z');
      } finally {
        await dbB.destroy();
      }
    });
  });
});
