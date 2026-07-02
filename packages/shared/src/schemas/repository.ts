import * as v from 'valibot';
import { branchNamePattern, branchNameErrorMessage } from './session';

/**
 * Schema for creating a repository
 */
export const CreateRepositoryRequestSchema = v.strictObject({
  path: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Path is required')
  ),
  description: v.optional(v.pipe(v.string(), v.trim())),
});

/**
 * Accepted clone URL shapes (Issue #834 Validation, tightened per CodeRabbit
 * review on PR #862):
 *   - `https://...` (TLS only; cleartext http:// is rejected to avoid
 *     credential-bearing clones over an unsecured channel)
 *   - `git://...`
 *   - `ssh://...`
 *   - `git@host:org/repo[.git]` (SCP-style SSH shortcut)
 *
 * The scheme regex pre-anchors the leading character (so a leading `-` cannot
 * pose as `--upload-pack=...`). The follow-up `cloneUrlDisallowedPattern`
 * check explicitly rejects whitespace, shell metacharacters
 * (`;`, `&`, `|`, `` ` ``, `$`, `<`, `>`, `(`, `)`, `[`, `]`, `{`, `}`, `'`,
 * `"`, `\\`), and any C0/C1 control character before the URL reaches the
 * server-side runner. The server-side
 * `services/repository-clone-service.ts` mirrors both layers.
 */
const cloneUrlPattern =
  /^(?:https:\/\/|git:\/\/|ssh:\/\/[^\s]+|[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9._-]+:[^\s]+)\S*$/;

/**
 * Characters that must NEVER appear in a clone URL accepted by this schema,
 * regardless of scheme. Covers POSIX shell metacharacters, both quote shapes,
 * the backslash escape, parentheses / brackets / braces, control characters
 * (0x00-0x1F + 0x7F), and any whitespace.
 *
 * Keep in sync with `URL_DISALLOWED_PATTERN` in
 * `packages/server/src/services/repository-clone-service.ts`.
 */
// eslint-disable-next-line no-control-regex
const cloneUrlDisallowedPattern = /[\s\x00-\x1F\x7F;&|`$<>()[\]{}'"\\]/;

/**
 * Repository name validation (Issue #834 Validation):
 * - 1-100 chars of `[A-Za-z0-9._-]`
 * - Cannot start with `-` (so it is never mistaken for a CLI flag)
 * - Cannot be `.` or `..`
 * - Cannot contain `..` (path traversal) or `/` (subdirectory escape; already
 *   excluded by the character class but called out for the error message)
 */
const repoNamePattern = /^[A-Za-z0-9_.][A-Za-z0-9._-]{0,99}$/;

/**
 * Schema for cloning + registering a repository (Issue #834).
 *
 * Validates at request boundary so the URL / name never reach a subprocess
 * spawn unless they pass the documented shape.
 */
export const CloneRepositoryRequestSchema = v.strictObject({
  url: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'URL is required'),
    v.regex(
      cloneUrlPattern,
      'URL must be https://, git://, ssh://, or git@host:org/repo (http:// rejected; no leading dashes)',
    ),
    v.check(
      (val) => !cloneUrlDisallowedPattern.test(val),
      'URL contains a disallowed character (whitespace, shell metacharacters, control characters, quotes, or backslash)',
    ),
  ),
  name: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1, 'Name cannot be empty when provided'),
      v.regex(
        repoNamePattern,
        'Name must contain only [A-Za-z0-9._-], be 1-100 chars, and not start with `-`',
      ),
      v.check(
        (val) => val !== '.' && val !== '..' && !val.includes('..'),
        'Name cannot be `.`, `..`, or contain `..`',
      ),
    ),
  ),
  description: v.optional(v.pipe(v.string(), v.trim())),
});

/**
 * Clone job status discriminator. The job transitions:
 *   pending -> cloning -> succeeded
 *                      `-> failed
 */
export const CLONE_JOB_STATUS = {
  PENDING: 'pending',
  CLONING: 'cloning',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
} as const;

export type CloneJobStatus = (typeof CLONE_JOB_STATUS)[keyof typeof CLONE_JOB_STATUS];

/**
 * Structured failure codes the server emits so the client can render an
 * actionable message in the user's locale (Issue #834 Failure modes).
 *
 * Each code maps to a documented operator-resolvable cause; `unknown` is the
 * catch-all when stderr does not match any known substring.
 */
export const CLONE_ERROR_CODES = {
  /** Input failed schema validation (URL shape, name shape, etc.). */
  VALIDATION_ERROR: 'validation_error',
  /** Target directory already exists at request time (pre-spawn 409). */
  NAME_CONFLICT: 'name_conflict',
  /** SSH key not accepted, HTTPS credential rejected, or token missing. */
  AUTH_FAILED: 'auth_failed',
  /** DNS / TCP / TLS failure reaching the remote. */
  NETWORK_ERROR: 'network_error',
  /** Remote returned 404 / does-not-exist. */
  REPO_NOT_FOUND: 'repo_not_found',
  /** Local filesystem refused write (target dir, parent dir, etc.). */
  PERMISSION_DENIED: 'permission_denied',
  /** Clone exceeded CLONE_TIMEOUT_MS. */
  TIMEOUT: 'timeout',
  /** No matching substring; raw stderr captured in the message field. */
  UNKNOWN: 'unknown',
} as const;

export type CloneErrorCode = (typeof CLONE_ERROR_CODES)[keyof typeof CLONE_ERROR_CODES];

/**
 * Structured error payload returned by the job-status endpoint when the job
 * is in `failed` state. `message` contains the underlying stderr (trimmed)
 * suitable for diagnostic display; `code` is the localizable discriminant.
 */
export interface CloneJobError {
  code: CloneErrorCode;
  message: string;
}

/**
 * Response shape for `POST /api/repositories/clone` (Issue #834). The repo is
 * cloned asynchronously; the client polls `GET /api/repositories/clone/:jobId`
 * for the final status and the new `repositoryId`.
 */
export interface CloneRepositoryResponse {
  jobId: string;
  /** Always `null` at request time; populated on the status endpoint after
   * the background clone + register chain completes. */
  repositoryId: null;
}

/**
 * Response shape for `GET /api/repositories/clone/:jobId`.
 *
 * - `pending` / `cloning`: no `error`, no `repositoryId` yet
 * - `succeeded`: `repositoryId` populated; no `error`
 * - `failed`: `error` populated; no `repositoryId`
 */
export interface CloneJobStatusResponse {
  jobId: string;
  status: CloneJobStatus;
  /** Present only when `status === 'failed'`. */
  error?: CloneJobError;
  /** Present only when `status === 'succeeded'`. */
  repositoryId?: string;
}

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
const CreateWorktreeBaseSchema = v.strictObject({
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
export const CreateWorktreePromptRequestSchema = v.strictObject({
  ...CreateWorktreeBaseSchema.entries,
  mode: v.literal('prompt'),
  initialPrompt: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Initial prompt is required for prompt mode')
  ),
  baseBranch: OptionalBranchSchema,
  useRemote: v.optional(v.boolean()), // Branch from origin/<base> instead of local <base>. Defaults to true.
});

/**
 * Schema for creating worktree with custom branch name
 */
export const CreateWorktreeCustomRequestSchema = v.strictObject({
  ...CreateWorktreeBaseSchema.entries,
  mode: v.literal('custom'),
  branch: RequiredBranchSchema,
  baseBranch: OptionalBranchSchema,
  useRemote: v.optional(v.boolean()), // Branch from origin/<base> instead of local <base>. Defaults to true.
});

/**
 * Schema for creating worktree from existing branch
 */
export const CreateWorktreeExistingRequestSchema = v.strictObject({
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
export const FetchGitHubIssueRequestSchema = v.strictObject({
  reference: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Issue reference is required')
  ),
});

/**
 * Schema for a GitHub issue summary
 */
export const GitHubIssueSummarySchema = v.strictObject({
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
export const DeleteWorktreeRequestSchema = v.strictObject({
  force: v.optional(v.boolean()),
});

/**
 * Schema for the DELETE /api/repositories/:id request body.
 *
 * `removeSourceRepo` toggles whether the server-side cleanup job also removes
 * the cloned source-repo directory (only valid when the repo's `path` lives
 * under the shared `source-repos` directory; the server applies a defensive
 * path-prefix guard regardless of the request body). Defaults to `false` so
 * an absent body keeps the historical behaviour of removing only the data
 * subtree.
 */
export const DeleteRepositoryRequestSchema = v.strictObject({
  removeSourceRepo: v.optional(v.boolean(), false),
});

/**
 * Schema for pulling a worktree (git pull --ff-only)
 */
export const PullWorktreeRequestSchema = v.strictObject({
  /** The absolute path of the worktree to pull */
  worktreePath: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Worktree path is required')
  ),
  /** Client-generated UUID for async request-response correlation */
  taskId: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Task ID is required')
  ),
});

/**
 * Schema for updating a repository
 */
export const UpdateRepositoryRequestSchema = v.strictObject({
  setupCommand: v.nullish(v.pipe(v.string(), v.trim())),
  cleanupCommand: v.nullish(v.pipe(v.string(), v.trim())),
  envVars: v.nullish(v.pipe(v.string(), v.trim())),
  description: v.nullish(v.pipe(v.string(), v.trim())),
  defaultAgentId: v.nullish(v.pipe(v.string(), v.trim())),
});

/**
 * Schema for the response of refreshing a repository's default branch
 */
export const RefreshDefaultBranchResponseSchema = v.strictObject({
  defaultBranch: v.pipe(v.string(), v.minLength(1, 'Default branch name is required')),
});

/**
 * Schema for remote branch status response
 */
export const RemoteBranchStatusSchema = v.strictObject({
  behind: v.number(),
  ahead: v.number(),
});

// Inferred types from schemas
export type CreateRepositoryRequest = v.InferOutput<typeof CreateRepositoryRequestSchema>;
export type CloneRepositoryRequest = v.InferOutput<typeof CloneRepositoryRequestSchema>;
export type CreateWorktreePromptRequest = v.InferOutput<typeof CreateWorktreePromptRequestSchema>;
export type CreateWorktreeCustomRequest = v.InferOutput<typeof CreateWorktreeCustomRequestSchema>;
export type CreateWorktreeExistingRequest = v.InferOutput<typeof CreateWorktreeExistingRequestSchema>;
export type CreateWorktreeRequest = v.InferOutput<typeof CreateWorktreeRequestSchema>;
export type DeleteWorktreeRequest = v.InferOutput<typeof DeleteWorktreeRequestSchema>;
export type DeleteRepositoryRequest = v.InferOutput<typeof DeleteRepositoryRequestSchema>;
export type PullWorktreeRequest = v.InferOutput<typeof PullWorktreeRequestSchema>;
export type UpdateRepositoryRequest = v.InferOutput<typeof UpdateRepositoryRequestSchema>;
export type FetchGitHubIssueRequest = v.InferOutput<typeof FetchGitHubIssueRequestSchema>;
export type GitHubIssueSummary = v.InferOutput<typeof GitHubIssueSummarySchema>;
export type RefreshDefaultBranchResponse = v.InferOutput<typeof RefreshDefaultBranchResponseSchema>;
export type RemoteBranchStatus = v.InferOutput<typeof RemoteBranchStatusSchema>;

/** Response type for repository description generation endpoint */
export interface GenerateRepositoryDescriptionResponse {
  description: string;
}
