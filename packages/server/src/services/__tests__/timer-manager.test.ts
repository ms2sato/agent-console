import { describe, it, expect, mock, beforeEach, afterEach, jest } from 'bun:test';
import {
  TimerManager,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  MAX_TIMERS_PER_SESSION,
  computeEffectiveIntervalSeconds,
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

  describe('restoreTimers (without repository)', () => {
    it('should return 0 when no repository is provided', async () => {
      const count = await manager.restoreTimers();
      expect(count).toBe(0);
    });
  });
  describe('computeEffectiveIntervalSeconds', () => {
    it('stays at base for factor 1', () => {
      expect(computeEffectiveIntervalSeconds(60, 1, 86400, 5)).toBe(60);
    });

    it('doubles per step and starts at base on step 0', () => {
      const waits = [0, 1, 2, 3].map((step) => computeEffectiveIntervalSeconds(60, 2, 86400, step));
      expect(waits).toEqual([60, 120, 240, 480]);
    });

    it('caps at max', () => {
      expect(computeEffectiveIntervalSeconds(60, 10, 600, 2)).toBe(600);
    });

    it('absorbs an Infinity power into the cap', () => {
      expect(computeEffectiveIntervalSeconds(60, 10, 86400, 1100)).toBe(86400);
    });

    it('rounds fractional waits up', () => {
      expect(computeEffectiveIntervalSeconds(7, 1.5, 86400, 1)).toBe(11);
    });
  });

  describe('backoff validation', () => {
    const create = (extra: { backoffFactor?: number; maxIntervalSeconds?: number }, intervalSeconds = 60) =>
      manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds,
        action: 'x',
        ...extra,
      });

    it.each([
      [0.5, 'backoffFactor 0.5 must be between 1 and 10'],
      [0, 'backoffFactor 0 must be between 1 and 10'],
      [11, 'backoffFactor 11 must be between 1 and 10'],
      [10.01, 'backoffFactor 10.01 must be between 1 and 10'],
      [Number.NaN, 'backoffFactor NaN must be between 1 and 10'],
      [Number.POSITIVE_INFINITY, 'backoffFactor Infinity must be between 1 and 10'],
    ])('rejects backoffFactor %p', (backoffFactor, message) => {
      expect(() => create({ backoffFactor })).toThrow(message);
    });

    it('accepts the factor boundaries 1 and 10', () => {
      expect(create({ backoffFactor: 1 }).backoffFactor).toBe(1);
      expect(create({ backoffFactor: 10 }).backoffFactor).toBe(10);
    });

    it('rejects maxIntervalSeconds below intervalSeconds', () => {
      expect(() => create({ backoffFactor: 2, maxIntervalSeconds: 30 })).toThrow(
        'maxIntervalSeconds 30s is below intervalSeconds 60s',
      );
    });

    it('rejects maxIntervalSeconds above the global maximum', () => {
      expect(() => create({ backoffFactor: 2, maxIntervalSeconds: 86401 })).toThrow(
        'maxIntervalSeconds 86401s exceeds maximum of 86400s',
      );
    });

    it('rejects a non-integer maxIntervalSeconds', () => {
      expect(() => create({ backoffFactor: 2, maxIntervalSeconds: 100.5 })).toThrow(
        'maxIntervalSeconds 100.5 must be an integer',
      );
    });

    it('rejects maxIntervalSeconds without backoffFactor', () => {
      expect(() => create({ maxIntervalSeconds: 600 })).toThrow(
        'maxIntervalSeconds has no effect without backoffFactor > 1',
      );
    });

    it('rejects maxIntervalSeconds with backoffFactor 1', () => {
      expect(() => create({ backoffFactor: 1, maxIntervalSeconds: 600 })).toThrow(
        'maxIntervalSeconds has no effect without backoffFactor > 1',
      );
    });

    it('accepts maxIntervalSeconds equal to intervalSeconds and to the global maximum', () => {
      expect(create({ backoffFactor: 2, maxIntervalSeconds: 60 }).maxIntervalSeconds).toBe(60);
      expect(create({ backoffFactor: 2, maxIntervalSeconds: 86400 }).maxIntervalSeconds).toBe(86400);
    });

    it('defaults to factor 1 and the global maximum', () => {
      const timer = create({});
      expect(timer.backoffFactor).toBe(1);
      expect(timer.maxIntervalSeconds).toBe(MAX_INTERVAL_SECONDS);
      expect(timer.currentIntervalSeconds).toBe(60);
    });
  });

  describe('backoff firing', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      manager.disposeAll();
      jest.useRealTimers();
    });

    const base = { sessionId: 'session-1', workerId: 'worker-1', action: 'x' };

    it('stretches the wait by the factor after each fire', () => {
      manager.createTimer({ ...base, intervalSeconds: 60, backoffFactor: 2 });

      jest.advanceTimersByTime(60000);
      expect(onTick).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(119999);
      expect(onTick).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1);
      expect(onTick).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(240000);
      expect(onTick).toHaveBeenCalledTimes(3);
    });

    it('stops stretching at maxIntervalSeconds', () => {
      manager.createTimer({ ...base, intervalSeconds: 60, backoffFactor: 10, maxIntervalSeconds: 600 });

      jest.advanceTimersByTime(60000);
      expect(onTick).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(599999);
      expect(onTick).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1);
      expect(onTick).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(600000);
      expect(onTick).toHaveBeenCalledTimes(3);
    });

    it('keeps a fixed cadence by default', () => {
      const timer = manager.createTimer({ ...base, intervalSeconds: 60 });

      for (let i = 1; i <= 3; i++) {
        jest.advanceTimersByTime(60000);
        expect(onTick).toHaveBeenCalledTimes(i);
        expect(manager.getTimer(timer.id)?.currentIntervalSeconds).toBe(60);
      }
    });

    it('hands onTick a payload that already describes the next wake-up', () => {
      const created = manager.createTimer({ ...base, intervalSeconds: 60, backoffFactor: 2 });
      expect(created.nextFireAt).toBe(new Date(Date.now() + 60000).toISOString());

      jest.advanceTimersByTime(60000);

      const payload = onTick.mock.calls[0]?.[0];
      expect(payload.currentIntervalSeconds).toBe(120);
      expect(payload.nextFireAt).toBe(new Date(Date.now() + 120000).toISOString());
      expect(payload.fireCount).toBe(1);
    });

    it('stops a chained timer when its session is deleted', () => {
      manager.createTimer({ ...base, intervalSeconds: 60, backoffFactor: 2 });
      jest.advanceTimersByTime(60000);
      expect(onTick).toHaveBeenCalledTimes(1);

      manager.deleteTimersBySession('session-1');
      jest.advanceTimersByTime(10_000_000);

      expect(onTick).toHaveBeenCalledTimes(1);
    });
  });

  describe('resetTimer', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      manager.disposeAll();
      jest.useRealTimers();
    });

    const base = { sessionId: 'session-1', workerId: 'worker-1', action: 'x' };

    it('returns the next wait to the base interval and keeps fireCount', () => {
      const timer = manager.createTimer({ ...base, intervalSeconds: 60, backoffFactor: 2 });
      jest.advanceTimersByTime(60000);
      jest.advanceTimersByTime(120000);
      expect(onTick).toHaveBeenCalledTimes(2);
      expect(manager.getTimer(timer.id)?.currentIntervalSeconds).toBe(240);

      const reset = manager.resetTimer(timer.id);

      expect(reset?.fireCount).toBe(2);
      expect(reset?.currentIntervalSeconds).toBe(60);
      expect(reset?.nextFireAt).toBe(new Date(Date.now() + 60000).toISOString());
      jest.advanceTimersByTime(59999);
      expect(onTick).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(1);
      expect(onTick).toHaveBeenCalledTimes(3);
      expect(manager.getTimer(timer.id)?.currentIntervalSeconds).toBe(120);
    });

    // Measured reach: removing the clearTimeout from resetTimer makes this fail
    // (the old 20 s wait still fires at t=30, a third tick); the previous shape
    // (reset right after a fire, then advance a full base interval) passed without it.
    it('does not leave the old pending wait running', () => {
      const timer = manager.createTimer({ ...base, intervalSeconds: 10, backoffFactor: 2 });
      jest.advanceTimersByTime(10000);
      expect(onTick).toHaveBeenCalledTimes(1);
      expect(manager.getTimer(timer.id)?.currentIntervalSeconds).toBe(20);

      // Pending wait would fire at t=30 s; reset at t=15 s moves the next fire to t=25 s.
      jest.advanceTimersByTime(5000);
      manager.resetTimer(timer.id);
      jest.advanceTimersByTime(20000);

      // t=35 s: the new base fire at t=25 s only. The old wait (t=30 s) must not have fired.
      expect(onTick).toHaveBeenCalledTimes(2);
    });

    it('restarts the wait from now on a fixed-interval timer', () => {
      const timer = manager.createTimer({ ...base, intervalSeconds: 60 });
      jest.advanceTimersByTime(50000);

      manager.resetTimer(timer.id);
      jest.advanceTimersByTime(59999);
      expect(onTick).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(onTick).toHaveBeenCalledTimes(1);
    });

    it('returns a copy', () => {
      const timer = manager.createTimer({ ...base, intervalSeconds: 60, backoffFactor: 2 });
      const reset = manager.resetTimer(timer.id);
      expect(reset).toBeDefined();
      if (reset) reset.fireCount = 99;
      expect(manager.getTimer(timer.id)?.fireCount).toBe(0);
    });

    it('returns undefined for an unknown id', () => {
      expect(manager.resetTimer('nope')).toBeUndefined();
    });
  });
});
