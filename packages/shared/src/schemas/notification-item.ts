import * as v from 'valibot';

// Notification center (docs/design/notification-center.md) -- the human-
// addressed awareness read-model, and the wire schemas its types are derived
// from. Distinct from the OUTBOUND (Slack) notification system in
// `types/notification.ts` -- see that file's header for the taxonomy (spec
// §7); no unification in v1.
//
// Strict, so a server response that silently drops/adds a field fails to
// parse instead of failing silently at the client (see
// `.claude/rules/pre-pr-completeness.md` Q10, the #926 lesson).

/** A composed notification list item -- a pointer + summary over a domain row, never itself persisted (N2). */
export const NotificationItemSchema = v.strictObject({
  kind: v.picklist(['artifact-created', 'worktree-deletion-finished', 'todo-agent-replied']),
  // Kind-scoped id (the domain row's own id); (kind, id) is the stable identity.
  id: v.pipe(v.string(), v.minLength(1)),
  // ISO 8601 timestamp.
  occurredAt: v.pipe(v.string(), v.isoTimestamp()),
  title: v.pipe(v.string(), v.minLength(1)),
  // Deep link target (a path, e.g. `/artifacts/{id}`).
  link: v.pipe(v.string(), v.minLength(1)),
  outcome: v.optional(v.picklist(['completed', 'failed'])),
});
export type NotificationItem = v.InferOutput<typeof NotificationItemSchema>;

/** Wire schema for `GET /api/notifications`'s response envelope. */
export const NotificationsResponseSchema = v.strictObject({
  items: v.array(NotificationItemSchema),
  // Current stored cursor, or null if the user has never opened the bell.
  lastSeenAt: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
  // Server-computed unread count, computed PRE-CAP (spec §8 amendment -- see docs/design/notification-center.md).
  unreadCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type NotificationsResponse = v.InferOutput<typeof NotificationsResponseSchema>;

/** Wire schema for `PUT /api/notifications/seen`'s request body. */
export const NotificationsSeenRequestSchema = v.strictObject({
  lastSeenAt: v.pipe(v.string(), v.isoTimestamp()),
});
export type NotificationsSeenRequest = v.InferOutput<typeof NotificationsSeenRequestSchema>;

/** Wire schema for `PUT /api/notifications/seen`'s response body -- the CURRENT stored cursor (R2: idempotent no-op semantics, not 409). */
export const NotificationsSeenResponseSchema = v.strictObject({
  lastSeenAt: v.pipe(v.string(), v.isoTimestamp()),
});
export type NotificationsSeenResponse = v.InferOutput<typeof NotificationsSeenResponseSchema>;
