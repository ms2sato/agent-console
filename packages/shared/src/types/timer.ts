/**
 * Types for the periodic timer (cron-like callback) feature.
 *
 * Timers persist across server restarts (fireCount and the backoff step
 * restart from the base interval).
 * Agents use timers to receive periodic callbacks for monitoring
 * delegated tasks, checking CI status, etc.
 */

export interface TimerInfo {
  id: string;
  sessionId: string;
  workerId: string;
  intervalSeconds: number;
  /** Description of what to do on each tick */
  action: string;
  createdAt: string;
  lastFiredAt?: string;
  fireCount: number;
  /** Multiplier applied to the wait after each fire; 1 = fixed interval */
  backoffFactor: number;
  /** Upper bound in seconds for the stretched wait */
  maxIntervalSeconds: number;
  /** The wait currently pending, in seconds */
  currentIntervalSeconds: number;
  /** ISO timestamp of the next fire */
  nextFireAt: string;
}
