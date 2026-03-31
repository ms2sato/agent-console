import type { FetchJobsParams } from './api';

/**
 * Centralized query key factories for TanStack Query.
 * Grouped by domain to ensure consistent cache key management.
 *
 * Usage:
 *   queryKey: repositoryKeys.all()
 *   queryKey: agentKeys.detail(agentId)
 *   invalidateQueries({ queryKey: jobKeys.root() })
 */

export const repositoryKeys = {
  /** All repositories list */
  all: () => ['repositories'] as const,
  /** Single repository detail */
  detail: (repositoryId: string) => ['repository', repositoryId] as const,
  /** Slack integration for a repository */
  slackIntegration: (repositoryId: string) => ['repository-slack-integration', repositoryId] as const,
} as const;

// Note: detail keys use singular form ('agent', 'job') while list keys use plural ('agents', 'jobs').
// This is intentional to preserve backward compatibility with existing cache keys from before
// centralization. As a result, detail keys are not hierarchical prefixes of list keys, and
// callers must handle invalidation explicitly (e.g., invalidating both root and detail separately).
export const agentKeys = {
  /** All agents list */
  all: () => ['agents'] as const,
  /** Single agent detail */
  detail: (agentId: string) => ['agent', agentId] as const,
} as const;

export const jobKeys = {
  /** Root key for invalidating all job queries */
  root: () => ['jobs'] as const,
  /** Jobs list with filters */
  list: (params: FetchJobsParams) => ['jobs', params] as const,
  /** Job stats */
  stats: () => ['jobs', 'stats'] as const,
  /** Single job detail */
  detail: (jobId: string) => ['job', jobId] as const,
} as const;

// Note: session keys use mixed naming styles (plural 'sessions', kebab-case 'session-validation',
// camelCase 'sessionPrLink') to preserve backward compatibility with existing cache keys from
// before centralization. Do not normalize these without a migration strategy.
export const sessionKeys = {
  /** Root key for invalidating all session queries (used by WS sync) */
  root: () => ['sessions'] as const,
  /** Session validation */
  validation: () => ['session-validation'] as const,
  /** PR link for a session */
  prLink: (sessionId: string) => ['sessionPrLink', sessionId] as const,
  /** Branches for a session */
  branches: (sessionId: string) => ['sessionBranches', sessionId] as const,
  /** Memo content for a session */
  memo: (sessionId: string) => ['session-memo', sessionId] as const,
} as const;

export const worktreeKeys = {
  /** Root key for invalidating all worktree queries */
  root: () => ['worktrees'] as const,
  /** Worktrees for a specific repository */
  byRepository: (repositoryId: string) => ['worktrees', repositoryId] as const,
} as const;

export const branchKeys = {
  /** Branches for a repository */
  byRepository: (repositoryId: string) => ['branches', repositoryId] as const,
  /** Branch commits for a session */
  commits: (sessionId: string, baseCommit: string) => ['branchCommits', sessionId, baseCommit] as const,
  /** Remote status root (for prefix invalidation) */
  remoteStatusRoot: (repositoryId: string) => ['remote-status', repositoryId] as const,
  /** Remote status for a specific branch */
  remoteStatus: (repositoryId: string, branch: string) => ['remote-status', repositoryId, branch] as const,
} as const;

export const systemKeys = {
  /** System health check */
  health: () => ['system', 'health'] as const,
} as const;

export const notificationKeys = {
  /** Notification status */
  status: () => ['notification-status'] as const,
} as const;
