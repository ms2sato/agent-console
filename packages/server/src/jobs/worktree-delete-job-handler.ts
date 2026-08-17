/**
 * Job handler for the worktree:delete job type.
 *
 * Kept in a dedicated module rather than `jobs/handlers.ts` -- this handler
 * needs `deleteWorktree` from `services/worktree-deletion-service.js` at
 * runtime (a real value import, not `import type`), and that module in turn
 * pulls in `services/session-manager.js`, which imports `JobQueue`'s type
 * from `jobs/index.js`. `jobs/index.js` re-exports `jobs/handlers.js`, so
 * adding the value import directly to `handlers.ts` closes a circular
 * dependency (`handlers.ts` -> `worktree-deletion-service.ts` ->
 * `session-manager.ts` -> `jobs/index.ts` -> `handlers.ts`), which
 * `bun run lint:cycles` (madge) rejects with no allowlist mechanism. This
 * module is intentionally NOT re-exported from `jobs/index.ts`, so no edge
 * leads back to it and the cycle does not close. See job-types.ts for
 * available job types and their payloads.
 */
import type { AppServerMessage, WorktreeDeletePayload } from '@agent-console/shared';
import type { JobQueue } from './job-queue.js';
import { JOB_TYPES } from './job-types.js';
import { createLogger } from '../lib/logger.js';
import {
  deleteWorktree as defaultDeleteWorktree,
  type DeleteWorktreeDeps,
  type DeleteWorktreeFn,
  type DeleteWorktreeResult,
} from '../services/worktree-deletion-service.js';

const logger = createLogger('job-handlers');

/**
 * Dependencies for the worktree:delete job handler.
 *
 * Registered separately from `registerJobHandlers` because `worktreeService`
 * / `sessionManager` / `repositoryManager` / `findOpenPullRequest` /
 * `getCurrentBranch` do not exist yet at the point `registerJobHandlers` is
 * called in `app-context.ts` (early, right after the job queue itself is
 * created). See `INBOUND_EVENT_PROCESS`'s handler in
 * `services/inbound/index.ts` for the same pattern: a separate, later
 * registration call once its dependencies exist. `jobQueue.registerHandler`
 * is just a `Map.set`, so there is no ordering requirement relative to
 * `jobQueue.start()` -- no job of this type can be enqueued until the HTTP
 * route that enqueues it is live, which is after the whole app context has
 * been constructed.
 */
export interface WorktreeDeleteHandlerDeps {
  deletionDeps: DeleteWorktreeDeps;
  broadcastToApp: (msg: AppServerMessage) => void;
  /** Test seam. Defaults to the real `deleteWorktree`. */
  deleteWorktreeImpl?: DeleteWorktreeFn;
}

/**
 * Register the worktree:delete job handler.
 *
 * Line-for-line semantic-preserving translation of the fire-and-forget IIFE
 * this replaces in `routes/worktrees.ts`: same result branches, same
 * broadcast payload fields, same logging. The one intentional
 * behavioral addition is that both failure branches now `throw` instead of
 * returning / falling off the end, so the job actually reaches `stalled`
 * with `last_error` set (`maxAttempts: 1` at enqueue time means this happens
 * on the very first failure, no retry).
 */
/**
 * Broadcasts a message, swallowing any error the broadcast itself throws.
 *
 * Used at every `broadcastToApp` call site in this handler so a broadcast
 * failure never corrupts the job's own success/failure outcome -- e.g.
 * replacing the deletion error being thrown right after it, or turning a
 * successful deletion into a thrown/stalled job.
 */
function safeBroadcast(broadcastToApp: (msg: AppServerMessage) => void, msg: AppServerMessage): void {
  try {
    broadcastToApp(msg);
  } catch {
    // If broadcast fails, we've already logged the error above
  }
}

export function registerWorktreeDeleteJobHandler(
  jobQueue: JobQueue,
  deps: WorktreeDeleteHandlerDeps,
): void {
  const deleteWorktreeImpl = deps.deleteWorktreeImpl ?? defaultDeleteWorktree;

  jobQueue.registerHandler<WorktreeDeletePayload>(
    JOB_TYPES.WORKTREE_DELETE,
    async (payload) => {
      const { jobId: taskId, repoId, worktreePath, force, requestUsername } = payload;

      let result: DeleteWorktreeResult;
      try {
        result = await deleteWorktreeImpl({ repoId, worktreePath, force, requestUsername }, deps.deletionDeps);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error during worktree deletion';
        logger.error({ taskId, repoId, worktreePath, error: errorMessage }, 'Worktree deletion failed');
        safeBroadcast(deps.broadcastToApp, {
          type: 'worktree-deletion-failed',
          taskId,
          sessionIds: [],
          error: errorMessage,
        });
        throw error instanceof Error ? error : new Error(errorMessage);
      }

      const sessionIds = result.sessionIds ?? [];

      if (!result.success) {
        safeBroadcast(deps.broadcastToApp, {
          type: 'worktree-deletion-failed',
          taskId,
          sessionIds,
          error: result.error || 'Failed to remove worktree',
          gitStatus: result.gitStatus,
        });
        logger.error({ taskId, repoId, worktreePath, error: result.error }, 'Worktree deletion failed');
        // Throw so the job queue marks this job stalled with last_error set
        // (maxAttempts: 1 means this happens on the first failure, no retry).
        throw new Error(result.error || 'Failed to remove worktree');
      }

      safeBroadcast(deps.broadcastToApp, {
        type: 'worktree-deletion-completed',
        taskId,
        sessionIds,
        cleanupCommandResult: result.cleanupCommandResult,
        killErrors: result.killErrors,
      });
      logger.info({ taskId, repoId, worktreePath, sessionIds }, 'Worktree and session deletion completed');
    },
  );
}
