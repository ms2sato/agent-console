import { describe, it, expect } from 'bun:test';
import type { InteractiveProcessInfo, InteractiveProcessStatus } from '../interactive-process.js';

describe('InteractiveProcess types', () => {
  it('should allow constructing a valid InteractiveProcessInfo', () => {
    const info: InteractiveProcessInfo = {
      id: 'proc-1',
      sessionId: 'session-1',
      workerId: 'worker-1',
      command: 'echo hello',
      status: 'running',
      startedAt: '2026-01-01T00:00:00Z',
    };

    expect(info.id).toBe('proc-1');
    expect(info.status).toBe('running');
  });

  it('should allow exited status with exitCode', () => {
    const info: InteractiveProcessInfo = {
      id: 'proc-2',
      sessionId: 'session-1',
      workerId: 'worker-1',
      command: 'echo done',
      status: 'exited',
      startedAt: '2026-01-01T00:00:00Z',
      exitCode: 0,
    };

    expect(info.status).toBe('exited');
    expect(info.exitCode).toBe(0);
  });

  it('should export InteractiveProcessStatus type with expected values', () => {
    const running: InteractiveProcessStatus = 'running';
    const exited: InteractiveProcessStatus = 'exited';

    expect(running).toBe('running');
    expect(exited).toBe('exited');
  });
});
