import type { TimerInfo } from '@agent-console/shared';
import type { TimerRepository } from '../repositories/timer-repository.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('timer-manager');

export const MIN_INTERVAL_SECONDS = 10;
export const MAX_INTERVAL_SECONDS = 86400;
export const MAX_TIMERS_PER_SESSION = 20;
export const MIN_BACKOFF_FACTOR = 1;
export const MAX_BACKOFF_FACTOR = 10;

interface StoredTimer {
  info: TimerInfo;
  handle: ReturnType<typeof setTimeout> | undefined;
  /** Fires since creation, restore or the last reset; runtime state, never persisted. */
  step: number;
  /** Set while the owning session is paused; the pending fire's remaining wait. */
  suspended?: { at: string; remainingMs: number };
}

/**
 * The wait, in seconds, before fire number `step + 1`: `base * factor ** step`
 * rounded up and capped at `max`. `step` 0 is always `base`; factor 1 is always
 * `base`. A `factor ** step` that overflows to Infinity is absorbed by the cap.
 */
export function computeEffectiveIntervalSeconds(
  base: number,
  factor: number,
  max: number,
  step: number,
): number {
  return Math.min(Math.ceil(base * factor ** step), max);
}

export class TimerManager {
  private timers = new Map<string, StoredTimer>();
  private onTick: (timer: TimerInfo) => void;

  constructor(
    onTick: (timer: TimerInfo) => void,
    private repository?: TimerRepository,
  ) {
    this.onTick = onTick;
  }

  createTimer(params: {
    sessionId: string;
    workerId: string;
    intervalSeconds: number;
    action: string;
    backoffFactor?: number;
    maxIntervalSeconds?: number;
  }): TimerInfo {
    const { sessionId, workerId, intervalSeconds, action } = params;
    const backoffFactor = params.backoffFactor ?? MIN_BACKOFF_FACTOR;

    if (intervalSeconds < MIN_INTERVAL_SECONDS) {
      throw new Error(
        `Interval ${intervalSeconds}s is below minimum of ${MIN_INTERVAL_SECONDS}s`
      );
    }
    if (intervalSeconds > MAX_INTERVAL_SECONDS) {
      throw new Error(
        `Interval ${intervalSeconds}s exceeds maximum of ${MAX_INTERVAL_SECONDS}s`
      );
    }

    if (
      !Number.isFinite(backoffFactor) ||
      backoffFactor < MIN_BACKOFF_FACTOR ||
      backoffFactor > MAX_BACKOFF_FACTOR
    ) {
      throw new Error(
        `backoffFactor ${backoffFactor} must be between ${MIN_BACKOFF_FACTOR} and ${MAX_BACKOFF_FACTOR}`
      );
    }
    if (params.maxIntervalSeconds !== undefined) {
      if (backoffFactor === MIN_BACKOFF_FACTOR) {
        throw new Error('maxIntervalSeconds has no effect without backoffFactor > 1');
      }
      if (!Number.isInteger(params.maxIntervalSeconds)) {
        throw new Error(`maxIntervalSeconds ${params.maxIntervalSeconds} must be an integer`);
      }
      if (params.maxIntervalSeconds < intervalSeconds) {
        throw new Error(
          `maxIntervalSeconds ${params.maxIntervalSeconds}s is below intervalSeconds ${intervalSeconds}s`
        );
      }
      if (params.maxIntervalSeconds > MAX_INTERVAL_SECONDS) {
        throw new Error(
          `maxIntervalSeconds ${params.maxIntervalSeconds}s exceeds maximum of ${MAX_INTERVAL_SECONDS}s`
        );
      }
    }
    const maxIntervalSeconds = params.maxIntervalSeconds ?? MAX_INTERVAL_SECONDS;

    const sessionTimerCount = this.listTimers(sessionId).length;
    if (sessionTimerCount >= MAX_TIMERS_PER_SESSION) {
      throw new Error(
        `Session ${sessionId} already has ${sessionTimerCount} timers (max ${MAX_TIMERS_PER_SESSION})`
      );
    }

    const id = crypto.randomUUID();
    const info: TimerInfo = {
      id,
      sessionId,
      workerId,
      intervalSeconds,
      action,
      createdAt: new Date().toISOString(),
      fireCount: 0,
      backoffFactor,
      maxIntervalSeconds,
      currentIntervalSeconds: intervalSeconds,
      nextFireAt: '',
    };

    this.timers.set(id, this.startChain(info));
    if (this.repository) {
      this.repository.save({
        id: info.id,
        sessionId: info.sessionId,
        workerId: info.workerId,
        intervalSeconds: info.intervalSeconds,
        action: info.action,
        createdAt: info.createdAt,
        backoffFactor: info.backoffFactor,
        maxIntervalSeconds: info.maxIntervalSeconds,
      }).catch((err) => {
        logger.warn({ timerId: id, err }, 'Failed to persist timer, continuing as volatile');
      });
    }
    logger.info(
      { timerId: id, sessionId, workerId, intervalSeconds, backoffFactor, maxIntervalSeconds },
      'Timer created'
    );

    return { ...info };
  }

  deleteTimer(timerId: string): boolean {
    const stored = this.timers.get(timerId);
    if (!stored) {
      return false;
    }

    clearTimeout(stored.handle);
    this.timers.delete(timerId);
    if (this.repository) {
      this.repository.delete(timerId).catch((err) => {
        logger.warn({ timerId, err }, 'Failed to delete persisted timer');
      });
    }
    logger.info({ timerId }, 'Timer deleted');
    return true;
  }

  /**
   * Return a timer to its base interval: the next wait is `intervalSeconds`
   * from now and the backoff starts over. `fireCount` is kept. On a timer
   * without backoff this simply restarts the wait from now.
   */
  resetTimer(timerId: string): TimerInfo | undefined {
    const stored = this.timers.get(timerId);
    if (!stored) {
      return undefined;
    }

    clearTimeout(stored.handle);
    if (stored.suspended) {
      stored.step = 0;
      stored.info.currentIntervalSeconds = stored.info.intervalSeconds;
      stored.suspended.remainingMs = stored.info.intervalSeconds * 1000;
      stored.info.nextFireAt = new Date(
        Date.now() + stored.suspended.remainingMs,
      ).toISOString();
      logger.info({ timerId }, 'Suspended timer reset to base interval');
      return { ...stored.info };
    }
    const restarted = this.startChain(stored.info);
    this.timers.set(timerId, restarted);
    logger.info({ timerId }, 'Timer reset to base interval');
    return { ...restarted.info };
  }

  getTimer(timerId: string): TimerInfo | undefined {
    const stored = this.timers.get(timerId);
    return stored ? { ...stored.info } : undefined;
  }

  listTimers(sessionId?: string): TimerInfo[] {
    const all = Array.from(this.timers.values(), (stored) => ({ ...stored.info }));
    if (sessionId === undefined) {
      return all;
    }
    return all.filter((info) => info.sessionId === sessionId);
  }

  deleteTimersBySession(sessionId: string): number {
    let count = 0;
    for (const [id, stored] of this.timers) {
      if (stored.info.sessionId === sessionId) {
        clearTimeout(stored.handle);
        this.timers.delete(id);
        count += 1;
      }
    }
    if (count > 0) {
      logger.info({ sessionId, count }, 'Deleted timers for session');
    }
    if (this.repository && count > 0) {
      this.repository.deleteBySessionId(sessionId).catch((err) => {
        logger.warn({ sessionId, err }, 'Failed to delete persisted timers for session');
      });
    }
    return count;
  }

  /**
   * Freeze every armed timer of a session: the pending fire is cancelled and
   * its remaining wait remembered. Backoff state is untouched. Idempotent.
   */
  suspendTimersBySession(sessionId: string): number {
    let count = 0;
    const now = Date.now();
    for (const stored of this.timers.values()) {
      if (stored.info.sessionId !== sessionId || stored.suspended) {
        continue;
      }
      clearTimeout(stored.handle);
      stored.handle = undefined;
      const remainingMs = Math.max(0, Date.parse(stored.info.nextFireAt) - now);
      const at = new Date(now).toISOString();
      stored.suspended = { at, remainingMs };
      stored.info.suspendedAt = at;
      count += 1;
    }
    if (count > 0) {
      logger.info({ sessionId, count }, 'Suspended timers for session');
    }
    return count;
  }

  /**
   * Re-arm every suspended timer of a session with its remaining wait,
   * continuing the same chain (same step). Idempotent.
   */
  resumeTimersBySession(sessionId: string): number {
    let count = 0;
    for (const stored of this.timers.values()) {
      if (stored.info.sessionId !== sessionId || !stored.suspended) {
        continue;
      }
      const { remainingMs } = stored.suspended;
      stored.suspended = undefined;
      delete stored.info.suspendedAt;
      this.armFire(stored, remainingMs);
      count += 1;
    }
    if (count > 0) {
      logger.info({ sessionId, count }, 'Resumed timers for session');
    }
    return count;
  }

  disposeAll(): void {
    for (const stored of this.timers.values()) {
      clearTimeout(stored.handle);
    }
    const count = this.timers.size;
    this.timers.clear();
    logger.info({ count }, 'All timers disposed');
  }

  async restoreTimers(options: { isSessionLive: (sessionId: string) => boolean }): Promise<number> {
    if (!this.repository) {
      return 0;
    }

    let records;
    try {
      records = await this.repository.findAll();
    } catch (err) {
      logger.warn({ err }, 'Failed to load persisted timers, starting fresh');
      return 0;
    }

    let restored = 0;
    for (const record of records) {
      const info: TimerInfo = {
        id: record.id,
        sessionId: record.sessionId,
        workerId: record.workerId,
        intervalSeconds: record.intervalSeconds,
        action: record.action,
        createdAt: record.createdAt,
        fireCount: 0,
        backoffFactor: record.backoffFactor,
        maxIntervalSeconds: record.maxIntervalSeconds,
        currentIntervalSeconds: record.intervalSeconds,
        nextFireAt: '',
      };

      if (options.isSessionLive(record.sessionId)) {
        this.timers.set(record.id, this.startChain(info));
      } else {
        const now = Date.now();
        const remainingMs = record.intervalSeconds * 1000;
        const at = new Date(now).toISOString();
        info.nextFireAt = new Date(now + remainingMs).toISOString();
        info.suspendedAt = at;
        this.timers.set(record.id, {
          info,
          step: 0,
          handle: undefined,
          suspended: { at, remainingMs },
        });
      }
      restored += 1;
    }

    if (restored > 0) {
      logger.info({ count: restored }, 'Restored persisted timers');
    }

    return restored;
  }

  /**
   * Start (or restart) the self-rescheduling wait chain for a timer at step 0.
   * Each fire advances the step, computes the NEXT wait, records it on the info
   * and only then calls `onTick`, so the tick payload already describes the
   * next wake-up.
   */
  private startChain(info: TimerInfo): StoredTimer {
    const stored: StoredTimer = { info, step: 0, handle: undefined };
    info.currentIntervalSeconds = info.intervalSeconds;
    this.scheduleNext(stored);
    return stored;
  }

  private scheduleNext(stored: StoredTimer): void {
    this.armFire(stored, stored.info.currentIntervalSeconds * 1000);
  }

  /** Arm the pending fire of a chain to run after `delayMs`. */
  private armFire(stored: StoredTimer, delayMs: number): void {
    const { info } = stored;
    info.nextFireAt = new Date(Date.now() + delayMs).toISOString();
    stored.handle = setTimeout(() => {
      stored.step += 1;
      info.lastFiredAt = new Date().toISOString();
      info.fireCount += 1;
      info.currentIntervalSeconds = computeEffectiveIntervalSeconds(
        info.intervalSeconds,
        info.backoffFactor,
        info.maxIntervalSeconds,
        stored.step,
      );
      this.scheduleNext(stored);
      logger.debug({ timerId: info.id, fireCount: info.fireCount }, 'Timer fired');
      this.onTick({ ...info });
    }, delayMs);
  }
}
