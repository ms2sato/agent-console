/**
 * Payload for worktree-pull-completed WebSocket message
 */
export interface WorktreePullCompletedPayload {
  /** Client-generated task ID for correlation */
  taskId: string;
  /** The worktree path that was pulled */
  worktreePath: string;
  /** The branch that was pulled */
  branch: string;
  /** Number of new commits pulled (0 if already up to date) */
  commitsPulled: number;
}

/**
 * Payload for worktree-pull-failed WebSocket message
 */
export interface WorktreePullFailedPayload {
  /** Client-generated task ID for correlation */
  taskId: string;
  /** The worktree path where pull failed */
  worktreePath: string;
  /** Human-readable error message */
  error: string;
}
