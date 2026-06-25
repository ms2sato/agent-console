import type { ConditionalWakeupInfo } from '@agent-console/shared';
import { createLogger } from '../lib/logger.js';
import { spawnAsUser, type SpawnAsUserFn } from './privilege-elevation.js';

const logger = createLogger('conditional-wakeup-manager');

export const MIN_INTERVAL_SECONDS = 30;
export const MAX_INTERVAL_SECONDS = 86400;
export const MAX_WAKEUPS_PER_SESSION = 20;

interface StoredWakeup {
  info: ConditionalWakeupInfo;
  handle: ReturnType<typeof setInterval>;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  currentProcess?: {
    exited: Promise<number | null>;
    kill: () => void;
  };
  checking: boolean;
  /**
   * OS username under which `conditionScript` should be spawned in
   * multi-user mode. `null` / `undefined` (or `AUTH_MODE !== 'multi-user'`,
   * or same-as-server-user) bypasses elevation -- single-user behaviour
   * preserved. Resolved once at `createWakeup` time from the calling
   * session's `createdBy`. Mirrors the `requestUser` field plumbed into
   * `InteractiveProcessManager.runProcess` by PR #880.
   */
  requestUsername?: string | null;
}

export class ConditionalWakeupManager {
  private wakeups = new Map<string, StoredWakeup>();
  private onWakeup: (wakeup: ConditionalWakeupInfo) => void;
  /**
   * Long-lived elevated-spawn helper. Routes the underlying `Bun.spawn`
   * through `sudo -u <user> -i sh -c ...` when the requesting user differs
   * from the server-process user under `AUTH_MODE=multi-user`. Injected for
   * testability; defaults to the production import.
   */
  private spawnAsUserFn: SpawnAsUserFn;

  constructor(
    onWakeup: (wakeup: ConditionalWakeupInfo) => void,
    spawnAsUserFn: SpawnAsUserFn = spawnAsUser,
  ) {
    this.onWakeup = onWakeup;
    this.spawnAsUserFn = spawnAsUserFn;
  }

  createWakeup(params: {
    sessionId: string;
    workerId: string;
    intervalSeconds: number;
    conditionScript: string;
    onTrueMessage: string;
    timeoutSeconds?: number;
    onTimeoutMessage?: string;
    /**
     * OS username to run `conditionScript` as. Treated identically when
     * `null` / `undefined` -- no elevation. Plumbed in by the MCP
     * `create_conditional_wakeup` tool, which resolves it from the calling
     * session's `createdBy` (Issue #886).
     */
    requestUsername?: string | null;
  }): ConditionalWakeupInfo {
    const {
      sessionId,
      workerId,
      intervalSeconds,
      conditionScript,
      onTrueMessage,
      timeoutSeconds,
      onTimeoutMessage,
      requestUsername,
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

    const stored: StoredWakeup = { info, handle, checking: false, requestUsername };

    // Set up timeout if specified
    if (timeoutSeconds) {
      const timeoutHandle = setTimeout(() => {
        this.handleTimeout(id);
      }, timeoutSeconds * 1000);
      stored.timeoutHandle = timeoutHandle;
    }

    this.wakeups.set(id, stored);

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
    const idsToDelete = Array.from(this.wakeups.entries())
      .filter(([, stored]) => stored.info.sessionId === sessionId)
      .map(([id]) => id);

    for (const id of idsToDelete) {
      this.cleanupWakeup(id, 'cancelled');
    }
    if (idsToDelete.length > 0) {
      logger.info({ sessionId, count: idsToDelete.length }, 'Deleted wakeups for session');
    }
    return idsToDelete.length;
  }

  disposeAll(): void {
    const count = this.wakeups.size;
    const idsToDelete = Array.from(this.wakeups.keys());
    for (const id of idsToDelete) {
      this.cleanupWakeup(id, 'cancelled');
    }
    logger.info({ count }, 'All wakeups disposed');
  }

  private async checkCondition(wakeupId: string): Promise<void> {
    const stored = this.wakeups.get(wakeupId);
    if (!stored || stored.info.status !== 'running') {
      return;
    }

    // Prevent race condition: skip if already checking
    if (stored.checking) {
      return;
    }

    stored.checking = true;

    try {
      // Cancel any existing process
      if (stored.currentProcess) {
        stored.currentProcess.kill();
      }

      // Route the condition-script spawn through `spawnAsUser` so multi-user
      // mode elevates the child to the requesting OS user (Issue #886). When
      // `requestUsername` is null/undefined or `AUTH_MODE !== 'multi-user'`,
      // the helper bypasses elevation and spawns `sh -c <script>` directly.
      const { subprocess } = this.spawnAsUserFn({
        username: stored.requestUsername ?? null,
        command: stored.info.conditionScript,
      });

      stored.currentProcess = subprocess;

      stored.info.lastCheckedAt = new Date().toISOString();
      stored.info.checkCount += 1;

      logger.debug(
        { wakeupId, checkCount: stored.info.checkCount },
        'Checking condition'
      );

      // `spawnAsUser` always pipes stdout/stderr (it is the shared elevation
      // primitive consumed by both one-shot and long-lived callers). The
      // prior `Bun.spawn(..., { stdout: 'ignore', stderr: 'ignore' })`
      // invocation redirected to /dev/null; here we instead drain both
      // streams concurrently with the exit await so a script that writes
      // more than one pipe buffer (typ. 64KB on Linux) cannot block.
      // Stream contents are discarded -- exit code is the sole signal for
      // conditional wakeups.
      const drainStdout = new Response(
        subprocess.stdout as ReadableStream<Uint8Array>,
      ).text().catch(() => '');
      const drainStderr = new Response(
        subprocess.stderr as ReadableStream<Uint8Array>,
      ).text().catch(() => '');

      const [exitCode] = await Promise.all([
        subprocess.exited,
        drainStdout,
        drainStderr,
      ]);

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
    } finally {
      // Reset checking flag regardless of success or failure
      const stored = this.wakeups.get(wakeupId);
      if (stored) {
        stored.checking = false;
      }
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

    // Clean up resources and remove the record
    this.cleanupWakeupResources(wakeupId);
    this.wakeups.delete(wakeupId);
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

    // Clear the timeout if exists
    if (stored.timeoutHandle) {
      clearTimeout(stored.timeoutHandle);
      stored.timeoutHandle = undefined;
    }

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