import { get, set, del, keys } from 'idb-keyval';
import { logger } from './logger.js';

const PREFIX = 'terminal:';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const SERVER_PID_KEY = 'agent-console:serverPid';

/**
 * Cache entries are owned by the client. Staleness (e.g., server-side file
 * truncation) is detected by the server via offset comparison in
 * `readHistoryWithOffset`, which responds with a full-history resync when the
 * client's offset is beyond the server's current range. The client therefore
 * does not preemptively invalidate cache on server restart: the next reconnect
 * self-corrects via the server's truncation-detection protocol.
 *
 * Trade-off: a stale cache may be briefly rendered before the server resync
 * response arrives. This is acceptable — the reconnect is fast and avoids the
 * previous ~20s full xterm re-render on the first post-restart visit (#648).
 */

/**
 * Current server PID stored in memory after initialization.
 * Set by setCurrentServerPid() during app initialization.
 */
let currentServerPid: number | null = null;

/**
 * Get the current server PID from memory.
 * Returns null if not yet initialized.
 */
export function getCurrentServerPid(): number | null {
  return currentServerPid;
}

/**
 * Reset currentServerPid to null.
 * This function is intended for testing purposes only to ensure test isolation.
 * @internal
 */
export function resetCurrentServerPid(): void {
  currentServerPid = null;
}

/**
 * Record the server PID in memory and localStorage for observability.
 *
 * This does NOT invalidate cached terminal states when the PID changes.
 * Staleness is detected by the server via offset comparison in
 * `readHistoryWithOffset`, which triggers a full-history resync response.
 *
 * @param serverPid - The server's process ID from /api/config
 */
export async function setCurrentServerPid(serverPid: number): Promise<void> {
  let storedPidStr: string | null = null;
  try {
    storedPidStr = localStorage.getItem(SERVER_PID_KEY);
  } catch (e) {
    logger.warn('[TerminalCache] Failed to read serverPid from localStorage:', e);
  }
  const storedPid = storedPidStr ? parseInt(storedPidStr, 10) : null;

  currentServerPid = serverPid;

  try {
    localStorage.setItem(SERVER_PID_KEY, String(serverPid));
  } catch (e) {
    logger.warn('[TerminalCache] Failed to persist serverPid to localStorage:', e);
  }

  if (storedPid !== null && !isNaN(storedPid) && storedPid !== serverPid) {
    logger.info(
      `[TerminalCache] Server PID changed (${storedPid} -> ${serverPid}); cache retained — server-side truncation detection handles staleness`
    );
  }
}

/**
 * Cached terminal state stored in IndexedDB.
 */
export interface CachedState {
  /** Serialized terminal state from xterm.js serialize addon */
  data: string;
  /** Timestamp when the state was saved */
  savedAt: number;
  /** Terminal columns at time of save */
  cols: number;
  /** Terminal rows at time of save */
  rows: number;
  /** Server-side buffer offset for incremental history requests */
  offset: number;
}

/**
 * Build the IndexedDB key for a terminal state.
 */
function buildKey(sessionId: string, workerId: string): string {
  return `${PREFIX}${sessionId}:${workerId}`;
}

/**
 * Type guard to validate that a value is a valid CachedState.
 */
function isCachedState(value: unknown): value is CachedState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.data === 'string' &&
    typeof obj.savedAt === 'number' &&
    typeof obj.cols === 'number' &&
    typeof obj.rows === 'number' &&
    typeof obj.offset === 'number'
  );
}

/**
 * Check if a cached state has expired.
 */
function isExpired(state: CachedState): boolean {
  return Date.now() - state.savedAt > MAX_AGE_MS;
}

/**
 * Save terminal state to IndexedDB.
 *
 * @param sessionId - The session ID
 * @param workerId - The worker ID
 * @param state - The terminal state to cache
 */
export async function saveTerminalState(
  sessionId: string,
  workerId: string,
  state: CachedState
): Promise<void> {
  try {
    const key = buildKey(sessionId, workerId);
    await set(key, state);
  } catch (error) {
    logger.warn('Failed to save terminal state to IndexedDB:', error);
  }
}

/**
 * Load terminal state from IndexedDB.
 *
 * Returns null if:
 * - No entry exists for the given session/worker
 * - The entry has expired (older than MAX_AGE_MS)
 * - The entry is malformed
 *
 * Expired or malformed entries are automatically deleted.
 *
 * @param sessionId - The session ID
 * @param workerId - The worker ID
 * @returns The cached state or null
 */
export async function loadTerminalState(
  sessionId: string,
  workerId: string,
  signal?: AbortSignal
): Promise<CachedState | null> {
  try {
    const key = buildKey(sessionId, workerId);

    if (signal?.aborted) return null;

    const value = await get(key);

    if (signal?.aborted) return null;

    if (value === undefined) {
      return null;
    }

    if (!isCachedState(value)) {
      logger.warn('Invalid cached state format, removing:', key);
      await del(key);
      return null;
    }

    if (isExpired(value)) {
      await del(key);
      return null;
    }

    return value;
  } catch (error) {
    if (signal?.aborted) return null;
    logger.warn('Failed to load terminal state from IndexedDB:', error);
    return null;
  }
}

/**
 * Clear terminal state from IndexedDB.
 *
 * @param sessionId - The session ID
 * @param workerId - The worker ID
 */
export async function clearTerminalState(
  sessionId: string,
  workerId: string
): Promise<void> {
  try {
    const key = buildKey(sessionId, workerId);
    await del(key);
  } catch (error) {
    logger.warn('Failed to clear terminal state from IndexedDB:', error);
  }
}

/**
 * Clean up expired terminal state entries from IndexedDB.
 *
 * This function iterates through all keys with the terminal prefix
 * and removes entries that have exceeded MAX_AGE_MS.
 *
 * Intended to be called at application startup.
 */
export async function cleanupOldStates(): Promise<void> {
  try {
    const allKeys = await keys();
    const terminalKeys = allKeys.filter(
      (key): key is string =>
        typeof key === 'string' && key.startsWith(PREFIX)
    );

    const deletePromises = terminalKeys.map(async (key) => {
      try {
        const value = await get(key);

        if (!isCachedState(value)) {
          await del(key);
          return;
        }

        if (isExpired(value)) {
          await del(key);
        }
      } catch (error) {
        logger.warn(`Failed to check/delete key ${key}:`, error);
      }
    });

    await Promise.all(deletePromises);
  } catch (error) {
    logger.warn('Failed to cleanup old terminal states:', error);
  }
}
