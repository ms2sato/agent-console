import { mock } from 'bun:test';
import type { PtyProvider, PtyInstance, PtyDataDiagnostics, PtySpawnOptions } from '../../lib/pty-provider.js';

/**
 * Disposable interface matching bun-pty's IDisposable.
 */
interface MockDisposable {
  dispose(): void;
}

/**
 * Mock PTY class for testing PTY-dependent code.
 * Simulates PTY behavior without spawning actual processes.
 *
 * `implements PtyInstance` so any future structural drift between this mock
 * and the real contract (bun-pty's `IPty`, extended with the optional
 * `dispose()` / `getDataDiagnostics()` members) is a compile error here,
 * rather than being hidden behind a cast at the factory boundary (Issue
 * #1829). Polarity measured (2026-09-25, `tsc --noEmit` in `packages/server`):
 * temporarily removing the `process` field produces
 * `TS2420: Class 'MockPty' incorrectly implements interface 'PtyInstance'. ...
 * Property 'process' is missing in type 'MockPty' but required in type
 * 'IPty'.` at this class's `implements` line; reverting `kill`'s parameter to
 * `number` produces `TS2416: Property 'kill' in type 'MockPty' is not
 * assignable to the same property in base type 'PtyInstance'.` at `kill`'s
 * declaration. Both restored immediately after measuring.
 */
export class MockPty implements PtyInstance {
  pid: number;
  /**
   * 120/30 = production spawn size; deliberately not 80/24 so a resize to
   * the xterm default is observable. Production spawns every agent/terminal
   * PTY at 120x30 (worker-manager.ts's `activateAgentWorkerPty` /
   * `activateTerminalWorkerPty`), not `BunTerminalPtyAdapter`'s
   * options-less-spawn fallback (80/24) -- production never takes that
   * fallback path, so the mock must not start there either.
   */
  cols = 120;
  rows = 30;
  process = 'mock';
  // Note: Single callback that gets replaced, matching PtyInstance interface contract
  // which specifies "Only one callback is supported. Subsequent calls will replace the previous callback."
  private dataCallback: ((data: string) => void) | null = null;
  // `IExitEvent.signal` (bun-pty) is `number | string | undefined` -- kept as
  // that exact union so both `kill(signal?: string)` below (the real IPty
  // contract) and `simulateExit(exitCode, signal?: number | string)` (used
  // by callers simulating a raw exit event, independent of kill()) deliver a
  // structurally valid IExitEvent with no numeric-to-string mapping invented
  // for either.
  private exitCallback: ((event: { exitCode: number; signal?: number | string }) => void | Promise<void>) | null =
    null;
  killed = false;
  /** Set true when dispose() is called. Mirrors PtyInstance's optional dispose(). */
  disposed = false;
  writtenData: string[] = [];
  loginShellSentinel?: string;
  /**
   * Optional diagnostics stub for the sentinel watchdog (Issue #1242).
   * Mirrors `BunTerminalPtyAdapter.getDataDiagnostics()`. Tests set this
   * directly; left unset, `getDataDiagnostics()` still returns a real
   * (zeroed) `PtyDataDiagnostics` -- `PtyInstance.getDataDiagnostics` is
   * optional by PRESENCE only, never by return value. Absence of
   * diagnostics is modeled by removing the METHOD itself on a given
   * instance (`mockPty.getDataDiagnostics = undefined;`, legal because the
   * class declares it as an optional member below), not by this field
   * being unset.
   */
  dataDiagnostics?: PtyDataDiagnostics;
  private sentinelEmitted = false;
  private autoEmitSentinel: boolean;

  constructor(pid: number, loginShellSentinel?: string, autoEmitSentinel = true) {
    this.pid = pid;
    this.loginShellSentinel = loginShellSentinel;
    this.autoEmitSentinel = autoEmitSentinel;
  }

  /**
   * Read-only aliases over `cols`/`rows`, kept for the tests that predate
   * this mock's `PtyInstance` conformance. `cols`/`rows` are the single
   * source of truth -- `resize()` writes only those -- so the two pairs can
   * never disagree.
   */
  get currentCols(): number {
    return this.cols;
  }

  get currentRows(): number {
    return this.rows;
  }

  onData(callback: (data: string) => void): MockDisposable {
    this.dataCallback = callback;
    if (this.autoEmitSentinel && this.loginShellSentinel && !this.sentinelEmitted) {
      this.sentinelEmitted = true;
      callback(this.loginShellSentinel + '\n');
    }
    return {
      dispose: () => {
        if (this.dataCallback === callback) this.dataCallback = null;
      },
    };
  }

  onExit(callback: (event: { exitCode: number; signal?: number | string }) => void | Promise<void>): MockDisposable {
    this.exitCallback = callback;
    return {
      dispose: () => {
        if (this.exitCallback === callback) this.exitCallback = null;
      },
    };
  }

  write(data: string) {
    this.writtenData.push(data);
  }

  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  /**
   * Matches `IPty.kill(signal?: string)`. The string is passed straight into
   * the exit event with no name-to-number mapping -- the real adapter
   * (`BunTerminalPtyAdapter.kill`) reports `subprocess.signalCode`, the POSIX
   * name as a string, unmapped, so a mapping here would be a mock-invented
   * convention the production contract doesn't have. A bare `kill()` (the
   * only production caller's shape, `pty.kill()` in worker-manager.ts) fires
   * `signal: undefined`, matching this mock's pre-#1829 behavior; no
   * consumer asserts a signal value after a bare kill (grepped
   * `worker-manager.test.ts` / `worker-lifecycle-manager.test.ts`), so no
   * `'SIGTERM'` default was added.
   */
  kill(signal?: string) {
    this.killed = true;
    // Simulate async exit like real PTY - fire exit callback via microtask
    if (this.exitCallback) {
      const cb = this.exitCallback;
      queueMicrotask(() => {
        // Only fire if callback hasn't been replaced or disposed
        if (this.exitCallback === cb) {
          cb({ exitCode: 0, signal });
        }
      });
    }
  }

  /** Mirrors PtyInstance's optional dispose() so detachPty wiring is assertable. */
  dispose() {
    this.disposed = true;
  }

  /**
   * Mirrors `PtyInstance`'s optional `getDataDiagnostics()` -- see
   * `dataDiagnostics` field doc. Declared as an optional class member (`?`)
   * so a test can model "provider does not implement this at all" by
   * assigning `mockPty.getDataDiagnostics = undefined;` on one instance,
   * rather than this method itself ever returning `undefined` while present.
   */
  getDataDiagnostics?(): PtyDataDiagnostics {
    return this.dataDiagnostics ?? { fireCount: 0, bufferedBytes: 0, droppedBytes: 0 };
  }

  // Test helpers - simulate PTY events
  simulateData(data: string) {
    // Only mark the sentinel as emitted once a callback actually receives it;
    // flipping the flag with no listener would suppress the real emit later.
    if (this.autoEmitSentinel && this.loginShellSentinel && !this.sentinelEmitted && this.dataCallback) {
      this.sentinelEmitted = true;
      this.dataCallback(this.loginShellSentinel + '\n');
    }
    if (this.dataCallback) {
      this.dataCallback(data);
    }
  }

  /**
   * Emit the login-shell sentinel exactly once, only when a callback is
   * registered and the sentinel has not already been emitted. Does not route
   * through simulateData (which would append a spurious duplicate when the
   * onData auto-emit already fired) and never flips the flag without a
   * listener present.
   */
  simulateLoginShellReady() {
    if (this.loginShellSentinel && !this.sentinelEmitted && this.dataCallback) {
      this.sentinelEmitted = true;
      this.dataCallback(this.loginShellSentinel + '\n');
    }
  }

  /**
   * Directly emit raw bytes to the onData callback, bypassing all sentinel
   * auto-emit. Lets tests feed a login-shell sentinel across arbitrary chunk
   * boundaries (pair with the factory's autoEmitSentinel=false option).
   */
  emitRaw(data: string) {
    if (this.dataCallback) {
      this.dataCallback(data);
    }
  }

  async simulateExit(exitCode: number, signal?: number | string): Promise<void> {
    await this.exitCallback?.({ exitCode, signal });
  }
}

/**
 * Creates a mock factory for PTY providers that tracks all created instances.
 * Usage:
 *   const ptyFactory = createMockPtyFactory();
 *   const manager = await SessionManager.create({ userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }), ... });
 */
export function createMockPtyFactory(startPid = 10000) {
  const instances: MockPty[] = [];
  let nextPid = startPid;
  let autoEmitSentinel = true;

  const spawn = mock((_command: string, args: string[], _options: PtySpawnOptions) => {
    // Scan the full argv, not just argv[1]: direct spawns are `sh -c <cmd>`
    // (sentinel at index 1) but elevated spawns are `sudo -u ... sh -c <cmd>`
    // (sentinel deep in the array). Joining covers both shapes.
    const joinedArgs = args.join(' ');
    const sentinelMatch = joinedArgs.match(/__AGENT_CONSOLE_READY_[a-f0-9]+/);
    const sentinel = sentinelMatch?.[0];
    const pty = new MockPty(nextPid++, sentinel, autoEmitSentinel);
    instances.push(pty);
    return pty;
  });

  const reset = () => {
    instances.length = 0;
    nextPid = startPid;
    autoEmitSentinel = true;
    spawn.mockClear();
  };

  /**
   * Toggle whether ptys spawned afterwards auto-emit their login-shell sentinel
   * when onData is registered. Disable to drive the sentinel manually via
   * MockPty.emitRaw (e.g. to feed it across chunk boundaries).
   */
  const setAutoEmitSentinel = (enabled: boolean) => {
    autoEmitSentinel = enabled;
  };

  // Typed wrapper, no cast: `MockPty implements PtyInstance` (see the class
  // doc comment), so `spawn`'s return type already satisfies `PtyProvider`.
  const provider: PtyProvider = {
    spawn(command, args, options) {
      return spawn(command, args, options);
    },
  };

  return { instances, spawn, reset, provider, setAutoEmitSentinel };
}
