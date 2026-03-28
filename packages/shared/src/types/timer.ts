/**
 * Types for the periodic timer (cron-like callback) feature.
 *
 * Timers are in-memory volatile — they disappear on server restart.
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
