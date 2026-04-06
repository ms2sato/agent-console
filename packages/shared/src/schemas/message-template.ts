import * as v from 'valibot';

export const CreateMessageTemplateRequestSchema = v.object({
  title: v.pipe(v.string(), v.trim(), v.minLength(1, 'Title is required')),
  content: v.pipe(v.string(), v.trim(), v.minLength(1, 'Content is required')),
});

export const UpdateMessageTemplateRequestSchema = v.object({
  title: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'Title is required'))),
  content: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'Content is required'))),
});

export const ReorderMessageTemplatesRequestSchema = v.object({
  orderedIds: v.pipe(
    v.array(v.string()),
    v.minLength(1, 'At least one ID is required'),
  ),
});

export type CreateMessageTemplateRequest = v.InferOutput<typeof CreateMessageTemplateRequestSchema>;
export type UpdateMessageTemplateRequest = v.InferOutput<typeof UpdateMessageTemplateRequestSchema>;
export type ReorderMessageTemplatesRequest = v.InferOutput<typeof ReorderMessageTemplatesRequestSchema>;
