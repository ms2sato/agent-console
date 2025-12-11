export * from './types/agent.js';
export * from './types/worker.js';
export * from './types/session.js';

export interface Repository {
  id: string;           // UUID
  name: string;         // Display name (directory name)
  path: string;         // Absolute path
  registeredAt: string; // Registration date (ISO 8601)
}

export interface Worktree {
  path: string;         // Worktree absolute path
  branch: string;       // Branch name (dynamically fetched from git)
  isMain: boolean;      // Is main worktree
  repositoryId: string; // Parent repository ID
  index?: number;       // Index number (starting from 1, not assigned to main)
}

export interface CreateRepositoryRequest {
  path: string;
}

interface CreateWorktreeBaseRequest {
  autoStartSession?: boolean;
  agentId?: string;
  /** Initial prompt to send to the agent after starting */
  initialPrompt?: string;
  /** Human-readable title for the session */
  title?: string;
}

interface CreateWorktreePromptRequest extends CreateWorktreeBaseRequest {
  mode: 'prompt';
  /** Required for prompt mode - the prompt to generate branch name from */
  initialPrompt: string;
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
  | CreateWorktreePromptRequest
  | CreateWorktreeCustomRequest
  | CreateWorktreeExistingRequest;

export interface DeleteWorktreeRequest {
  force?: boolean;          // Force delete with session termination
}

export interface ApiError {
  error: string;
  message: string;
}

