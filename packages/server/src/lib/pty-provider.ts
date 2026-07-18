import type { IPty, IDisposable, IExitEvent } from 'bun-pty';
import { createLogger } from './logger.js';

const logger = createLogger('pty-provider');

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
 * PTY instance interface matching bun-pty's IPty, extended with an optional
 * `dispose()` for providers that hold OS resources beyond the IPty contract
 * (e.g. `BunTerminalPtyAdapter`'s Bun.Terminal master-fd handle). Optional so
 * `bunPtyProvider`'s native Terminal (which has no such method) still
 * structurally satisfies this type.
 */
export type PtyInstance = IPty & { dispose?(): void };

/**
 * PTY provider interface for dependency injection.
 * This abstraction enables:
 * 1. Easy mocking in tests without mock.module()
 * 2. Multiple implementations: bun-pty (native shared library) and Bun.Terminal (built-in PTY)
 *
 * Selection at runtime is controlled by `serverConfig.PTY_PROVIDER`.
 * Use {@link getPtyProvider} to obtain the configured provider.
 */
export interface PtyProvider {
  spawn(command: string, args: string[], options: PtySpawnOptions): PtyInstance;
}

/**
 * PtyProvider implementation using bun-pty (native shared library).
 * This is a legacy/opt-in alternative to the default {@link bunTerminalProvider} --
 * select it via `PTY_PROVIDER=bun-pty` (see `serverConfig.PTY_PROVIDER`).
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
 */
export const bunPtyProvider: PtyProvider = {
  spawn(command, args, options) {
    // Dynamic require to defer native library loading (see comment above)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('bun-pty');
    return spawn(command, args, options);
  },
};

/**
 * Decode a Uint8Array chunk to string with UTF-8 decoding that preserves
 * partial multi-byte sequences across calls (`stream: true`).
 *
 * Bun.Terminal delivers raw bytes; consumers of `IPty.onData` expect strings
 * matching bun-pty's behavior. A per-adapter TextDecoder instance keeps the
 * boundary safe.
 */
function createStreamingDecoder(): (chunk: Uint8Array) => string {
  const decoder = new TextDecoder('utf-8');
  return (chunk) => decoder.decode(chunk, { stream: true });
}

/**
 * Adapter that wraps a `Bun.spawn(..., { terminal: ... })` subprocess to
 * conform to bun-pty's `IPty` shape.
 *
 * Behavioral notes:
 * - `onData` / `onExit` accept a single listener each (matches bun-pty's
 *   "Only one callback supported, subsequent calls replace" contract used by
 *   existing consumers).
 * - `onExit` fires when the child process exits (via `subprocess.exited`),
 *   NOT when the PTY-side `exit` callback fires — the PTY callback reports
 *   stream lifecycle (EOF/error), not the real exit code. See
 *   `TerminalOptions.exit` doc in `@types/bun`.
 * - `process` getter returns the command name. bun-pty's `process` reflects
 *   the active foreground process; Bun.Terminal does not expose that, so we
 *   fall back to the spawn command.
 */
class BunTerminalPtyAdapter implements IPty {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  private readonly commandName: string;
  private readonly subprocess: Bun.Subprocess;
  private readonly terminal: Bun.Terminal;
  private dataListener: ((data: string) => void) | null = null;
  private exitListener: ((event: IExitEvent) => void) | null = null;
  /**
   * Guards against double-fire of the exit listener when the listener is
   * attached AFTER subprocess.exited has already resolved: in that race the
   * constructor's `.then()` callback and `onExit()`'s synchronous-replay
   * microtask both target the same listener. Set true on the first fire.
   */
  private exitFired = false;
  /**
   * Guards `dispose()` against double-close of the underlying Bun.Terminal.
   * `dispose()` is called from multiple lifetime endpoints (see its JSDoc).
   */
  private disposed = false;

  constructor(args: {
    subprocess: Bun.Subprocess;
    terminal: Bun.Terminal;
    cols: number;
    rows: number;
    commandName: string;
  }) {
    this.subprocess = args.subprocess;
    this.terminal = args.terminal;
    this.cols = args.cols;
    this.rows = args.rows;
    this.commandName = args.commandName;
    this.pid = args.subprocess.pid;

    // Bridge subprocess.exited -> IPty.onExit. Bun.Terminal's `exit` callback
    // signals PTY stream close, not process exit. The real exit code lives on
    // subprocess.exited / subprocess.exitCode.
    void this.subprocess.exited.then((exitCode) => {
      this.fireExit(exitCode);
    });
  }

  private fireExit(exitCode: number): void {
    this.dispose();
    if (this.exitFired) return;
    const listener = this.exitListener;
    if (!listener) return;
    this.exitFired = true;
    const signal = this.subprocess.signalCode;
    listener({
      exitCode,
      // IExitEvent.signal: number | string | undefined. signalCode is the
      // POSIX signal name (e.g. 'SIGTERM') or null.
      signal: signal ?? undefined,
    });
  }

  /**
   * Idempotent release of the underlying Bun.Terminal (the ptmx master-fd
   * owner). Safe to call multiple times and from multiple lifetime endpoints
   * — the constructor's subprocess.exited chain (primary owner, covers both
   * natural exit and kill()-then-exit) and worker-manager's detachPty
   * (backstop, covers the kill-timeout give-up path where exit was never
   * confirmed).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.terminal.close();
    } catch (err) {
      logger.warn({ pid: this.pid, err }, 'Failed to close Bun.Terminal; ptmx fd may leak');
    }
  }

  get process(): string {
    return this.commandName;
  }

  onData(listener: (data: string) => void): IDisposable {
    this.dataListener = listener;
    return {
      dispose: () => {
        if (this.dataListener === listener) {
          this.dataListener = null;
        }
      },
    };
  }

  onExit(listener: (event: IExitEvent) => void): IDisposable {
    this.exitListener = listener;
    // If the process has already exited before onExit was attached, fire
    // synchronously so callers (e.g. worker-manager's exit-wait race) don't
    // hang. Subprocess.exitCode is non-null after exit.
    //
    // fireExit() guards against double-fire: the constructor's `.then()`
    // callback may also be queued for this same listener; the exitFired flag
    // ensures only the first one wins.
    const code = this.subprocess.exitCode;
    if (code !== null && !this.exitFired) {
      queueMicrotask(() => {
        this.fireExit(code);
      });
    }
    return {
      dispose: () => {
        if (this.exitListener === listener) {
          this.exitListener = null;
        }
      },
    };
  }

  /**
   * @internal Exposed so the spawn() factory can route Terminal `data`
   * callbacks into the adapter's listener. Not part of IPty.
   */
  _emitData(chunk: Uint8Array, decode: (c: Uint8Array) => string): void {
    const listener = this.dataListener;
    if (listener) {
      listener(decode(chunk));
    }
  }

  write(data: string): void {
    this.terminal.write(data);
  }

  resize(columns: number, rows: number): void {
    this.terminal.resize(columns, rows);
  }

  kill(signal?: string): void {
    // Bun.Subprocess.kill accepts a signal name. bun-pty's IPty.kill signal
    // defaults to SIGTERM; preserve that.
    this.subprocess.kill((signal ?? 'SIGTERM') as NodeJS.Signals);
  }
}

/**
 * PtyProvider implementation using the built-in `Bun.spawn({ terminal: ... })`
 * API (Bun >= 1.3.5). No native shared library is required.
 *
 * The adapter forwards `data` callbacks into `IPty.onData`, bridges
 * `subprocess.exited` into `IPty.onExit`, and passes the caller-supplied
 * `env` verbatim to `Bun.spawn` so callers' env routing (e.g.
 * `getChildProcessEnv()` which sets TERM/COLORTERM/FORCE_COLOR) reaches the
 * child unchanged.
 *
 * IMPORTANT: When the `env` option is provided to `Bun.spawn`, the parent
 * process env is NOT merged — the child receives only the keys passed.
 * Callers must pass a complete env including PATH, HOME, TERM, etc.
 */
export const bunTerminalProvider: PtyProvider = {
  spawn(command, args, options) {
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;
    const decode = createStreamingDecoder();

    // We need a reference to the adapter inside the `data` callback. Bun
    // returns the Subprocess from spawn(), and Subprocess.terminal is the
    // Terminal handle. The adapter is constructed after spawn returns.
    let adapter: BunTerminalPtyAdapter | null = null;

    const subprocess = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: options.env,
      terminal: {
        cols,
        rows,
        name: options.name ?? 'xterm-256color',
        data: (_terminal, chunk) => {
          if (adapter) {
            adapter._emitData(chunk, decode);
          }
        },
      },
    });

    const terminal = subprocess.terminal;
    if (!terminal) {
      // Defensive: should never happen because we passed a terminal option.
      // Kill the process to avoid leaking a zombie before throwing.
      subprocess.kill();
      throw new Error('Bun.spawn did not attach a terminal despite terminal option');
    }

    adapter = new BunTerminalPtyAdapter({
      subprocess,
      terminal,
      cols,
      rows,
      commandName: command,
    });

    return adapter;
  },
};

/**
 * Identifier for the configured PTY backend.
 */
export type PtyProviderName = 'bun-pty' | 'bun-terminal';

/**
 * Resolve the configured `PtyProvider`. `serverConfig.PTY_PROVIDER` defaults
 * to `'bun-terminal'` ({@link bunTerminalProvider}); set `PTY_PROVIDER=bun-pty`
 * to opt into the legacy native-library implementation ({@link bunPtyProvider}).
 */
export function getPtyProvider(name: PtyProviderName): PtyProvider {
  switch (name) {
    case 'bun-terminal':
      return bunTerminalProvider;
    case 'bun-pty':
      return bunPtyProvider;
  }
}
