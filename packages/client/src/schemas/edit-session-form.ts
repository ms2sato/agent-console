import * as v from 'valibot';
import { branchNamePattern, branchNameErrorMessage } from '@agent-console/shared';

/**
 * Schema for the edit session form.
 * At least one of title or branch must be provided.
 *
 * IMPORTANT: Cross-field validation with v.forward()
 *
 * When using v.check() at the pipe level for cross-field validation, the error has
 * `path: undefined` (root-level error). However, @hookform/resolvers/valibot (v5.2.2)
 * does not map root-level errors to React Hook Form's errors object - they are silently
 * ignored, causing the form to submit despite validation failure.
 *
 * Workaround: Use v.forward() to explicitly assign errors to a specific field path.
 * This is also the recommended approach in Valibot documentation for cross-field validation.
 *
 * @see https://valibot.dev/api/forward/
 */
export const EditSessionFormSchema = v.pipe(
  v.object({
    title: v.optional(v.pipe(v.string(), v.trim())),
    branch: v.optional(
      v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1, 'Branch name cannot be empty'),
        v.regex(branchNamePattern, branchNameErrorMessage)
      )
    ),
  }),
  // Forward to 'title' field since it's the first field in the form
  v.forward(
    v.check(
      (input) => input.title !== undefined || input.branch !== undefined,
      'At least one of title or branch must be provided'
    ),
    ['title']
  )
);

export type EditSessionFormData = v.InferOutput<typeof EditSessionFormSchema>;
