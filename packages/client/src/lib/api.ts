import type { Session, Repository, Worktree, CreateWorktreeRequest } from '@agents-web-console/shared';

const API_BASE = '/api';

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
  continueConversation: boolean = false
): Promise<CreateSessionResponse> {
  const res = await fetch(`${API_BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ worktreePath, repositoryId, continueConversation }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create session: ${res.statusText}`);
  }
  return res.json();
}

export interface SessionMetadata {
  id: string;
  worktreePath: string;
  repositoryId: string;
  isActive: boolean;
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
  continueConversation: boolean = false
): Promise<CreateSessionResponse> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/restart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ continueConversation }),
  });
  if (!res.ok) {
    throw new Error(`Failed to restart session: ${res.statusText}`);
  }
  return res.json();
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error(`Failed to delete session: ${res.statusText}`);
  }
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
