/**
 * SharedAccountRegistry — resolves and caches the configured shared OS
 * account(s) for shared-session creation.
 *
 * On startup, the registry is built from `AGENT_CONSOLE_SHARED_USERNAME`:
 * - Unset (or empty string) → registry is disabled; no upsert.
 * - Set + OS account exists  → upsert into `users` table, cache the resulting
 *                              `users.id`.
 * - Set + OS account missing → factory throws. The server fails fast at
 *                              startup so an operator can fix the misconfig
 *                              before anyone tries to create a shared session.
 *
 * The registry is queried by:
 * - The session-create route, to translate `shared: true` into the shared
 *   account's `users.id` for `sessions.created_by`.
 * - The session-create route, to reject `shared: true` when the feature is
 *   disabled with a clear error.
 *
 * See docs/design/shared-orchestrator-session.md §"Configuration" and
 * §"Session Creation Flow".
 */

import type { UserRepository } from '../repositories/user-repository.js';
import type { LookupOsUserFn } from './os-user-lookup.js';
import { lookupOsUser as defaultLookupOsUser } from './os-user-lookup.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('shared-account-registry');

/**
 * Re-export so callers (e.g., tests) can refer to the function shape via this
 * module without importing the underlying os-user-lookup helper directly.
 */
export type { LookupOsUserFn } from './os-user-lookup.js';

interface SharedAccountEntry {
  /** users.id (UUID) of the shared account record */
  userId: string;
  /** OS username of the shared account */
  username: string;
}

export interface CreateSharedAccountRegistryOptions {
  /** OS username of the shared account, or undefined to disable the feature. */
  username: string | undefined;
  /** User repository used to upsert the shared account row. */
  userRepository: UserRepository;
  /** Injectable OS lookup; defaults to the production helper. */
  lookupOsUser?: LookupOsUserFn;
}

export class SharedAccountRegistry {
  private readonly accountsByUserId: Map<string, SharedAccountEntry>;

  private constructor(entries: SharedAccountEntry[]) {
    this.accountsByUserId = new Map(entries.map((entry) => [entry.userId, entry]));
  }

  /**
   * Build a registry from configuration. Performs OS lookup + DB upsert when
   * a username is configured.
   *
   * @throws Error when the configured username does not resolve to an OS account.
   */
  static async create(options: CreateSharedAccountRegistryOptions): Promise<SharedAccountRegistry> {
    const { username, userRepository } = options;
    const lookup = options.lookupOsUser ?? defaultLookupOsUser;

    if (!username) {
      logger.info({}, 'shared account: disabled (AGENT_CONSOLE_SHARED_USERNAME not set)');
      return new SharedAccountRegistry([]);
    }

    const osInfo = await lookup(username);
    if (!osInfo) {
      throw new Error(
        `shared account: configured username '${username}' does not resolve to an OS account. ` +
          `Either create the account, fix AGENT_CONSOLE_SHARED_USERNAME, or unset it.`,
      );
    }

    const authUser = await userRepository.upsertByOsUid(osInfo.uid, username, osInfo.homeDir);
    logger.info(
      { username, userId: authUser.id, uid: osInfo.uid },
      'shared account: registered',
    );

    return new SharedAccountRegistry([{ userId: authUser.id, username: authUser.username }]);
  }

  /**
   * Create a disabled registry synchronously. Useful for tests that build a
   * partial AppContext without going through the async factory, and for the
   * AUTH_MODE=none path that should never have a shared account configured.
   */
  static createDisabled(): SharedAccountRegistry {
    return new SharedAccountRegistry([]);
  }

  /** True when at least one shared account is registered. */
  isEnabled(): boolean {
    return this.accountsByUserId.size > 0;
  }

  /** True when the given users.id refers to a registered shared account. */
  isSharedUserId(userId: string): boolean {
    return this.accountsByUserId.has(userId);
  }

  /**
   * Returns the registered shared account's users.id for the single-account
   * configuration. Returns null when no account is registered. When multiple
   * accounts are configured (a future extension) this picks the first one;
   * callers needing per-account selection should use a separate API.
   */
  getDefaultUserId(): string | null {
    const first = this.accountsByUserId.values().next();
    if (first.done) return null;
    return first.value.userId;
  }

  /** Returns the registered shared account's username, or null when disabled. */
  getDefaultUsername(): string | null {
    const first = this.accountsByUserId.values().next();
    if (first.done) return null;
    return first.value.username;
  }
}
