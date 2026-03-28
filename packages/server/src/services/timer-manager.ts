import type { TimerInfo } from '@agent-console/shared';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('timer-manager');

export const MIN_INTERVAL_SECONDS = 10;
export const MAX_INTERVAL_SECONDS = 86400;
export const MAX_TIMERS_PER_SESSION = 20;

interface StoredTimer {
  info: TimerInfo;
  handle: ReturnType<typeof setInterval>;
}

export class TimerManager {
  private timers = new Map<string, StoredTimer>();
  private onTick: (timer: TimerInfo) => void;

  constructor(onTick: (timer: TimerInfo) => void) {
    this.onTick = onTick;
  }

  createTimer(params: {
    sessionId: string;
    workerId: string;
    intervalSeconds: number;
    action: string;
  }): TimerInfo {
    const { sessionId, workerId, intervalSeconds, action } = params;

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
    };

    const handle = setInterval(() => {
      info.lastFiredAt = new Date().toISOString();
      info.fireCount += 1;
      logger.debug({ timerId: id, fireCount: info.fireCount }, 'Timer fired');
      this.onTick(info);
    }, intervalSeconds * 1000);

    this.timers.set(id, { info, handle });
    logger.info(
      { timerId: id, sessionId, workerId, intervalSeconds },
      'Timer created'
    );

    return info;
  }

  deleteTimer(timerId: string): boolean {
    const stored = this.timers.get(timerId);
    if (!stored) {
      return false;
    }

    clearInterval(stored.handle);
    this.timers.delete(timerId);
    logger.info({ timerId }, 'Timer deleted');
    return true;
  }

  getTimer(timerId: string): TimerInfo | undefined {
    return this.timers.get(timerId)?.info;
  }

  listTimers(sessionId?: string): TimerInfo[] {
    const all = Array.from(this.timers.values(), (stored) => stored.info);
    if (sessionId === undefined) {
      return all;
    }
    return all.filter((info) => info.sessionId === sessionId);
  }

  deleteTimersBySession(sessionId: string): number {
    let count = 0;
    for (const [id, stored] of this.timers) {
      if (stored.info.sessionId === sessionId) {
        clearInterval(stored.handle);
        this.timers.delete(id);
        count += 1;
      }
    }
    if (count > 0) {
      logger.info({ sessionId, count }, 'Deleted timers for session');
    }
    return count;
  }

  disposeAll(): void {
    for (const stored of this.timers.values()) {
      clearInterval(stored.handle);
    }
    const count = this.timers.size;
    this.timers.clear();
    logger.info({ count }, 'All timers disposed');
  }
}
