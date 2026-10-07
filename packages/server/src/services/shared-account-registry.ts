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
 * For every registered row, `createFromDb` performs an OS lookup
 * (`resolveAccountEntry`):
 * - Resolves, same uid as persisted → `refreshOsIdentity` refreshes the
 *               `users` row scoped strictly by the persisted `id` (never an
 *               `os_uid`-keyed upsert); cached entry has `resolvable: true`
 *               and the SAME `userId` the row was persisted with.
 * - Resolves, DIFFERENT uid than persisted → the OS account was likely
 *               deleted and recreated (or this username now belongs to
 *               someone else); nothing is written, the entry is kept with
 *               `resolvable: false`, and ONE `logger.warn` names both uids.
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
 * Resolve one ALREADY-PERSISTED shared-account row into a cache entry: OS
 * lookup + a strictly `id`-scoped `users` row refresh on success, or a
 * `resolvable: false` entry (with one WARN naming the username) on failure
 * (lookup throws, resolves to `null`, or the persisted `userId`'s `os_uid`
 * no longer matches the OS account currently resolved for `username`).
 * Shared by `createFromDb`'s per-row loop, and by the 409-recovery self-heal
 * in `routes/shared-accounts.ts`.
 *
 * Deliberately never calls `upsertByOsUid`: that helper is keyed solely by
 * `os_uid`, so if the OS account's uid has changed since the binding was
 * created (the OS account was deleted and recreated, or the username now
 * happens to resolve to a DIFFERENT, pre-existing `users` row), an upsert
 * would silently rename that OTHER row to this username and the registry
 * would cache its `users.id` under the shared account's persisted `userId`
 * slot -- corrupting both the persisted `userId` binding (which still
 * points at the original id) and `isSharedUserId` for the other row's
 * owner. The persisted `userId` is an immutable identifier once a shared
 * account is registered; this function must never return a different one.
 */
export async function resolveAccountEntry(
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

  const persistedOsUid = await userRepository.getOsUidById(userId);

  if (persistedOsUid === undefined) {
    // Should be unreachable: shared_accounts has an ON DELETE CASCADE FK to
    // users, so a persisted shared-account row implies a surviving users
    // row. Coded defensively rather than assumed away.
    logger.warn(
      { username, userId },
      'shared account: persisted user row no longer exists (should be unreachable -- ON DELETE CASCADE); marking unresolvable',
    );
    return { userId, username, resolvable: false };
  }

  if (persistedOsUid !== osInfo.uid) {
    // The OS account's uid no longer matches the uid this binding was
    // created against. Do NOT write anything -- in particular, do not touch
    // the OTHER users row that now actually holds osInfo.uid; it may belong
    // to an unrelated person.
    logger.warn(
      { username, userId, persistedOsUid, currentOsUid: osInfo.uid },
      'shared account: OS account uid no longer matches the persisted binding (the OS account may have been deleted and recreated, or this username may now belong to someone else); marking unresolvable -- an operator should investigate and, if appropriate, unregister then re-register to re-anchor to the new identity',
    );
    return { userId, username, resolvable: false };
  }

  const refreshed = await userRepository.refreshOsIdentity(userId, username, osInfo.homeDir);
  logger.info(
    { username: refreshed.username, userId, uid: osInfo.uid },
    'shared account: registered',
  );

  return { userId, username: refreshed.username, resolvable: true };
}
