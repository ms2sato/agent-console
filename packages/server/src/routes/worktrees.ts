import { Hono } from 'hono';
import { resolve as resolvePath, sep as pathSep } from 'node:path';
import { stat } from 'node:fs/promises';
import type {
  BranchNameFallback,
  WorktreeDeletePayload,
} from '@agent-console/shared';
import { CreateWorktreeRequestSchema, PullWorktreeRequestSchema } from '@agent-console/shared';
import type { AppBindings } from '../app-context.js';
import { getRepositoriesDir } from '../lib/config.js';
import { CLAUDE_CODE_AGENT_ID } from '../services/agent-manager.js';
import { InternalError, NotFoundError, ValidationError } from '../lib/errors.js';
import { vValidator } from '../middleware/validation.js';
import { getCurrentBranch, isWorkingDirectoryClean, pullFastForward } from '../lib/git.js';
import { createLogger } from '../lib/logger.js';
import { JOB_TYPES } from '../jobs/index.js';
import {
  _getDeletionsInProgress,
  isDeletionInProgress,
  deleteWorktree,
} from '../services/worktree-deletion-service.js';
import { createWorktreeWithSession } from '../services/worktree-creation-service.js';

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
    const { repositoryManager, worktreeService } = c.get('appContext');
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
    const { repositoryManager, sessionManager, agentManager, agentDirectory, worktreeService, broadcastToApp, suggestSessionMetadata, sharedAccountRegistry } = c.get('appContext');
    const repo = repositoryManager.getRepository(repoId);

    if (!repo) {
      throw new NotFoundError('Repository');
    }

    const body = c.req.valid('json');
    const authUser = c.get('authUser');
    const { taskId, mode, autoStartSession, agentId, embeddedAgentId, model, reasoningEffort, contextWindowTokens, initialPrompt, title } = body;

    // Validate agent exists before returning accepted (fail fast for invalid config).
    // This terminal agent is always resolved -- it drives `suggestSessionMetadata`'s
    // headless branch/title generation in 'prompt' mode regardless of whether the
    // user selected an embedded agent for the actual initial worker (embedded agents
    // have no headless CLI template and can never drive branch-name suggestion).
    const selectedAgentId = agentId || CLAUDE_CODE_AGENT_ID;
    const agent = agentManager.getAgent(selectedAgentId);
    if (!agent) {
      throw new ValidationError(`Agent not found: ${selectedAgentId}`);
    }

    // Validate the embedded agent exists before returning accepted.
    if (embeddedAgentId) {
      const embeddedAgent = agentDirectory.get('embedded', embeddedAgentId)?.agent;
      if (!embeddedAgent) {
        throw new ValidationError(`Embedded agent not found: ${embeddedAgentId}`);
      }
    }

    // Determine worktree/session ownership. For shared sessions, createdBy is
    // the shared account (PTY spawn identity) and initiatedBy is the
    // authenticated user (audit trail); the whole creation pipeline below
    // (git worktree add, useRemote fetch, setup command, headless
    // branch-name suggestion) runs as the shared account via
    // `requestUsername`. For personal sessions, createdBy is the
    // authenticated user, initiatedBy is left undefined, and requestUsername
    // is the authenticated user's OS username. This mirrors
    // POST /api/sessions (see routes/sessions.ts) exactly. Resolved
    // synchronously (before the fire-and-forget block) so an invalid request
    // (feature disabled) fails with 400 instead of a broadcast failure.
    // Does NOT go through `resolveRequestUsername` (services/resolve-spawn-username.ts):
    // the personal branch already has the freshest source (`authUser.username`,
    // no DB round-trip needed), and the shared branch reads a registry cache
    // whose only write path is the one-time startup upsert, so it cannot
    // drift from a fresh `userRepository.findById` lookup.
    let createdBy: string;
    let initiatedBy: string | undefined;
    let requestUsername: string | null;
    if (body.shared === true) {
      if (!sharedAccountRegistry.isEnabled()) {
        throw new ValidationError('Shared sessions are not enabled on this server.');
      }
      const sharedUserId = sharedAccountRegistry.getDefaultUserId();
      const sharedUsername = sharedAccountRegistry.getDefaultUsername();
      if (!sharedUserId || !sharedUsername) {
        // isEnabled() returned true but no default -- unreachable in
        // practice; surface as 500 since it indicates server-side
        // inconsistency, not a client input error.
        throw new InternalError('Shared account registry is enabled but has no default user.');
      }
      createdBy = sharedUserId;
      initiatedBy = authUser.id;
      requestUsername = sharedUsername;
    } else {
      createdBy = authUser.id;
      initiatedBy = undefined;
      requestUsername = authUser.username;
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
            // Thread `requestUsername` down so the headless agent command
            // runs as the requesting user in multi-user mode. For shared
            // sessions this is the shared account's OS username (the whole
            // creation pipeline runs as the shared account, so the
            // suggestion uses the shared account's API-key credentials
            // rather than the human's personal subscription); otherwise it
            // is the authenticated user's OS username. In single-user mode
            // `runAsUser` reads this value but `AUTH_MODE` gates the
            // elevation to a no-op.
            const suggestion = await suggestSessionMetadata({
              prompt: body.initialPrompt!.trim(),
              repositoryPath: repo.path,
              agent,
              requestUser: requestUsername,
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
          agentId: embeddedAgentId ? undefined : selectedAgentId,
          embeddedAgentId,
          model,
          reasoningEffort,
          contextWindowTokens,
          initialPrompt,
          title: effectiveTitle,
          autoStartSession,
          context: { createdBy, initiatedBy },
          // Thread `requestUsername` down to `git worktree add` (and the
          // rest of the creation pipeline) so multi-user installs create the
          // worktree as the requesting user -- or, for shared sessions, as
          // the shared account. In single-user mode, `runAsUser` reads this
          // value but `AUTH_MODE` gates the elevation to a no-op.
          requestUsername,
        }, sessionManager, worktreeService);

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
    })().catch((err) => {
      logger.error({ err, taskId, repoId }, 'Unhandled error in worktree creation');
    });

    // Return accepted immediately (do not wait for worktree creation)
    return c.json({ accepted: true }, 202);
  })
  // Pull a worktree (git pull --ff-only, async)
  .post('/:id/worktrees/pull', vValidator(PullWorktreeRequestSchema), async (c) => {
    const repoId = c.req.param('id');
    const { repositoryManager, worktreeService, broadcastToApp } = c.get('appContext');
    const authUser = c.get('authUser');
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

        // Execute git pull --ff-only. Thread the authenticated OS username so
        // multi-user mode runs the network fetch as the requesting user (picks
        // up their SSH_AUTH_SOCK / gitconfig via the elevation helper);
        // otherwise SSH-URL remotes fail with Permission denied. In single-user
        // mode, `runAsUser` reads this value but `AUTH_MODE` gates the
        // elevation to a no-op.
        const commitsPulled = await pullFastForward(worktreePath, authUser.username);

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
    })().catch((err) => {
      logger.error({ err, taskId, repoId, worktreePath }, 'Unhandled error in worktree pull');
    });

    // Return accepted immediately
    return c.json({ accepted: true }, 202);
  })
  // Optionally accepts taskId query parameter for async WebSocket notification
  .delete('/:id/worktrees/*', async (c) => {
    const repoId = c.req.param('id');
    const { repositoryManager, sessionManager, worktreeService, jobQueue, findOpenPullRequest } = c.get('appContext');
    // Thread the authenticated OS username down to the deletion service so
    // multi-user installs (a) delete the worktree as the worktree-owning
    // user — fixing the `Permission denied` failure when `agentconsole`
    // tries to remove a delegated user's files, and (b) run the
    // `gh pr list` open-PR check under the requesting user's gh auth token.
    // In single-user mode, `runAsUser` reads this value but `AUTH_MODE`
    // gates the elevation to a no-op for both paths.
    const authUser = c.get('authUser');

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
    const asyncMode = c.req.query('async') === 'true';

    // Pre-check concurrency guard before branching into async/sync paths.
    // The service also acquires the guard internally (defense in depth),
    // but this check preserves the original behavior of returning HTTP 409
    // for the async path instead of accepting and then enqueuing a job that
    // would fail anyway.
    if (isDeletionInProgress(worktreePath)) {
      return c.json({ error: 'Deletion already in progress' }, 409);
    }

    const deletionDeps = { worktreeService, sessionManager, repositoryManager, findOpenPullRequest, getCurrentBranch };
    const requestUsername = authUser.username;

    // Async mode: enqueue a durable job instead of running fire-and-forget.
    // GET /api/jobs/:id becomes the recovery path for a client that
    // reloads, misses the broadcast, or opens the task in another tab.
    // maxAttempts: 1 -- deletion must not be silently retried: force
    // semantics, the open-PR check, and a watching user all make a silent
    // second attempt wrong.
    if (asyncMode) {
      const jobId = crypto.randomUUID();
      const payload: WorktreeDeletePayload = { jobId, repoId, worktreePath, force, requestUsername };
      await jobQueue.enqueue(JOB_TYPES.WORKTREE_DELETE, payload, { jobId, maxAttempts: 1 });
      return c.json({ accepted: true, jobId }, 202);
    }

    // Synchronous deletion (backward compatible)
    const result = await deleteWorktree({ repoId, worktreePath, force, requestUsername }, deletionDeps);

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
