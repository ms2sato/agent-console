import { vi } from 'vitest';

/**
 * Mock PTY class for testing bun-pty dependent code.
 * Simulates PTY behavior without spawning actual processes.
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
 * Creates a mock factory for @zenyr/bun-pty that tracks all created instances.
 * Usage:
 *   const { instances, createMock } = createMockPtyFactory();
 *   vi.mock('@zenyr/bun-pty', () => createMock());
 */
export function createMockPtyFactory(startPid = 10000) {
  const instances: MockPty[] = [];
  let nextPid = startPid;

  const createMock = () => ({
    spawn: vi.fn(() => {
      const pty = new MockPty(nextPid++);
      instances.push(pty);
      return pty;
    }),
  });

  const reset = () => {
    instances.length = 0;
    nextPid = startPid;
  };

  return { instances, createMock, reset };
}
