import type { AuthUser } from '@agent-console/shared';

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
}
