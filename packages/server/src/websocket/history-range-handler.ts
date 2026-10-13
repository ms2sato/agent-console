import type { WSContext } from 'hono/ws';
import type { WorkerServerMessage } from '@agent-console/shared';
import type { HistoryRangeResult } from '../lib/worker-output-file.js';
import { createLogger } from '../lib/logger.js';
import { raceWithTimeout } from '../lib/race-with-timeout.js';
import { type HistoryInFlightLimiter, reportHistoryOverCap } from './history-in-flight-limiter.js';

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
 * - With a `limiter`, a request arriving while the connection's in-flight cap
 *   is reached is answered immediately with `HISTORY_LOAD_FAILED` carrying the
 *   same `requestId` — never the unavailable shape, which would tell a paging
 *   client that history ends there. The slot is claimed after `requestId`
 *   validation (an uncorrelatable message is dropped without consuming one)
 *   and held until the underlying read settles (or, if no read is issued,
 *   until the handler returns) — a timeout answers the client but does not
 *   free the slot of a read that is still running.
 */
export async function handleHistoryRangeRequest(
  ws: WSContext,
  sessionId: string,
  workerId: string,
  parsed: Record<string, unknown>,
  sessionManager: HistoryRangeSessionManager,
  /** @internal Timeout override for tests; production uses the 5s default. */
  options: { timeoutMs?: number; limiter?: HistoryInFlightLimiter } = {},
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

  const limiter = options.limiter;
  if (limiter && !limiter.tryAcquire()) {
    const message = reportHistoryOverCap(limiter, { sessionId, workerId, type: 'request-history-range' });
    send({ type: 'error', code: 'HISTORY_LOAD_FAILED', message, requestId });
    return;
  }

  // Once the read is issued, the slot belongs to the read: it is released when
  // the read settles, not when the race below gives up on it, so a read that
  // outlives its timeout keeps occupying the slot (the client was already
  // told). Every exit before the read is issued releases in the `finally`.
  let readIssued = false;
  try {
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

    try {
      const read = sessionManager.getWorkerHistoryRange(sessionId, workerId, beforeOffset, maxBytes);
      const releaseSlot = (): void => limiter?.release();
      read.then(releaseSlot, releaseSlot);
      readIssued = true;
      const result = await raceWithTimeout(read, timeoutMs, 'History range request timeout');

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
    }
  } finally {
    if (!readIssued) limiter?.release();
  }
}
