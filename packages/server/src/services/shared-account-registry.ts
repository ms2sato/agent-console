/**
 * SharedAccountRegistry — in-memory cache of the DB-backed shared-account SET
 * (`shared_accounts` table), used to resolve and validate shared execution
 * identities for shared-session creation.
 *
 * Release 2 of the shared-accounts design (see
 * docs/design/shared-orchestrator-session.md §"Shared-Account Set and
 * Per-Repository Binding (DB-backed)"): the registry is built from the
 * `shared_accounts` table via `createFromDb`, NOT from
 * `AGENT_CONSOLE_SHARED_USERNAME`. The env var is no longer a session-creation
 * source; `app-context.ts` reads it only to decide whether to log the two
 * boot WARN lines described in that design doc's rollout table.
 *
 * For every registered row, `createFromDb` performs an OS lookup:
 * - Resolves  → `upsertByOsUid` refreshes the `users` row; cached entry has
 *               `resolvable: true`.
 * - Unresolved → the entry is kept (so `isSharedUserId` still recognizes it —
 *               existing sessions and bindings stay valid) with
 *               `resolvable: false`, and ONE `logger.warn` names the
 *               username. Boot never fails on this (owner ruling: WARN, not
 *               refuse — see the design doc's rollout table).
 *
 * The registry is queried by:
 * - `routes/worktrees.ts`'s `shared: true` branch, via `getEntry(userId)`
 *   (after resolving the repository's BOUND account id through
 *   `RepositoryManager.getSharedAccountUserId`).
 * - `routes/sessions.ts`: NOT consulted — quick sessions can never be shared
 *   (Release 2; a binding is a repository property and a quick session has
 *   no repository to bind against).
 * - `session-access.ts` / `SessionConverterService` / MCP's assignee
 *   authorisation, via `isSharedUserId(userId)` — SET membership only, never
 *   which repository an account is bound to.
 * - `routes/shared-accounts.ts`'s register/unregister handlers, via
 *   `register()` / `unregister()`, so a newly registered (or removed)
 *   account becomes usable (or stops being usable) without a server restart.
 *
 * See docs/design/shared-orchestrator-session.md §"Configuration" and
 * §"Shared-Account Set and Per-Repository Binding (DB-backed)".
 */

import type { UserRepository } from '../repositories/user-repository.js';
import type { SharedAccountRepository } from '../repositories/shared-account-repository.js';
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
  /** users.id (UUID) of the shared account record. */
  userId: string;
  /** OS username of the shared account. */
  username: string;
  /**
   * Whether the OS account currently resolves. `false` means the account is
   * still a registered member of the SET (existing sessions/bindings stay
   * valid) but cannot be used to spawn a NEW shared session until the OS
   * account is restored.
   */
  resolvable: boolean;
}

export interface CreateSharedAccountRegistryFromDbOptions {
  /** Shared-account SET storage (the source of truth for Release 2). */
  sharedAccountRepository: SharedAccountRepository;
  /** User repository used to refresh each resolvable account's row. */
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
   * Build a registry from the DB-backed shared-account SET
   * (`SharedAccountRepository.list()`). Performs an OS lookup + `users` row
   * refresh for every row; never throws — an unresolvable row is kept with
   * `resolvable: false` and a single WARN (boot never fails on this).
   */
  static async createFromDb(
    options: CreateSharedAccountRegistryFromDbOptions,
  ): Promise<SharedAccountRegistry> {
    const { sharedAccountRepository, userRepository } = options;
    const lookup = options.lookupOsUser ?? defaultLookupOsUser;

    const rows = await sharedAccountRepository.list();
    const entries = await Promise.all(
      rows.map((row) => resolveAccountEntry(row.userId, row.username, userRepository, lookup)),
    );

    return new SharedAccountRegistry(entries);
  }

  /**
   * Create a disabled registry synchronously. Useful for tests that build a
   * partial AppContext without going through the async factory, and for the
   * AUTH_MODE=none path that should never have shared accounts configured.
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
   * Returns the registered shared account's username + resolvability for
   * `userId`, or `undefined` when `userId` is not a registered shared
   * account at all.
   */
  getEntry(userId: string): { username: string; resolvable: boolean } | undefined {
    const entry = this.accountsByUserId.get(userId);
    if (!entry) return undefined;
    return { username: entry.username, resolvable: entry.resolvable };
  }

  /**
   * Add (or replace) a cache entry without a server restart. Called by
   * `POST /api/shared-accounts` after a successful DB registration, so the
   * account is immediately usable for shared-session creation in the same
   * process.
   */
  register(entry: { userId: string; username: string; resolvable: boolean }): void {
    this.accountsByUserId.set(entry.userId, entry);
  }

  /**
   * Remove a cache entry without a server restart. Called by
   * `DELETE /api/shared-accounts/:username` after a successful DB
   * unregistration.
   */
  unregister(userId: string): void {
    this.accountsByUserId.delete(userId);
  }
}

/**
 * Resolve one shared-account row into a cache entry: OS lookup + `users` row
 * refresh on success, or a `resolvable: false` entry (with one WARN naming
 * the username) on failure (lookup throws, or resolves to `null`). Shared by
 * `createFromDb`'s per-row loop.
 */
async function resolveAccountEntry(
  userId: string,
  username: string,
  userRepository: UserRepository,
  lookup: LookupOsUserFn,
): Promise<SharedAccountEntry> {
  let osInfo: Awaited<ReturnType<LookupOsUserFn>>;
  try {
    osInfo = await lookup(username);
  } catch (err) {
    // lookup is an injectable LookupOsUserFn seam; the built-in
    // implementation never rejects, but an injected implementation is not
    // contractually guaranteed not to throw (see os-user-lookup.ts's
    // LookupOsUserFn JSDoc). Distinguish this from the "genuinely
    // unresolved" case below via a distinct log message, but treat both the
    // same way for the resulting entry: unresolvable, boot continues.
    logger.warn(
      { username, err },
      'shared account: OS lookup failed unexpectedly; marking unresolvable',
    );
    return { userId, username, resolvable: false };
  }

  if (!osInfo) {
    logger.warn(
      { username },
      'shared account: configured username does not resolve to an OS account; marking unresolvable',
    );
    return { userId, username, resolvable: false };
  }

  const authUser = await userRepository.upsertByOsUid(osInfo.uid, username, osInfo.homeDir);
  logger.info(
    { username: authUser.username, userId: authUser.id, uid: osInfo.uid },
    'shared account: registered',
  );

  return { userId: authUser.id, username: authUser.username, resolvable: true };
}
