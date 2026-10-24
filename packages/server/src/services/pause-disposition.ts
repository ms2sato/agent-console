/**
 * What happens to a notification of each kind when its target worker belongs
 * to a paused (or pausing) session. The single place that lists kinds for this
 * decision: the delivery seam (`SessionManager.deliverWorkerNotification`)
 * branches on {@link PAUSE_DISPOSITION}, nothing else enumerates kinds.
 *
 * - `defer`: stored in `deferred_worker_notifications` and delivered inside the
 *   one digest the worker receives on resume.
 * - `suspended-at-source`: the producer itself does not run while paused (timers
 *   and conditional wakeups are suspended by the pause participants), so a
 *   notification of this kind arriving at the seam is a bug to log, not to store.
 * - `live-only`: written directly to an already-live worker by a caller that
 *   never goes through the seam; meaningless once the session is paused.
 *
 * See docs/design/session-pause-resume.md.
 */
import type { PtyNotificationKind } from '@agent-console/shared';

export type PauseDisposition = 'defer' | 'suspended-at-source' | 'live-only';

export const PAUSE_DISPOSITION = {
  'inbound-event': 'defer',
  'internal-message': 'defer',
  'internal-process': 'defer',
  'internal-todo-resolved': 'defer',
  'internal-todo-comment': 'defer',
  'internal-worker-interrupted': 'defer',
  'internal-paused-digest': 'defer',
  'internal-timer': 'suspended-at-source',
  'internal-conditional-wakeup': 'suspended-at-source',
  'internal-review-comment': 'live-only',
  'internal-reviewed': 'live-only',
  'internal-agent-spawn-failed': 'live-only',
} as const satisfies Record<PtyNotificationKind, PauseDisposition>;

/** The kinds stored while a session is paused, derived from {@link PAUSE_DISPOSITION}. */
export const DEFERRABLE_NOTIFICATION_KINDS = (
  Object.keys(PAUSE_DISPOSITION) as PtyNotificationKind[]
).filter((kind) => PAUSE_DISPOSITION[kind] === 'defer');

/** Rows kept per session; beyond this the oldest is dropped (FIFO). No time-based retention. */
export const MAX_DEFERRED_NOTIFICATIONS_PER_SESSION = 100;
