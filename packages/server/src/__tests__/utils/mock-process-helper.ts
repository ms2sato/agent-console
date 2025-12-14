/**
 * Centralized process-utils module mock for tests.
 *
 * IMPORTANT: Import this module in test files that need process mocking.
 * The mock.module calls are executed once when this module is imported.
 * By default, processKill does nothing and isProcessAlive returns false (safe defaults).
 *
 * @example
 * ```typescript
 * import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
 *
 * beforeEach(() => {
 *   resetProcessMock();
 *   // Optionally set up specific PIDs as alive
 *   mockProcess.markAlive(12345);
 * });
 *
 * afterEach(() => {
 *   resetProcessMock();
 * });
 * ```
 */
import { mock } from 'bun:test';
import path from 'path';

// Track process states
const alivePids = new Set<number>();
const killedPids: number[] = [];

// Build absolute path to process-utils.js from this file's location
const processUtilsPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../lib/process-utils.js'
);

// Mock implementation
const mockImplementation = () => ({
  processKill: (pid: number, _signal?: NodeJS.Signals | number) => {
    killedPids.push(pid);
    alivePids.delete(pid);
    return true;
  },
  isProcessAlive: (pid: number) => alivePids.has(pid),
});

// Register mock once at module load time using absolute path
mock.module(processUtilsPath, mockImplementation);

/**
 * Mock process utilities for controlling process simulation in tests.
 */
export const mockProcess = {
  /**
   * Mark a PID as alive (isProcessAlive will return true for it).
   */
  markAlive(pid: number): void {
    alivePids.add(pid);
  },

  /**
   * Mark a PID as dead (remove from alive set).
   */
  markDead(pid: number): void {
    alivePids.delete(pid);
  },

  /**
   * Check if a PID was killed during the test.
   */
  wasKilled(pid: number): boolean {
    return killedPids.includes(pid);
  },

  /**
   * Get all PIDs that were killed during the test.
   */
  getKilledPids(): number[] {
    return [...killedPids];
  },

  /**
   * Get count of killed PIDs.
   */
  getKillCount(): number {
    return killedPids.length;
  },

  /**
   * Check if a PID is currently marked as alive.
   */
  isAlive(pid: number): boolean {
    return alivePids.has(pid);
  },
};

/**
 * Reset all process mock state.
 * Call this in beforeEach/afterEach to ensure clean state between tests.
 */
export function resetProcessMock(): void {
  alivePids.clear();
  killedPids.length = 0;
}
