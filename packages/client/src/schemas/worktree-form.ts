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
    embeddedAgentId: v.optional(v.string()),
    shared: v.optional(v.boolean()),
    // Non-empty validation (reject blank-after-trim) is enforced server-side
    // by CreateWorktreeBaseSchema; the client only needs to omit the field
    // from the submitted request when blank (see buildRequest in
    // CreateWorktreeForm.tsx).
    model: v.optional(v.string()),
    reasoningEffort: v.optional(v.string()),
    // Embedded-agent-only context-window override (agent-surface.md Ruling
    // 4). AgentParameterFields only renders this input alongside a non-empty
    // model value, and the cross-field v.forward() check below enforces the
    // same constraint at the schema level so a value that somehow survives
    // the render-gating (e.g. a stale draft restore) is still rejected here
    // rather than reaching CreateWorktreeBaseSchema's server-side check.
    contextWindowTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
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
  ),
  // Validate contextWindowTokens requires a model override (agent-surface.md
  // Ruling 4) -- a declared window with no model change would silently
  // apply to a model it wasn't declared for.
  v.forward(
    v.check(
      (data) => data.contextWindowTokens == null || !!data.model?.trim(),
      'contextWindowTokens requires a model override (agent-surface.md Ruling 4)'
    ),
    ['contextWindowTokens']
  )
);

export type CreateWorktreeFormData = v.InferOutput<typeof CreateWorktreeFormSchema>;
