/**
 * Status of a worktree deletion task (client-side only)
 */
export type WorktreeDeletionStatus = 'deleting' | 'completed' | 'failed';

/**
 * Worktree deletion task managed on the client side.
 * Used to track async worktree deletion progress in the UI.
 *
 * Note: Only worktree sessions use async deletion with task tracking.
 * Quick sessions are deleted synchronously without task management.
 */
export interface WorktreeDeletionTask {
  /** Client-generated UUID for request-response correlation */
  id: string;
  /** The session being deleted */
  sessionId: string;
  /** Display name for the task */
  sessionTitle: string;
  /** Repository ID for retry */
  repositoryId: string;
  /** Worktree path for retry */
  worktreePath: string;
  status: WorktreeDeletionStatus;
  /** Error message when status is 'failed' */
  error?: string;
  /** Git status output when status is 'failed' */
  gitStatus?: string;
  /** ISO 8601 timestamp */
  createdAt: string;
}

/**
 * Payload for worktree-deletion-completed WebSocket message
 */
export interface WorktreeDeletionCompletedPayload {
  /** Client-generated task ID for correlation */
  taskId: string;
  sessionId: string;
}

/**
 * Payload for worktree-deletion-failed WebSocket message
 */
export interface WorktreeDeletionFailedPayload {
  /** Client-generated task ID for correlation */
  taskId: string;
  sessionId: string;
  error: string;
  /** Git status output to help users understand what files are causing the issue */
  gitStatus?: string;
}
