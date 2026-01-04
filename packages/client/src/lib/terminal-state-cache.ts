import { get, set, del, keys } from 'idb-keyval';

const PREFIX = 'terminal:';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

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
  /**
   * Server instance identifier for cache invalidation on server restart.
   * When server restarts, the buffer offsets become invalid because the server
   * loses its in-memory history. By storing the server ID with the cache,
   * we can detect when the server has restarted and invalidate stale caches.
   * Optional for backward compatibility with existing cached states.
   */
  serverId?: string;
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
    typeof obj.offset === 'number' &&
    // serverId is optional for backward compatibility
    (obj.serverId === undefined || typeof obj.serverId === 'string')
  );
}

/**
 * Check if the cached state is valid for the current server instance.
 * Returns false if the server has restarted (different serverId).
 *
 * @param cachedState - The cached state to validate
 * @param currentServerId - The current server's instance ID (optional)
 * @returns true if the cache is valid for the current server, false otherwise
 */
export function isValidForServer(
  cachedState: CachedState,
  currentServerId: string | undefined
): boolean {
  // If current server ID is not provided (feature not enabled), accept all caches
  if (!currentServerId) {
    return true;
  }

  // If cached state has no serverId (old cache format), it's invalid
  // because we can't verify it's from the current server instance
  if (!cachedState.serverId) {
    return false;
  }

  // Server ID must match
  return cachedState.serverId === currentServerId;
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
    console.warn('Failed to save terminal state to IndexedDB:', error);
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
 * Expired entries are automatically deleted.
 *
 * @param sessionId - The session ID
 * @param workerId - The worker ID
 * @returns The cached state or null
 */
export async function loadTerminalState(
  sessionId: string,
  workerId: string
): Promise<CachedState | null> {
  try {
    const key = buildKey(sessionId, workerId);
    const value = await get(key);

    if (value === undefined) {
      return null;
    }

    if (!isCachedState(value)) {
      console.warn('Invalid cached state format, removing:', key);
      await del(key);
      return null;
    }

    if (isExpired(value)) {
      await del(key);
      return null;
    }

    return value;
  } catch (error) {
    console.warn('Failed to load terminal state from IndexedDB:', error);
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
    console.warn('Failed to clear terminal state from IndexedDB:', error);
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
        console.warn(`Failed to check/delete key ${key}:`, error);
      }
    });

    await Promise.all(deletePromises);
  } catch (error) {
    console.warn('Failed to cleanup old terminal states:', error);
  }
}
