/**
 * Notification center (docs/design/notification-center.md) — the human-
 * addressed awareness read-model. Distinct from the OUTBOUND (Slack)
 * notification system in `notification.ts` — see that file's header for
 * the taxonomy (spec §7); no unification in v1.
 */

/** A composed notification list item — a pointer + summary over a domain row, never itself persisted (N2). */
export interface NotificationItem {
  kind: 'artifact-created' | 'worktree-deletion-finished';
  /** kind-scoped id (the domain row's own id); (kind, id) is the stable identity. */
  id: string;
  /** ISO 8601 timestamp. */
  occurredAt: string;
  title: string;
  /** Deep link target (a path, e.g. `/artifacts/{id}`). */
  link: string;
  outcome?: 'completed' | 'failed';
}

/** GET /api/notifications response envelope. */
export interface NotificationsResponse {
  items: NotificationItem[];
  /** Current stored cursor, or null if the user has never opened the bell. */
  lastSeenAt: string | null;
  /** Server-computed unread count, computed PRE-CAP (spec §8 amendment — see docs/design/notification-center.md). */
  unreadCount: number;
}

/** PUT /api/notifications/seen request body. */
export interface NotificationsSeenRequest {
  lastSeenAt: string;
}

/** PUT /api/notifications/seen response — the CURRENT stored cursor (R2: idempotent no-op semantics, not 409). */
export interface NotificationsSeenResponse {
  lastSeenAt: string;
}
