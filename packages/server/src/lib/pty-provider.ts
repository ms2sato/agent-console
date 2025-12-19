/// <reference path="../types/bun-terminal.d.ts" />

import { createLogger } from './logger.js';
import { BunTerminalAdapter } from './bun-terminal-adapter.js';

const logger = createLogger('pty-provider');

/**
 * PTY spawn options for terminal processes
 */
export interface PtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * PTY instance interface for terminal process management.
 * This interface abstracts the underlying terminal implementation
 * (now using Bun.Terminal, previously bun-pty).
 */
export interface PtyInstance {
  /** Process ID of the spawned terminal process */
  readonly pid: number;
  /**
   * Register a callback to receive terminal output data.
   * Note: Only one callback is supported. Subsequent calls will replace the previous callback.
   */
  onData(callback: (data: string) => void): void;
  /**
   * Register a callback to be notified when the process exits.
   * Note: signal is only available when process is terminated by a signal.
   * Note: Only one callback is supported. Subsequent calls will replace the previous callback.
   */
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
  /** Write input data to the terminal */
  write(data: string): void;
  /** Resize the terminal dimensions */
  resize(cols: number, rows: number): void;
  /** Kill the terminal process */
  kill(): void;
}

/**
 * PTY provider interface for dependency injection.
 * This abstraction enables easy mocking in tests without mock.module().
 */
export interface PtyProvider {
  spawn(command: string, args: string[], options: PtySpawnOptions): PtyInstance;
}

/**
 * Helper function to spawn a process with terminal support.
 *
 * This uses type assertion because @types/bun does not yet include the
 * terminal option in Bun.spawn. The terminal API is available since Bun 1.3.5.
 *
 * @internal
 */
function spawnWithTerminal(
  command: string[],
  options: BunSpawnWithTerminalOptions
): BunSubprocessWithTerminal {
  // Use type assertion because @types/bun doesn't include terminal option yet
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subprocess = (Bun.spawn as any)(command, options) as BunSubprocessWithTerminal;

  if (!subprocess.terminal) {
    throw new Error('Failed to create terminal: subprocess.terminal is undefined');
  }

  return subprocess;
}

/**
 * Default PtyProvider implementation using Bun.Terminal (native API).
 *
 * Uses Bun.spawn with the terminal option to create pseudo-terminal processes.
 * This replaces the previous bun-pty dependency with Bun's native terminal support
 * available since Bun 1.3.5.
 *
 * The BunTerminalAdapter wraps the subprocess to provide the PtyInstance interface
 * that SessionManager expects.
 */
export const bunPtyProvider: PtyProvider = {
  spawn(command, args, options) {
    // We need to create the adapter first, then pass callbacks to spawn
    // But spawn needs the adapter to call _handleData/_handleExit
    // Solution: Create adapter after spawn using a deferred pattern

    let adapter: BunTerminalAdapter;

    const subprocess = spawnWithTerminal([command, ...args], {
      cwd: options.cwd,
      env: options.env,
      terminal: {
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        data(_terminal: BunTerminal, data: Uint8Array) {
          // This callback is called with terminal output
          adapter._handleData(data);
        },
      },
      onExit(
        _proc: BunSubprocessWithTerminal,
        exitCode: number | null,
        signal: number | null,
        error: Error | undefined
      ) {
        if (error) {
          logger.error({ error, exitCode, signal }, 'PTY process exited with error');
        }
        adapter._handleExit(exitCode, signal);
      },
    });

    adapter = new BunTerminalAdapter(subprocess.pid, subprocess.terminal);

    return adapter;
  },
};
