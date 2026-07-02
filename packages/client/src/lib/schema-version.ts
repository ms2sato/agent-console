/**
 * Client-side schema-version handshake.
 *
 * The server advertises the wire-schema version it was built with, both as the
 * first frame on `/ws/app` (`{ type: 'schema-version', version }`) and as an
 * `X-Schema-Version` header on every REST response. This module compares that
 * value against `SCHEMA_VERSION` — the version compiled into this client bundle
 * — and forces a one-time page reload when they diverge, so a browser holding a
 * stale bundle picks up the freshly deployed assets.
 *
 * A strict reload-loop guard prevents an endless reload cycle: if the mismatch
 * persists after a reload for the same server version (e.g. a proxy or the
 * browser cache keeps serving stale assets), the module stops reloading and
 * surfaces a degraded error state instead.
 *
 * @see docs/design/websocket-protocol.md
 */
import { useSyncExternalStore } from 'react';
import { SCHEMA_VERSION } from '@agent-console/shared';
import { logger } from './logger.js';

/**
 * sessionStorage key recording the server schema version we already forced a
 * reload for. sessionStorage (not an in-memory flag) is required so the guard
 * survives the reload it triggers: on the next page load we can detect that the
 * mismatch persisted and avoid reloading again.
 */
const RELOAD_GUARD_KEY = 'agent-console:schema-version-reload-attempted';

/** REST response header carrying the server's wire-schema version. */
const SCHEMA_VERSION_HEADER = 'X-Schema-Version';

// === Mismatch state (subscribable for React) ===

let mismatch = false;
const mismatchListeners = new Set<() => void>();

function setMismatch(value: boolean): void {
  if (mismatch === value) return;
  mismatch = value;
  mismatchListeners.forEach((fn) => fn());
}

/** Subscribe to mismatch-state changes (for useSyncExternalStore). */
export function subscribeMismatch(listener: () => void): () => void {
  mismatchListeners.add(listener);
  return () => mismatchListeners.delete(listener);
}

/** Current mismatch-state snapshot (for useSyncExternalStore). */
export function getMismatch(): boolean {
  return mismatch;
}

/**
 * React hook exposing whether the client bundle is on an incompatible schema
 * version from the server AND a reload has already failed to resolve it (the
 * degraded state that warrants a manual-refresh banner).
 */
export function useSchemaVersionMismatch(): boolean {
  return useSyncExternalStore(subscribeMismatch, getMismatch, getMismatch);
}

// === Reload seam (test-injectable) ===

type ReloadFn = () => void;
const defaultReload: ReloadFn = () => {
  window.location.reload();
};
let reloadImpl: ReloadFn = defaultReload;

/**
 * Ensures `reloadImpl` is invoked at most once per page load, even when
 * `checkServerSchemaVersion` fires many times before the navigation completes
 * (the first WebSocket frame plus every REST response can each call it).
 */
let reloadTriggeredThisLoad = false;

// === Reload guard storage (sessionStorage) ===

// The reload guard MUST live in sessionStorage: it is the only store that both
// survives the reload it triggers and is bounded per browser tab. An in-memory
// flag cannot enforce "reload at most once" because it is wiped by the very
// reload it is meant to gate — so when sessionStorage is unavailable (privacy
// mode can throw), we do NOT auto-reload at all and fall back to the manual
// refresh banner instead of risking an unbounded reload loop.

function readReloadGuard(): string | null {
  try {
    return window.sessionStorage.getItem(RELOAD_GUARD_KEY);
  } catch {
    return null;
  }
}

/**
 * Persist the reload guard.
 * @returns true if the value was written, false if sessionStorage threw (in
 *   which case the caller must NOT auto-reload, since the guard could not be
 *   persisted to bound the reload to a single attempt).
 */
function writeReloadGuard(value: string): boolean {
  try {
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, value);
    return true;
  } catch {
    return false;
  }
}

function clearReloadGuard(): void {
  try {
    window.sessionStorage.removeItem(RELOAD_GUARD_KEY);
  } catch {
    // Ignore: an unwritable store also has nothing persisted to clear.
  }
}

// === Core check ===

/**
 * Compare the server's advertised schema version against this bundle's
 * `SCHEMA_VERSION` and react to a mismatch.
 *
 * - Match: clear the reload guard (so a future deploy can auto-reload again)
 *   and clear any degraded state.
 * - First mismatch for a given server version: persist the guard, then force a
 *   reload to fetch the new bundle.
 * - Mismatch that persists after we already reloaded for this exact version:
 *   stop reloading (avoid a loop) and enter the degraded mismatch state.
 */
export function checkServerSchemaVersion(serverVersion: string): void {
  if (serverVersion === SCHEMA_VERSION) {
    clearReloadGuard();
    setMismatch(false);
    return;
  }

  // A reload for a mismatch was already initiated in this page load; the
  // navigation is pending. Do nothing until the new bundle loads — reloading
  // again or flipping into the degraded state here would be premature.
  if (reloadTriggeredThisLoad) {
    return;
  }

  const alreadyReloadedFor = readReloadGuard();
  if (alreadyReloadedFor === serverVersion) {
    // The guard was written by a previous page load's reload, yet the mismatch
    // is still present. Reloading again would loop, so surface a degraded state
    // and let the user refresh manually.
    logger.error(
      `[SchemaVersion] Schema-version mismatch persists after reload ` +
        `(client=${SCHEMA_VERSION}, server=${serverVersion}). A cached stale ` +
        `bundle or an intermediary proxy may be serving old assets. Not ` +
        `reloading again to avoid a reload loop.`,
    );
    setMismatch(true);
    return;
  }

  // First mismatch for this server version: record the guard BEFORE reloading
  // so it survives the reload, then force the page to fetch the new bundle.
  if (!writeReloadGuard(serverVersion)) {
    // The guard could not be persisted (sessionStorage unavailable). Without a
    // durable guard we cannot bound the reload to a single attempt, so skip the
    // automatic reload entirely and let the user refresh manually via the
    // banner rather than risk an unbounded reload loop.
    logger.error(
      `[SchemaVersion] Schema-version mismatch detected ` +
        `(client=${SCHEMA_VERSION}, server=${serverVersion}) but the reload ` +
        `guard could not be persisted to sessionStorage. Skipping automatic ` +
        `reload to avoid a reload loop; a manual refresh is required.`,
    );
    setMismatch(true);
    return;
  }
  reloadTriggeredThisLoad = true;
  reloadImpl();
}

// === REST header inspector ===

let fetchInspectorInstalled = false;

/**
 * Wrap `globalThis.fetch` once so every REST response is inspected for the
 * `X-Schema-Version` header. Transparent: the original fetch is awaited and its
 * Response is returned unchanged (no body consumption); a rejection propagates.
 *
 * Idempotent — a second call is a no-op so repeated app inits do not stack
 * wrappers.
 */
export function installSchemaVersionFetchInspector(): void {
  if (fetchInspectorInstalled) return;
  fetchInspectorInstalled = true;

  const originalFetch = globalThis.fetch;
  const wrapped = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const response = await originalFetch(input, init);
    const headerValue = response.headers.get(SCHEMA_VERSION_HEADER);
    if (headerValue) {
      checkServerSchemaVersion(headerValue);
    }
    return response;
  };
  // `typeof globalThis.fetch` carries a `preconnect` companion property in the
  // Bun/DOM lib; the wrapper only needs to intercept the callable path, so the
  // assertion narrows the plain async function to the fetch signature.
  globalThis.fetch = wrapped as typeof globalThis.fetch;
}

// === Test seams ===

/**
 * Reset module state for testing.
 * @internal
 */
export function _reset(): void {
  mismatch = false;
  mismatchListeners.clear();
  reloadImpl = defaultReload;
  reloadTriggeredThisLoad = false;
  fetchInspectorInstalled = false;
  clearReloadGuard();
}

/**
 * Inject a stub reload implementation (happy-dom cannot spy on
 * `window.location.reload` directly).
 * @internal
 */
export function _setReloadImpl(fn: ReloadFn): void {
  reloadImpl = fn;
}

/**
 * Model a page reload boundary in tests: clears the per-page-load transient
 * flag while leaving the persisted reload guard intact, mirroring what a real
 * `window.location.reload()` does to this module's state.
 * @internal
 */
export function _simulateReload(): void {
  reloadTriggeredThisLoad = false;
}
