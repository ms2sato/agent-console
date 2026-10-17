import * as v from 'valibot';

/**
 * Schema for manually sending a message from the user to a worker via API.
 * Content is optional when files are attached (validated at route level).
 */
export const SendWorkerMessageRequestSchema = v.strictObject({
  toWorkerId: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Target worker ID is required'),
  ),
  content: v.pipe(
    v.string(),
    v.trim(),
    v.maxLength(10000, 'Message content must be 10000 characters or less'),
  ),
});

export type SendWorkerMessageRequest = v.InferOutput<typeof SendWorkerMessageRequestSchema>;

/**
 * A delivered worker message as it crosses the wire. Mirrors `WorkerMessage` in
 * `types/worker-message.ts` (pinned in the schema test), which the server still
 * imports.
 */
export const WorkerMessageSchema = v.strictObject({
  id: v.string(),
  sessionId: v.string(),
  fromWorkerId: v.string(),
  fromWorkerName: v.string(),
  toWorkerId: v.string(),
  toWorkerName: v.string(),
  content: v.string(),
  /** ISO 8601 */
  timestamp: v.string(),
});

/** Schema for `POST /api/sessions/:sessionId/messages`'s 201 response. */
export const SendWorkerMessageResponseSchema = v.strictObject({
  message: WorkerMessageSchema,
});

export type SendWorkerMessageResponse = v.InferOutput<typeof SendWorkerMessageResponseSchema>;
