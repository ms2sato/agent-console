import type { CachedState } from './terminal-state-cache';
import { saveTerminalState } from './terminal-state-cache';

const DEFAULT_IDLE_SAVE_DELAY_MS = 60_000; // 1 minute

/**
 * Current idle save delay. Can be overridden for testing.
 */
let idleSaveDelayMs = DEFAULT_IDLE_SAVE_DELAY_MS;

interface WorkerSaveState {
  isDirty: boolean;
  idleTimeout: ReturnType<typeof setTimeout> | null;
  pendingSave: Promise<void> | null;
  getState: () => CachedState | null;
  cancelled: boolean;
}

/**
 * Build the registry key for a worker.
 */
function buildKey(sessionId: string, workerId: string): string {
  return `${sessionId}:${workerId}`;
}

/**
 * Registry of workers and their save states.
 */
const registry = new Map<string, WorkerSaveState>();

/**
 * Save state for a single worker.
 * Returns a promise that resolves when the save is complete.
 */
async function saveWorkerState(
  sessionId: string,
  workerId: string,
  workerState: WorkerSaveState
): Promise<void> {
  const state = workerState.getState();
  if (state === null) {
    // Terminal disposed, nothing to save
    workerState.isDirty = false;
    return;
  }

  await saveTerminalState(sessionId, workerId, state);
  workerState.isDirty = false;
}

/**
 * Register a worker for managed saves.
 *
 * @param sessionId - The session ID
 * @param workerId - The worker ID
 * @param getStateCallback - Callback that returns the current terminal state, or null if disposed
 */
export function register(
  sessionId: string,
  workerId: string,
  getStateCallback: () => CachedState | null
): void {
  const key = buildKey(sessionId, workerId);

  // Clean up existing registration if any
  const existing = registry.get(key);
  if (existing?.idleTimeout) {
    clearTimeout(existing.idleTimeout);
  }

  registry.set(key, {
    isDirty: false,
    idleTimeout: null,
    pendingSave: null,
    getState: getStateCallback,
    cancelled: false,
  });
}

/**
 * Unregister a worker and save its state if dirty.
 *
 * @param sessionId - The session ID
 * @param workerId - The worker ID
 */
export async function unregister(
  sessionId: string,
  workerId: string
): Promise<void> {
  const key = buildKey(sessionId, workerId);
  const workerState = registry.get(key);

  if (!workerState) {
    return;
  }

  // Mark as cancelled to prevent any queued timeout callbacks from executing
  workerState.cancelled = true;

  // Clear pending timeout
  if (workerState.idleTimeout) {
    clearTimeout(workerState.idleTimeout);
    workerState.idleTimeout = null;
  }

  // Wait for any pending save to complete
  if (workerState.pendingSave) {
    await workerState.pendingSave;
  }

  // Save if dirty
  if (workerState.isDirty) {
    await saveWorkerState(sessionId, workerId, workerState);
  }

  registry.delete(key);
}

/**
 * Execute an idle save with concurrent save handling.
 * Waits for any pending save, then saves if still dirty.
 */
async function executeIdleSave(
  sessionId: string,
  workerId: string,
  workerState: WorkerSaveState
): Promise<void> {
  // Wait for pending save to complete first
  if (workerState.pendingSave) {
    await workerState.pendingSave;
  }

  // Check if another save happened while we were waiting
  if (!workerState.isDirty) {
    return;
  }

  // Create save promise BEFORE starting async work to claim the slot
  const savePromise = saveWorkerState(sessionId, workerId, workerState);
  workerState.pendingSave = savePromise;

  try {
    await savePromise;
  } finally {
    // Only clear if this is still our save (another might have started)
    if (workerState.pendingSave === savePromise) {
      workerState.pendingSave = null;
    }
  }
}

/**
 * Mark a worker's state as dirty and start/reset the idle timer.
 * When the timer fires after 1 minute of no new calls, the state will be saved.
 *
 * @param sessionId - The session ID
 * @param workerId - The worker ID
 */
export function markDirty(sessionId: string, workerId: string): void {
  const key = buildKey(sessionId, workerId);
  const workerState = registry.get(key);

  if (!workerState) {
    return;
  }

  workerState.isDirty = true;

  // Clear existing timeout
  if (workerState.idleTimeout) {
    clearTimeout(workerState.idleTimeout);
  }

  // Start new idle timeout
  workerState.idleTimeout = setTimeout(() => {
    // Skip if worker was unregistered while timeout was queued
    if (workerState.cancelled) return;

    workerState.idleTimeout = null;

    // Execute save with concurrent save handling
    // Intentional fire-and-forget: timeout callbacks cannot be async
    void executeIdleSave(sessionId, workerId, workerState).catch((error) => {
      console.warn('Failed to save terminal state:', error);
    });
  }, idleSaveDelayMs);
}

/**
 * Create a save promise for a worker, handling pending saves.
 */
function createFlushSavePromise(
  key: string,
  workerState: WorkerSaveState
): Promise<void> | null {
  const [sessionId, workerId] = key.split(':');

  if (workerState.pendingSave) {
    // Wait for pending save, then save if still dirty
    return workerState.pendingSave.then(async () => {
      if (workerState.isDirty) {
        await saveWorkerState(sessionId, workerId, workerState);
      }
    });
  }

  if (workerState.isDirty) {
    return saveWorkerState(sessionId, workerId, workerState);
  }

  return null;
}

/**
 * Flush all dirty terminal states immediately.
 * Used for beforeunload protection.
 */
export async function flush(): Promise<void> {
  const savePromises: Promise<void>[] = [];

  for (const [key, workerState] of registry) {
    // Clear timeout to prevent double-saves
    if (workerState.idleTimeout) {
      clearTimeout(workerState.idleTimeout);
      workerState.idleTimeout = null;
    }

    const savePromise = createFlushSavePromise(key, workerState);
    if (savePromise) {
      savePromises.push(savePromise);
    }
  }

  await Promise.all(savePromises);
}

/**
 * Check if there are any pending saves.
 *
 * @returns true if any worker has isDirty=true or a pending save
 */
export function hasPendingSaves(): boolean {
  for (const workerState of registry.values()) {
    if (workerState.isDirty || workerState.pendingSave !== null) {
      return true;
    }
  }
  return false;
}

/**
 * Get the current size of the registry (for testing).
 */
export function getRegistrySize(): number {
  return registry.size;
}

/**
 * Clear all registrations (for testing).
 */
export function clearRegistry(): void {
  for (const workerState of registry.values()) {
    if (workerState.idleTimeout) {
      clearTimeout(workerState.idleTimeout);
    }
  }
  registry.clear();
}

/**
 * Set the idle save delay (for testing).
 * @param delayMs - The delay in milliseconds
 */
export function setIdleSaveDelay(delayMs: number): void {
  idleSaveDelayMs = delayMs;
}

/**
 * Reset the idle save delay to the default value (for testing).
 */
export function resetIdleSaveDelay(): void {
  idleSaveDelayMs = DEFAULT_IDLE_SAVE_DELAY_MS;
}

/**
 * Get the current idle save delay (for testing).
 */
export function getIdleSaveDelay(): number {
  return idleSaveDelayMs;
}

// Export for reference
export { DEFAULT_IDLE_SAVE_DELAY_MS };
