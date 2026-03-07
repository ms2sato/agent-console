import type { AuthUser } from '@agent-console/shared';

/**
 * Repository for user identity management.
 *
 * Users are identified by a stable UUID (id) and optionally linked
 * to an OS user via os_uid. The upsertByOsUid method creates or updates
 * user records based on the OS UID, keeping username and home directory
 * in sync with the OS.
 */
export interface UserRepository {
  /**
   * Find or create a user by OS UID.
   * If a user with the given os_uid exists, updates username and home_dir if changed.
   * If no user exists, creates a new one with a fresh UUID.
   *
   * @param osUid - OS numeric user ID
   * @param username - Current OS username
   * @param homeDir - Current home directory path
   * @returns AuthUser with stable id
   */
  upsertByOsUid(osUid: number, username: string, homeDir: string): Promise<AuthUser>;

  /**
   * Find a user by their stable UUID.
   *
   * @param id - User UUID
   * @returns AuthUser or null if not found
   */
  findById(id: string): Promise<AuthUser | null>;
}
