import { Hono } from 'hono';
import { resolve as resolvePath, sep as pathSep } from 'node:path';
import type {
  CreateRepositoryRequest,
  UpdateRepositoryRequest,
  FetchGitHubIssueRequest,
  GitHubIssueSummary,
  Repository,
  RepositorySlackIntegrationInput,
  CreateWorktreeRequest,
  BranchNameFallback,
  SetupCommandResult,
} from '@agent-console/shared';
import {
  CreateRepositoryRequestSchema,
  UpdateRepositoryRequestSchema,
  FetchGitHubIssueRequestSchema,
  RepositorySlackIntegrationInputSchema,
  CreateWorktreeRequestSchema,
} from '@agent-console/shared';
import { getRepositoriesDir } from '../lib/config.js';
import { getSessionManager } from '../services/session-manager.js';
import { getRepositoryManager } from '../services/repository-manager.js';
import { worktreeService } from '../services/worktree-service.js';
import { getAgentManager, CLAUDE_CODE_AGENT_ID } from '../services/agent-manager.js';
import { suggestSessionMetadata } from '../services/session-metadata-suggester.js';
import {
  getNotificationManager,
  getRepositorySlackIntegration,
  upsertRepositorySlackIntegration,
  deleteRepositorySlackIntegration,
} from '../services/notifications/index.js';
import { fetchGitHubIssue } from '../services/github-issue-service.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { validateBody, getValidatedBody } from '../middleware/validation.js';
import { getRemoteUrl, parseOrgRepo, fetchAllRemote, getCommitsBehind, getCommitsAhead, GitError, fetchRemote } from '../lib/git.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('api:repositories');

const repositories = new Hono();

async function withRepositoryRemote(repository: Repository): Promise<Repository> {
  const remoteUrl = await getRemoteUrl(repository.path);
  return {
    ...repository,
    remoteUrl: remoteUrl ?? undefined,
  };
}

// Get all repositories
repositories.get('/', async (c) => {
  const repositoryManager = getRepositoryManager();
  const repos = repositoryManager.getAllRepositories();
  const repositoriesWithRemote = await Promise.all(repos.map(withRepositoryRemote));
  return c.json({ repositories: repositoriesWithRemote });
});

// Register a repository
repositories.post('/', validateBody(CreateRepositoryRequestSchema), async (c) => {
  const body = getValidatedBody<CreateRepositoryRequest>(c);
  const { path } = body;
  const repositoryManager = getRepositoryManager();

  try {
    const repository = await repositoryManager.registerRepository(path);
    const repositoryWithRemote = await withRepositoryRemote(repository);
    return c.json({ repository: repositoryWithRemote }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new ValidationError(message);
  }
});

// Redirect to repository GitHub URL
repositories.get('/:id/github', async (c) => {
  const repoId = c.req.param('id');
  const repositoryManager = getRepositoryManager();
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    throw new NotFoundError('Repository');
  }

  const remoteUrl = await getRemoteUrl(repo.path);
  if (!remoteUrl) {
    throw new ValidationError('Repository does not have a git remote');
  }
  if (!remoteUrl.includes('github.com')) {
    throw new ValidationError('Repository remote is not GitHub');
  }

  const orgRepo = parseOrgRepo(remoteUrl);
  if (!orgRepo) {
    throw new ValidationError('Failed to parse GitHub repository from remote');
  }

  return c.redirect(`https://github.com/${orgRepo}`, 302);
});

// Get a single repository
repositories.get('/:id', async (c) => {
  const repoId = c.req.param('id');
  const repositoryManager = getRepositoryManager();
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    throw new NotFoundError('Repository');
  }

  const repositoryWithRemote = await withRepositoryRemote(repo);
  return c.json({ repository: repositoryWithRemote });
});

// Unregister a repository
repositories.delete('/:id', async (c) => {
  const repoId = c.req.param('id');
  const repositoryManager = getRepositoryManager();

  // Check if repository exists
  const repo = repositoryManager.getRepository(repoId);
  if (!repo) {
    throw new NotFoundError('Repository');
  }

  // Check if any active sessions use this repository
  const sessionManager = getSessionManager();
  const activeSessions = sessionManager.getSessionsUsingRepository(repoId);
  const activeSessionIds = new Set(activeSessions.map(s => s.id));

  // Also check persisted (inactive) sessions
  const persistedSessions = await sessionManager.getAllPersistedSessions();
  const inactiveSessions = persistedSessions.filter(ps =>
    !activeSessionIds.has(ps.id) &&
    ps.type === 'worktree' && ps.repositoryId === repoId
  );

  const totalCount = activeSessions.length + inactiveSessions.length;
  if (totalCount > 0) {
    const activeNames = activeSessions.map(s => s.title || s.id);
    const inactiveNames = inactiveSessions.map(s => s.title || s.id);
    const allNames = [...activeNames, ...inactiveNames].join(', ');

    const details = activeSessions.length > 0 && inactiveSessions.length > 0
      ? ` (${activeSessions.length} active, ${inactiveSessions.length} inactive)`
      : activeSessions.length > 0 ? ' (active)' : ' (inactive)';

    throw new ConflictError(
      `Repository is in use by ${totalCount} session(s)${details}: ${allNames}`
    );
  }

  // Clean up Slack integration before deleting repository
  // This prevents orphaned integration records in the database
  try {
    await deleteRepositorySlackIntegration(repoId);
  } catch {
    // Ignore errors - integration may not exist, which is fine
    logger.debug({ repositoryId: repoId }, 'No Slack integration to cleanup for repository');
  }

  const success = await repositoryManager.unregisterRepository(repoId);

  if (!success) {
    // Repository was likely deleted between the check and unregister (race condition)
    throw new NotFoundError('Repository');
  }

  return c.json({ success: true });
});

// Update a repository
repositories.patch('/:id', validateBody(UpdateRepositoryRequestSchema), async (c) => {
  const repoId = c.req.param('id');
  const body = getValidatedBody<UpdateRepositoryRequest>(c);
  const repositoryManager = getRepositoryManager();

  const updated = await repositoryManager.updateRepository(repoId, body);

  if (!updated) {
    throw new NotFoundError('Repository');
  }

  const repositoryWithRemote = await withRepositoryRemote(updated);
  return c.json({ repository: repositoryWithRemote });
});

// ===========================================================================
// Worktree Routes
// ===========================================================================

// Get worktrees for a repository
repositories.get('/:id/worktrees', async (c) => {
  const repoId = c.req.param('id');
  const repositoryManager = getRepositoryManager();
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    throw new NotFoundError('Repository');
  }

  const worktrees = await worktreeService.listWorktrees(repo.path, repoId);
  return c.json({ worktrees });
});

// Create a worktree (async - returns immediately and broadcasts result via WebSocket)
repositories.post('/:id/worktrees', validateBody(CreateWorktreeRequestSchema), async (c) => {
  const repoId = c.req.param('id');
  const repositoryManager = getRepositoryManager();
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    throw new NotFoundError('Repository');
  }

  const body = getValidatedBody<CreateWorktreeRequest>(c);
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

      const result = await worktreeService.createWorktree(repo.path, branch, effectiveBaseBranch);

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
      let setupCommandResult: SetupCommandResult | undefined;
      if (repo.setupCommand && worktree && result.index !== undefined) {
        setupCommandResult = await worktreeService.executeSetupCommand(
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
});

// Delete a worktree
repositories.delete('/:id/worktrees/*', async (c) => {
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

  // Verify this is actually a worktree of this repository
  if (!await worktreeService.isWorktreeOf(repo.path, worktreePath)) {
    throw new ValidationError('Invalid worktree path for this repository');
  }

  // Check for force flag in query
  const force = c.req.query('force') === 'true';

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

  return c.json({ success: true });
});

// ===========================================================================
// GitHub Issue Routes
// ===========================================================================

// Fetch a GitHub issue for a repository
repositories.post('/:id/github-issue', validateBody(FetchGitHubIssueRequestSchema), async (c) => {
  const repoId = c.req.param('id');
  const repositoryManager = getRepositoryManager();
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    throw new NotFoundError('Repository');
  }

  const body = getValidatedBody<FetchGitHubIssueRequest>(c);

  try {
    const issue: GitHubIssueSummary = await fetchGitHubIssue(body.reference, repo.path);
    return c.json({ issue });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch GitHub issue';
    throw new ValidationError(message);
  }
});

// ===========================================================================
// Branch Routes
// ===========================================================================

// Get branches for a repository
repositories.get('/:id/branches', async (c) => {
  const repoId = c.req.param('id');
  const repositoryManager = getRepositoryManager();
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    throw new NotFoundError('Repository');
  }

  const branches = await worktreeService.listBranches(repo.path);
  return c.json(branches);
});

// Refresh default branch from remote for a repository
repositories.post('/:id/refresh-default-branch', async (c) => {
  const repoId = c.req.param('id');
  const repositoryManager = getRepositoryManager();
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    throw new NotFoundError('Repository');
  }

  try {
    const defaultBranch = await worktreeService.refreshDefaultBranch(repo.path);
    return c.json({ defaultBranch });
  } catch (error) {
    // Handle git-specific errors (network issues, no remote, etc.)
    // Use name check for compatibility with mocked GitError in tests
    if (error instanceof Error && error.name === 'GitError') {
      throw new ValidationError(`Failed to refresh default branch: ${error.message}`);
    }
    throw error;
  }
});

// Get remote branch status (how far behind/ahead local is from remote)
repositories.get('/:id/branches/:branch/remote-status', async (c) => {
  const repoId = c.req.param('id');
  const branch = c.req.param('branch');
  const repositoryManager = getRepositoryManager();
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    throw new NotFoundError('Repository');
  }

  try {
    // First fetch the specific branch to get latest remote state
    await fetchRemote(branch, repo.path);

    // Then count commits behind and ahead
    const [behind, ahead] = await Promise.all([
      getCommitsBehind(branch, repo.path),
      getCommitsAhead(branch, repo.path),
    ]);

    return c.json({ behind, ahead });
  } catch (error) {
    // Handle git-specific errors (network issues, branch doesn't exist, etc.)
    if (error instanceof GitError) {
      throw new ValidationError(`Failed to get remote status: ${error.message}`);
    }
    throw error;
  }
});

// Fetch all remote branches for a repository
repositories.post('/:id/fetch', async (c) => {
  const repoId = c.req.param('id');
  const repositoryManager = getRepositoryManager();
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    throw new NotFoundError('Repository');
  }

  try {
    await fetchAllRemote(repo.path);
    return c.json({ success: true });
  } catch (error) {
    // Handle git-specific errors (network issues, no remote, etc.)
    if (error instanceof GitError) {
      throw new ValidationError(`Failed to fetch remote: ${error.message}`);
    }
    throw error;
  }
});

// ===========================================================================
// Repository Slack Integration
// ===========================================================================

// Get Slack integration for a repository
repositories.get('/:id/integrations/slack', async (c) => {
  const repositoryId = c.req.param('id');
  const integration = await getRepositorySlackIntegration(repositoryId);

  if (!integration) {
    throw new NotFoundError('Slack integration not found for this repository');
  }

  return c.json(integration);
});

// Create or update Slack integration for a repository
repositories.put(
  '/:id/integrations/slack',
  validateBody(RepositorySlackIntegrationInputSchema),
  async (c) => {
    const repositoryId = c.req.param('id');
    const body = getValidatedBody<RepositorySlackIntegrationInput>(c);

    // Verify repository exists
    const repositoryManager = getRepositoryManager();
    const repo = repositoryManager.getRepository(repositoryId);
    if (!repo) {
      throw new NotFoundError('Repository');
    }

    const integration = await upsertRepositorySlackIntegration(
      repositoryId,
      body.webhookUrl,
      body.enabled
    );

    return c.json(integration);
  }
);

// Delete Slack integration for a repository
repositories.delete('/:id/integrations/slack', async (c) => {
  const repositoryId = c.req.param('id');
  const deleted = await deleteRepositorySlackIntegration(repositoryId);

  if (!deleted) {
    throw new NotFoundError('Slack integration not found for this repository');
  }

  return c.json({ success: true });
});

// Test Slack integration for a repository
repositories.post('/:id/integrations/slack/test', async (c) => {
  const repositoryId = c.req.param('id');

  // Verify repository exists
  const repositoryManager = getRepositoryManager();
  const repo = repositoryManager.getRepository(repositoryId);
  if (!repo) {
    throw new NotFoundError('Repository');
  }

  const notificationManager = getNotificationManager();
  await notificationManager.sendTestNotification(
    repositoryId,
    '🔔 Test notification from Agent Console'
  );
  return c.json({ success: true });
});

export { repositories };
