import type { CreateWorktreeRequest } from '@agent-console/shared';

/**
 * Status of a worktree creation task (client-side only)
 */
export type WorktreeCreationStatus = 'creating' | 'completed' | 'failed';

/**
 * Worktree creation task managed on the client side.
 * Used to track async worktree creation progress in the UI.
 */
export interface WorktreeCreationTask {
  /** Client-generated UUID for request-response correlation */
  id: string;
  repositoryId: string;
  repositoryName: string;
  status: WorktreeCreationStatus;
  /** Original request data for retry functionality */
  request: CreateWorktreeRequest;
  /** Error message when status is 'failed' */
  error?: string;
  /** Session ID when status is 'completed' (for navigation) */
  sessionId?: string;
  /** Session title when status is 'completed' */
  sessionTitle?: string;
  /** ISO 8601 timestamp */
  createdAt: string;
}
