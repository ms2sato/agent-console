import { mock } from 'bun:test';
import type { PtyProvider } from '../../lib/pty-provider.js';

/**
 * Mock PTY class for testing PTY-dependent code.
 * Simulates PTY behavior without spawning actual processes.
 * Implements the PtyInstance interface from pty-provider.
 */
export class MockPty {
  pid: number;
  private dataCallbacks: ((data: string) => void)[] = [];
  private exitCallbacks: ((event: { exitCode: number; signal?: number }) => void)[] = [];
  killed = false;
  writtenData: string[] = [];
  currentCols = 120;
  currentRows = 30;

  constructor(pid: number) {
    this.pid = pid;
  }

  onData(callback: (data: string) => void) {
    this.dataCallbacks.push(callback);
    return { dispose: () => {} };
  }

  onExit(callback: (event: { exitCode: number; signal?: number }) => void) {
    this.exitCallbacks.push(callback);
    return { dispose: () => {} };
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
    for (const cb of this.dataCallbacks) {
      cb(data);
    }
  }

  simulateExit(exitCode: number, signal?: number) {
    for (const cb of this.exitCallbacks) {
      cb({ exitCode, signal });
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
