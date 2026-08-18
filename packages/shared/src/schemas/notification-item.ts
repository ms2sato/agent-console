import * as v from 'valibot';

/**
 * Wire schema for the `NotificationItem` shape (Notification Center Phase 1).
 * Mirrors `types/notification-item.ts`'s `NotificationItem` interface
 * field-for-field so a server response that silently drops/adds a field
 * fails to parse instead of failing silently at the client (see
 * `.claude/rules/pre-pr-completeness.md` Q10, the #926 lesson).
 */
export const NotificationItemSchema = v.strictObject({
  kind: v.picklist(['artifact-created', 'worktree-deletion-finished']),
  id: v.pipe(v.string(), v.minLength(1)),
  occurredAt: v.pipe(v.string(), v.isoTimestamp()),
  title: v.pipe(v.string(), v.minLength(1)),
  link: v.pipe(v.string(), v.minLength(1)),
  outcome: v.optional(v.picklist(['completed', 'failed'])),
});
export type NotificationItemSchemaOutput = v.InferOutput<typeof NotificationItemSchema>;

/** Wire schema for `GET /api/notifications`'s response envelope. */
export const NotificationsResponseSchema = v.strictObject({
  items: v.array(NotificationItemSchema),
  lastSeenAt: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
  unreadCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type NotificationsResponseSchemaOutput = v.InferOutput<typeof NotificationsResponseSchema>;

/** Wire schema for `PUT /api/notifications/seen`'s request body. */
export const NotificationsSeenRequestSchema = v.strictObject({
  lastSeenAt: v.pipe(v.string(), v.isoTimestamp()),
});
export type NotificationsSeenRequestSchemaOutput = v.InferOutput<typeof NotificationsSeenRequestSchema>;

/** Wire schema for `PUT /api/notifications/seen`'s response body. */
export const NotificationsSeenResponseSchema = v.strictObject({
  lastSeenAt: v.pipe(v.string(), v.isoTimestamp()),
});
export type NotificationsSeenResponseSchemaOutput = v.InferOutput<typeof NotificationsSeenResponseSchema>;
