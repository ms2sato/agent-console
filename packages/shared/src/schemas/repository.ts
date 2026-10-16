import * as v from 'valibot';
import { branchNamePattern, branchNameErrorMessage } from './session';
import { RepositorySchema, WorktreeSchema } from './app-server-message.js';

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
 * Accepted clone URL shapes:
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
 * Repository name validation:
 * - 1-100 chars of `[A-Za-z0-9._-]`
 * - Cannot start with `-` (so it is never mistaken for a CLI flag)
 * - Cannot be `.` or `..`
 * - Cannot contain `..` (path traversal) or `/` (subdirectory escape; already
 *   excluded by the character class but called out for the error message)
 */
const repoNamePattern = /^[A-Za-z0-9_.][A-Za-z0-9._-]{0,99}$/;

/**
 * Schema for cloning + registering a repository.
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
  /** Clone as a bare repository (no working tree). Omitted means a regular clone. */
  bare: v.optional(v.boolean()),
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
 * actionable message in the user's locale.
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
 * Response shape for `POST /api/repositories/clone`. The repo is
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
 * Wire schema for `GET /api/repositories/clone/:jobId`.
 *
 * - `pending` / `cloning`: no `error`, no `repositoryId` yet
 * - `succeeded`: `repositoryId` populated; no `error`
 * - `failed`: `error` populated; no `repositoryId`
 *
 * The route omits the optional keys when absent, so they are `optional`, never
 * `nullable` (the `null` of `CloneRepositoryResponse` is a different shape).
 */
export const CloneJobStatusResponseSchema = v.strictObject({
  jobId: v.string(),
  status: v.picklist(Object.values(CLONE_JOB_STATUS)),
  /** Present only when `status === 'failed'`. */
  error: v.optional(
    v.strictObject({
      code: v.picklist(Object.values(CLONE_ERROR_CODES)),
      message: v.string(),
    }),
  ),
  /** Present only when `status === 'succeeded'`. */
  repositoryId: v.optional(v.string()),
});

export type CloneJobStatusResponse = v.InferOutput<typeof CloneJobStatusResponseSchema>;

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
  /**
   * Embedded-agent selection for the initial worker. Mutually exclusive
   * with `agentId` -- widens the PER-WORKTREE initial-worker choice only;
   * `Repository.defaultAgentId` remains terminal-agent-only.
   */
  embeddedAgentId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'Embedded agent ID cannot be empty'))),
  initialPrompt: v.optional(v.string()),
  title: v.optional(v.string()),
  /**
   * When true, create the worktree session as a shared session running as
   * the account bound to this repository (Settings > Shared accounts). 400
   * if the repository has no binding or the bound account is no longer
   * resolvable to an OS account. See
   * docs/design/shared-orchestrator-session.md
   * §"Shared-Account Set and Per-Repository Binding (DB-backed)".
   */
  shared: v.optional(v.boolean()),
  /** Model override for the initial worker (agent-surface.md Ruling 2). See CreateAgentWorkerParamsSchema. */
  model: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'model must not be empty'))),
  /** Reasoning-effort override for the initial worker (agent-surface.md Ruling 2). See CreateAgentWorkerParamsSchema. */
  reasoningEffort: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'reasoningEffort must not be empty'))),
  /**
   * Context-window override for the initial worker, embedded-agent only
   * (agent-surface.md Ruling 4). Only meaningful alongside a `model`
   * override -- a declared window with no model change would silently apply
   * to a model it wasn't declared for. Cross-field validation (requires
   * `model` to be present) happens at createWorker(), not here. See
   * CreateEmbeddedAgentWorkerParamsSchema in schemas/worker.ts.
   */
  contextWindowTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

/**
 * Schema for creating worktree with prompt-based branch name
 */
export const CreateWorktreePromptRequestSchema = v.pipe(
  v.strictObject({
    ...CreateWorktreeBaseSchema.entries,
    mode: v.literal('prompt'),
    initialPrompt: v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1, 'Initial prompt is required for prompt mode')
    ),
    baseBranch: OptionalBranchSchema,
    useRemote: v.optional(v.boolean()), // Branch from origin/<base> instead of local <base>. Defaults to true.
  }),
  v.check(
    (val) => !(val.agentId && val.embeddedAgentId),
    'Cannot specify both agentId and embeddedAgentId',
  ),
);

/**
 * Schema for creating worktree with custom branch name
 */
export const CreateWorktreeCustomRequestSchema = v.pipe(
  v.strictObject({
    ...CreateWorktreeBaseSchema.entries,
    mode: v.literal('custom'),
    branch: RequiredBranchSchema,
    baseBranch: OptionalBranchSchema,
    useRemote: v.optional(v.boolean()), // Branch from origin/<base> instead of local <base>. Defaults to true.
  }),
  v.check(
    (val) => !(val.agentId && val.embeddedAgentId),
    'Cannot specify both agentId and embeddedAgentId',
  ),
);

/**
 * Schema for creating worktree from existing branch
 */
export const CreateWorktreeExistingRequestSchema = v.pipe(
  v.strictObject({
    ...CreateWorktreeBaseSchema.entries,
    mode: v.literal('existing'),
    branch: RequiredBranchSchema,
  }),
  v.check(
    (val) => !(val.agentId && val.embeddedAgentId),
    'Cannot specify both agentId and embeddedAgentId',
  ),
);

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
  issueTriggerLabels: v.nullish(v.pipe(v.string(), v.trim())),
  sharedAccountUsername: v.nullish(v.pipe(v.string(), v.trim())),
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

/**
 * Schema for `GET /api/repositories/:id`'s response. Composes the shared
 * `RepositorySchema` entity (the same one the `/ws/app` repository broadcasts
 * use) rather than restating it.
 */
export const RepositoryResponseSchema = v.strictObject({
  repository: RepositorySchema,
});

/** Schema for `GET /api/repositories`'s response. */
export const RepositoriesResponseSchema = v.strictObject({
  repositories: v.array(RepositorySchema),
});

/**
 * What the server process observed about a repository's directory when it
 * listed the repository's worktrees.
 * - `ok`: readable (or the listing failed for a reason other than the path)
 * - `missing`: the directory does not exist (moved, renamed or deleted)
 * - `inaccessible`: the directory exists or could not be told apart, but the
 *   server process cannot read it (permissions or another OS-level error)
 */
export const RepositoryPathStatusSchema = v.picklist(['ok', 'missing', 'inaccessible']);

/** Schema for `GET /api/repositories/:id/worktrees`'s response. */
export const WorktreesResponseSchema = v.strictObject({
  worktrees: v.array(WorktreeSchema),
  pathStatus: RepositoryPathStatusSchema,
});

/**
 * Schema for the response of listing a repository's (or a session's) branches:
 * `GET /api/repositories/:id/branches` and `GET /api/sessions/:id/branches`.
 */
export const BranchesResponseSchema = v.strictObject({
  local: v.array(v.string()),
  remote: v.array(v.string()),
  defaultBranch: v.nullable(v.string()),
});

/** One commit of `GET /api/sessions/:id/commits`; the field set is pinned by `getBranchCommits` in the server's git library. */
export const CommitInfoSchema = v.strictObject({
  hash: v.string(),
  shortHash: v.string(),
  message: v.string(),
  author: v.string(),
  date: v.string(),
});

/** Schema for `GET /api/sessions/:id/commits`'s response. */
export const BranchCommitsResponseSchema = v.strictObject({
  commits: v.array(CommitInfoSchema),
});

/** Schema for `POST /api/repositories/:id/github-issue`'s response. */
export const GitHubIssueResponseSchema = v.strictObject({
  issue: GitHubIssueSummarySchema,
});

/** Schema for `GET /api/sessions/:id/pr-link`'s response. */
export const SessionPrLinkResponseSchema = v.strictObject({
  prUrl: v.nullable(v.string()),
  branchName: v.string(),
  orgRepo: v.nullable(v.string()),
});

export type RepositoriesResponse = v.InferOutput<typeof RepositoriesResponseSchema>;
export type CommitInfo = v.InferOutput<typeof CommitInfoSchema>;
export type BranchCommitsResponse = v.InferOutput<typeof BranchCommitsResponseSchema>;
export type GitHubIssueResponse = v.InferOutput<typeof GitHubIssueResponseSchema>;
export type SessionPrLinkResponse = v.InferOutput<typeof SessionPrLinkResponseSchema>;
export type RepositoryResponse = v.InferOutput<typeof RepositoryResponseSchema>;
export type RepositoryPathStatus = v.InferOutput<typeof RepositoryPathStatusSchema>;
export type WorktreesResponse = v.InferOutput<typeof WorktreesResponseSchema>;
export type BranchesResponse = v.InferOutput<typeof BranchesResponseSchema>;
