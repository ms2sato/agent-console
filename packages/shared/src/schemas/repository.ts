import * as v from 'valibot';
import { branchNamePattern, branchNameErrorMessage } from './session';

/**
 * Schema for creating a repository
 */
export const CreateRepositoryRequestSchema = v.object({
  path: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Path is required')
  ),
});

/**
 * Optional branch name schema - validates format only when provided and non-empty
 */
const OptionalBranchSchema = v.optional(
  v.pipe(
    v.string(),
    v.trim(),
    v.check(
      (val) => val === '' || branchNamePattern.test(val),
      branchNameErrorMessage
    )
  )
);

/**
 * Required branch name schema - validates format and requires non-empty value
 */
const RequiredBranchSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, 'Branch name is required'),
  v.regex(branchNamePattern, branchNameErrorMessage)
);

/**
 * Base schema for worktree creation requests
 */
const CreateWorktreeBaseSchema = v.object({
  autoStartSession: v.optional(v.boolean()),
  agentId: v.optional(v.string()),
  initialPrompt: v.optional(v.string()),
  title: v.optional(v.string()),
});

/**
 * Schema for creating worktree with prompt-based branch name
 */
export const CreateWorktreePromptRequestSchema = v.object({
  ...CreateWorktreeBaseSchema.entries,
  mode: v.literal('prompt'),
  initialPrompt: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Initial prompt is required for prompt mode')
  ),
  baseBranch: OptionalBranchSchema,
});

/**
 * Schema for creating worktree with custom branch name
 */
export const CreateWorktreeCustomRequestSchema = v.object({
  ...CreateWorktreeBaseSchema.entries,
  mode: v.literal('custom'),
  branch: RequiredBranchSchema,
  baseBranch: OptionalBranchSchema,
});

/**
 * Schema for creating worktree from existing branch
 */
export const CreateWorktreeExistingRequestSchema = v.object({
  ...CreateWorktreeBaseSchema.entries,
  mode: v.literal('existing'),
  branch: RequiredBranchSchema,
});

/**
 * Schema for creating any worktree (union)
 */
export const CreateWorktreeRequestSchema = v.union([
  CreateWorktreePromptRequestSchema,
  CreateWorktreeCustomRequestSchema,
  CreateWorktreeExistingRequestSchema,
]);

/**
 * Schema for deleting a worktree
 */
export const DeleteWorktreeRequestSchema = v.object({
  force: v.optional(v.boolean()),
});

// Inferred types from schemas
export type CreateRepositoryRequest = v.InferOutput<typeof CreateRepositoryRequestSchema>;
export type CreateWorktreePromptRequest = v.InferOutput<typeof CreateWorktreePromptRequestSchema>;
export type CreateWorktreeCustomRequest = v.InferOutput<typeof CreateWorktreeCustomRequestSchema>;
export type CreateWorktreeExistingRequest = v.InferOutput<typeof CreateWorktreeExistingRequestSchema>;
export type CreateWorktreeRequest = v.InferOutput<typeof CreateWorktreeRequestSchema>;
export type DeleteWorktreeRequest = v.InferOutput<typeof DeleteWorktreeRequestSchema>;
