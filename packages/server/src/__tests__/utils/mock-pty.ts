import { mock } from 'bun:test';
import type { PtyProvider } from '../../lib/pty-provider.js';

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

  constructor(pid: number) {
    this.pid = pid;
  }

  onData(callback: (data: string) => void): void {
    this.dataCallback = callback;
  }

  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void {
    this.exitCallback = callback;
  }

  write(data: string) {
    this.writtenData.push(data);
  }

  resize(cols: number, rows: number) {
    this.currentCols = cols;
    this.currentRows = rows;
  }

  kill() {
    this.killed = true;
  }

  // Test helpers - simulate PTY events
  simulateData(data: string) {
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
 *   const manager = new SessionManager(ptyFactory.provider);
 */
export function createMockPtyFactory(startPid = 10000) {
  const instances: MockPty[] = [];
  let nextPid = startPid;

  const spawn = mock(() => {
    const pty = new MockPty(nextPid++);
    instances.push(pty);
    return pty;
  });

  const reset = () => {
    instances.length = 0;
    nextPid = startPid;
    spawn.mockClear();
  };

  // Create a PtyProvider that uses the mock spawn
  const provider: PtyProvider = {
    spawn: spawn as unknown as PtyProvider['spawn'],
  };

  return { instances, spawn, reset, provider };
}
