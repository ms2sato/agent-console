import { describe, it, expect, mock, afterEach } from 'bun:test';
import { IdleEvictionTimers } from '../embedded-agent-idle-eviction.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('IdleEvictionTimers', () => {
  let timers: IdleEvictionTimers | undefined;

  const createTimers = (
    idleTimeoutMs: number,
    onExpire: (workerId: string) => void,
  ): IdleEvictionTimers => {
    timers = new IdleEvictionTimers({ idleTimeoutMs, onExpire });
    return timers;
  };

  afterEach(() => {
    timers?.clearAll();
    timers = undefined;
  });

  describe('enabled', () => {
    it('should be true for a positive timeout', () => {
      expect(createTimers(20, () => {}).enabled).toBe(true);
    });

    it('should be false for a zero timeout', () => {
      expect(createTimers(0, () => {}).enabled).toBe(false);
    });

    it('should be false for a negative timeout', () => {
      expect(createTimers(-1, () => {}).enabled).toBe(false);
    });
  });

  describe('touch', () => {
    it('should arm a countdown and fire onExpire once with the worker id', async () => {
      const onExpire = mock((_workerId: string) => {});
      const t = createTimers(15, onExpire);

      t.touch('worker-1');
      expect(t.isArmed('worker-1')).toBe(true);
      expect(onExpire).not.toHaveBeenCalled();

      await sleep(60);

      expect(onExpire).toHaveBeenCalledTimes(1);
      expect(onExpire).toHaveBeenCalledWith('worker-1');
      expect(t.isArmed('worker-1')).toBe(false);
    });

    it('should postpone expiry when touched again before it elapses', async () => {
      const onExpire = mock((_workerId: string) => {});
      const t = createTimers(40, onExpire);

      t.touch('worker-1');
      await sleep(25);
      // The first countdown has NOT elapsed yet; re-touching restarts it.
      t.touch('worker-1');

      // Past the moment the first countdown would have fired (t≈40ms).
      await sleep(30);
      expect(onExpire).not.toHaveBeenCalled();
      expect(t.isArmed('worker-1')).toBe(true);

      // Past the moment the second countdown fires (t≈65ms).
      await sleep(50);
      expect(onExpire).toHaveBeenCalledTimes(1);
      expect(onExpire).toHaveBeenCalledWith('worker-1');
    });
  });

  describe('clear', () => {
    it('should prevent onExpire entirely when called before expiry', async () => {
      const onExpire = mock((_workerId: string) => {});
      const t = createTimers(15, onExpire);

      t.touch('worker-1');
      t.clear('worker-1');
      expect(t.isArmed('worker-1')).toBe(false);

      await sleep(60);
      expect(onExpire).not.toHaveBeenCalled();
    });

    it('should not throw for an unknown worker id', () => {
      const t = createTimers(15, () => {});
      expect(() => t.clear('never-touched')).not.toThrow();
    });

    it('should not throw when called twice for the same worker', () => {
      const t = createTimers(15, () => {});
      t.touch('worker-1');
      expect(() => {
        t.clear('worker-1');
        t.clear('worker-1');
      }).not.toThrow();
      expect(t.isArmed('worker-1')).toBe(false);
    });
  });

  describe('clearAll', () => {
    it('should cancel every armed worker at once', async () => {
      const onExpire = mock((_workerId: string) => {});
      const t = createTimers(15, onExpire);

      t.touch('worker-1');
      t.touch('worker-2');
      t.touch('worker-3');
      expect(t.isArmed('worker-1')).toBe(true);
      expect(t.isArmed('worker-2')).toBe(true);
      expect(t.isArmed('worker-3')).toBe(true);

      t.clearAll();

      expect(t.isArmed('worker-1')).toBe(false);
      expect(t.isArmed('worker-2')).toBe(false);
      expect(t.isArmed('worker-3')).toBe(false);

      await sleep(60);
      expect(onExpire).not.toHaveBeenCalled();
    });
  });

  describe('re-arm from inside onExpire', () => {
    it('should keep the re-armed countdown, not clobber it with the expiring entry cleanup', async () => {
      const calls: string[] = [];
      const t = createTimers(20, (workerId) => {
        calls.push(workerId);
        // Commit-point decision: not evictable right now, so re-arm.
        if (calls.length === 1) {
          timers?.touch(workerId);
        }
      });

      t.touch('worker-1');

      // After the first callback returned, the re-armed countdown must still
      // be in flight -- proving the map entry was deleted BEFORE onExpire ran.
      await sleep(40);
      expect(calls).toEqual(['worker-1']);
      expect(t.isArmed('worker-1')).toBe(true);

      // The re-armed countdown then fires on its own.
      await sleep(50);
      expect(calls).toEqual(['worker-1', 'worker-1']);
      expect(t.isArmed('worker-1')).toBe(false);
    });
  });

  describe('disabled mode', () => {
    it('should never arm or fire when idleTimeoutMs is 0', async () => {
      const onExpire = mock((_workerId: string) => {});
      const t = createTimers(0, onExpire);

      t.touch('worker-1');
      expect(t.enabled).toBe(false);
      expect(t.isArmed('worker-1')).toBe(false);

      await sleep(40);
      expect(onExpire).not.toHaveBeenCalled();
    });

    it('should never arm or fire when idleTimeoutMs is negative', async () => {
      const onExpire = mock((_workerId: string) => {});
      const t = createTimers(-100, onExpire);

      t.touch('worker-1');
      expect(t.enabled).toBe(false);
      expect(t.isArmed('worker-1')).toBe(false);

      await sleep(40);
      expect(onExpire).not.toHaveBeenCalled();
    });
  });

  describe('independence between workers', () => {
    it('should expire workers in touch order without interfering', async () => {
      const expired: string[] = [];
      const t = createTimers(40, (workerId) => {
        expired.push(workerId);
      });

      t.touch('worker-1');
      await sleep(25);
      t.touch('worker-2');

      // t≈55ms: worker-1's countdown (fires at ≈40ms) has elapsed,
      // worker-2's (fires at ≈65ms) has not.
      await sleep(30);
      expect(expired).toEqual(['worker-1']);
      expect(t.isArmed('worker-1')).toBe(false);
      expect(t.isArmed('worker-2')).toBe(true);

      await sleep(50);
      expect(expired).toEqual(['worker-1', 'worker-2']);
    });

    it('should not disturb another worker when one is cleared', async () => {
      const expired: string[] = [];
      const t = createTimers(20, (workerId) => {
        expired.push(workerId);
      });

      t.touch('worker-1');
      t.touch('worker-2');
      t.clear('worker-1');

      expect(t.isArmed('worker-1')).toBe(false);
      expect(t.isArmed('worker-2')).toBe(true);

      await sleep(60);
      expect(expired).toEqual(['worker-2']);
    });
  });
});
