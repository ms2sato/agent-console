import { Hono } from 'hono';
import type {
  GitHubIssueSummary,
} from '@agent-console/shared';
import {
  CreateRepositoryRequestSchema,
  UpdateRepositoryRequestSchema,
  FetchGitHubIssueRequestSchema,
  RepositorySlackIntegrationInputSchema,
} from '@agent-console/shared';
import { CLAUDE_CODE_AGENT_ID } from '../services/agent-manager.js';
import { fetchGitHubIssue } from '../services/github-issue-service.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { vValidator } from '../middleware/validation.js';
import { getRemoteUrl, parseOrgRepo, fetchAllRemote, getCommitsBehind, getCommitsAhead, GitError, fetchRemote } from '../lib/git.js';
import { withRepositoryRemote } from '../lib/repository-remote.js';
import { createLogger } from '../lib/logger.js';
import type { AppBindings } from '../app-context.js';

const logger = createLogger('api:repositories');

// Guard against concurrent description generation for the same repository
const descriptionGenerationsInProgress = new Set<string>();

const repositories = new Hono<AppBindings>()
  // Get all repositories
  .get('/', async (c) => {
    const { repositoryManager } = c.get('appContext');
    const repos = repositoryManager.getAllRepositories();
    const repositoriesWithRemote = await Promise.all(repos.map(withRepositoryRemote));
    return c.json({ repositories: repositoriesWithRemote });
  })
  // Register a repository
  .post('/', vValidator(CreateRepositoryRequestSchema), async (c) => {
    const body = c.req.valid('json');
    const { path, description } = body;
    const { repositoryManager } = c.get('appContext');

    try {
      const repository = await repositoryManager.registerRepository(path, { description });
      const repositoryWithRemote = await withRepositoryRemote(repository);
      return c.json({ repository: repositoryWithRemote }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new ValidationError(message);
    }
  })
  // Redirect to repository GitHub URL
  .get('/:id/github', async (c) => {
    const repoId = c.req.param('id');
    const { repositoryManager } = c.get('appContext');
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
  })
  // Get a single repository
  .get('/:id', async (c) => {
    const repoId = c.req.param('id');
    const { repositoryManager } = c.get('appContext');
    const repo = repositoryManager.getRepository(repoId);

    if (!repo) {
      throw new NotFoundError('Repository');
    }

    const repositoryWithRemote = await withRepositoryRemote(repo);
    return c.json({ repository: repositoryWithRemote });
  })
  // Unregister a repository
  .delete('/:id', async (c) => {
    const repoId = c.req.param('id');
    const { repositoryManager, sessionManager } = c.get('appContext');

    // Check if repository exists
    const repo = repositoryManager.getRepository(repoId);
    if (!repo) {
      throw new NotFoundError('Repository');
    }

    // Check if any active sessions use this repository
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
    const { repositorySlackIntegrationService } = c.get('appContext');
    try {
      await repositorySlackIntegrationService.deleteIntegration(repoId);
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
  })
  // Update a repository
  .patch('/:id', vValidator(UpdateRepositoryRequestSchema), async (c) => {
    const repoId = c.req.param('id');
    const body = c.req.valid('json');
    const { repositoryManager } = c.get('appContext');

    const updated = await repositoryManager.updateRepository(repoId, body);

    if (!updated) {
      throw new NotFoundError('Repository');
    }

    const repositoryWithRemote = await withRepositoryRemote(updated);
    return c.json({ repository: repositoryWithRemote });
  })
  // Generate a repository description using AI
  .post('/:id/generate-description', async (c) => {
    const repoId = c.req.param('id');
    const { repositoryManager, agentManager, generateRepositoryDescription } = c.get('appContext');
    const repo = repositoryManager.getRepository(repoId);

    if (!repo) {
      throw new NotFoundError('Repository');
    }

    // Use the built-in Claude Code agent for description generation
    const agent = agentManager.getAgent(CLAUDE_CODE_AGENT_ID);
    if (!agent) {
      throw new ValidationError('Built-in agent not available');
    }

    if (descriptionGenerationsInProgress.has(repoId)) {
      throw new ValidationError('Description generation already in progress for this repository');
    }

    descriptionGenerationsInProgress.add(repoId);
    try {
      const result = await generateRepositoryDescription({
        repositoryPath: repo.path,
        agent,
      });

      if (result.error) {
        throw new ValidationError(result.error);
      }

      return c.json({ description: result.description });
    } finally {
      descriptionGenerationsInProgress.delete(repoId);
    }
  })
  // ===========================================================================
  // GitHub Issue Routes
  // ===========================================================================
  // Fetch a GitHub issue for a repository
  .post('/:id/github-issue', vValidator(FetchGitHubIssueRequestSchema), async (c) => {
    const repoId = c.req.param('id');
    const { repositoryManager } = c.get('appContext');
    const repo = repositoryManager.getRepository(repoId);

    if (!repo) {
      throw new NotFoundError('Repository');
    }

    const body = c.req.valid('json');

    try {
      const issue: GitHubIssueSummary = await fetchGitHubIssue(body.reference, repo.path);
      return c.json({ issue });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch GitHub issue';
      throw new ValidationError(message);
    }
  })
  // ===========================================================================
  // Branch Routes
  // ===========================================================================
  // Get branches for a repository
  .get('/:id/branches', async (c) => {
    const repoId = c.req.param('id');
    const { repositoryManager, worktreeService } = c.get('appContext');
    const repo = repositoryManager.getRepository(repoId);

    if (!repo) {
      throw new NotFoundError('Repository');
    }

    const branches = await worktreeService.listBranches(repo.path);
    return c.json(branches);
  })
  // Refresh default branch from remote for a repository
  .post('/:id/refresh-default-branch', async (c) => {
    const repoId = c.req.param('id');
    const { repositoryManager, worktreeService } = c.get('appContext');
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
  })
  // Get remote branch status (how far behind/ahead local is from remote)
  .get('/:id/branches/:branch/remote-status', async (c) => {
    const repoId = c.req.param('id');
    const branch = c.req.param('branch');
    const { repositoryManager } = c.get('appContext');
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
  })
  // Fetch all remote branches for a repository
  .post('/:id/fetch', async (c) => {
    const repoId = c.req.param('id');
    const { repositoryManager } = c.get('appContext');
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
  })
  // ===========================================================================
  // Repository Slack Integration
  // ===========================================================================
  // Get Slack integration for a repository
  .get('/:id/integrations/slack', async (c) => {
    const repositoryId = c.req.param('id');
    const { repositorySlackIntegrationService } = c.get('appContext');
    const integration = await repositorySlackIntegrationService.getByRepositoryId(repositoryId);

    if (!integration) {
      throw new NotFoundError('Slack integration not found for this repository');
    }

    return c.json(integration);
  })
  // Create or update Slack integration for a repository
  .put(
    '/:id/integrations/slack',
    vValidator(RepositorySlackIntegrationInputSchema),
    async (c) => {
      const repositoryId = c.req.param('id');
      const body = c.req.valid('json');

      // Verify repository exists
      const { repositoryManager, repositorySlackIntegrationService } = c.get('appContext');
      const repo = repositoryManager.getRepository(repositoryId);
      if (!repo) {
        throw new NotFoundError('Repository');
      }

      const integration = await repositorySlackIntegrationService.upsert(
        repositoryId,
        body.webhookUrl,
        body.enabled
      );

      return c.json(integration);
    }
  )
  // Delete Slack integration for a repository
  .delete('/:id/integrations/slack', async (c) => {
    const repositoryId = c.req.param('id');
    const { repositorySlackIntegrationService } = c.get('appContext');
    const deleted = await repositorySlackIntegrationService.deleteIntegration(repositoryId);

    if (!deleted) {
      throw new NotFoundError('Slack integration not found for this repository');
    }

    return c.json({ success: true });
  })
  // Test Slack integration for a repository
  .post('/:id/integrations/slack/test', async (c) => {
    const repositoryId = c.req.param('id');

    // Verify repository exists
    const { repositoryManager, notificationManager } = c.get('appContext');
    const repo = repositoryManager.getRepository(repositoryId);
    if (!repo) {
      throw new NotFoundError('Repository');
    }

    await notificationManager.sendTestNotification(
      repositoryId,
      '🔔 Test notification from Agent Console'
    );
    return c.json({ success: true });
  });

export { repositories };
