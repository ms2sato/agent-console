/**
 * Result of executing a hook command (setup or cleanup) during worktree lifecycle
 */
export interface HookCommandResult {
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
