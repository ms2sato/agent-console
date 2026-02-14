import * as v from 'valibot';

export const EditSessionFormSchema = v.object({
  title: v.optional(v.pipe(v.string(), v.trim())),
});

export type EditSessionFormData = v.InferOutput<typeof EditSessionFormSchema>;
