/// <reference path="../types/bun-terminal.d.ts" />

import type { PtyInstance } from './pty-provider.js';

/**
 * Adapter class that wraps Bun.Subprocess with terminal support
 * to provide the PtyInstance interface.
 *
 * This adapter:
 * - Stores callbacks registered via onData() and onExit()
 * - Converts Uint8Array data from Bun.Terminal to string for onData callback
 * - Maps kill() to terminal.close()
 * - Exposes pid from the subprocess
 *
 * @internal Exported for testing purposes only. Use bunPtyProvider for production code.
 */
export class BunTerminalAdapter implements PtyInstance {
  readonly pid: number;
  private terminal: BunTerminal;
  private dataCallback: ((data: string) => void) | null = null;
  private exitCallback: ((event: { exitCode: number; signal?: number }) => void) | null = null;

  constructor(pid: number, terminal: BunTerminal) {
    this.pid = pid;
    this.terminal = terminal;
  }

  /**
   * Handle data from the terminal (called from spawn options).
   * Converts Uint8Array to string and forwards to registered callback.
   * @internal
   */
  _handleData(data: Uint8Array): void {
    if (this.dataCallback) {
      const text = new TextDecoder().decode(data);
      this.dataCallback(text);
    }
  }

  /**
   * Handle process exit (called from spawn onExit).
   * @internal
   */
  _handleExit(exitCode: number | null, signal: number | null): void {
    if (this.exitCallback) {
      // When process is killed by signal, exitCode may be null.
      // Use 128 + signal as conventional exit code (similar to shell behavior).
      // If both are null, use -1 to indicate unknown exit status.
      const effectiveExitCode = exitCode ?? (signal !== null ? 128 + signal : -1);
      this.exitCallback({
        exitCode: effectiveExitCode,
        signal: signal ?? undefined,
      });
    }
  }

  onData(callback: (data: string) => void): void {
    this.dataCallback = callback;
  }

  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void {
    this.exitCallback = callback;
  }

  write(data: string): void {
    this.terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  kill(): void {
    this.terminal.close();
  }
}
