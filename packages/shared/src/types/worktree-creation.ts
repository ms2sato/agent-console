import type { Session } from './session.js';
import type { Worktree, BranchNameFallback, HookCommandResult } from './repository.js';

/**
 * Payload for worktree-creation-completed WebSocket message
 */
export interface WorktreeCreationCompletedPayload {
  /** Client-generated task ID for correlation */
  taskId: string;
  worktree: Worktree;
  /**
   * The full public Session created for the new worktree (null when session
   * creation was skipped). Carries the same shape as sessions-sync entries;
   * clients typically read only `id` / `title` for navigation.
   */
  session: Session | null;
  /** Present when AI branch name generation failed and fallback was used */
  branchNameFallback?: BranchNameFallback;
  /** Present when setup command was executed */
  setupCommandResult?: HookCommandResult;
  /** Present when fetch from remote failed */
  fetchFailed?: boolean;
  fetchError?: string;
}

/**
 * Payload for worktree-creation-failed WebSocket message
 */
export interface WorktreeCreationFailedPayload {
  /** Client-generated task ID for correlation */
  taskId: string;
  error: string;
}
