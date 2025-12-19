import type { IPty } from 'bun-pty';

/**
 * PTY spawn options (subset of bun-pty options)
 */
export interface PtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * PTY instance interface matching bun-pty's IPty
 */
export type PtyInstance = IPty;

/**
 * PTY provider interface for dependency injection.
 * This abstraction enables:
 * 1. Easy mocking in tests without mock.module()
 * 2. Future migration to Bun.Terminal when available
 */
export interface PtyProvider {
  spawn(command: string, args: string[], options: PtySpawnOptions): PtyInstance;
}

/**
 * Default PtyProvider implementation using bun-pty.
 * Uses lazy initialization to defer native library loading until first spawn() call.
 * This allows the module to be imported in test environments without loading native code.
 *
 * ## Why lazy require?
 *
 * bun-pty is a native module that loads a shared library (librust_pty) at import time.
 * In test environments, we mock the PtyProvider interface instead of using real PTY.
 * However, ES module imports are hoisted and evaluated before any test code runs,
 * causing the native library to load even when not needed.
 *
 * By using dynamic require() inside the spawn() method, we defer loading until
 * the method is actually called, which never happens in tests that use mock providers.
 *
 * ## Future: Bun.Terminal migration
 *
 * When Bun's native Terminal API lands (https://github.com/oven-sh/bun/pull/25415),
 * we can replace bun-pty with Bun.spawn({ terminal: opts }). This will eliminate
 * the need for external native dependencies and simplify this code:
 *
 * ```typescript
 * export const bunTerminalProvider: PtyProvider = {
 *   spawn(command, args, options) {
 *     return Bun.spawn([command, ...args], { terminal: options });
 *   },
 * };
 * ```
 */
export const bunPtyProvider: PtyProvider = {
  spawn(command, args, options) {
    // Dynamic require to defer native library loading (see comment above)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('bun-pty');
    return spawn(command, args, options);
  },
};
