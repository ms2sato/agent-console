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
   *
   * Precondition: `lastSeenAt` MUST be a canonical UTC ISO 8601 string
   * (i.e. `new Date(lastSeenAt).toISOString() === lastSeenAt`). Callers are
   * responsible for normalizing before calling; implementations may throw
   * if this precondition is violated, since the monotonicity guarantee
   * above is only sound when every caller compares canonical values.
   */
  advance(userId: string, lastSeenAt: string): Promise<string>;
}
