/**
 * Cross-Package Boundary Test: InteractiveProcess Types
 *
 * Verifies that the shared InteractiveProcess types are correctly exported
 * and usable from both the shared package and server package.
 */
import { describe, it, expect } from 'bun:test';
import type {
  InteractiveProcessInfo,
  InteractiveProcessStatus,
} from '@agent-console/shared';

describe('InteractiveProcess types cross-package boundary', () => {
  it('should allow constructing InteractiveProcessInfo from shared package', () => {
    const info: InteractiveProcessInfo = {
      id: 'proc-1',
      sessionId: 'session-1',
      workerId: 'worker-1',
      command: 'echo hello',
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    expect(info.status).toBe('running');
    expect(info.exitCode).toBeUndefined();
  });

  it('should support all InteractiveProcessStatus values', () => {
    const statuses: InteractiveProcessStatus[] = ['running', 'exited'];
    expect(statuses).toHaveLength(2);
  });

  it('should allow exited status with exitCode', () => {
    const info: InteractiveProcessInfo = {
      id: 'proc-2',
      sessionId: 'session-1',
      workerId: 'worker-1',
      command: 'exit 1',
      status: 'exited',
      startedAt: new Date().toISOString(),
      exitCode: 1,
    };

    expect(info.status).toBe('exited');
    expect(info.exitCode).toBe(1);
  });
});
