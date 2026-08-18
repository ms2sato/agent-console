/**
 * Repository for the per-user notification read cursor
 * (docs/design/notification-center.md §5). One row per user; `last_seen_at`
 * is a monotonic high-water mark enforced structurally in the SQL upsert
 * (R2 — see SqliteNotificationCursorRepository), not by application-level
 * checks.
 */
export interface NotificationCursorRepository {
  /** Current stored cursor for a user, or null if never set (never opened the bell). */
  getCursor(userId: string): Promise<string | null>;
  /**
   * Attempt to advance the cursor to `lastSeenAt`. A backward or equal move
   * is a no-op by construction (SQL-level WHERE guard), not an error.
   * Always returns the CURRENT stored cursor after the attempt, whether or
   * not this call's value "won".
   */
  advance(userId: string, lastSeenAt: string): Promise<string>;
}
