import { Hono } from 'hono';
import { resolve as resolvePath, sep as pathSep } from 'node:path';
import { stat } from 'node:fs/promises';
import type {
  BranchNameFallback,
} from '@agent-console/shared';
import { CreateWorktreeRequestSchema, PullWorktreeRequestSchema } from '@agent-console/shared';
import type { AppBindings } from '../app-context.js';
import { getRepositoriesDir } from '../lib/config.js';
import { worktreeService } from '../services/worktree-service.js';
import { CLAUDE_CODE_AGENT_ID } from '../services/agent-manager.js';
import { suggestSessionMetadata } from '../services/session-metadata-suggester.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { vValidator } from '../middleware/validation.js';
import { getCurrentBranch, isWorkingDirectoryClean, pullFastForward } from '../lib/git.js';
import { createLogger } from '../lib/logger.js';
import { broadcastToApp } from '../websocket/routes.js';
import {
  _getDeletionsInProgress,
  isDeletionInProgress,
  deleteWorktree,
} from '../services/worktree-deletion-service.js';
import { createWorktreeWithSession } from '../services/worktree-creation-service.js';
import { findOpenPullRequest } from '../services/github-pr-service.js';

export { _getDeletionsInProgress };

const logger = createLogger('api:worktrees');

// Guard against concurrent pull of the same worktree
const pullsInProgress = new Set<string>();

/** Get the pull guard set. Exported for testing only. */
export function _getPullsInProgress(): Set<string> {
  return pullsInProgress;
}

const worktrees = new Hono<AppBindings>()
  // Get worktrees for a repository
  .get('/:id/worktrees', async (c) => {
    const repoId = c.req.param('id');
    const { repositoryManager } = c.get('appContext');
    const repo = repositoryManager.getRepository(repoId);

    if (!repo) {
      throw new NotFoundError('Repository');
    }

    const worktrees = await worktreeService.listWorktrees(repo.path, repoId);
    return c.json({ worktrees });
  })
  // Create a worktree (async - returns immediately and broadcasts result via WebSocket)
  .post('/:id/worktrees', vValidator(CreateWorktreeRequestSchema), async (c) => {
    const repoId = c.req.param('id');
    const { repositoryManager, sessionManager, agentManager } = c.get('appContext');
    const repo = repositoryManager.getRepository(repoId);

    if (!repo) {
      throw new NotFoundError('Repository');
    }

    const body = c.req.valid('json');
    const authUser = c.get('authUser');
    const { taskId, mode, autoStartSession, agentId, initialPrompt, title } = body;

    // Validate agent exists before returning accepted (fail fast for invalid config)
    const selectedAgentId = agentId || CLAUDE_CODE_AGENT_ID;
    const agent = agentManager.getAgent(selectedAgentId);
    if (!agent) {
      throw new ValidationError(`Agent not found: ${selectedAgentId}`);
    }

    // Execute worktree creation in background (fire-and-forget)
    // This promise is intentionally not awaited
    (async () => {
      try {
        let branch: string;
        let baseBranch: string | undefined;
        let effectiveTitle: string | undefined = title;
        let branchNameFallback: BranchNameFallback | undefined;

        // Extract useRemote flag (only available for 'prompt' and 'custom' modes)
        const useRemote = (mode === 'prompt' || mode === 'custom') && body.useRemote !== false;

        switch (mode) {
          case 'prompt': {
            // Generate branch name from prompt using the selected agent
            const suggestion = await suggestSessionMetadata({
              prompt: body.initialPrompt!.trim(),
              repositoryPath: repo.path,
              agent,
            });
            if (suggestion.error || !suggestion.branch) {
              // Fallback: use timestamp-based branch name, empty title
              branch = `task-${Date.now()}`;
              branchNameFallback = {
                usedBranch: branch,
                reason: suggestion.error || 'Failed to generate branch name',
              };
            } else {
              branch = suggestion.branch;
              // Use generated title if user didn't provide one
              effectiveTitle = title ?? suggestion.title;
            }
            baseBranch = body.baseBranch || await worktreeService.getDefaultBranch(repo.path) || 'main';
            break;
          }
          case 'custom':
            branch = body.branch!;
            baseBranch = body.baseBranch || await worktreeService.getDefaultBranch(repo.path) || 'main';
            break;
          case 'existing':
            branch = body.branch!;
            baseBranch = undefined;
            break;
          default: {
            // Exhaustiveness check - compile error if new mode is added
            const _exhaustive: never = mode;
            throw new Error(`Unhandled branch mode: ${_exhaustive}`);
          }
        }

        const result = await createWorktreeWithSession({
          repoPath: repo.path,
          repoId,
          repoName: repo.name,
          setupCommand: repo.setupCommand,
          branch,
          baseBranch,
          useRemote,
          agentId: selectedAgentId,
          initialPrompt,
          title: effectiveTitle,
          createdBy: authUser.id,
          autoStartSession,
        }, sessionManager);

        if (!result.success) {
          broadcastToApp({
            type: 'worktree-creation-failed',
            taskId,
            error: result.error!,
          });
          return;
        }

        if (result.worktree) {
          broadcastToApp({
            type: 'worktree-creation-completed',
            taskId,
            worktree: result.worktree,
            session: result.session ?? null,
            branchNameFallback,
            setupCommandResult: result.setupCommandResult,
            fetchFailed: result.fetchFailed || undefined,
            fetchError: result.fetchError,
          });
          logger.info({ taskId, repoId, branch: result.worktree.branch }, 'Worktree creation completed');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error during worktree creation';
        logger.error({ taskId, repoId, error: errorMessage }, 'Worktree creation failed');
        broadcastToApp({
          type: 'worktree-creation-failed',
          taskId,
          error: errorMessage,
        });
      }
    })();

    // Return accepted immediately (do not wait for worktree creation)
    return c.json({ accepted: true }, 202);
  })
  // Pull a worktree (git pull --ff-only, async)
  .post('/:id/worktrees/pull', vValidator(PullWorktreeRequestSchema), async (c) => {
    const repoId = c.req.param('id');
    const { repositoryManager } = c.get('appContext');
    const repo = repositoryManager.getRepository(repoId);

    if (!repo) {
      throw new NotFoundError('Repository');
    }

    const { worktreePath: rawWorktreePath, taskId } = c.req.valid('json');

    // Canonicalize both paths to prevent path traversal and ensure consistent comparison.
    // Both worktreePath and repo.path must be normalized so that string equality is reliable.
    const worktreePath = resolvePath(rawWorktreePath);
    const normalizedRepoPath = resolvePath(repo.path);
    const isMain = worktreePath === normalizedRepoPath;

    // For non-primary worktrees, enforce boundary check and ownership verification.
    // Primary worktree (repo root) may reside outside the managed worktrees directory,
    // so boundary check applies only to non-primary worktrees.
    if (!isMain) {
      const repositoriesDir = getRepositoriesDir();
      if (!worktreePath.startsWith(repositoriesDir + pathSep)) {
        throw new ValidationError('Worktree path is outside managed directory');
      }

      if (!await worktreeService.isWorktreeOf(repo.path, worktreePath, repoId)) {
        throw new ValidationError('Invalid worktree path for this repository');
      }
    }

    // Validate worktree directory exists before proceeding
    try {
      await stat(worktreePath);
    } catch {
      throw new ValidationError('Worktree directory does not exist');
    }

    // Reject pull if the worktree is currently being deleted
    if (isDeletionInProgress(worktreePath)) {
      return c.json({ error: 'Worktree is being deleted' }, 409);
    }

    // Reject pull on detached HEAD (no upstream to pull from)
    const currentBranch = await getCurrentBranch(worktreePath);
    if (currentBranch === '(detached)' || currentBranch === '(unknown)') {
      throw new ValidationError('Cannot pull in detached HEAD state');
    }

    // Guard against concurrent pull of the same worktree.
    // Placed after validation so invalid requests don't block the guard.
    // No await between .has() and .add() ensures atomicity in single-threaded runtime.
    if (pullsInProgress.has(worktreePath)) {
      return c.json({ error: 'Pull already in progress' }, 409);
    }

    pullsInProgress.add(worktreePath);

    // Execute pull in background (fire-and-forget)
    (async () => {
      try {
        // Check working directory is clean
        const clean = await isWorkingDirectoryClean(worktreePath);
        if (!clean) {
          broadcastToApp({
            type: 'worktree-pull-failed',
            taskId,
            worktreePath,
            error: 'Working directory has uncommitted changes. Please commit or stash your changes first.',
          });
          return;
        }

        // Get current branch for the success message
        const branch = await getCurrentBranch(worktreePath);

        // Execute git pull --ff-only
        const commitsPulled = await pullFastForward(worktreePath);

        broadcastToApp({
          type: 'worktree-pull-completed',
          taskId,
          worktreePath,
          branch,
          commitsPulled,
        });
        logger.info({ taskId, repoId, worktreePath, branch, commitsPulled }, 'Worktree pull completed');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error during pull';
        logger.error({ taskId, repoId, worktreePath, error: errorMessage }, 'Worktree pull failed');

        try {
          broadcastToApp({
            type: 'worktree-pull-failed',
            taskId,
            worktreePath,
            error: errorMessage,
          });
        } catch {
          // If broadcast fails, we've already logged the error above
        }
      } finally {
        pullsInProgress.delete(worktreePath);
      }
    })();

    // Return accepted immediately
    return c.json({ accepted: true }, 202);
  })
  // Delete a worktree
  // Optionally accepts taskId query parameter for async WebSocket notification
  .delete('/:id/worktrees/*', async (c) => {
    const repoId = c.req.param('id');
    const { repositoryManager, sessionManager } = c.get('appContext');

    // Get worktree path from URL (everything after /worktrees/)
    const url = new URL(c.req.url);
    const pathMatch = url.pathname.match(/\/worktrees\/(.+)$/);
    const rawWorktreePath = pathMatch ? decodeURIComponent(pathMatch[1]) : '';

    if (!rawWorktreePath) {
      throw new ValidationError('worktree path is required');
    }

    // Canonicalize path (transport-specific: raw URL path parsing)
    const worktreePath = resolvePath(rawWorktreePath);

    // Reject deletion while pull is in progress (transport-specific: REST-only concern)
    if (pullsInProgress.has(worktreePath)) {
      return c.json({ error: 'Pull is in progress for this worktree' }, 409);
    }

    const force = c.req.query('force') === 'true';
    const taskId = c.req.query('taskId');

    // Pre-check concurrency guard before branching into async/sync paths.
    // The service also acquires the guard internally (defense in depth),
    // but this check preserves the original behavior of returning HTTP 409
    // for the async path instead of accepting and then broadcasting failure.
    if (isDeletionInProgress(worktreePath)) {
      return c.json({ error: 'Deletion already in progress' }, 409);
    }

    const deletionDeps = { sessionManager, repositoryManager, findOpenPullRequest, getCurrentBranch };

    // If taskId is provided, handle deletion asynchronously
    if (taskId) {
      // Execute deletion in background (fire-and-forget)
      (async () => {
        try {
          const result = await deleteWorktree({ repoId, worktreePath, force }, deletionDeps);

          // Use first session ID for backward-compatible WebSocket broadcast
          const broadcastSessionId = result.sessionIds?.[0] || '';

          if (!result.success) {
            broadcastToApp({
              type: 'worktree-deletion-failed',
              taskId,
              sessionId: broadcastSessionId,
              error: result.error || 'Failed to remove worktree',
              gitStatus: result.gitStatus,
            });
            logger.error({ taskId, repoId, worktreePath, error: result.error }, 'Worktree deletion failed');
            return;
          }

          broadcastToApp({
            type: 'worktree-deletion-completed',
            taskId,
            sessionId: broadcastSessionId,
            cleanupCommandResult: result.cleanupCommandResult,
          });
          logger.info({ taskId, repoId, worktreePath, sessionIds: result.sessionIds }, 'Worktree and session deletion completed');
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error during worktree deletion';
          logger.error({ taskId, repoId, worktreePath, error: errorMessage }, 'Worktree deletion failed');

          try {
            broadcastToApp({
              type: 'worktree-deletion-failed',
              taskId,
              sessionId: '',
              error: errorMessage,
            });
          } catch {
            // If broadcast fails, we've already logged the error above
          }
        }
      })();

      // Return accepted immediately (do not wait for deletion)
      return c.json({ accepted: true }, 202);
    }

    // Synchronous deletion (backward compatible)
    const result = await deleteWorktree({ repoId, worktreePath, force }, deletionDeps);

    if (!result.success) {
      // Map errorType to appropriate HTTP status
      if (result.errorType === 'conflict' || result.errorType === 'open-pr') {
        return c.json({ error: result.error }, 409);
      }
      if (result.errorType === 'not-found') {
        throw new NotFoundError(result.error || 'Repository');
      }
      throw new ValidationError(result.error || 'Failed to remove worktree');
    }

    return c.json({ success: true, cleanupCommandResult: result.cleanupCommandResult });
  });

export { worktrees };
