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
export type PtyInstance = IPty & {
  dispose?(): void;
  /**
   * @internal Diagnostics for the pre-attach data buffer, used by
   * worker-manager's sentinel watchdog to distinguish "native
   * never delivered any bytes" from "bytes arrived but the sentinel never
   * matched" from "the 64 KiB pre-attach cap was hit". Present only on
   * `BunTerminalPtyAdapter`; absent on `bunPtyProvider`'s native `IPty` (no
   * such instrumentation) -- callers must treat this as optional and omit
   * the diagnostics fields gracefully when absent.
   */
  getDataDiagnostics?(): { fireCount: number; bufferedBytes: number; droppedBytes: number };
};

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
 * Bytes kept from a pre-attach window before the rest are dropped. The
 * sentinel `worker-manager.ts` waits for appears within the
 * first few hundred bytes of a fresh login shell, so keeping the FIRST
 * bytes (not a sliding tail) is the useful policy -- see
 * `PreAttachDataBuffer`'s doc comment.
 */
const PRE_ATTACH_BUFFER_CAP_BYTES = 64 * 1024;

/**
 * Bounded buffer for raw PTY `data` bytes that arrive before a consumer is
 * ready to receive them.
 *
 * Two silent byte-loss windows exist in {@link bunTerminalProvider}:
 * 1. Between `Bun.spawn()` being called and the {@link BunTerminalPtyAdapter}
 *    being constructed. The native `data` callback is passed as a
 *    `Bun.spawn` argument, so the native side holds a reference to it
 *    BEFORE spawn returns, while the `adapter` variable in the provider
 *    closure is only assigned AFTER spawn returns -- a chunk delivered in
 *    between had no adapter to reach.
 * 2. Between adapter construction and the first `onData()` attach --
 *    `_emitData` had no listener to forward to.
 *
 * A single instance is created in the provider closure BEFORE `Bun.spawn`
 * is called and shared into the adapter's constructor, so both windows
 * push into the same buffer and a single flush-on-first-attach replays
 * whichever window(s) actually lost bytes, in arrival order. This gives
 * `data` the same late-attach-safe contract `onExit` already has (see
 * `BunTerminalPtyAdapter.onExit`'s replay-on-attach handling).
 *
 * Keeps only the FIRST `PRE_ATTACH_BUFFER_CAP_BYTES` bytes -- the sentinel
 * this buffer exists to protect (`worker-manager.ts`'s `loginShellSentinel`
 * detection) appears early in the stream, so early bytes are the valuable
 * ones. Bytes beyond the cap are dropped and counted (surfaced via
 * {@link BunTerminalPtyAdapter.getDataDiagnostics} for the sentinel
 * watchdog).
 */
class PreAttachDataBuffer {
  private chunks: Uint8Array[] = [];
  private bufferedByteCount = 0;
  private flushed = false;
  private droppedByteCount = 0;
  private fireCountValue = 0;

  /** Record a native `data` callback fire, whether or not it gets buffered. */
  recordFire(): void {
    this.fireCountValue++;
  }

  /**
   * Push a raw chunk into the buffer. No-op past the cap or after the
   * buffer has been flushed -- both cases count the chunk as dropped
   * instead.
   */
  push(chunk: Uint8Array): void {
    if (this.flushed) {
      this.droppedByteCount += chunk.byteLength;
      return;
    }
    const remaining = PRE_ATTACH_BUFFER_CAP_BYTES - this.bufferedByteCount;
    if (remaining <= 0) {
      this.droppedByteCount += chunk.byteLength;
      return;
    }
    if (chunk.byteLength > remaining) {
      // .slice() COPIES the bytes (unlike .subarray(), which is a view into
      // the same underlying ArrayBuffer) -- the terminal `data` callback's
      // buffer is only valid for the duration of that synchronous callback
      // and may be reused/mutated by the runtime for a later event, so a
      // view would risk silent corruption of buffered pre-attach bytes.
      // Copying removes the need to know whether Bun's Terminal binding
      // actually reuses that buffer across events -- the same
      // don't-trust-native-behavior-assumptions principle this buffer
      // itself exists for (see the class doc comment above).
      this.chunks.push(chunk.slice(0, remaining));
      this.bufferedByteCount += remaining;
      this.droppedByteCount += chunk.byteLength - remaining;
      return;
    }
    // .slice() with no args also copies (same reasoning as above -- removes
    // the native-buffer-reuse assumption entirely).
    this.chunks.push(chunk.slice());
    this.bufferedByteCount += chunk.byteLength;
  }

  /**
   * Decode and return every buffered chunk, in arrival order, through the
   * caller-supplied streaming decoder (the SAME decoder instance used for
   * live chunks, so a partial multi-byte sequence split across the
   * pre-attach boundary still decodes correctly). Only meaningful on the
   * first call -- the adapter guards against calling this more than once
   * (subsequent `onData` attaches do not replay).
   */
  flush(decode: (chunk: Uint8Array) => string): string {
    const decoded = this.chunks.map((chunk) => decode(chunk)).join('');
    this.chunks = [];
    this.bufferedByteCount = 0;
    this.flushed = true;
    return decoded;
  }

  /** Free retained bytes without decoding (dispose path -- #1196 hygiene). */
  discard(): void {
    this.chunks = [];
    this.bufferedByteCount = 0;
    this.flushed = true;
  }

  get bufferedBytes(): number {
    return this.bufferedByteCount;
  }

  get droppedBytes(): number {
    return this.droppedByteCount;
  }

  get fireCount(): number {
    return this.fireCountValue;
  }
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
  private readonly preAttachBuffer: PreAttachDataBuffer;
  private readonly decode: (chunk: Uint8Array) => string;
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
  /**
   * True once `onData()` has been called at least once. Guards the
   * pre-attach buffer flush so only the FIRST attach replays
   * buffered bytes -- a later listener replacement must not re-deliver
   * them.
   */
  private hasAttachedOnData = false;

  constructor(args: {
    subprocess: Bun.Subprocess;
    terminal: Bun.Terminal;
    cols: number;
    rows: number;
    commandName: string;
    preAttachBuffer: PreAttachDataBuffer;
    decode: (chunk: Uint8Array) => string;
  }) {
    this.subprocess = args.subprocess;
    this.terminal = args.terminal;
    this.cols = args.cols;
    this.rows = args.rows;
    this.commandName = args.commandName;
    this.pid = args.subprocess.pid;
    this.preAttachBuffer = args.preAttachBuffer;
    this.decode = args.decode;

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
    // Free any bytes still sitting in the pre-attach buffer --
    // same hygiene family as the Bun.Terminal fd release below: no
    // retention past the point nothing will ever read it.
    this.preAttachBuffer.discard();
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
    // Flush the pre-attach buffer on the FIRST attach only --
    // this is the "late attach must not lose the event" contract, mirrored
    // from onExit's replay-on-attach handling below. Guarded by
    // hasAttachedOnData so a later listener replacement does not replay
    // bytes a previous listener already received.
    if (!this.hasAttachedOnData) {
      this.hasAttachedOnData = true;
      const buffered = this.preAttachBuffer.flush(this.decode);
      if (buffered.length > 0) {
        listener(buffered);
      }
    }
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
   * callbacks into the adapter's listener. Not part of IPty. Falls back to
   * the pre-attach buffer when no listener is attached yet,
   * instead of silently discarding the chunk.
   */
  _emitData(chunk: Uint8Array): void {
    const listener = this.dataListener;
    if (listener) {
      listener(this.decode(chunk));
    } else {
      this.preAttachBuffer.push(chunk);
    }
  }

  /**
   * @internal Diagnostics for the sentinel watchdog. See
   * `PtyInstance.getDataDiagnostics`'s doc comment.
   */
  getDataDiagnostics(): { fireCount: number; bufferedBytes: number; droppedBytes: number } {
    return {
      fireCount: this.preAttachBuffer.fireCount,
      bufferedBytes: this.preAttachBuffer.bufferedBytes,
      droppedBytes: this.preAttachBuffer.droppedBytes,
    };
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

    // Created BEFORE Bun.spawn so both pre-attach windows (the native
    // `data` callback firing before `adapter` is assigned below, and
    // `_emitData` firing before the first `onData` attach) push into the
    // same buffer -- see PreAttachDataBuffer's doc comment.
    const preAttachBuffer = new PreAttachDataBuffer();

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
          preAttachBuffer.recordFire();
          if (adapter) {
            adapter._emitData(chunk);
          } else {
            preAttachBuffer.push(chunk);
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
      preAttachBuffer,
      decode,
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
