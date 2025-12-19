/**
 * Type declarations for Bun.Terminal API (available since Bun 1.3.5)
 *
 * These types are used locally since @types/bun does not yet include
 * the Terminal API. This file can be removed once @types/bun is updated.
 *
 * @see https://github.com/oven-sh/bun/pull/25415
 */

/**
 * Terminal object returned by Bun.spawn when terminal option is provided
 */
interface BunTerminal {
  /** Write data to the terminal */
  write(data: string | Uint8Array): void;
  /** Resize the terminal */
  resize(cols: number, rows: number): void;
  /** Close the terminal */
  close(): void;
  /** Whether the terminal is closed */
  readonly closed: boolean;
}

/**
 * Terminal spawn options for Bun.spawn
 */
interface BunTerminalSpawnOptions {
  /** Number of columns */
  cols?: number;
  /** Number of rows */
  rows?: number;
  /** Callback when data is received from the terminal */
  data?(terminal: BunTerminal, data: Uint8Array): void;
}

/**
 * Subprocess with terminal - extends the result of Bun.spawn when terminal option is used
 */
interface BunSubprocessWithTerminal {
  /** Process ID */
  readonly pid: number;
  /** Terminal object for PTY interaction */
  readonly terminal: BunTerminal;
}

/**
 * Spawn options for terminal-enabled spawn
 */
interface BunSpawnWithTerminalOptions {
  cwd?: string;
  env?: Record<string, string>;
  terminal: BunTerminalSpawnOptions;
  onExit?: (
    proc: BunSubprocessWithTerminal,
    exitCode: number | null,
    signal: number | null,
    error: Error | undefined
  ) => void;
}
