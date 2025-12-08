// ========== Agent ==========
export * from './types/agent.js';

// ========== Worker ==========
export * from './types/worker.js';

// ========== Session ==========
export * from './types/session.js';

// ========== Repository ==========
export interface Repository {
  id: string;           // UUID
  name: string;         // Display name (directory name)
  path: string;         // Absolute path
  registeredAt: string; // Registration date (ISO 8601)
}

// ========== Worktree ==========
export interface Worktree {
  path: string;         // Worktree absolute path
  branch: string;       // Branch name (dynamically fetched from git)
  isMain: boolean;      // Is main worktree
  repositoryId: string; // Parent repository ID
  index?: number;       // Index number (starting from 1, not assigned to main)
}

// ========== API Request/Response ==========
export interface CreateRepositoryRequest {
  path: string;
}

interface CreateWorktreeBaseRequest {
  autoStartSession?: boolean;
  agentId?: string;
}

interface CreateWorktreeAutoRequest extends CreateWorktreeBaseRequest {
  mode: 'auto';
  baseBranch?: string;
}

interface CreateWorktreeCustomRequest extends CreateWorktreeBaseRequest {
  mode: 'custom';
  branch: string;
  baseBranch?: string;
}

interface CreateWorktreeExistingRequest extends CreateWorktreeBaseRequest {
  mode: 'existing';
  branch: string;
}

export type CreateWorktreeRequest =
  | CreateWorktreeAutoRequest
  | CreateWorktreeCustomRequest
  | CreateWorktreeExistingRequest;

export interface DeleteWorktreeRequest {
  force?: boolean;          // Force delete with session termination
}

// ========== API Response ==========
export interface ApiError {
  error: string;
  message: string;
}
