import { Hono } from 'hono';
import { $ } from 'bun';
import { resolve as resolvePath, sep as pathSep } from 'node:path';
import { stat } from 'node:fs/promises';
import type {
  BranchNameFallback,
  HookCommandResult,
} from '@agent-console/shared';
import { CreateWorktreeRequestSchema, PullWorktreeRequestSchema } from '@agent-console/shared';
import type { AppBindings } from '../app-context.js';
import { getRepositoriesDir } from '../lib/config.js';
import { worktreeService } from '../services/worktree-service.js';
import { CLAUDE_CODE_AGENT_ID } from '../services/agent-manager.js';
import { suggestSessionMetadata } from '../services/session-metadata-suggester.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { vValidator } from '../middleware/validation.js';
import { fetchRemote, getCurrentBranch, isWorkingDirectoryClean, pullFastForward } from '../lib/git.js';
import { createLogger } from '../lib/logger.js';
import { broadcastToApp } from '../websocket/routes.js';
import {
  _getDeletionsInProgress,
  isDeletionInProgress,
  markDeletionInProgress,
  clearDeletionInProgress,
  validateWorktreePath,
  executeCleanupCommandIfConfigured,
} from '../services/worktree-deletion-service.js';
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

        // If useRemote is true, fetch the remote branch first to ensure it's up-to-date,
        // then prefix baseBranch with origin/ to branch from remote
        let effectiveUseRemote = useRemote;
        let fetchFailed = false;
        let fetchError: string | undefined;
        if (useRemote && baseBranch) {
          try {
            // Fetch to ensure origin/<baseBranch> is up-to-date
            await fetchRemote(baseBranch, repo.path);
          } catch (error) {
            // If fetch fails, fall back to local branch
            logger.warn({ repoId, baseBranch, error: error instanceof Error ? error.message : String(error) },
              'Failed to fetch remote branch, falling back to local');
            effectiveUseRemote = false;
            fetchFailed = true;
            fetchError = 'Failed to fetch remote branch, created from local branch instead';
          }
        }
        const effectiveBaseBranch = effectiveUseRemote && baseBranch ? `origin/${baseBranch}` : baseBranch;

        const result = await worktreeService.createWorktree(repo.path, branch, repoId, effectiveBaseBranch);

        if (result.error) {
          // Broadcast failure
          broadcastToApp({
            type: 'worktree-creation-failed',
            taskId,
            error: result.error,
          });
          return;
        }

        // Get the created worktree info
        const worktrees = await worktreeService.listWorktrees(repo.path, repoId);
        const worktree = worktrees.find(wt => wt.path === result.worktreePath);

        // Execute setup command if configured
        let setupCommandResult: HookCommandResult | undefined;
        if (repo.setupCommand && worktree && result.index !== undefined) {
          setupCommandResult = await worktreeService.executeHookCommand(
            repo.setupCommand,
            result.worktreePath,
            {
              worktreeNum: result.index,
              branch: worktree.branch,
              repo: repo.name,
            }
          );
        }

        // Optionally start a session
        let session = null;
        if (autoStartSession && worktree) {
          session = await sessionManager.createSession({
            type: 'worktree',
            repositoryId: repoId,
            worktreeId: worktree.branch,
            locationPath: worktree.path,
            agentId: agentId ?? CLAUDE_CODE_AGENT_ID,
            initialPrompt,
            title: effectiveTitle,
          }, { createdBy: authUser.id });
        }

        // Broadcast success
        if (worktree) {
          broadcastToApp({
            type: 'worktree-creation-completed',
            taskId,
            worktree,
            session,
            branchNameFallback,
            setupCommandResult,
            fetchFailed: fetchFailed || undefined,
            fetchError,
          });
          logger.info({ taskId, repoId, branch: worktree.branch }, 'Worktree creation completed');
        } else {
          // This shouldn't happen, but handle gracefully
          broadcastToApp({
            type: 'worktree-creation-failed',
            taskId,
            error: 'Worktree created but not found in list',
          });
          logger.error({ taskId, repoId, worktreePath: result.worktreePath }, 'Worktree created but not found in list');
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
    const repo = repositoryManager.getRepository(repoId);

    if (!repo) {
      throw new NotFoundError('Repository');
    }

    // Get worktree path from URL (everything after /worktrees/)
    const url = new URL(c.req.url);
    const pathMatch = url.pathname.match(/\/worktrees\/(.+)$/);
    const rawWorktreePath = pathMatch ? decodeURIComponent(pathMatch[1]) : '';

    if (!rawWorktreePath) {
      throw new ValidationError('worktree path is required');
    }

    // Canonicalize path to prevent path traversal attacks
    const worktreePath = resolvePath(rawWorktreePath);

    // Reject deletion while pull is in progress
    if (pullsInProgress.has(worktreePath)) {
      return c.json({ error: 'Pull is in progress for this worktree' }, 409);
    }

    // Check for force flag and taskId in query (needed by PR check message)
    const force = c.req.query('force') === 'true';
    const taskId = c.req.query('taskId');

    // Validate path is within managed directory and belongs to this repository.
    // This MUST run before any git operations (getCurrentBranch, findOpenPullRequest)
    // to prevent arbitrary paths from reaching git commands.
    const validationError = await validateWorktreePath(repo.path, worktreePath, repoId);
    if (validationError) {
      throw new ValidationError(validationError);
    }

    // Check for open PRs on the branch before acquiring concurrency guard.
    // This avoids holding the guard during a potentially slow network call.
    // Skip the check when force=true to allow forced deletion regardless of PR state.
    if (!force) {
      const branchForPrCheck = await getCurrentBranch(worktreePath);
      if (branchForPrCheck && branchForPrCheck !== '(detached)' && branchForPrCheck !== '(unknown)') {
        try {
          const openPr = await findOpenPullRequest(branchForPrCheck, repo.path);
          if (openPr) {
            throw new ValidationError(
              `WARNING: Cannot remove worktree. Branch '${branchForPrCheck}' has open PR #${openPr.number}. Merge or close the PR first, then retry.`,
            );
          }
        } catch (error) {
          if (error instanceof ValidationError) {
            throw error;
          }
          // findOpenPullRequest threw — fail-closed: block deletion
          throw new ValidationError(
            `Failed to check for open PRs: ${error instanceof Error ? error.message : String(error)}. Cannot proceed with deletion.`,
          );
        }
      }
    }

    // Guard against concurrent deletion — markDeletionInProgress is the single
    // atomic gate so no await can sneak in between a read-check and a write.
    if (!markDeletionInProgress(worktreePath)) {
      return c.json({ error: 'Deletion already in progress' }, 409);
    }

    // If taskId is provided, handle deletion asynchronously
    if (taskId) {
      // Find the associated session before returning accepted
      const allSessions = sessionManager.getAllSessions();
      const targetSession = allSessions.find(session => session.locationPath === worktreePath);
      const sessionId = targetSession?.id;

      // Execute deletion in background (fire-and-forget)
      (async () => {
        try {
          // Execute cleanup command before deletion if configured
          const cleanupCommandResult = await executeCleanupCommandIfConfigured(repo, repoId, worktreePath);

          // Kill PTY processes first to release worktree directory handles (cwd)
          if (sessionId) {
            sessionManager.killSessionWorkers(sessionId);
          }

          // Remove worktree after PTY processes are terminated
          const result = await worktreeService.removeWorktree(repo.path, worktreePath, force);

          if (!result.success) {
            // Worktree deletion failed - capture git status for diagnostics
            let gitStatus: string | undefined;
            try {
              const gitStatusResult = await $`git -C ${worktreePath} status`.quiet();
              gitStatus = gitStatusResult.stdout.toString();
            } catch {
              // If git status fails, just omit the field
            }

            broadcastToApp({
              type: 'worktree-deletion-failed',
              taskId,
              sessionId: sessionId || '',
              error: result.error || 'Failed to remove worktree',
              gitStatus,
            });
            logger.error({ taskId, repoId, worktreePath, error: result.error }, 'Worktree deletion failed');
            // Do NOT delete session here — preserve it for retry
            return;
          }

          // Clean up session after successful worktree removal
          if (sessionId) {
            try {
              await sessionManager.deleteSession(sessionId);
            } catch (error) {
              logger.error({ taskId, repoId, worktreePath, sessionId, error }, 'Failed to delete session after worktree removal');
            }
          }

          broadcastToApp({
            type: 'worktree-deletion-completed',
            taskId,
            sessionId: sessionId || '',
            cleanupCommandResult,
          });
          logger.info({ taskId, repoId, worktreePath, sessionId }, 'Worktree and session deletion completed');
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error during worktree deletion';
          logger.error({ taskId, repoId, worktreePath, error: errorMessage }, 'Worktree deletion failed');

          // Try to broadcast failure
          try {
            // Capture git status for diagnostics
            let gitStatus: string | undefined;
            try {
              const gitStatusResult = await $`git -C ${worktreePath} status`.quiet();
              gitStatus = gitStatusResult.stdout.toString();
            } catch {
              // If git status fails, just omit the field
            }

            broadcastToApp({
              type: 'worktree-deletion-failed',
              taskId,
              sessionId: sessionId || '',
              error: errorMessage,
              gitStatus,
            });
          } catch {
            // If broadcast fails, we've already logged the error above
          }
        } finally {
          clearDeletionInProgress(worktreePath);
        }
      })();

      // Return accepted immediately (do not wait for deletion)
      return c.json({ accepted: true }, 202);
    }

    // Synchronous deletion (backward compatible)
    try {
      // Execute cleanup command before deletion if configured
      const cleanupCommandResult = await executeCleanupCommandIfConfigured(repo, repoId, worktreePath);

      // Kill PTY processes first to release worktree directory handles (cwd)
      const sessions = sessionManager.getAllSessions();
      const matchingSessions = sessions.filter(session => session.locationPath === worktreePath);
      for (const session of matchingSessions) {
        sessionManager.killSessionWorkers(session.id);
      }

      // Remove worktree after PTY processes are terminated
      const result = await worktreeService.removeWorktree(repo.path, worktreePath, force);

      if (!result.success) {
        throw new ValidationError(result.error || 'Failed to remove worktree');
      }

      // Clean up sessions after successful worktree removal
      for (const session of matchingSessions) {
        try {
          await sessionManager.deleteSession(session.id);
        } catch (error) {
          logger.error({ repoId, worktreePath, sessionId: session.id, error }, 'Failed to delete session after worktree removal');
        }
      }

      return c.json({ success: true, cleanupCommandResult });
    } finally {
      clearDeletionInProgress(worktreePath);
    }
  });

export { worktrees };
