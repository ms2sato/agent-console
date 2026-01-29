import type {
  Session,
  Worker,
  Repository,
  Worktree,
  CreateWorktreeRequest,
  CreateWorkerRequest,
  CreateWorkerResponse,
  CreateSessionRequest,
  AgentDefinition,
  CreateAgentRequest,
  UpdateAgentRequest,
  SessionsValidationResponse,
  BranchNameFallback,
  GitHubIssueSummary,
  Job,
  JobsResponse,
  JobStats,
  JobStatus,
  JobType,
  SetupCommandResult,
  RefreshDefaultBranchResponse,
  RemoteBranchStatus,
} from '@agent-console/shared';
import { api } from './api-client';

// Base URL kept only for the wildcard worktree delete endpoint which Hono RPC doesn't handle well
const API_BASE = '/api';

export interface ConfigResponse {
  homeDir: string;
  capabilities: {
    vscode: boolean;
  };
  serverPid: number;
}

export async function fetchConfig(): Promise<ConfigResponse> {
  const res = await api.config.$get();
  if (!res.ok) {
    throw new Error(`Failed to fetch config: ${res.statusText}`);
  }
  return res.json();
}

export interface CreateSessionResponse {
  session: Session;
}

export async function createSession(
  request: CreateSessionRequest
): Promise<CreateSessionResponse> {
  const res = await api.sessions.$post({ json: request });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to create session');
  }
  return res.json() as Promise<CreateSessionResponse>;
}

export async function getSession(sessionId: string): Promise<Session | null> {
  try {
    const res = await api.sessions[':id'].$get({ param: { id: sessionId } });
    if (res.status === 404) {
      return null;
    }
    // 500/502/503/504 likely means server is down (Vite proxy returns 500 when backend is unavailable)
    if (res.status >= 500) {
      throw new ServerUnavailableError();
    }
    if (!res.ok) {
      throw new Error(`Failed to get session: ${res.statusText}`);
    }
    const data = (await res.json()) as { session: Session };
    return data.session;
  } catch (error) {
    // Network error - server is likely down
    // TypeError is thrown when fetch fails due to network issues
    if (error instanceof TypeError) {
      throw new ServerUnavailableError();
    }
    throw error;
  }
}

export class ServerUnavailableError extends Error {
  constructor() {
    super('Server is unavailable');
    this.name = 'ServerUnavailableError';
  }
}

export interface WorkersResponse {
  workers: Worker[];
}

export async function fetchWorkers(sessionId: string): Promise<WorkersResponse> {
  const res = await api.sessions[':sessionId'].workers.$get({ param: { sessionId } });
  if (!res.ok) {
    throw new Error(`Failed to fetch workers: ${res.statusText}`);
  }
  return res.json() as Promise<WorkersResponse>;
}

export async function createWorker(
  sessionId: string,
  request: CreateWorkerRequest & { continueConversation?: boolean }
): Promise<CreateWorkerResponse> {
  const res = await api.sessions[':sessionId'].workers.$post({
    param: { sessionId },
    json: request,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to create worker');
  }
  return res.json() as Promise<CreateWorkerResponse>;
}

export async function deleteWorker(sessionId: string, workerId: string): Promise<void> {
  const res = await api.sessions[':sessionId'].workers[':workerId'].$delete({
    param: { sessionId, workerId },
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to delete worker');
  }
}

export async function restartAgentWorker(
  sessionId: string,
  workerId: string,
  continueConversation: boolean = false
): Promise<{ worker: Worker }> {
  const res = await api.sessions[':sessionId'].workers[':workerId'].restart.$post({
    param: { sessionId, workerId },
    json: { continueConversation },
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to restart worker');
  }
  return res.json() as Promise<{ worker: Worker }>;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await api.sessions[':id'].$delete({ param: { id: sessionId } });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to delete session');
  }
}


export interface UpdateSessionMetadataRequest {
  title?: string;
  branch?: string;
}

export interface UpdateSessionMetadataResponse {
  success: boolean;
  title?: string;
  branch?: string;
}

export async function updateSessionMetadata(
  sessionId: string,
  updates: UpdateSessionMetadataRequest
): Promise<UpdateSessionMetadataResponse> {
  const res = await api.sessions[':id'].$patch({
    param: { id: sessionId },
    json: updates,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to update session');
  }
  return res.json() as Promise<UpdateSessionMetadataResponse>;
}

export interface RepositoriesResponse {
  repositories: Repository[];
}

export interface CreateRepositoryResponse {
  repository: Repository;
}

export async function fetchRepositories(): Promise<RepositoriesResponse> {
  const res = await api.repositories.$get();
  if (!res.ok) {
    throw new Error(`Failed to fetch repositories: ${res.statusText}`);
  }
  return res.json();
}

export async function registerRepository(path: string): Promise<CreateRepositoryResponse> {
  const res = await api.repositories.$post({ json: { path } });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to register repository');
  }
  return res.json() as Promise<CreateRepositoryResponse>;
}

export async function unregisterRepository(repositoryId: string): Promise<void> {
  const res = await api.repositories[':id'].$delete({ param: { id: repositoryId } });
  if (!res.ok) {
    throw new Error(`Failed to unregister repository: ${res.statusText}`);
  }
}

export interface UpdateRepositoryRequest {
  setupCommand?: string | null;
  envVars?: string | null;
}

export interface UpdateRepositoryResponse {
  repository: Repository;
}

export async function updateRepository(
  repositoryId: string,
  request: UpdateRepositoryRequest
): Promise<UpdateRepositoryResponse> {
  // Cast needed: client-side UpdateRepositoryRequest allows null for optional fields,
  // but vValidator infers string | undefined (without null)
  const res = await (api.repositories[':id'].$patch as (opts: { param: { id: string }; json: UpdateRepositoryRequest }) => Promise<Response>)({
    param: { id: repositoryId },
    json: request,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to update repository');
  }
  return res.json() as Promise<UpdateRepositoryResponse>;
}

export interface WorktreesResponse {
  worktrees: Worktree[];
}

export interface BranchesResponse {
  local: string[];
  remote: string[];
  defaultBranch: string | null;
}

export interface CreateWorktreeResponse {
  worktree: Worktree;
  session: Session | null;
  /** Present when AI-based branch name generation failed and a fallback name was used */
  branchNameFallback?: BranchNameFallback;
  /** Present when a setup command was configured and executed */
  setupCommandResult?: SetupCommandResult;
  /** True when useRemote was requested but fetch failed, falling back to local branch */
  fetchFailed?: boolean;
  /** Error message when fetchFailed is true */
  fetchError?: string;
}

/**
 * Response for async worktree creation (when taskId is provided)
 */
export interface CreateWorktreeAsyncResponse {
  accepted: true;
}

export async function fetchWorktrees(repositoryId: string): Promise<WorktreesResponse> {
  const res = await api.repositories[':id'].worktrees.$get({ param: { id: repositoryId } });
  if (!res.ok) {
    throw new Error(`Failed to fetch worktrees: ${res.statusText}`);
  }
  return res.json() as Promise<WorktreesResponse>;
}

export async function fetchBranches(repositoryId: string): Promise<BranchesResponse> {
  const res = await api.repositories[':id'].branches.$get({ param: { id: repositoryId } });
  if (!res.ok) {
    throw new Error(`Failed to fetch branches: ${res.statusText}`);
  }
  return res.json() as Promise<BranchesResponse>;
}

export async function fetchSessionBranches(sessionId: string): Promise<BranchesResponse> {
  const res = await api.sessions[':sessionId'].branches.$get({ param: { sessionId } });
  if (!res.ok) {
    throw new Error(`Failed to fetch session branches: ${res.statusText}`);
  }
  return res.json() as Promise<BranchesResponse>;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

export interface BranchCommitsResponse {
  commits: CommitInfo[];
}

export async function fetchBranchCommits(sessionId: string, baseRef: string): Promise<BranchCommitsResponse> {
  // Cast needed: query params not exposed in Hono RPC type for this route
  const res = await (api.sessions[':sessionId'].commits.$get as (opts: { param: { sessionId: string }; query: { base: string } }) => Promise<Response>)({
    param: { sessionId },
    query: { base: baseRef },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch branch commits: ${res.statusText}`);
  }
  return res.json() as Promise<BranchCommitsResponse>;
}

/**
 * Create a worktree synchronously (without taskId).
 * @deprecated Use createWorktreeAsync instead for non-blocking UI
 */
export async function createWorktree(
  repositoryId: string,
  request: CreateWorktreeRequest
): Promise<CreateWorktreeResponse> {
  const res = await api.repositories[':id'].worktrees.$post({
    param: { id: repositoryId },
    json: request,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to create worktree');
  }
  // Server returns different shapes based on taskId presence; Hono RPC infers the async shape
  return res.json() as unknown as Promise<CreateWorktreeResponse>;
}

/**
 * Create a worktree asynchronously.
 * The request must include a client-generated taskId for correlation.
 * Returns immediately with `{ accepted: true }`.
 * Listen to WebSocket for `worktree-creation-completed` or `worktree-creation-failed` events.
 */
export async function createWorktreeAsync(
  repositoryId: string,
  request: CreateWorktreeRequest
): Promise<CreateWorktreeAsyncResponse> {
  const res = await api.repositories[':id'].worktrees.$post({
    param: { id: repositoryId },
    json: request,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to create worktree');
  }
  return res.json() as Promise<CreateWorktreeAsyncResponse>;
}

export interface GitHubIssueResponse {
  issue: GitHubIssueSummary;
}

export async function fetchGitHubIssue(
  repositoryId: string,
  reference: string
): Promise<GitHubIssueResponse> {
  const res = await api.repositories[':id']['github-issue'].$post({
    param: { id: repositoryId },
    json: { reference },
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to fetch GitHub issue');
  }
  return res.json() as Promise<GitHubIssueResponse>;
}

/**
 * Delete a worktree synchronously.
 * NOTE: This endpoint uses manual fetch because the server route uses a wildcard pattern
 * (`DELETE /:id/worktrees/*`) which Hono RPC client doesn't handle well.
 */
export async function deleteWorktree(
  repositoryId: string,
  worktreePath: string,
  force: boolean = false
): Promise<void> {
  const url = `${API_BASE}/repositories/${repositoryId}/worktrees/${encodeURIComponent(worktreePath)}${force ? '?force=true' : ''}`;
  const res = await fetch(url, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to delete worktree');
  }
}

/**
 * Delete a worktree asynchronously.
 * The request includes a client-generated taskId for correlation.
 * Returns immediately with `{ accepted: true }`.
 * Listen to WebSocket for `worktree-deletion-completed` or `worktree-deletion-failed` events.
 *
 * NOTE: This endpoint uses manual fetch because the server route uses a wildcard pattern
 * (`DELETE /:id/worktrees/*`) which Hono RPC client doesn't handle well.
 */
export async function deleteWorktreeAsync(
  repositoryId: string,
  worktreePath: string,
  taskId: string,
  force: boolean = false
): Promise<{ accepted: true }> {
  const params = new URLSearchParams();
  if (force) params.set('force', 'true');
  params.set('taskId', taskId);
  const url = `${API_BASE}/repositories/${repositoryId}/worktrees/${encodeURIComponent(worktreePath)}?${params.toString()}`;
  const res = await fetch(url, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to delete worktree');
  }
  return res.json();
}

export interface AgentsResponse {
  agents: AgentDefinition[];
}

export interface AgentResponse {
  agent: AgentDefinition;
}

export async function fetchAgents(): Promise<AgentsResponse> {
  const res = await api.agents.$get();
  if (!res.ok) {
    throw new Error(`Failed to fetch agents: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchAgent(agentId: string): Promise<AgentResponse> {
  const res = await api.agents[':id'].$get({ param: { id: agentId } });
  if (!res.ok) {
    throw new Error(`Failed to fetch agent: ${res.statusText}`);
  }
  return res.json() as Promise<AgentResponse>;
}

export async function registerAgent(request: CreateAgentRequest): Promise<AgentResponse> {
  const res = await api.agents.$post({ json: request });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to register agent');
  }
  return res.json() as Promise<AgentResponse>;
}

export async function updateAgent(
  agentId: string,
  request: UpdateAgentRequest
): Promise<AgentResponse> {
  const res = await api.agents[':id'].$patch({
    param: { id: agentId },
    json: request,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to update agent');
  }
  return res.json() as Promise<AgentResponse>;
}

export async function unregisterAgent(agentId: string): Promise<void> {
  const res = await api.agents[':id'].$delete({ param: { id: agentId } });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to unregister agent');
  }
}

export async function openPath(path: string): Promise<void> {
  const res = await api.system.open.$post({ json: { path } });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to open path');
  }
}

export async function openInVSCode(path: string): Promise<void> {
  const res = await api.system['open-in-vscode'].$post({ json: { path } });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to open in VS Code');
  }
}

// Session validation
export async function validateSessions(): Promise<SessionsValidationResponse> {
  const res = await api.sessions.validate.$get();
  if (!res.ok) {
    throw new Error(`Failed to validate sessions: ${res.statusText}`);
  }
  return res.json() as Promise<SessionsValidationResponse>;
}

export async function deleteInvalidSession(sessionId: string): Promise<void> {
  const res = await api.sessions[':id'].invalid.$delete({ param: { id: sessionId } });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to delete invalid session');
  }
}

// ===========================================================================
// Jobs API
// ===========================================================================

// Re-export job types from shared package
export type { Job, JobsResponse, JobStats, JobStatus, JobType };

/**
 * Parameters for fetching jobs.
 */
export interface FetchJobsParams {
  status?: JobStatus;
  type?: JobType;
  limit?: number;
  offset?: number;
}

export async function fetchJobs(params?: FetchJobsParams): Promise<JobsResponse> {
  // Build query object - only include defined values
  const query: Record<string, string> = {};
  if (params?.status) {
    query.status = params.status;
  }
  if (params?.type) {
    query.type = params.type;
  }
  if (params?.limit !== undefined) {
    query.limit = String(params.limit);
  }
  if (params?.offset !== undefined) {
    query.offset = String(params.offset);
  }

  const res = await api.jobs.$get({ query });
  if (!res.ok) {
    throw new Error(`Failed to fetch jobs: ${res.statusText}`);
  }
  // Server returns JSONValue for payload but we expect JobPayload - use unknown bridge
  return res.json() as unknown as Promise<JobsResponse>;
}

export async function fetchJobStats(): Promise<JobStats> {
  const res = await api.jobs.stats.$get();
  if (!res.ok) {
    throw new Error(`Failed to fetch job stats: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchJob(jobId: string): Promise<Job> {
  const res = await api.jobs[':id'].$get({ param: { id: jobId } });
  if (!res.ok) {
    throw new Error(`Failed to fetch job: ${res.statusText}`);
  }
  // Server returns JSONValue for payload but we expect JobPayload - use unknown bridge
  return res.json() as unknown as Promise<Job>;
}

export async function retryJob(jobId: string): Promise<void> {
  const res = await api.jobs[':id'].retry.$post({ param: { id: jobId } });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to retry job');
  }
}

export async function cancelJob(jobId: string): Promise<void> {
  const res = await api.jobs[':id'].$delete({ param: { id: jobId } });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to cancel job');
  }
}

// ===========================================================================
// Repository Default Branch
// ===========================================================================

export async function refreshDefaultBranch(repositoryId: string): Promise<RefreshDefaultBranchResponse> {
  const res = await api.repositories[':id']['refresh-default-branch'].$post({
    param: { id: repositoryId },
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to refresh default branch');
  }
  return res.json() as Promise<RefreshDefaultBranchResponse>;
}

// ===========================================================================
// Session PR Link
// ===========================================================================

export interface SessionPrLinkResponse {
  prUrl: string | null;
  branchName: string;
  orgRepo: string | null;
}

export async function fetchSessionPrLink(sessionId: string): Promise<SessionPrLinkResponse> {
  const res = await api.sessions[':sessionId']['pr-link'].$get({ param: { sessionId } });
  if (!res.ok) {
    throw new Error(`Failed to fetch session PR link: ${res.statusText}`);
  }
  return res.json() as Promise<SessionPrLinkResponse>;
}

// ===========================================================================
// Remote Branch Status
// ===========================================================================

export async function getRemoteBranchStatus(
  repositoryId: string,
  branch: string
): Promise<RemoteBranchStatus> {
  const res = await api.repositories[':id'].branches[':branch']['remote-status'].$get({
    param: { id: repositoryId, branch },
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to get remote branch status');
  }
  return res.json() as Promise<RemoteBranchStatus>;
}

// ===========================================================================
// Repository Slack Integration
// ===========================================================================

export interface RepositorySlackIntegrationResponse {
  id: string;
  repositoryId: string;
  webhookUrl: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Fetch Slack integration settings for a repository.
 * Returns null if no integration exists (404 response).
 */
export async function fetchRepositorySlackIntegration(
  repositoryId: string
): Promise<RepositorySlackIntegrationResponse | null> {
  const res = await api.repositories[':id'].integrations.slack.$get({
    param: { id: repositoryId },
  });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to fetch Slack integration');
  }
  return res.json() as Promise<RepositorySlackIntegrationResponse>;
}

export interface UpdateRepositorySlackIntegrationRequest {
  webhookUrl: string;
  enabled: boolean;
}

/**
 * Update or create Slack integration settings for a repository.
 */
export async function updateRepositorySlackIntegration(
  repositoryId: string,
  data: UpdateRepositorySlackIntegrationRequest
): Promise<RepositorySlackIntegrationResponse> {
  const res = await api.repositories[':id'].integrations.slack.$put({
    param: { id: repositoryId },
    json: data,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to update Slack integration');
  }
  return res.json() as Promise<RepositorySlackIntegrationResponse>;
}

/**
 * Send a test notification to the repository's Slack webhook.
 */
export async function testRepositorySlackIntegration(repositoryId: string): Promise<void> {
  const res = await api.repositories[':id'].integrations.slack.test.$post({
    param: { id: repositoryId },
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(error.error || 'Failed to send test notification');
  }
}

// ===========================================================================
// Notification Settings
// ===========================================================================

export interface NotificationStatus {
  baseUrl: string;
  isBaseUrlConfigured: boolean;
}

export async function fetchNotificationStatus(): Promise<NotificationStatus> {
  const res = await api.settings.notifications.status.$get();
  if (!res.ok) {
    throw new Error('Failed to fetch notification status');
  }
  return res.json() as Promise<NotificationStatus>;
}
