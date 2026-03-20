/**
 * Diagnostic logging utility for terminal render pipeline.
 *
 * Enable via: localStorage.setItem('terminal-render-diagnostics', 'true')
 * Disable via: localStorage.removeItem('terminal-render-diagnostics')
 *
 * When disabled, all functions are no-ops with zero overhead.
 * This is temporary diagnostic code to identify where terminal display stalls.
 */

export interface RenderWatchdog {
  /** Call when handleOutput receives data */
  onWriteStart(dataLength: number, offset: number): void;
  /** Call when terminal.write() callback fires */
  onWriteComplete(): void;
  /** Call when handleHistory receives data */
  onHistoryReceived(dataLength: number, offset: number): void;
  /** Call when history write completes */
  onHistoryWriteComplete(): void;
  /** Call when WebSocket message is received (before dispatch) */
  onMessageReceived(type: string): void;
  /** Start the periodic check timer */
  start(): void;
  /** Stop and cleanup */
  dispose(): void;
}

const DIAG_KEY = 'terminal-render-diagnostics';

const noopWatchdog: RenderWatchdog = {
  onWriteStart() {},
  onWriteComplete() {},
  onHistoryReceived() {},
  onHistoryWriteComplete() {},
  onMessageReceived() {},
  start() {},
  dispose() {},
};

export function isRenderDiagnosticsEnabled(): boolean {
  try {
    return localStorage.getItem(DIAG_KEY) === 'true';
  } catch {
    return false;
  }
}

export function diagLog(component: string, event: string, data?: Record<string, unknown>): void {
  if (!isRenderDiagnosticsEnabled()) return;
  const ts = new Date().toISOString();
  if (data) {
    console.warn(`[RenderDiag] ${ts} [${component}] ${event}`, data);
  } else {
    console.warn(`[RenderDiag] ${ts} [${component}] ${event}`);
  }
}

const STALL_CHECK_INTERVAL = 2000;
const SUMMARY_INTERVAL = 30000;

export function createRenderWatchdog(
  sessionId: string,
  workerId: string,
  terminal: { rows: number },
): RenderWatchdog {
  if (!isRenderDiagnosticsEnabled()) {
    return noopWatchdog;
  }

  let lastWriteStartTime = 0;
  let lastWriteCompleteTime = 0;
  let pendingWriteCount = 0;
  let messagesSinceLastComplete = 0;
  let currentOffset = 0;

  // Summary counters
  let totalMessages = 0;
  let totalWrites = 0;
  let totalStalls = 0;

  let stallCheckTimer: ReturnType<typeof setInterval> | null = null;
  let summaryTimer: ReturnType<typeof setInterval> | null = null;

  const label = `${sessionId}/${workerId}`;

  const watchdog: RenderWatchdog = {
    onWriteStart(dataLength: number, offset: number) {
      lastWriteStartTime = Date.now();
      pendingWriteCount++;
      currentOffset = offset;
      totalWrites++;
      diagLog('Watchdog', `write:start`, {
        label,
        dataLength,
        offset,
        pendingWriteCount,
      });
    },

    onWriteComplete() {
      lastWriteCompleteTime = Date.now();
      pendingWriteCount = Math.max(0, pendingWriteCount - 1);
      messagesSinceLastComplete = 0;
      diagLog('Watchdog', `write:complete`, {
        label,
        pendingWriteCount,
        elapsed: lastWriteStartTime > 0 ? lastWriteCompleteTime - lastWriteStartTime : 0,
      });
    },

    onHistoryReceived(dataLength: number, offset: number) {
      currentOffset = offset;
      diagLog('Watchdog', `history:received`, {
        label,
        dataLength,
        offset,
      });
    },

    onHistoryWriteComplete() {
      diagLog('Watchdog', `history:writeComplete`, { label });
    },

    onMessageReceived(type: string) {
      totalMessages++;
      messagesSinceLastComplete++;
      diagLog('Watchdog', `message:received`, {
        label,
        type,
        messagesSinceLastComplete,
      });
    },

    start() {
      diagLog('Watchdog', `start`, {
        label,
        terminalRows: terminal.rows,
      });

      stallCheckTimer = setInterval(() => {
        if (pendingWriteCount > 0 && lastWriteStartTime > lastWriteCompleteTime) {
          const stallDuration = Date.now() - lastWriteStartTime;
          if (stallDuration > STALL_CHECK_INTERVAL) {
            totalStalls++;
            console.warn(
              `[RenderDiag] STALL DETECTED for ${label}:`,
              {
                stallDurationMs: stallDuration,
                timeSinceLastCompleteMs: lastWriteCompleteTime > 0
                  ? Date.now() - lastWriteCompleteTime
                  : 'never completed',
                pendingWriteCount,
                messagesSinceLastComplete,
                currentOffset,
                terminalRows: terminal.rows,
              },
            );
          }
        }
      }, STALL_CHECK_INTERVAL);

      summaryTimer = setInterval(() => {
        console.warn(
          `[RenderDiag] SUMMARY for ${label}:`,
          {
            totalMessages,
            totalWrites,
            totalStalls,
            pendingWriteCount,
            currentOffset,
            terminalRows: terminal.rows,
          },
        );
      }, SUMMARY_INTERVAL);
    },

    dispose() {
      if (stallCheckTimer) {
        clearInterval(stallCheckTimer);
        stallCheckTimer = null;
      }
      if (summaryTimer) {
        clearInterval(summaryTimer);
        summaryTimer = null;
      }
      diagLog('Watchdog', `dispose`, { label, totalMessages, totalWrites, totalStalls });
    },
  };

  return watchdog;
}
