import type { QueryKey } from '@tanstack/react-query';

/**
 * The query families that only a trigger-only app-WebSocket frame keeps fresh.
 * A frame sent while the socket was down is never replayed, so after a
 * reconnect every one of these families must be refetched (see
 * `useReconnectInvalidation`).
 *
 * Entries are NEVER removed when a consumer unmounts: an unmounted consumer's
 * cached rows are exactly what goes stale during the gap, and they must be
 * marked stale before the consumer remounts (the global `staleTime` would
 * otherwise block the remount's refetch). One entry per family root, keyed by
 * value, so registering the same root from many consumers is one entry.
 */
const registry = new Map<string, QueryKey>();

/** Idempotent: registering a key that is already present changes nothing. */
export function registerReconnectInvalidation(keys: readonly QueryKey[]): void {
  for (const key of keys) {
    const id = JSON.stringify(key);
    if (!registry.has(id)) registry.set(id, key);
  }
}

export function listReconnectInvalidationKeys(): QueryKey[] {
  return [...registry.values()];
}

/** Test-only: empties the registry. */
export function _resetReconnectInvalidation(): void {
  registry.clear();
}
