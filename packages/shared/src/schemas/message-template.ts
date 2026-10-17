import * as v from 'valibot';

export const CreateMessageTemplateRequestSchema = v.strictObject({
  title: v.pipe(v.string(), v.trim(), v.minLength(1, 'Title is required')),
  content: v.pipe(v.string(), v.trim(), v.minLength(1, 'Content is required')),
});

export const UpdateMessageTemplateRequestSchema = v.pipe(
  v.strictObject({
    title: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'Title is required'))),
    content: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'Content is required'))),
  }),
  v.check(
    (val) => val.title !== undefined || val.content !== undefined,
    'At least one of title or content is required',
  ),
);

export const ReorderMessageTemplatesRequestSchema = v.strictObject({
  orderedIds: v.pipe(
    v.array(v.string()),
    v.minLength(1, 'At least one ID is required'),
  ),
});

export type CreateMessageTemplateRequest = v.InferOutput<typeof CreateMessageTemplateRequestSchema>;
export type UpdateMessageTemplateRequest = v.InferOutput<typeof UpdateMessageTemplateRequestSchema>;
export type ReorderMessageTemplatesRequest = v.InferOutput<typeof ReorderMessageTemplatesRequestSchema>;

/** A saved message template as it crosses the wire. */
export const MessageTemplateSchema = v.strictObject({
  id: v.string(),
  title: v.string(),
  content: v.string(),
  sortOrder: v.number(),
  createdAt: v.string(),
  updatedAt: v.string(),
});

/** Schema for `GET /api/message-templates`'s response. */
export const MessageTemplatesResponseSchema = v.strictObject({
  templates: v.array(MessageTemplateSchema),
});

export type MessageTemplatesResponse = v.InferOutput<typeof MessageTemplatesResponseSchema>;

/**
 * Schema for the single-template response of `POST /api/message-templates` (201)
 * and `PUT /api/message-templates/:id`.
 */
export const MessageTemplateResponseSchema = v.strictObject({
  template: MessageTemplateSchema,
});

/**
 * Schema for the `{ success: true }` acknowledgement of
 * `DELETE /api/message-templates/:id` and `PUT /api/message-templates/reorder`.
 * `success` is the literal the routes write, not a boolean. Hoist to a shared
 * file when a third route uses it.
 */
export const SuccessResponseSchema = v.strictObject({
  success: v.literal(true),
});

export type MessageTemplateResponse = v.InferOutput<typeof MessageTemplateResponseSchema>;
export type SuccessResponse = v.InferOutput<typeof SuccessResponseSchema>;
