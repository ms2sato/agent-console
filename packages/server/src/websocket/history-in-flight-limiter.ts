import { createLogger } from '../lib/logger.js';

const logger = createLogger('history-in-flight-limiter');

/**
 * Per-connection cap on unresolved worker-WS history requests. One instance is
 * shared by `request-history` and `request-history-range` on a connection:
 * both compete for the same per-worker output lock and decompression budget,
 * so the cap is on the connection, not on each message type.
 *
 * `release` never takes the count below 0, so a defensive double release
 * cannot grant extra capacity.
 */
export class HistoryInFlightLimiter {
  private current = 0;
  private rejections = 0;

  constructor(private readonly maxInFlight: number) {}

  /** Claim a slot. Returns false (and counts a rejection) when the cap is reached. */
  tryAcquire(): boolean {
    if (this.current >= this.maxInFlight) {
      this.rejections += 1;
      return false;
    }
    this.current += 1;
    return true;
  }

  release(): void {
    if (this.current > 0) this.current -= 1;
  }

  get inFlight(): number {
    return this.current;
  }

  get max(): number {
    return this.maxInFlight;
  }

  /** Number of requests refused on this connection so far. */
  get rejectedCount(): number {
    return this.rejections;
  }
}

/**
 * Log an over-cap rejection and return the client-facing error text. The first
 * rejection on a connection warns; later ones log at debug so a flood does not
 * become a log flood. Call after `tryAcquire()` returned false.
 *
 * `log` is a pay-as-you-go injection seam so the once-ness is testable.
 */
export function reportHistoryOverCap(
  limiter: HistoryInFlightLimiter,
  context: { sessionId: string; workerId: string; type: string },
  log: Pick<typeof logger, 'warn' | 'debug'> = logger,
): string {
  const fields = { ...context, inFlight: limiter.inFlight, max: limiter.max };
  if (limiter.rejectedCount === 1) {
    log.warn(fields, 'Worker WS history request rejected: per-connection in-flight cap reached');
  } else {
    log.debug(fields, 'Worker WS history request rejected: per-connection in-flight cap reached');
  }
  return `Too many concurrent history requests on this connection (max ${limiter.max}); retry after the pending ones complete.`;
}
