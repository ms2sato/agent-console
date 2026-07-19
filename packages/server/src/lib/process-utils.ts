/**
 * Thin wrappers around process functions for testability.
 *
 * These wrappers allow tests to mock process operations using mock.module()
 * without modifying global process object.
 */
import { isErrnoException } from './type-guards.js';

/**
 * Kill a process by PID.
 */
export function processKill(pid: number, signal?: NodeJS.Signals | number): boolean {
  return process.kill(pid, signal);
}

/**
 * Check if a process is alive (exists).
 *
 * Fail-safe-toward-"alive" asymmetry: `process.kill(pid, 0)` throws `EPERM`
 * when the process exists but is owned by a different OS user -- exactly
 * the case multi-user orphan-worker cleanup needs to detect (a worker's PID
 * spawned via `resolveSpawnUsername` under a different OS user than the
 * server process). Only `ESRCH` ("no such process") means the process is
 * actually dead; every other outcome, including `EPERM` and any unexpected
 * error, is treated as "alive". If this is wrong and the process is
 * actually dead, the caller's next step is always "try to kill it", which
 * is safe (killing an already-dead pid just fails harmlessly). If this is
 * wrong the other way -- misreading a live cross-user process as "dead" --
 * orphan cleanup would skip it forever, which is the bug this asymmetry
 * fixes.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ESRCH') {
      return false;
    }
    return true;
  }
}
