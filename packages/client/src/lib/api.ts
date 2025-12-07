import type {
  Session,
  Repository,
  Worktree,
  CreateWorktreeRequest,
  AgentDefinition,
  CreateAgentRequest,
  UpdateAgentRequest,
} from '@agent-console/shared';

const API_BASE = '/api';

// ========== Config API ==========

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

// ========== Sessions API ==========

export interface SessionsResponse {
  sessions: Session[];
}

export interface CreateSessionResponse {
  session: Session;
}

export async function fetchSessions(): Promise<SessionsResponse> {
  const res = await fetch(`${API_BASE}/sessions`);
  if (!res.ok) {
    throw new Error(`Failed to fetch sessions: ${res.statusText}`);
  }
  return res.json();
}

export async function createSession(
  worktreePath?: string,
  repositoryId?: string,
  continueConversation: boolean = false,
  agentId?: string
): Promise<CreateSessionResponse> {
  const res = await fetch(`${API_BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ worktreePath, repositoryId, continueConversation, agentId }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to create session');
  }
  return res.json();
}

export interface SessionMetadata {
  id: string;
  worktreePath: string;
  repositoryId: string;
  isActive: boolean;
  branch: string;
}

export class ServerUnavailableError extends Error {
  constructor() {
    super('Server is unavailable');
    this.name = 'ServerUnavailableError';
  }
}

export async function getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
  try {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/metadata`);
    if (res.status === 404) {
      return null;
    }
    // 500/502/503/504 likely means server is down (Vite proxy returns 500 when backend is unavailable)
    if (res.status >= 500) {
      throw new ServerUnavailableError();
    }
    if (!res.ok) {
      throw new Error(`Failed to get session metadata: ${res.statusText}`);
    }
    return res.json();
  } catch (error) {
    // Network error - server is likely down
    // TypeError is thrown when fetch fails due to network issues
    if (error instanceof TypeError) {
      throw new ServerUnavailableError();
    }
    throw error;
  }
}

export async function restartSession(
  sessionId: string,
  continueConversation: boolean = false,
  agentId?: string
): Promise<CreateSessionResponse> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/restart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ continueConversation, agentId }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to restart session');
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

export interface RenameBranchResponse {
  success: boolean;
  branch: string;
}

export async function renameSessionBranch(
  sessionId: string,
  newBranch: string
): Promise<RenameBranchResponse> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/branch`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newBranch }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || 'Failed to rename branch');
  }
  return res.json();
}

// ========== Repositories API ==========

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

// ========== Worktrees API ==========

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

// ========== Agents API ==========

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
