import * as v from 'valibot';

// Wire schemas for `GET /api/review-queue`. The item and group field sets mirror
// `ReviewQueueItem` / `ReviewQueueGroup` in `types/git-diff.ts` (pinned in the
// schema test), which the server still imports.

/** Schema for a review queue item's annotation summary. */
export const AnnotationSummarySchema = v.strictObject({
  totalFiles: v.number(),
  reviewFiles: v.number(),
  mechanicalFiles: v.number(),
  confidence: v.picklist(['high', 'medium', 'low']),
});

/**
 * Schema for one review queue item. `parentSessionId` / `parentSessionTitle` are
 * omitted by the route when the item's session has no parent.
 */
export const ReviewQueueItemSchema = v.strictObject({
  workerId: v.string(),
  sessionId: v.string(),
  sessionTitle: v.string(),
  sourceSessionId: v.string(),
  sourceSessionTitle: v.string(),
  parentSessionId: v.optional(v.string()),
  parentSessionTitle: v.optional(v.string()),
  annotationCount: v.number(),
  summary: AnnotationSummarySchema,
  status: v.picklist(['pending', 'completed']),
  commentCount: v.number(),
  createdAt: v.string(),
});

/** Schema for review queue items grouped by source session. */
export const ReviewQueueGroupSchema = v.strictObject({
  sourceSessionId: v.string(),
  sourceSessionTitle: v.string(),
  items: v.array(ReviewQueueItemSchema),
});

/** Schema for `GET /api/review-queue`'s response: a bare array of groups, not an envelope. */
export const ReviewQueueResponseSchema = v.array(ReviewQueueGroupSchema);

/**
 * One inline review comment as it crosses the wire. Mirrors `ReviewComment` in
 * `types/git-diff.ts` (pinned in the schema test), which the server still imports.
 * `POST /api/review-queue/:workerId/comments` answers this entity bare (201).
 */
export const ReviewCommentSchema = v.strictObject({
  id: v.string(),
  file: v.string(),
  line: v.pipe(v.number(), v.integer()),
  body: v.string(),
  /** ISO timestamp */
  createdAt: v.string(),
});

/** Schema for `PATCH /api/review-queue/:workerId/status`'s response. */
export const ReviewStatusResponseSchema = v.strictObject({
  workerId: v.string(),
  status: v.string(),
});

export type ReviewStatusResponse = v.InferOutput<typeof ReviewStatusResponseSchema>;
