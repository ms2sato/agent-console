import * as v from 'valibot';

/**
 * Schema for creating a worktree session
 */
export const CreateWorktreeSessionRequestSchema = v.object({
  type: v.literal('worktree'),
  repositoryId: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Repository ID is required')
  ),
  worktreeId: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Worktree ID is required')
  ),
  locationPath: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Location path is required')
  ),
  agentId: v.optional(v.string()),
  continueConversation: v.optional(v.boolean()),
  initialPrompt: v.optional(v.string()),
  title: v.optional(v.string()),
  useSdk: v.optional(v.boolean()),
});

/**
 * Schema for creating a quick session
 */
export const CreateQuickSessionRequestSchema = v.object({
  type: v.literal('quick'),
  locationPath: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Location path is required')
  ),
  agentId: v.optional(v.string()),
  continueConversation: v.optional(v.boolean()),
  initialPrompt: v.optional(v.string()),
  title: v.optional(v.string()),
  useSdk: v.optional(v.boolean()),
});

/**
 * Schema for creating any session (union)
 */
export const CreateSessionRequestSchema = v.union([
  CreateWorktreeSessionRequestSchema,
  CreateQuickSessionRequestSchema,
]);

/**
 * Branch name validation regex pattern
 * Valid: alphanumeric, dots, underscores, slashes, hyphens
 */
export const branchNamePattern = /^[a-zA-Z0-9._/-]+$/;

/**
 * Branch name validation error message
 */
export const branchNameErrorMessage = 'Invalid branch name. Use alphanumeric, dots, underscores, slashes, or hyphens.';

/**
 * Schema for updating a session
 */
export const UpdateSessionRequestSchema = v.pipe(
  v.object({
    title: v.optional(v.string()),
    branch: v.optional(
      v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1, 'Branch name cannot be empty'),
        v.regex(branchNamePattern, branchNameErrorMessage)
      )
    ),
  }),
  v.check(
    (input) => input.title !== undefined || input.branch !== undefined,
    'At least one of title or branch must be provided'
  )
);

/**
 * Schema for deleting a session.
 * Quick sessions are deleted synchronously without task management.
 * For worktree sessions with async deletion, use the worktree deletion endpoint instead.
 */
export const DeleteSessionRequestSchema = v.object({});

// Inferred types from schemas
export type CreateWorktreeSessionRequest = v.InferOutput<typeof CreateWorktreeSessionRequestSchema>;
export type CreateQuickSessionRequest = v.InferOutput<typeof CreateQuickSessionRequestSchema>;
export type CreateSessionRequest = v.InferOutput<typeof CreateSessionRequestSchema>;
export type UpdateSessionRequest = v.InferOutput<typeof UpdateSessionRequestSchema>;
export type DeleteSessionRequest = v.InferOutput<typeof DeleteSessionRequestSchema>;
