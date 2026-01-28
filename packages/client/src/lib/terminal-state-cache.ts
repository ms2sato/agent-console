import { get, set, del, keys } from 'idb-keyval';

const PREFIX = 'terminal:';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const SERVER_PID_KEY = 'agent-console:serverPid';

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
 * Set the current server PID and handle cache invalidation if server has restarted.
 * Call this during app initialization after fetching config from server.
 *
 * @param serverPid - The server's process ID from /api/config
 * @returns true if cache was invalidated due to server restart
 */
export async function setCurrentServerPid(serverPid: number): Promise<boolean> {
  const storedPidStr = localStorage.getItem(SERVER_PID_KEY);
  const storedPid = storedPidStr ? parseInt(storedPidStr, 10) : null;

  currentServerPid = serverPid;

  // Store the new PID
  try {
    localStorage.setItem(SERVER_PID_KEY, String(serverPid));
  } catch (e) {
    console.warn('[TerminalCache] Failed to persist serverPid to localStorage:', e);
  }

  // If stored PID exists and differs from current, server has restarted
  if (storedPid !== null && !isNaN(storedPid) && storedPid !== serverPid) {
    console.info(`[TerminalCache] Server restart detected (PID changed: ${storedPid} -> ${serverPid}), clearing all cached states`);
    await clearAllTerminalStates();
    return true;
  }

  return false;
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
  /** Server process ID at time of save. Used to detect server restarts. */
  serverPid?: number;
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
 * - The entry's serverPid doesn't match the current server
 *
 * Expired or stale entries are automatically deleted.
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

    // Validate serverPid if both are available
    // If the cached state has a serverPid and it doesn't match current, invalidate
    if (value.serverPid !== undefined && currentServerPid !== null && value.serverPid !== currentServerPid) {
      console.warn(`[TerminalCache] Cache serverPid mismatch (cached: ${value.serverPid}, current: ${currentServerPid}), removing:`, key);
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

/**
 * Clear all terminal state entries from IndexedDB.
 *
 * This is used when a server restart is detected to invalidate all cached states,
 * since the server's in-memory history buffers are lost on restart.
 */
export async function clearAllTerminalStates(): Promise<void> {
  try {
    const allKeys = await keys();
    const terminalKeys = allKeys.filter(
      (key): key is string =>
        typeof key === 'string' && key.startsWith(PREFIX)
    );

    const deletePromises = terminalKeys.map((key) => del(key));
    await Promise.all(deletePromises);

    console.info(`[TerminalCache] Cleared ${terminalKeys.length} cached terminal states`);
  } catch (error) {
    console.warn('Failed to clear all terminal states:', error);
  }
}
