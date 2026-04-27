import type { ConditionalWakeupInfo } from '@agent-console/shared';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('conditional-wakeup-manager');

export const MIN_INTERVAL_SECONDS = 30;
export const MAX_INTERVAL_SECONDS = 86400;
export const MAX_WAKEUPS_PER_SESSION = 20;

interface StoredWakeup {
  info: ConditionalWakeupInfo;
  handle: ReturnType<typeof setInterval>;
  currentProcess?: {
    exited: Promise<number | null>;
    kill: () => void;
  };
}

export class ConditionalWakeupManager {
  private wakeups = new Map<string, StoredWakeup>();
  private onWakeup: (wakeup: ConditionalWakeupInfo) => void;

  constructor(onWakeup: (wakeup: ConditionalWakeupInfo) => void) {
    this.onWakeup = onWakeup;
  }

  createWakeup(params: {
    sessionId: string;
    workerId: string;
    intervalSeconds: number;
    conditionScript: string;
    onTrueMessage: string;
    timeoutSeconds?: number;
    onTimeoutMessage?: string;
  }): ConditionalWakeupInfo {
    const {
      sessionId,
      workerId,
      intervalSeconds,
      conditionScript,
      onTrueMessage,
      timeoutSeconds,
      onTimeoutMessage,
    } = params;

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

    const sessionWakeupCount = this.listWakeups(sessionId).filter(
      w => w.status === 'running'
    ).length;
    if (sessionWakeupCount >= MAX_WAKEUPS_PER_SESSION) {
      throw new Error(
        `Session ${sessionId} already has ${sessionWakeupCount} running wakeups (max ${MAX_WAKEUPS_PER_SESSION})`
      );
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const info: ConditionalWakeupInfo = {
      id,
      sessionId,
      workerId,
      intervalSeconds,
      conditionScript,
      onTrueMessage,
      timeoutSeconds,
      onTimeoutMessage,
      createdAt,
      checkCount: 0,
      status: 'running',
    };

    const handle = setInterval(() => {
      this.checkCondition(id);
    }, intervalSeconds * 1000);

    this.wakeups.set(id, { info, handle });

    // Set up timeout if specified
    if (timeoutSeconds) {
      setTimeout(() => {
        this.handleTimeout(id);
      }, timeoutSeconds * 1000);
    }

    logger.info(
      { wakeupId: id, sessionId, workerId, intervalSeconds, timeoutSeconds },
      'Conditional wakeup created'
    );

    return { ...info };
  }

  deleteWakeup(wakeupId: string): boolean {
    const stored = this.wakeups.get(wakeupId);
    if (!stored) {
      return false;
    }

    this.cleanupWakeup(wakeupId, 'cancelled');
    logger.info({ wakeupId }, 'Conditional wakeup deleted');
    return true;
  }

  getWakeup(wakeupId: string): ConditionalWakeupInfo | undefined {
    const stored = this.wakeups.get(wakeupId);
    return stored ? { ...stored.info } : undefined;
  }

  listWakeups(sessionId?: string): ConditionalWakeupInfo[] {
    const all = Array.from(this.wakeups.values(), (stored) => ({ ...stored.info }));
    if (sessionId === undefined) {
      return all;
    }
    return all.filter((info) => info.sessionId === sessionId);
  }

  deleteWakeupsBySession(sessionId: string): number {
    let count = 0;
    for (const [id, stored] of this.wakeups) {
      if (stored.info.sessionId === sessionId) {
        this.cleanupWakeup(id, 'cancelled');
        count += 1;
      }
    }
    if (count > 0) {
      logger.info({ sessionId, count }, 'Deleted wakeups for session');
    }
    return count;
  }

  disposeAll(): void {
    const count = this.wakeups.size;
    for (const [id] of this.wakeups) {
      this.cleanupWakeup(id, 'cancelled');
    }
    logger.info({ count }, 'All wakeups disposed');
  }

  private async checkCondition(wakeupId: string): Promise<void> {
    const stored = this.wakeups.get(wakeupId);
    if (!stored || stored.info.status !== 'running') {
      return;
    }

    try {
      // Cancel any existing process
      if (stored.currentProcess) {
        stored.currentProcess.kill();
      }

      const process = Bun.spawn(['sh', '-c', stored.info.conditionScript], {
        stdout: 'ignore',
        stderr: 'ignore',
      });

      stored.currentProcess = process;

      stored.info.lastCheckedAt = new Date().toISOString();
      stored.info.checkCount += 1;

      logger.debug(
        { wakeupId, checkCount: stored.info.checkCount },
        'Checking condition'
      );

      const exitCode = await process.exited;

      // Clear the current process reference since it's complete
      stored.currentProcess = undefined;

      if (exitCode === 0) {
        // Condition is true - complete and notify
        this.completeWakeup(wakeupId, 'completed_true');
      }
      // For non-zero exit, just continue silent polling
    } catch (error) {
      logger.warn(
        { wakeupId, error: error instanceof Error ? error.message : 'Unknown error' },
        'Error checking condition'
      );
    }
  }

  private handleTimeout(wakeupId: string): void {
    const stored = this.wakeups.get(wakeupId);
    if (!stored || stored.info.status !== 'running') {
      return;
    }

    logger.info({ wakeupId }, 'Conditional wakeup timed out');
    this.completeWakeup(wakeupId, 'completed_timeout');
  }

  private completeWakeup(
    wakeupId: string,
    status: 'completed_true' | 'completed_timeout'
  ): void {
    const stored = this.wakeups.get(wakeupId);
    if (!stored) {
      return;
    }

    stored.info.status = status;

    // Determine the message to send
    let message: string;
    if (status === 'completed_true') {
      message = stored.info.onTrueMessage;
    } else {
      message = stored.info.onTimeoutMessage ||
        `Conditional wakeup timed out after ${stored.info.timeoutSeconds}s`;
    }

    const notificationInfo = {
      ...stored.info,
      notificationMessage: message
    };

    // Send the notification
    this.onWakeup(notificationInfo);

    // Clean up resources but keep the record for status tracking
    this.cleanupWakeupResources(wakeupId);
  }

  private cleanupWakeup(
    wakeupId: string,
    status: ConditionalWakeupInfo['status']
  ): void {
    const stored = this.wakeups.get(wakeupId);
    if (stored) {
      stored.info.status = status;
      this.cleanupWakeupResources(wakeupId);
      this.wakeups.delete(wakeupId);
    }
  }

  private cleanupWakeupResources(wakeupId: string): void {
    const stored = this.wakeups.get(wakeupId);
    if (!stored) {
      return;
    }

    // Clear the interval
    clearInterval(stored.handle);

    // Kill any running process
    if (stored.currentProcess) {
      try {
        stored.currentProcess.kill();
      } catch (error) {
        logger.warn(
          { wakeupId, error: error instanceof Error ? error.message : 'Unknown error' },
          'Error killing condition check process'
        );
      }
      stored.currentProcess = undefined;
    }
  }
}