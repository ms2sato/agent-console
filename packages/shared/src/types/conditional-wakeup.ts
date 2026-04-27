/**
 * Types for the conditional wakeup feature.
 *
 * Conditional wakeups check a condition at intervals and notify only when
 * the condition becomes true (script exits 0), or when timeout is reached.
 * Silent polling preserves LLM context windows.
 */

export interface ConditionalWakeupInfo {
  id: string;
  sessionId: string;
  workerId: string;
  intervalSeconds: number;
  /** Shell command to execute for condition check */
  conditionScript: string;
  /** Message to send when condition becomes true (script exits 0) */
  onTrueMessage: string;
  /** Optional timeout in seconds */
  timeoutSeconds?: number;
  /** Message to send when timeout is reached (defaults to generic timeout message) */
  onTimeoutMessage?: string;
  createdAt: string;
  lastCheckedAt?: string;
  checkCount: number;
  /** Current status of the wakeup */
  status: 'running' | 'completed_true' | 'completed_timeout' | 'cancelled';
}