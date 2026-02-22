import { Hono } from 'hono';
import { $ } from 'bun';
import { resolve as resolvePath, sep as pathSep } from 'node:path';
import type {
  BranchNameFallback,
  HookCommandResult,
} from '@agent-console/shared';
import { CreateWorktreeRequestSchema } from '@agent-console/shared';
import { getRepositoriesDir } from '../lib/config.js';
import { getSessionManager } from '../services/session-manager.js';
import { getRepositoryManager } from '../services/repository-manager.js';
import { worktreeService } from '../services/worktree-service.js';
import { getAgentManager, CLAUDE_CODE_AGENT_ID } from '../services/agent-manager.js';
import { suggestSessionMetadata } from '../services/session-metadata-suggester.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { vValidator } from '../middleware/validation.js';
import { fetchRemote } from '../lib/git.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('api:worktrees');

// Guard against concurrent deletion of the same worktree
const deletionsInProgress = new Set<string>();

/** Get the deletion guard set. Exported for testing only. */
export function _getDeletionsInProgress(): Set<string> {
  return deletionsInProgress;
}

/**
 * Execute the repository's cleanup command if configured.
 * Looks up the worktree in git listing to resolve template variables.
 *
 * @returns The cleanup command result, or undefined if no cleanup command is configured.
 */
async function executeCleanupCommandIfConfigured(
  repo: { path: string; name: string; cleanupCommand?: string | null },
  repoId: string,
  worktreePath: string
): Promise<HookCommandResult | undefined> {
  if (!repo.cleanupCommand) return undefined;

  const worktrees = await worktreeService.listWorktrees(repo.path, repoId);
  const targetWorktree = worktrees.find(wt => wt.path === worktreePath);
  if (!targetWorktree || targetWorktree.index === undefined) {
    return { success: false, error: 'Cleanup command skipped: worktree not found in git listing' };
  }

  return worktreeService.executeHookCommand(
    repo.cleanupCommand,
    worktreePath,
    {
      worktreeNum: targetWorktree.index,
      branch: targetWorktree.branch,
      repo: repo.name,
    }
  );
}

const worktrees = new Hono()
  // Get worktrees for a repository
  .get('/:id/worktrees', async (c) => {
    const repoId = c.req.param('id');
    const repositoryManager = getRepositoryManager();
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
    const repositoryManager = getRepositoryManager();
    const repo = repositoryManager.getRepository(repoId);

    if (!repo) {
      throw new NotFoundError('Repository');
    }

    const body = c.req.valid('json');
    const { taskId, mode, autoStartSession, agentId, initialPrompt, title } = body;

    // Validate agent exists before returning accepted (fail fast for invalid config)
    const selectedAgentId = agentId || CLAUDE_CODE_AGENT_ID;
    const agentManager = await getAgentManager();
    const agent = agentManager.getAgent(selectedAgentId);
    if (!agent) {
      throw new ValidationError(`Agent not found: ${selectedAgentId}`);
    }

    // Execute worktree creation in background (fire-and-forget)
    // This promise is intentionally not awaited
    (async () => {
      // Import broadcast function lazily to avoid circular dependencies
      // This import is inside the async IIFE to avoid blocking the 202 response
      const { broadcastToApp } = await import('../websocket/routes.js');

      try {
        let branch: string;
        let baseBranch: string | undefined;
        let effectiveTitle: string | undefined = title;
        let branchNameFallback: BranchNameFallback | undefined;

        // Extract useRemote flag (only available for 'prompt' and 'custom' modes)
        const useRemote = (mode === 'prompt' || mode === 'custom') && body.useRemote === true;

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
          const sessionManager = getSessionManager();
          session = await sessionManager.createSession({
            type: 'worktree',
            repositoryId: repoId,
            worktreeId: worktree.branch,
            locationPath: worktree.path,
            agentId: agentId ?? CLAUDE_CODE_AGENT_ID,
            initialPrompt,
            title: effectiveTitle,
          });
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
  // Delete a worktree
  // Optionally accepts taskId query parameter for async WebSocket notification
  .delete('/:id/worktrees/*', async (c) => {
    const repoId = c.req.param('id');
    const repositoryManager = getRepositoryManager();
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

    // SECURITY: Explicit boundary check - worktree path must be within the managed repositories directory
    // This prevents deletion of arbitrary directories even if isWorktreeOf has a bug
    const repositoriesDir = getRepositoriesDir();
    if (!worktreePath.startsWith(repositoriesDir + pathSep)) {
      throw new ValidationError('Worktree path is outside managed directory');
    }

    // Guard against concurrent deletion of the same worktree
    if (deletionsInProgress.has(worktreePath)) {
      return c.json({ error: 'Deletion already in progress' }, 409);
    }

    // Add to guard immediately before any async operations to prevent race conditions
    deletionsInProgress.add(worktreePath);

    // Verify this is actually a worktree of this repository
    try {
      if (!await worktreeService.isWorktreeOf(repo.path, worktreePath, repoId)) {
        deletionsInProgress.delete(worktreePath);
        throw new ValidationError('Invalid worktree path for this repository');
      }
    } catch (error) {
      deletionsInProgress.delete(worktreePath);
      throw error;
    }

    // Check for force flag and taskId in query
    const force = c.req.query('force') === 'true';
    const taskId = c.req.query('taskId');

    // If taskId is provided, handle deletion asynchronously
    if (taskId) {
      // Find the associated session before returning accepted
      const sessionManager = getSessionManager();
      const allSessions = sessionManager.getAllSessions();
      const targetSession = allSessions.find(session => session.locationPath === worktreePath);
      const sessionId = targetSession?.id;

      // Execute deletion in background (fire-and-forget)
      (async () => {
        try {
          // Import broadcast function lazily to avoid circular dependencies
          const { broadcastToApp } = await import('../websocket/routes.js');

          // Execute cleanup command before deletion if configured
          const cleanupCommandResult = await executeCleanupCommandIfConfigured(repo, repoId, worktreePath);

          // Try to remove worktree first
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
            return;
          }

          // Worktree deletion succeeded - now clean up any associated sessions
          if (sessionId) {
            await sessionManager.deleteSession(sessionId);
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

          // Try to broadcast failure - import may have been the cause of the error
          try {
            const { broadcastToApp } = await import('../websocket/routes.js');

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
          deletionsInProgress.delete(worktreePath);
        }
      })();

      // Return accepted immediately (do not wait for deletion)
      return c.json({ accepted: true }, 202);
    }

    // Synchronous deletion (backward compatible)
    try {
      // Execute cleanup command before deletion if configured
      const cleanupCommandResult = await executeCleanupCommandIfConfigured(repo, repoId, worktreePath);

      // Try to remove worktree first
      const result = await worktreeService.removeWorktree(repo.path, worktreePath, force);

      if (!result.success) {
        // Worktree deletion failed - don't touch sessions
        throw new ValidationError(result.error || 'Failed to remove worktree');
      }

      // Worktree deletion succeeded - now clean up any associated sessions
      const sessionManager = getSessionManager();
      const sessions = sessionManager.getAllSessions();
      for (const session of sessions) {
        if (session.locationPath === worktreePath) {
          await sessionManager.deleteSession(session.id);
        }
      }

      return c.json({ success: true, cleanupCommandResult });
    } finally {
      deletionsInProgress.delete(worktreePath);
    }
  });

export { worktrees };
