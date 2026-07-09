import { mock } from 'bun:test';
import type { PtyProvider } from '../../lib/pty-provider.js';

/**
 * Disposable interface matching bun-pty's IDisposable.
 */
interface MockDisposable {
  dispose(): void;
}

/**
 * Mock PTY class for testing PTY-dependent code.
 * Simulates PTY behavior without spawning actual processes.
 * Implements the PtyInstance interface from pty-provider.
 */
export class MockPty {
  pid: number;
  // Note: Single callback that gets replaced, matching PtyInstance interface contract
  // which specifies "Only one callback is supported. Subsequent calls will replace the previous callback."
  private dataCallback: ((data: string) => void) | null = null;
  private exitCallback: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  killed = false;
  writtenData: string[] = [];
  currentCols = 120;
  currentRows = 30;
  loginShellSentinel?: string;
  private sentinelEmitted = false;
  private autoEmitSentinel: boolean;

  constructor(pid: number, loginShellSentinel?: string, autoEmitSentinel = true) {
    this.pid = pid;
    this.loginShellSentinel = loginShellSentinel;
    this.autoEmitSentinel = autoEmitSentinel;
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

  onExit(callback: (event: { exitCode: number; signal?: number }) => void): MockDisposable {
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
    this.currentCols = cols;
    this.currentRows = rows;
  }

  kill(signal?: number) {
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

  simulateExit(exitCode: number, signal?: number) {
    if (this.exitCallback) {
      this.exitCallback({ exitCode, signal });
    }
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

  const spawn = mock((...args: unknown[]) => {
    const spawnArgs = args[1] as string[] | undefined;
    // Scan the full argv, not just argv[1]: direct spawns are `sh -c <cmd>`
    // (sentinel at index 1) but elevated spawns are `sudo -u ... sh -c <cmd>`
    // (sentinel deep in the array). Joining covers both shapes.
    const joinedArgs = Array.isArray(spawnArgs) ? spawnArgs.join(' ') : '';
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

  // Create a PtyProvider that uses the mock spawn
  const provider: PtyProvider = {
    spawn: spawn as unknown as PtyProvider['spawn'],
  };

  return { instances, spawn, reset, provider, setAutoEmitSentinel };
}
