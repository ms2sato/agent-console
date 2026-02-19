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
  description: v.optional(v.pipe(v.string(), v.trim())),
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
  /** Client-generated UUID for async request-response correlation */
  taskId: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Task ID is required')
  ),
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
  useRemote: v.optional(v.boolean()), // If true, branch from origin/<base> instead of local <base>
});

/**
 * Schema for creating worktree with custom branch name
 */
export const CreateWorktreeCustomRequestSchema = v.object({
  ...CreateWorktreeBaseSchema.entries,
  mode: v.literal('custom'),
  branch: RequiredBranchSchema,
  baseBranch: OptionalBranchSchema,
  useRemote: v.optional(v.boolean()), // If true, branch from origin/<base> instead of local <base>
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
 * Schema for fetching a GitHub issue by reference
 */
export const FetchGitHubIssueRequestSchema = v.object({
  reference: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Issue reference is required')
  ),
});

/**
 * Schema for a GitHub issue summary
 */
export const GitHubIssueSummarySchema = v.object({
  org: v.string(),
  repo: v.string(),
  number: v.number(),
  title: v.string(),
  body: v.string(),
  url: v.string(),
  suggestedBranch: v.optional(v.string()),
});

/**
 * Schema for deleting a worktree
 */
export const DeleteWorktreeRequestSchema = v.object({
  force: v.optional(v.boolean()),
});

/**
 * Schema for updating a repository
 */
export const UpdateRepositoryRequestSchema = v.object({
  setupCommand: v.nullish(v.pipe(v.string(), v.trim())),
  cleanupCommand: v.nullish(v.pipe(v.string(), v.trim())),
  envVars: v.nullish(v.pipe(v.string(), v.trim())),
  description: v.nullish(v.pipe(v.string(), v.trim())),
  defaultAgentId: v.nullish(v.pipe(v.string(), v.trim())),
});

/**
 * Schema for the response of refreshing a repository's default branch
 */
export const RefreshDefaultBranchResponseSchema = v.object({
  defaultBranch: v.pipe(v.string(), v.minLength(1, 'Default branch name is required')),
});

/**
 * Schema for remote branch status response
 */
export const RemoteBranchStatusSchema = v.object({
  behind: v.number(),
  ahead: v.number(),
});

// Inferred types from schemas
export type CreateRepositoryRequest = v.InferOutput<typeof CreateRepositoryRequestSchema>;
export type CreateWorktreePromptRequest = v.InferOutput<typeof CreateWorktreePromptRequestSchema>;
export type CreateWorktreeCustomRequest = v.InferOutput<typeof CreateWorktreeCustomRequestSchema>;
export type CreateWorktreeExistingRequest = v.InferOutput<typeof CreateWorktreeExistingRequestSchema>;
export type CreateWorktreeRequest = v.InferOutput<typeof CreateWorktreeRequestSchema>;
export type DeleteWorktreeRequest = v.InferOutput<typeof DeleteWorktreeRequestSchema>;
export type UpdateRepositoryRequest = v.InferOutput<typeof UpdateRepositoryRequestSchema>;
export type FetchGitHubIssueRequest = v.InferOutput<typeof FetchGitHubIssueRequestSchema>;
export type GitHubIssueSummary = v.InferOutput<typeof GitHubIssueSummarySchema>;
export type RefreshDefaultBranchResponse = v.InferOutput<typeof RefreshDefaultBranchResponseSchema>;
export type RemoteBranchStatus = v.InferOutput<typeof RemoteBranchStatusSchema>;

/** Response type for repository description generation endpoint */
export interface GenerateRepositoryDescriptionResponse {
  description: string;
}
