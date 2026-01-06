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
} from '@agent-console/shared';

const API_BASE = '/api';

export interface ConfigResponse {
  homeDir: string;
}

export async function fetchConfig(): Promise<ConfigResponse> {
  const res = await fetch(`${API_BASE}/config`);
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
  const res = await fetch(`${API_BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to create session');
  }
  return res.json();
}

export async function getSession(sessionId: string): Promise<Session | null> {
  try {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}`);
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
    const data = await res.json();
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
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/workers`);
  if (!res.ok) {
    throw new Error(`Failed to fetch workers: ${res.statusText}`);
  }
  return res.json();
}

export async function createWorker(
  sessionId: string,
  request: CreateWorkerRequest & { continueConversation?: boolean }
): Promise<CreateWorkerResponse> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/workers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to create worker');
  }
  return res.json();
}

export async function deleteWorker(sessionId: string, workerId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/workers/${workerId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to delete worker');
  }
}

export async function restartAgentWorker(
  sessionId: string,
  workerId: string,
  continueConversation: boolean = false
): Promise<{ worker: Worker }> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/workers/${workerId}/restart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ continueConversation }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to restart worker');
  }
  return res.json();
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
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
  const res = await fetch(`${API_BASE}/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to update session');
  }
  return res.json();
}

export interface RepositoriesResponse {
  repositories: Repository[];
}

export interface CreateRepositoryResponse {
  repository: Repository;
}

export async function fetchRepositories(): Promise<RepositoriesResponse> {
  const res = await fetch(`${API_BASE}/repositories`);
  if (!res.ok) {
    throw new Error(`Failed to fetch repositories: ${res.statusText}`);
  }
  return res.json();
}

export async function registerRepository(path: string): Promise<CreateRepositoryResponse> {
  const res = await fetch(`${API_BASE}/repositories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to register repository');
  }
  return res.json();
}

export async function unregisterRepository(repositoryId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/repositories/${repositoryId}`, {
    method: 'DELETE',
  });
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
  const res = await fetch(`${API_BASE}/repositories/${repositoryId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to update repository');
  }
  return res.json();
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
}

export async function fetchWorktrees(repositoryId: string): Promise<WorktreesResponse> {
  const res = await fetch(`${API_BASE}/repositories/${repositoryId}/worktrees`);
  if (!res.ok) {
    throw new Error(`Failed to fetch worktrees: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchBranches(repositoryId: string): Promise<BranchesResponse> {
  const res = await fetch(`${API_BASE}/repositories/${repositoryId}/branches`);
  if (!res.ok) {
    throw new Error(`Failed to fetch branches: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchSessionBranches(sessionId: string): Promise<BranchesResponse> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/branches`);
  if (!res.ok) {
    throw new Error(`Failed to fetch session branches: ${res.statusText}`);
  }
  return res.json();
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
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/commits?base=${encodeURIComponent(baseRef)}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch branch commits: ${res.statusText}`);
  }
  return res.json();
}

export async function createWorktree(
  repositoryId: string,
  request: CreateWorktreeRequest
): Promise<CreateWorktreeResponse> {
  const res = await fetch(`${API_BASE}/repositories/${repositoryId}/worktrees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to create worktree');
  }
  return res.json();
}

export interface GitHubIssueResponse {
  issue: GitHubIssueSummary;
}

export async function fetchGitHubIssue(
  repositoryId: string,
  reference: string
): Promise<GitHubIssueResponse> {
  const res = await fetch(`${API_BASE}/repositories/${repositoryId}/github-issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to fetch GitHub issue');
  }
  return res.json();
}

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

export interface AgentsResponse {
  agents: AgentDefinition[];
}

export interface AgentResponse {
  agent: AgentDefinition;
}

export async function fetchAgents(): Promise<AgentsResponse> {
  const res = await fetch(`${API_BASE}/agents`);
  if (!res.ok) {
    throw new Error(`Failed to fetch agents: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchAgent(agentId: string): Promise<AgentResponse> {
  const res = await fetch(`${API_BASE}/agents/${agentId}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch agent: ${res.statusText}`);
  }
  return res.json();
}

export async function registerAgent(request: CreateAgentRequest): Promise<AgentResponse> {
  const res = await fetch(`${API_BASE}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to register agent');
  }
  return res.json();
}

export async function updateAgent(
  agentId: string,
  request: UpdateAgentRequest
): Promise<AgentResponse> {
  const res = await fetch(`${API_BASE}/agents/${agentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to update agent');
  }
  return res.json();
}

export async function unregisterAgent(agentId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/agents/${agentId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to unregister agent');
  }
}

export async function openPath(path: string): Promise<void> {
  const res = await fetch(`${API_BASE}/system/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to open path');
  }
}

// Session validation
export async function validateSessions(): Promise<SessionsValidationResponse> {
  const res = await fetch(`${API_BASE}/sessions/validate`);
  if (!res.ok) {
    throw new Error(`Failed to validate sessions: ${res.statusText}`);
  }
  return res.json();
}

export async function deleteInvalidSession(sessionId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/invalid`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
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
  const searchParams = new URLSearchParams();
  if (params?.status) {
    searchParams.set('status', params.status);
  }
  if (params?.type) {
    searchParams.set('type', params.type);
  }
  if (params?.limit !== undefined) {
    searchParams.set('limit', String(params.limit));
  }
  if (params?.offset !== undefined) {
    searchParams.set('offset', String(params.offset));
  }

  const queryString = searchParams.toString();
  const url = queryString ? `${API_BASE}/jobs?${queryString}` : `${API_BASE}/jobs`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch jobs: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchJobStats(): Promise<JobStats> {
  const res = await fetch(`${API_BASE}/jobs/stats`);
  if (!res.ok) {
    throw new Error(`Failed to fetch job stats: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchJob(jobId: string): Promise<Job> {
  const res = await fetch(`${API_BASE}/jobs/${jobId}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch job: ${res.statusText}`);
  }
  return res.json();
}

export async function retryJob(jobId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/jobs/${jobId}/retry`, {
    method: 'POST',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to retry job');
  }
}

export async function cancelJob(jobId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/jobs/${jobId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to cancel job');
  }
}

// ===========================================================================
// Repository Default Branch
// ===========================================================================

export async function refreshDefaultBranch(repositoryId: string): Promise<RefreshDefaultBranchResponse> {
  const res = await fetch(`${API_BASE}/repositories/${repositoryId}/refresh-default-branch`, {
    method: 'POST',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to refresh default branch');
  }
  return res.json();
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
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/pr-link`);
  if (!res.ok) {
    throw new Error(`Failed to fetch session PR link: ${res.statusText}`);
  }
  return res.json();
}

// ===========================================================================
// Server ID
// ===========================================================================

export interface ServerIdResponse {
  serverId: string;
}

/**
 * Fetch the server instance ID.
 * This ID is unique per server process and is used to detect server restarts.
 * When the server restarts, terminal caches become invalid because the server
 * loses its in-memory history buffers.
 */
export async function fetchServerId(): Promise<ServerIdResponse> {
  const res = await fetch(`${API_BASE}/server/id`);
  if (!res.ok) {
    throw new Error(`Failed to fetch server ID: ${res.statusText}`);
  }
  return res.json();
}
