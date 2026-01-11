import type { CreateWorktreeRequest } from '../schemas/repository.js';
import type { Worker } from './worker.js';
import type { Worktree, BranchNameFallback, SetupCommandResult } from '../index.js';

/**
 * Session information for worktree creation completion.
 * Inlined to avoid circular import with session.ts.
 */
interface WorktreeCreationSessionBase {
  id: string;
  locationPath: string;
  status: 'active' | 'inactive';
  createdAt: string;
  workers: Worker[];
  initialPrompt?: string;
  title?: string;
}

interface WorktreeCreationWorktreeSession extends WorktreeCreationSessionBase {
  type: 'worktree';
  repositoryId: string;
  repositoryName: string;
  worktreeId: string;
}

interface WorktreeCreationQuickSession extends WorktreeCreationSessionBase {
  type: 'quick';
}

type WorktreeCreationSession = WorktreeCreationWorktreeSession | WorktreeCreationQuickSession;

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

/**
 * Payload for worktree-creation-completed WebSocket message
 */
export interface WorktreeCreationCompletedPayload {
  /** Client-generated task ID for correlation */
  taskId: string;
  worktree: Worktree;
  session: WorktreeCreationSession | null;
  /** Present when AI branch name generation failed and fallback was used */
  branchNameFallback?: BranchNameFallback;
  /** Present when setup command was executed */
  setupCommandResult?: SetupCommandResult;
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
