/**
 * UsernameLookup — sync adapter that resolves a `users.id` (UUID) to its
 * OS username. Used by `SessionConverterService` to populate
 * `Session.createdByUsername` server-side.
 *
 * Why a sync adapter?
 * `UserRepository.findById` is async, but `toPublicSession` /
 * `persistedToPublicSession` are sync (alongside `deriveIsShared` which uses
 * the sibling `SharedAccountLookup` for the same reason). Making the
 * converter async would propagate `Promise` through every call site
 * (`getSession`, `getAllSessions`, lifecycle broadcasts) and defeat the
 * point of a cheap derived field. Instead, we cache `userId -> username`
 * in memory and let callers prime the cache asynchronously at lifecycle
 * boundaries (session create / restore / resume / load from DB) so that by
 * the time `toPublicSession` runs the value is already cached.
 *
 * Cache miss behaviour: `getUsername` returns `null`. The wire field
 * becomes `null`, which the client treats as "owner not known" and
 * gracefully hides the label. Misses cache as `null` so deleted users do
 * not generate repeated DB lookups.
 */

import type { UserRepository } from '../repositories/user-repository.js';

/**
 * Minimum view of the username cache needed by the converter. Decoupled
 * as an interface so tests can inject a stub without instantiating the
 * UserRepository-backed implementation. Mirrors the
 * `SharedAccountLookup` pattern in `session-converter-service.ts`.
 */
export interface UsernameLookup {
  /** Returns the cached username for `userId`, or `null` on cache miss. */
  getUsername(userId: string): string | null;
}

/**
 * UserRepository-backed cache. Sync `getUsername` reads from the cache;
 * async `prime` resolves and stores. Resolution failures and missing users
 * cache `null` so the lookup is idempotent for deleted accounts.
 *
 * Wired in `app-context.ts` alongside `SharedAccountRegistry` and passed
 * to `SessionManager` via the `usernameLookup` option. `SessionManager`
 * primes the cache at lifecycle boundaries (createSession, resumeSession,
 * getAllPausedSessions, etc.) so that subsequent sync serialization sees
 * a warm cache.
 */
export class UsernameLookupService implements UsernameLookup {
  private readonly cache = new Map<string, string | null>();

  constructor(private readonly userRepository: UserRepository) {}

  getUsername(userId: string): string | null {
    const cached = this.cache.get(userId);
    return cached ?? null;
  }

  /** Resolve a single userId and cache the result. No-op when already cached. */
  async prime(userId: string): Promise<void> {
    if (this.cache.has(userId)) return;
    const user = await this.userRepository.findById(userId);
    this.cache.set(userId, user?.username ?? null);
  }

  /**
   * Resolve a batch of userIds in parallel and cache the results. Skips
   * already-cached entries. Safe to call with `undefined` / `null` mixed
   * in via Iterable (those are filtered out).
   */
  async primeMany(userIds: Iterable<string | undefined | null>): Promise<void> {
    const unique = new Set<string>();
    for (const id of userIds) {
      if (id && !this.cache.has(id)) unique.add(id);
    }
    if (unique.size === 0) return;
    await Promise.all([...unique].map((id) => this.prime(id)));
  }
}

/**
 * Always-null lookup used as the default when no UsernameLookup is wired
 * (e.g. unit tests that construct `SessionManager` directly without
 * threading a `UserRepository` through). Production callers always pass
 * a real `UsernameLookupService`.
 */
export const NULL_USERNAME_LOOKUP: UsernameLookup = {
  getUsername: () => null,
};
