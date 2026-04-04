import type { TimerInfo } from '@agent-console/shared';
import type { TimerRepository } from '../repositories/timer-repository.js';
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
      this.onTick({ ...info });
    }, intervalSeconds * 1000);

    this.timers.set(id, { info, handle });
    if (this.repository) {
      this.repository.save({
        id: info.id,
        sessionId: info.sessionId,
        workerId: info.workerId,
        intervalSeconds: info.intervalSeconds,
        action: info.action,
        createdAt: info.createdAt,
      }).catch((err) => {
        logger.warn({ timerId: id, err }, 'Failed to persist timer, continuing as volatile');
      });
    }
    logger.info(
      { timerId: id, sessionId, workerId, intervalSeconds },
      'Timer created'
    );

    return { ...info };
  }

  deleteTimer(timerId: string): boolean {
    const stored = this.timers.get(timerId);
    if (!stored) {
      return false;
    }

    clearInterval(stored.handle);
    this.timers.delete(timerId);
    if (this.repository) {
      this.repository.delete(timerId).catch((err) => {
        logger.warn({ timerId, err }, 'Failed to delete persisted timer');
      });
    }
    logger.info({ timerId }, 'Timer deleted');
    return true;
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
        clearInterval(stored.handle);
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

  disposeAll(): void {
    for (const stored of this.timers.values()) {
      clearInterval(stored.handle);
    }
    const count = this.timers.size;
    this.timers.clear();
    logger.info({ count }, 'All timers disposed');
  }

  async restoreTimers(): Promise<number> {
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
      };

      const handle = setInterval(() => {
        info.lastFiredAt = new Date().toISOString();
        info.fireCount += 1;
        logger.debug({ timerId: info.id, fireCount: info.fireCount }, 'Timer fired');
        this.onTick({ ...info });
      }, record.intervalSeconds * 1000);

      this.timers.set(record.id, { info, handle });
      restored += 1;
    }

    if (restored > 0) {
      logger.info({ count: restored }, 'Restored persisted timers');
    }

    return restored;
  }
}
