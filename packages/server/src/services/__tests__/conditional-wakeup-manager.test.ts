import { describe, it, expect, mock, beforeEach, afterEach, jest } from 'bun:test';
import {
  ConditionalWakeupManager,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  MAX_WAKEUPS_PER_SESSION,
} from '../conditional-wakeup-manager.js';

describe('ConditionalWakeupManager', () => {
  let manager: ConditionalWakeupManager;
  let onWakeup: ReturnType<typeof mock>;

  beforeEach(() => {
    onWakeup = mock(() => {});
    manager = new ConditionalWakeupManager(onWakeup);
  });

  afterEach(() => {
    manager.disposeAll();
  });

  describe('createWakeup', () => {
    it('should return ConditionalWakeupInfo with correct fields', () => {
      const wakeup = manager.createWakeup({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 30,
        conditionScript: 'echo "test"',
        onTrueMessage: 'Test condition met!',
        timeoutSeconds: 600,
        onTimeoutMessage: 'Test timed out',
      });

      expect(wakeup.id).toBeString();
      expect(wakeup.id.length).toBeGreaterThan(0);
      expect(wakeup.sessionId).toBe('session-1');
      expect(wakeup.workerId).toBe('worker-1');
      expect(wakeup.intervalSeconds).toBe(30);
      expect(wakeup.conditionScript).toBe('echo "test"');
      expect(wakeup.onTrueMessage).toBe('Test condition met!');
      expect(wakeup.timeoutSeconds).toBe(600);
      expect(wakeup.onTimeoutMessage).toBe('Test timed out');
      expect(wakeup.createdAt).toBeString();
      expect(wakeup.checkCount).toBe(0);
      expect(wakeup.lastCheckedAt).toBeUndefined();
      expect(wakeup.status).toBe('running');
    });

    it('should accept optional timeout parameters', () => {
      const wakeup = manager.createWakeup({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 30,
        conditionScript: 'echo "test"',
        onTrueMessage: 'Test condition met!',
      });

      expect(wakeup.timeoutSeconds).toBeUndefined();
      expect(wakeup.onTimeoutMessage).toBeUndefined();
    });

    it('should throw when interval is below minimum', () => {
      expect(() =>
        manager.createWakeup({
          sessionId: 'session-1',
          workerId: 'worker-1',
          intervalSeconds: MIN_INTERVAL_SECONDS - 1,
          conditionScript: 'echo "test"',
          onTrueMessage: 'Too fast!',
        }),
      ).toThrow();
    });

    it('should throw when interval exceeds maximum', () => {
      expect(() =>
        manager.createWakeup({
          sessionId: 'session-1',
          workerId: 'worker-1',
          intervalSeconds: MAX_INTERVAL_SECONDS + 1,
          conditionScript: 'echo "test"',
          onTrueMessage: 'Too slow!',
        }),
      ).toThrow();
    });

    it('should accept the exact minimum interval', () => {
      const wakeup = manager.createWakeup({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: MIN_INTERVAL_SECONDS,
        conditionScript: 'echo "test"',
        onTrueMessage: 'Min interval test',
      });
      expect(wakeup.intervalSeconds).toBe(MIN_INTERVAL_SECONDS);
    });

    it('should throw when session reaches the per-session wakeup limit', () => {
      for (let i = 0; i < MAX_WAKEUPS_PER_SESSION; i++) {
        manager.createWakeup({
          sessionId: 'session-1',
          workerId: 'worker-1',
          intervalSeconds: 30,
          conditionScript: `echo "test-${i}"`,
          onTrueMessage: `Message ${i}`,
        });
      }

      expect(() =>
        manager.createWakeup({
          sessionId: 'session-1',
          workerId: 'worker-1',
          intervalSeconds: 30,
          conditionScript: 'echo "overflow"',
          onTrueMessage: 'One too many',
        }),
      ).toThrow();
    });
  });

  describe('deleteWakeup', () => {
    it('should return true and remove an existing wakeup', () => {
      const wakeup = manager.createWakeup({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 30,
        conditionScript: 'echo "test"',
        onTrueMessage: 'Test message',
      });

      const result = manager.deleteWakeup(wakeup.id);
      expect(result).toBe(true);
      expect(manager.getWakeup(wakeup.id)).toBeUndefined();
    });

    it('should return false for a non-existent wakeup', () => {
      const result = manager.deleteWakeup('non-existent-id');
      expect(result).toBe(false);
    });

    it('should cancel running wakeup', () => {
      const wakeup = manager.createWakeup({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 30,
        conditionScript: 'echo "test"',
        onTrueMessage: 'Test message',
      });

      manager.deleteWakeup(wakeup.id);
      const retrieved = manager.getWakeup(wakeup.id);
      expect(retrieved).toBeUndefined();
    });
  });

  describe('getWakeup', () => {
    it('should return ConditionalWakeupInfo for an existing wakeup', () => {
      const created = manager.createWakeup({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 30,
        conditionScript: 'echo "test"',
        onTrueMessage: 'Get me!',
      });

      const retrieved = manager.getWakeup(created.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.onTrueMessage).toBe('Get me!');
    });

    it('should return undefined for a non-existent wakeup', () => {
      expect(manager.getWakeup('does-not-exist')).toBeUndefined();
    });
  });

  describe('listWakeups', () => {
    it('should list all wakeups when no sessionId filter is provided', () => {
      manager.createWakeup({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 30,
        conditionScript: 'echo "a"',
        onTrueMessage: 'Message A',
      });
      manager.createWakeup({
        sessionId: 'session-2',
        workerId: 'worker-2',
        intervalSeconds: 30,
        conditionScript: 'echo "b"',
        onTrueMessage: 'Message B',
      });

      const all = manager.listWakeups();
      expect(all).toHaveLength(2);
    });

    it('should filter by sessionId when provided', () => {
      manager.createWakeup({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 30,
        conditionScript: 'echo "a"',
        onTrueMessage: 'Message A',
      });
      manager.createWakeup({
        sessionId: 'session-2',
        workerId: 'worker-2',
        intervalSeconds: 30,
        conditionScript: 'echo "b"',
        onTrueMessage: 'Message B',
      });

      const session1Wakeups = manager.listWakeups('session-1');
      expect(session1Wakeups).toHaveLength(1);
      expect(session1Wakeups[0].sessionId).toBe('session-1');
    });
  });

  describe('deleteWakeupsBySession', () => {
    it('should delete all wakeups for a session and return the count', () => {
      manager.createWakeup({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 30,
        conditionScript: 'echo "a"',
        onTrueMessage: 'Message A',
      });
      manager.createWakeup({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 30,
        conditionScript: 'echo "b"',
        onTrueMessage: 'Message B',
      });
      manager.createWakeup({
        sessionId: 'session-2',
        workerId: 'worker-2',
        intervalSeconds: 30,
        conditionScript: 'echo "c"',
        onTrueMessage: 'Message C',
      });

      const deleted = manager.deleteWakeupsBySession('session-1');
      expect(deleted).toBe(2);
      expect(manager.listWakeups('session-1')).toEqual([]);
    });

    it('should not affect other sessions', () => {
      manager.createWakeup({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 30,
        conditionScript: 'echo "a"',
        onTrueMessage: 'Message A',
      });
      manager.createWakeup({
        sessionId: 'session-2',
        workerId: 'worker-2',
        intervalSeconds: 30,
        conditionScript: 'echo "b"',
        onTrueMessage: 'Message B',
      });

      manager.deleteWakeupsBySession('session-1');

      const remaining = manager.listWakeups();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].sessionId).toBe('session-2');
    });
  });

  describe('disposeAll', () => {
    it('should clear all wakeups', () => {
      manager.createWakeup({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 30,
        conditionScript: 'echo "a"',
        onTrueMessage: 'Message A',
      });
      manager.createWakeup({
        sessionId: 'session-2',
        workerId: 'worker-2',
        intervalSeconds: 30,
        conditionScript: 'echo "b"',
        onTrueMessage: 'Message B',
      });

      manager.disposeAll();

      expect(manager.listWakeups()).toEqual([]);
    });
  });

  describe('condition checking behavior', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      manager.disposeAll();
      jest.useRealTimers();
    });

    it('should not immediately call onWakeup when created', () => {
      manager.createWakeup({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 30,
        conditionScript: 'exit 0',
        onTrueMessage: 'Condition met!',
      });

      expect(onWakeup).not.toHaveBeenCalled();
    });

    it('should call onWakeup when condition becomes true (exit 0)', async () => {
      manager.createWakeup({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 30,
        conditionScript: 'exit 0',
        onTrueMessage: 'Condition met!',
      });

      // Mock Bun.spawn to simulate exit 0
      const originalSpawn = Bun.spawn;
      Bun.spawn = mock(() => ({
        exited: Promise.resolve(0),
        kill: mock(),
        // Add minimal required properties for Subprocess interface
        stdin: null,
        stdout: null,
        stderr: null,
        terminal: null,
        pid: 123,
        killed: false,
        ref: mock(),
        unref: mock(),
        flush: mock(),
        disconnect: mock(),
      })) as any;

      jest.advanceTimersByTime(30000);
      await Promise.resolve(); // Allow async operations to complete

      expect(onWakeup).toHaveBeenCalledTimes(1);
      const call = onWakeup.mock.calls[0][0];
      expect(call.onTrueMessage).toBe('Condition met!');
      expect(call.status).toBe('completed_true');

      Bun.spawn = originalSpawn;
    });

    it('should not call onWakeup when condition is false (non-zero exit)', async () => {
      manager.createWakeup({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 30,
        conditionScript: 'exit 1',
        onTrueMessage: 'Condition met!',
      });

      // Mock Bun.spawn to simulate exit 1
      const originalSpawn = Bun.spawn;
      Bun.spawn = mock(() => ({
        exited: Promise.resolve(1),
        kill: mock(),
        // Add minimal required properties for Subprocess interface
        stdin: null,
        stdout: null,
        stderr: null,
        terminal: null,
        pid: 123,
        killed: false,
        ref: mock(),
        unref: mock(),
        flush: mock(),
        disconnect: mock(),
      })) as any;

      jest.advanceTimersByTime(30000);
      await Promise.resolve(); // Allow async operations to complete

      expect(onWakeup).not.toHaveBeenCalled();

      Bun.spawn = originalSpawn;
    });

    it('should call onWakeup with timeout message when timeout is reached', async () => {
      manager.createWakeup({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 30,
        conditionScript: 'exit 1',
        onTrueMessage: 'Condition met!',
        timeoutSeconds: 60,
        onTimeoutMessage: 'Timeout reached!',
      });

      // Mock Bun.spawn to simulate persistent exit 1
      const originalSpawn = Bun.spawn;
      Bun.spawn = mock(() => ({
        exited: Promise.resolve(1),
        kill: mock(),
        // Add minimal required properties for Subprocess interface
        stdin: null,
        stdout: null,
        stderr: null,
        terminal: null,
        pid: 123,
        killed: false,
        ref: mock(),
        unref: mock(),
        flush: mock(),
        disconnect: mock(),
      })) as any;

      jest.advanceTimersByTime(60000); // Advance to timeout
      await Promise.resolve(); // Allow async operations to complete

      expect(onWakeup).toHaveBeenCalledTimes(1);
      const call = onWakeup.mock.calls[0][0];
      expect(call.onTimeoutMessage).toBe('Timeout reached!');
      expect(call.status).toBe('completed_timeout');

      Bun.spawn = originalSpawn;
    });

    it('should stop checking after condition becomes true', async () => {
      manager.createWakeup({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 30,
        conditionScript: 'exit 0',
        onTrueMessage: 'Condition met!',
      });

      // Mock Bun.spawn to simulate exit 0
      const originalSpawn = Bun.spawn;
      Bun.spawn = mock(() => ({
        exited: Promise.resolve(0),
        kill: mock(),
        // Add minimal required properties for Subprocess interface
        stdin: null,
        stdout: null,
        stderr: null,
        terminal: null,
        pid: 123,
        killed: false,
        ref: mock(),
        unref: mock(),
        flush: mock(),
        disconnect: mock(),
      })) as any;

      jest.advanceTimersByTime(30000);
      await Promise.resolve(); // First check - condition true

      expect(onWakeup).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(30000); // Second interval
      await Promise.resolve();

      expect(onWakeup).toHaveBeenCalledTimes(1); // Should not be called again

      Bun.spawn = originalSpawn;
    });

    it('should stop checking after deletion', async () => {
      const wakeup = manager.createWakeup({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 30,
        conditionScript: 'exit 1',
        onTrueMessage: 'Condition met!',
      });

      // Mock Bun.spawn to simulate exit 1
      const originalSpawn = Bun.spawn;
      Bun.spawn = mock(() => ({
        exited: Promise.resolve(1),
        kill: mock(),
        // Add minimal required properties for Subprocess interface
        stdin: null,
        stdout: null,
        stderr: null,
        terminal: null,
        pid: 123,
        killed: false,
        ref: mock(),
        unref: mock(),
        flush: mock(),
        disconnect: mock(),
      })) as any;

      jest.advanceTimersByTime(30000);
      await Promise.resolve(); // First check - condition false

      expect(onWakeup).not.toHaveBeenCalled();

      manager.deleteWakeup(wakeup.id);

      jest.advanceTimersByTime(30000); // Second interval after deletion
      await Promise.resolve();

      expect(onWakeup).not.toHaveBeenCalled(); // Should still not be called

      Bun.spawn = originalSpawn;
    });

    it('should increment checkCount on each check', async () => {
      const wakeup = manager.createWakeup({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 30,
        conditionScript: 'exit 1',
        onTrueMessage: 'Condition met!',
      });

      // Mock Bun.spawn to simulate exit 1
      const originalSpawn = Bun.spawn;
      Bun.spawn = mock(() => ({
        exited: Promise.resolve(1),
        kill: mock(),
        // Add minimal required properties for Subprocess interface
        stdin: null,
        stdout: null,
        stderr: null,
        terminal: null,
        pid: 123,
        killed: false,
        ref: mock(),
        unref: mock(),
        flush: mock(),
        disconnect: mock(),
      })) as any;

      jest.advanceTimersByTime(30000);
      await Promise.resolve();
      jest.advanceTimersByTime(30000);
      await Promise.resolve();
      jest.advanceTimersByTime(30000);
      await Promise.resolve();

      const updated = manager.getWakeup(wakeup.id);
      expect(updated?.checkCount).toBe(3);

      Bun.spawn = originalSpawn;
    });
  });
});