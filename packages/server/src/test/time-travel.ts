/**
 * Time travel utility for testing time-dependent code.
 * Uses Bun's fake timers to mock both Date.now() and setTimeout/setInterval.
 */

import { jest } from 'bun:test';

export interface TimeController {
  /** Set the current time to a specific Date */
  setTime: (time: Date) => void;
  /** Advance the current time and trigger pending timers */
  tick: (ms: number) => void;
}

/**
 * Execute a callback with mocked time.
 * Both Date.now() and setTimeout/setInterval are controlled.
 *
 * @param startTime - The initial time to set
 * @param callback - The callback to execute with time control
 *
 * @example
 * ```typescript
 * travel(new Date('2025-01-01T00:00:00Z'), (c) => {
 *   doSomething(); // Date.now() returns 1735689600000
 *   c.tick(100);   // Advance 100ms and trigger pending timers
 *   doSomething(); // Date.now() returns 1735689600100
 * });
 * ```
 */
export function travel(startTime: Date, callback: (c: TimeController) => void): void {
  jest.useFakeTimers({ now: startTime });

  try {
    callback({
      setTime: (time: Date) => {
        jest.setSystemTime(time);
      },
      tick: (ms: number) => {
        jest.advanceTimersByTime(ms);
      },
    });
  } finally {
    jest.useRealTimers();
  }
}
