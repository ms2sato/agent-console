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
   * Read a user's preferences. Returns `null` when the user row does not
   * exist -- callers resolve that to each field's own default (never
   * thrown as an error; a missing row is a legitimate state for a
   * pre-migration or since-deleted user).
   */
  getPreferences(id: string): Promise<UserPreferences | null>;

  /**
   * Write a user's preferences. Returns `true` iff a row was actually
   * updated; `false` when `id` does not match any user (no row updated,
   * not an error).
   */
  setPreferences(id: string, preferences: UserPreferences): Promise<boolean>;
}
