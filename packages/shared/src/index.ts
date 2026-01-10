export * from './types/agent.js';
export * from './types/worker.js';
export * from './types/session.js';
export * from './types/worktree-creation.js';
export * from './types/git-diff.js';
export * from './types/job.js';
export * from './schemas/index.js';
export * from './constants/index.js';

export interface Repository {
  id: string;           // UUID
  name: string;         // Display name (directory name)
  path: string;         // Absolute path
  createdAt: string;    // Creation date (ISO 8601)
  remoteUrl?: string;   // Git remote URL for origin (if available)
  setupCommand?: string | null; // Shell command to run after creating worktrees
  envVars?: string | null; // Environment variables in .env format (applied to workers)
}

/**
 * Result of executing a setup command after worktree creation
 */
export interface SetupCommandResult {
  success: boolean;
  output?: string;
  error?: string;
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
