/**
 * Types for the periodic timer (cron-like callback) feature.
 *
 * Timers are persisted to the database and restored on server restart.
 * Runtime state (fireCount, lastFiredAt) remains in-memory only.
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
}
