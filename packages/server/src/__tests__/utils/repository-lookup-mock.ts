/**
 * Shared test doubles for RepositoryLookup / RepositoryEnvLookup.
 *
 * Use `defaultRepositoryLookup` / `defaultRepositoryEnvLookup` for tests that
 * do not exercise repository behaviour. Use the factory variants to simulate
 * specific repositories.
 */

import type { RepositoryLookup, RepositoryEnvLookup, RepositoryInfo } from '../../services/repository-lookup.js';

/**
 * A repository lookup that resolves any `repositoryId` to a fixed slug.
 * Useful for tests that just need SessionManager to stop complaining about
 * missing repositories at session-creation time.
 */
export function makeRepositoryLookup(
  mapping: Record<string, string> | ((id: string) => string | undefined) = { 'repo-1': 'test-repo' },
): RepositoryLookup {
  const fn = typeof mapping === 'function'
    ? mapping
    : (id: string) => mapping[id];
  return {
    getRepositorySlug: fn,
  };
}

/**
 * An env-lookup that resolves any `repositoryId` to a fixed `RepositoryInfo`.
 * `getWorktreeIndexNumber` is a no-op returning 0 unless overridden.
 */
export function makeRepositoryEnvLookup(
  options?: {
    mapping?: Record<string, RepositoryInfo> | ((id: string) => RepositoryInfo | undefined);
    getWorktreeIndexNumber?: (path: string) => Promise<number>;
  },
): RepositoryEnvLookup {
  const mapping = options?.mapping ?? { 'repo-1': { name: 'test-repo', path: '/test/repo' } };
  const fn = typeof mapping === 'function'
    ? mapping
    : (id: string) => mapping[id];
  return {
    getRepositoryInfo: fn,
    getWorktreeIndexNumber: options?.getWorktreeIndexNumber ?? (async () => 0),
  };
}

/** Default lookups suitable for most tests. */
export const defaultRepositoryLookup: RepositoryLookup = makeRepositoryLookup();
export const defaultRepositoryEnvLookup: RepositoryEnvLookup = makeRepositoryEnvLookup();
