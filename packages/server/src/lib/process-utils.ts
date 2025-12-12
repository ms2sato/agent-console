/**
 * Thin wrappers around process functions for testability.
 *
 * These wrappers allow tests to mock process operations using mock.module()
 * without modifying global process object.
 */

/**
 * Kill a process by PID.
 */
export function processKill(pid: number, signal?: NodeJS.Signals | number): boolean {
  return process.kill(pid, signal);
}

/**
 * Check if a process is alive (exists).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
