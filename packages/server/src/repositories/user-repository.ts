import type { AuthUser, UserPreferences } from '@agent-console/shared';

/**
 * Repository for user identity management.
 *
 * Users are identified by a stable UUID (id) and optionally linked
 * to an OS user via os_uid.
 */
export interface UserRepository {
  /**
   * Find or create a user by OS UID.
   * If a matching os_uid exists, updates username and home_dir if changed.
   * Otherwise creates a new record with a fresh UUID.
   */
  upsertByOsUid(osUid: number, username: string, homeDir: string): Promise<AuthUser>;

  findById(id: string): Promise<AuthUser | null>;

  /**
   * Read a user's current OS uid by id, without any write. `undefined` means
   * no row exists for `id` (should be unreachable in practice --
   * `shared_accounts` has an ON DELETE CASCADE FK to `users` -- but callers
   * must branch on it explicitly, not assume). `null` means the row exists
   * but has no `os_uid` (not expected for a shared account, but the column
   * is nullable).
   */
  getOsUidById(id: string): Promise<number | null | undefined>;

  /**
   * Refresh username/homeDir for an EXISTING user row, scoped strictly by
   * `id` -- never touches `os_uid`, never upserts, never creates a row. Used
   * only when the caller has already confirmed (via `getOsUidById`) that
   * this id's `os_uid` still matches the OS account being refreshed.
   */
  refreshOsIdentity(id: string, username: string, homeDir: string): Promise<AuthUser>;

  /**
   * Read a user's preferences. Returns `null` when the user row does not
   * exist -- callers resolve that to each field's own default (never
   * thrown as an error; a missing row is a legitimate state for a
   * pre-migration or since-deleted user).
   */
  getPreferences(id: string): Promise<UserPreferences | null>;

  /**
   * Write a user's preferences. Returns `true` iff a row was actually
   * updated; `false` when `id` does not match any user (no row updated,
   * not an error). The `PATCH /api/auth/me/preferences` route maps a
   * `false` return to a 404, so implementers should preserve this
   * "no row updated" signal rather than, e.g., silently upserting.
   */
  setPreferences(id: string, preferences: UserPreferences): Promise<boolean>;
}
