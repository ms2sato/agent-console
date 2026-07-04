import type { WSContext } from 'hono/ws';
import type { WorkerServerMessage } from '@agent-console/shared';
import type { HistoryRangeResult } from '../lib/worker-output-file.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('history-range-handler');

/** Server-side guard mirroring the client's per-request timeout (§5.1). */
const RANGE_REQUEST_TIMEOUT_MS = 5000;

/**
 * SessionManager surface needed to serve a backwards range request. Injected so
 * the handler is unit-testable without the full manager.
 */
export interface HistoryRangeSessionManager {
  getWorkerHistoryRange(
    sessionId: string,
    workerId: string,
    beforeOffset: number,
    maxBytes?: number,
  ): Promise<HistoryRangeResult | null>;
  getWorkerEpoch(sessionId: string, workerId: string): number | null;
}

/** Boundary validation: a client-supplied numeric field must be a non-negative safe integer (§5.1). */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Handle a `request-history-range` message on the worker WebSocket and respond
 * on the same socket with a `history-range` (or a `HISTORY_LOAD_FAILED` error).
 *
 * Contract (§5.1 / §5.2):
 * - `requestId` must itself be a non-negative safe integer; without it a response
 *   cannot be correlated, so the message is dropped silently.
 * - Invalid `beforeOffset` / `maxBytes` are answered with the unavailable-range
 *   shape (`data: ''`, `hasMore: false`) echoing `requestId` — indistinguishable
 *   from a pruned range to the client, never an errored socket.
 * - A 5s timeout or an unexpected read error is answered with the
 *   `HISTORY_LOAD_FAILED` error carrying the same `requestId`.
 */
export async function handleHistoryRangeRequest(
  ws: WSContext,
  sessionId: string,
  workerId: string,
  parsed: Record<string, unknown>,
  sessionManager: HistoryRangeSessionManager,
  /** @internal Timeout override for tests; production uses the 5s default. */
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? RANGE_REQUEST_TIMEOUT_MS;
  const { requestId } = parsed;
  if (!isNonNegativeSafeInteger(requestId)) {
    // No valid requestId — a response could not be correlated. Drop.
    logger.warn({ sessionId, workerId }, 'request-history-range with invalid requestId; dropping');
    return;
  }

  const send = (msg: WorkerServerMessage): void => {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Connection may be closed — nothing to do.
    }
  };

  const beforeOffset = parsed.beforeOffset;
  const maxBytes = parsed.maxBytes;
  const validBefore = isNonNegativeSafeInteger(beforeOffset);
  const validMax = maxBytes === undefined || isNonNegativeSafeInteger(maxBytes);

  // Epoch for the invalid-input / no-scope fallbacks that do not read the
  // manifest. Successful reads carry the manifest epoch instead.
  const fallbackEpoch = sessionManager.getWorkerEpoch(sessionId, workerId) ?? 0;

  if (!validBefore || !validMax) {
    // Invalid numeric input → unavailable shape. Server-emitted offsets must be
    // non-negative safe integers by construction, so anchor at 0.
    send({ type: 'history-range', requestId, data: '', startOffset: 0, endOffset: 0, hasMore: false, epoch: fallbackEpoch });
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('History range request timeout')), timeoutMs);
  });

  try {
    const result = await Promise.race([
      sessionManager.getWorkerHistoryRange(sessionId, workerId, beforeOffset, maxBytes),
      timeout,
    ]);

    if (result === null) {
      // Worker missing, wrong type (e.g. git-diff), or no output scope
      // available — treat as an unavailable range.
      send({ type: 'history-range', requestId, data: '', startOffset: beforeOffset, endOffset: beforeOffset, hasMore: false, epoch: fallbackEpoch });
      return;
    }

    send({
      type: 'history-range',
      requestId,
      data: result.data,
      startOffset: result.startOffset,
      endOffset: result.endOffset,
      hasMore: result.hasMore,
      epoch: result.epoch,
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === 'History range request timeout';
    if (isTimeout) {
      logger.warn({ sessionId, workerId, requestId }, 'History range request timed out');
    } else {
      logger.error({ sessionId, workerId, requestId, err }, 'Failed to serve history range');
    }
    send({
      type: 'error',
      code: 'HISTORY_LOAD_FAILED',
      message: 'Failed to load terminal history. Try switching workers or refreshing.',
      requestId,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
