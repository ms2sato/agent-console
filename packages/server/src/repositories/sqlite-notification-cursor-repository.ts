import type { Kysely } from 'kysely';
import type { NotificationCursorRepository } from './notification-cursor-repository.js';
import type { Database } from '../database/schema.js';

/**
 * SQLite-backed `NotificationCursorRepository`. `advance` is a single
 * conditional upsert (`ON CONFLICT DO UPDATE ... WHERE`), so a
 * backward-or-equal move is a no-op by construction (R2 —
 * docs/design/notification-center.md §5), not a checked convention. The
 * `WHERE` clause on the `DO UPDATE SET` compares against the PRE-UPDATE row
 * of the conflicting `user_notification_cursor` table (SQLite's UPSERT
 * grammar), which is exactly the "only advance if strictly newer" contract.
 */
export class SqliteNotificationCursorRepository implements NotificationCursorRepository {
  constructor(private db: Kysely<Database>) {}

  async getCursor(userId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('user_notification_cursor')
      .where('user_id', '=', userId)
      .select('last_seen_at')
      .executeTakeFirst();
    return row?.last_seen_at ?? null;
  }

  async advance(userId: string, lastSeenAt: string): Promise<string> {
    await this.db
      .insertInto('user_notification_cursor')
      .values({ user_id: userId, last_seen_at: lastSeenAt })
      .onConflict((oc) =>
        oc
          .column('user_id')
          .doUpdateSet({ last_seen_at: lastSeenAt })
          .where('last_seen_at', '<', lastSeenAt)
      )
      .execute();

    const current = await this.getCursor(userId);
    // The row was just inserted-or-updated above, so it must exist now.
    if (current === null) {
      throw new Error(`Notification cursor for user ${userId} missing immediately after upsert`);
    }
    return current;
  }
}
