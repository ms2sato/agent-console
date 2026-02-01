import * as v from 'valibot';

/**
 * Schema for manually sending a message from the user to a worker via API.
 */
export const SendWorkerMessageRequestSchema = v.object({
  toWorkerId: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Target worker ID is required'),
  ),
  content: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Message content is required'),
    v.maxLength(10000, 'Message content must be 10000 characters or less'),
  ),
});

export type SendWorkerMessageRequest = v.InferOutput<typeof SendWorkerMessageRequestSchema>;
