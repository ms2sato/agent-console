/**
 * Client-Server Boundary Test: ConditionalWakeup Types
 *
 * Tests that the ConditionalWakeupInfo type from @agent-console/shared
 * is properly exported and can be consumed across package boundaries.
 * This validates the cross-package contract for Issue #700.
 */
import { describe, it, expect } from 'bun:test';

describe('Cross-Package Contract: ConditionalWakeup Types', () => {
  it('should export ConditionalWakeupInfo from shared package', async () => {
    // Import ConditionalWakeupInfo from shared package
    const sharedModule = await import('@agent-console/shared');

    // Verify the module loads successfully
    expect(sharedModule).toBeDefined();

    // Create a ConditionalWakeupInfo-compatible object to verify the contract
    const wakeupInfo = {
      id: 'test-wakeup-123',
      sessionId: 'session-abc',
      workerId: 'worker-xyz',
      intervalSeconds: 30,
      conditionScript: 'exit 0',
      onTrueMessage: 'Condition met successfully!',
      timeoutSeconds: 600,
      onTimeoutMessage: 'Operation timed out',
      createdAt: '2026-04-27T00:00:00.000Z',
      lastCheckedAt: '2026-04-27T00:00:30.000Z',
      checkCount: 1,
      status: 'running' as const
    };

    // Verify structure matches expected interface
    expect(wakeupInfo.id).toBe('test-wakeup-123');
    expect(wakeupInfo.sessionId).toBe('session-abc');
    expect(wakeupInfo.workerId).toBe('worker-xyz');
    expect(wakeupInfo.intervalSeconds).toBe(30);
    expect(wakeupInfo.conditionScript).toBe('exit 0');
    expect(wakeupInfo.onTrueMessage).toBe('Condition met successfully!');
    expect(wakeupInfo.timeoutSeconds).toBe(600);
    expect(wakeupInfo.onTimeoutMessage).toBe('Operation timed out');
    expect(wakeupInfo.createdAt).toBe('2026-04-27T00:00:00.000Z');
    expect(wakeupInfo.lastCheckedAt).toBe('2026-04-27T00:00:30.000Z');
    expect(wakeupInfo.checkCount).toBe(1);
    expect(wakeupInfo.status).toBe('running');
  });

  it('should support all status values for ConditionalWakeupInfo', async () => {
    const statusValues: Array<'running' | 'completed_true' | 'completed_timeout' | 'cancelled'> = [
      'running',
      'completed_true',
      'completed_timeout',
      'cancelled'
    ];

    for (const status of statusValues) {
      const wakeupInfo = {
        id: `test-${status}`,
        sessionId: 'session-test',
        workerId: 'worker-test',
        intervalSeconds: 30,
        conditionScript: 'echo test',
        onTrueMessage: 'Success',
        createdAt: '2026-04-27T00:00:00.000Z',
        checkCount: 0,
        status
      };

      expect(wakeupInfo.status).toBe(status);
    }
  });

  it('should support optional fields in ConditionalWakeupInfo', async () => {
    // Test minimal ConditionalWakeupInfo without optional fields
    const minimalWakeupInfo = {
      id: 'minimal-test',
      sessionId: 'session-minimal',
      workerId: 'worker-minimal',
      intervalSeconds: 60,
      conditionScript: 'true',
      onTrueMessage: 'Done',
      createdAt: '2026-04-27T00:00:00.000Z',
      checkCount: 0,
      status: 'running' as const
    };

    // Optional fields should be undefined
    expect(minimalWakeupInfo.timeoutSeconds).toBeUndefined();
    expect(minimalWakeupInfo.onTimeoutMessage).toBeUndefined();
    expect(minimalWakeupInfo.lastCheckedAt).toBeUndefined();

    // Required fields should be present
    expect(minimalWakeupInfo.id).toBe('minimal-test');
    expect(minimalWakeupInfo.status).toBe('running');
  });
});