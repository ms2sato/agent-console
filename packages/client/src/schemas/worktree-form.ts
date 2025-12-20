import * as v from 'valibot';
import { branchNamePattern, branchNameErrorMessage } from '@agent-console/shared';

/**
 * Client-side schema for Create Worktree form
 * This schema handles the unified form state with conditional validation based on branchNameMode
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
export const CreateWorktreeFormSchema = v.pipe(
  v.object({
    branchNameMode: v.picklist(['prompt', 'custom', 'existing']),
    initialPrompt: v.optional(v.string()),
    githubIssue: v.optional(
      v.pipe(
        v.string(),
        v.trim()
      )
    ),
    customBranch: v.optional(
      v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1, 'Branch name is required'),
        v.regex(branchNamePattern, branchNameErrorMessage)
      )
    ),
    baseBranch: v.optional(v.string()),
    sessionTitle: v.optional(v.string()),
    agentId: v.optional(v.string()),
  }),
  // Validate initialPrompt is required when mode is 'prompt'
  v.forward(
    v.check(
      (data) => data.branchNameMode !== 'prompt' || !!data.initialPrompt?.trim(),
      'Initial prompt is required when using "Generate from prompt" mode'
    ),
    ['initialPrompt']
  ),
  // Validate customBranch is required when mode is 'custom' or 'existing'
  v.forward(
    v.check(
      (data) =>
        data.branchNameMode === 'prompt' || !!data.customBranch?.trim(),
      'Branch name is required'
    ),
    ['customBranch']
  )
);

export type CreateWorktreeFormData = v.InferOutput<typeof CreateWorktreeFormSchema>;
