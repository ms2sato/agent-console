import { describe, it, expect, mock, beforeEach, afterEach, jest } from 'bun:test';
import {
  TimerManager,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  MAX_TIMERS_PER_SESSION,
} from '../timer-manager.js';

describe('TimerManager', () => {
  let manager: TimerManager;
  let onTick: ReturnType<typeof mock>;

  beforeEach(() => {
    onTick = mock(() => {});
    manager = new TimerManager(onTick);
  });

  afterEach(() => {
    manager.disposeAll();
  });

  describe('createTimer', () => {
    it('should return a TimerInfo with correct fields', () => {
      const timer = manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 60,
        action: 'status check',
      });

      expect(timer.id).toBeString();
      expect(timer.id.length).toBeGreaterThan(0);
      expect(timer.sessionId).toBe('session-1');
      expect(timer.workerId).toBe('worker-1');
      expect(timer.intervalSeconds).toBe(60);
      expect(timer.action).toBe('status check');
      expect(timer.createdAt).toBeString();
      expect(timer.fireCount).toBe(0);
      expect(timer.lastFiredAt).toBeUndefined();
    });

    it('should throw when interval is below minimum', () => {
      expect(() =>
        manager.createTimer({
          sessionId: 'session-1',
          workerId: 'worker-1',
          intervalSeconds: MIN_INTERVAL_SECONDS - 1,
          action: 'too fast',
        }),
      ).toThrow();
    });

    it('should throw when interval exceeds maximum', () => {
      expect(() =>
        manager.createTimer({
          sessionId: 'session-1',
          workerId: 'worker-1',
          intervalSeconds: MAX_INTERVAL_SECONDS + 1,
          action: 'too slow',
        }),
      ).toThrow();
    });

    it('should accept the exact minimum interval', () => {
      const timer = manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: MIN_INTERVAL_SECONDS,
        action: 'min interval',
      });
      expect(timer.intervalSeconds).toBe(MIN_INTERVAL_SECONDS);
    });

    it('should accept the exact maximum interval', () => {
      const timer = manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: MAX_INTERVAL_SECONDS,
        action: 'max interval',
      });
      expect(timer.intervalSeconds).toBe(MAX_INTERVAL_SECONDS);
    });

    it('should throw when session reaches the per-session timer limit', () => {
      for (let i = 0; i < MAX_TIMERS_PER_SESSION; i++) {
        manager.createTimer({
          sessionId: 'session-1',
          workerId: 'worker-1',
          intervalSeconds: 60,
          action: `action-${i}`,
        });
      }

      expect(() =>
        manager.createTimer({
          sessionId: 'session-1',
          workerId: 'worker-1',
          intervalSeconds: 60,
          action: 'one too many',
        }),
      ).toThrow();
    });

    it('should allow timers in different sessions independently of per-session limit', () => {
      for (let i = 0; i < MAX_TIMERS_PER_SESSION; i++) {
        manager.createTimer({
          sessionId: 'session-1',
          workerId: 'worker-1',
          intervalSeconds: 60,
          action: `action-${i}`,
        });
      }

      // A different session should still accept timers
      const timer = manager.createTimer({
        sessionId: 'session-2',
        workerId: 'worker-2',
        intervalSeconds: 60,
        action: 'different session',
      });
      expect(timer.sessionId).toBe('session-2');
    });
  });

  describe('deleteTimer', () => {
    it('should return true and remove an existing timer', () => {
      const timer = manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 60,
        action: 'to delete',
      });

      const result = manager.deleteTimer(timer.id);
      expect(result).toBe(true);
      expect(manager.getTimer(timer.id)).toBeUndefined();
    });

    it('should return false for a non-existent timer', () => {
      const result = manager.deleteTimer('non-existent-id');
      expect(result).toBe(false);
    });
  });

  describe('getTimer', () => {
    it('should return TimerInfo for an existing timer', () => {
      const created = manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 120,
        action: 'get me',
      });

      const retrieved = manager.getTimer(created.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.action).toBe('get me');
    });

    it('should return undefined for a non-existent timer', () => {
      expect(manager.getTimer('does-not-exist')).toBeUndefined();
    });
  });

  describe('listTimers', () => {
    it('should list all timers when no sessionId filter is provided', () => {
      manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 60,
        action: 'a',
      });
      manager.createTimer({
        sessionId: 'session-2',
        workerId: 'worker-2',
        intervalSeconds: 120,
        action: 'b',
      });

      const all = manager.listTimers();
      expect(all).toHaveLength(2);
    });

    it('should filter by sessionId when provided', () => {
      manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 60,
        action: 'a',
      });
      manager.createTimer({
        sessionId: 'session-2',
        workerId: 'worker-2',
        intervalSeconds: 60,
        action: 'b',
      });
      manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 120,
        action: 'c',
      });

      const session1Timers = manager.listTimers('session-1');
      expect(session1Timers).toHaveLength(2);
      expect(session1Timers.every((t) => t.sessionId === 'session-1')).toBe(true);
    });

    it('should return an empty array when no timers exist', () => {
      expect(manager.listTimers()).toEqual([]);
    });

    it('should return an empty array when filtering by a session with no timers', () => {
      manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 60,
        action: 'a',
      });

      expect(manager.listTimers('session-other')).toEqual([]);
    });
  });

  describe('deleteTimersBySession', () => {
    it('should delete all timers for a session and return the count', () => {
      manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 60,
        action: 'a',
      });
      manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 120,
        action: 'b',
      });
      manager.createTimer({
        sessionId: 'session-2',
        workerId: 'worker-2',
        intervalSeconds: 60,
        action: 'c',
      });

      const deleted = manager.deleteTimersBySession('session-1');
      expect(deleted).toBe(2);
      expect(manager.listTimers('session-1')).toEqual([]);
    });

    it('should return 0 for a session with no timers', () => {
      expect(manager.deleteTimersBySession('no-such-session')).toBe(0);
    });

    it('should not affect other sessions', () => {
      manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 60,
        action: 'a',
      });
      manager.createTimer({
        sessionId: 'session-2',
        workerId: 'worker-2',
        intervalSeconds: 60,
        action: 'b',
      });

      manager.deleteTimersBySession('session-1');

      const remaining = manager.listTimers();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].sessionId).toBe('session-2');
    });
  });

  describe('disposeAll', () => {
    it('should clear all timers', () => {
      manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 60,
        action: 'a',
      });
      manager.createTimer({
        sessionId: 'session-2',
        workerId: 'worker-2',
        intervalSeconds: 60,
        action: 'b',
      });

      manager.disposeAll();

      expect(manager.listTimers()).toEqual([]);
    });

    it('should result in empty list from listTimers', () => {
      manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 30,
        action: 'x',
      });

      manager.disposeAll();

      expect(manager.listTimers()).toHaveLength(0);
      expect(manager.listTimers('session-1')).toHaveLength(0);
    });
  });

  describe('timer firing behavior', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      manager.disposeAll();
      jest.useRealTimers();
    });

    it('should call onTick after interval elapses', () => {
      manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 60,
        action: 'check status',
      });

      expect(onTick).not.toHaveBeenCalled();

      jest.advanceTimersByTime(60000);

      expect(onTick).toHaveBeenCalledTimes(1);
    });

    it('should increment fireCount on each tick', () => {
      manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 60,
        action: 'check status',
      });

      jest.advanceTimersByTime(60000);
      jest.advanceTimersByTime(60000);
      jest.advanceTimersByTime(60000);

      expect(onTick).toHaveBeenCalledTimes(3);
      const lastCall = onTick.mock.calls[2][0];
      expect(lastCall.fireCount).toBe(3);
    });

    it('should update lastFiredAt on each tick', () => {
      manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 60,
        action: 'check status',
      });

      jest.advanceTimersByTime(60000);

      const callArg = onTick.mock.calls[0][0];
      expect(callArg.lastFiredAt).toBeString();
    });

    it('should stop firing after deleteTimer', () => {
      const timer = manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 60,
        action: 'check status',
      });

      jest.advanceTimersByTime(60000);
      expect(onTick).toHaveBeenCalledTimes(1);

      manager.deleteTimer(timer.id);

      jest.advanceTimersByTime(60000);
      expect(onTick).toHaveBeenCalledTimes(1);
    });

    it('should stop firing after disposeAll', () => {
      manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 60,
        action: 'check status',
      });

      jest.advanceTimersByTime(60000);
      expect(onTick).toHaveBeenCalledTimes(1);

      manager.disposeAll();

      jest.advanceTimersByTime(60000);
      expect(onTick).toHaveBeenCalledTimes(1);
    });
  });
});
