export * from './types/agent.js';
export * from './types/worker.js';
export * from './types/session.js';
export * from './types/git-diff.js';
export * from './schemas/index.js';
export * from './constants/index.js';

export interface Repository {
  id: string;           // UUID
  name: string;         // Display name (directory name)
  path: string;         // Absolute path
  registeredAt: string; // Registration date (ISO 8601)
  remoteUrl?: string;   // Git remote URL for origin (if available)
}

export interface Worktree {
  path: string;         // Worktree absolute path
  branch: string;       // Branch name (dynamically fetched from git)
  isMain: boolean;      // Is main worktree
  repositoryId: string; // Parent repository ID
  index?: number;       // Index number (starting from 1, not assigned to main)
}

export interface ApiError {
  error: string;
  message: string;
}

/**
 * Information about branch name generation fallback
 * Returned when AI-based branch name generation fails and a fallback name is used
 */
export interface BranchNameFallback {
  /** The fallback branch name that was used (e.g., "task-1702000000000") */
  usedBranch: string;
  /** The error message from the AI agent */
  reason: string;
}
