import { Hono } from 'hono';
import * as v from 'valibot';
import type {
  GitHubIssueSummary,
  CloneRepositoryResponse,
  CloneJobStatusResponse,
  DeleteRepositoryRequest,
} from '@agent-console/shared';
import {
  CreateRepositoryRequestSchema,
  CloneRepositoryRequestSchema,
  DeleteRepositoryRequestSchema,
  UpdateRepositoryRequestSchema,
  FetchGitHubIssueRequestSchema,
  RepositorySlackIntegrationInputSchema,
} from '@agent-console/shared';
import { CLAUDE_CODE_AGENT_ID } from '../services/agent-manager.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { vValidator } from '../middleware/validation.js';
import { getRemoteUrl, parseOrgRepo, fetchAllRemote, getCommitsBehind, getCommitsAhead, GitError, fetchRemote } from '../lib/git.js';
import { withRepositoryRemote } from '../lib/repository-remote.js';
import { createLogger } from '../lib/logger.js';
import type { AppBindings } from '../app-context.js';
import {
  CloneValidationError,
  CloneNameConflictError,
} from '../services/repository-clone-service.js';

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
  // Clone a repository and register it. Returns 202 Accepted with a jobId;
  // the client polls GET /api/repositories/clone/:jobId for the final
  // status. The clone runs as the authenticated user via the
  // privilege-elevation helper when AUTH_MODE=multi-user.
  .post('/clone', vValidator(CloneRepositoryRequestSchema), async (c) => {
    const body = c.req.valid('json');
    const { repositoryCloneService } = c.get('appContext');
    const authUser = c.get('authUser');

    try {
      const jobId = await repositoryCloneService.enqueueClone({
        url: body.url,
        name: body.name,
        description: body.description,
        requestUser: authUser.username,
      });
      logger.info(
        { jobId, requestUser: authUser.username },
        'Clone job enqueued',
      );
      const response: CloneRepositoryResponse = { jobId, repositoryId: null };
      return c.json(response, 202);
    } catch (error) {
      if (error instanceof CloneNameConflictError) {
        throw new ConflictError(error.message);
      }
      if (error instanceof CloneValidationError) {
        throw new ValidationError(error.message);
      }
      throw error;
    }
  })
  // Poll the status of a previously-enqueued clone job.
  // Returns 404 if the jobId is unknown (e.g., expired or never existed).
  .get('/clone/:jobId', async (c) => {
    const jobId = c.req.param('jobId');
    const { repositoryCloneService } = c.get('appContext');
    const state = repositoryCloneService.getJob(jobId);
    if (!state) {
      throw new NotFoundError('Clone job');
    }
    const response: CloneJobStatusResponse = {
      jobId: state.id,
      status: state.status,
      ...(state.repositoryId ? { repositoryId: state.repositoryId } : {}),
      ...(state.error ? { error: state.error } : {}),
    };
    return c.json(response);
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
    const authUser = c.get('authUser');

    // Parse the DELETE body manually because `vValidator` would 400 on a
    // missing body / missing Content-Type. The schema's default makes an
    // absent `removeSourceRepo` field equivalent to `false`. We
    // differentiate three states explicitly so malformed JSON cannot fall
    // through to the default-false path silently:
    //   - empty / whitespace-only body -> default ({})
    //   - non-empty body parseable as JSON -> validate via schema
    //   - non-empty body that fails JSON.parse -> 400 ValidationError
    const rawText = await c.req.text();
    let raw: unknown = {};
    if (rawText.trim() !== '') {
      try {
        raw = JSON.parse(rawText) as unknown;
      } catch {
        throw new ValidationError('Invalid JSON body');
      }
    }
    const parseResult = v.safeParse(DeleteRepositoryRequestSchema, raw);
    if (!parseResult.success) {
      const firstIssue = parseResult.issues[0];
      throw new ValidationError(firstIssue?.message ?? 'Validation failed');
    }
    const parsed: DeleteRepositoryRequest = parseResult.output;

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

    // Thread the authenticated username so the CLEANUP_REPOSITORY job can
    // elevate the recursive `rm` to that user under multi-user mode
    // (worktree subtrees are owned by the requesting user). Forward
    // `removeSourceRepo` so the cleanup job optionally removes the
    // source-repo clone in addition to the data subtree.
    const success = await repositoryManager.unregisterRepository(
      repoId,
      authUser.username,
      { removeSourceRepo: parsed.removeSourceRepo },
    );

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
    const authUser = c.get('authUser');
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
      // Thread the authenticated username so multi-user mode runs the agent's
      // headless command (e.g. `claude -p ...`) as the requesting user via
      // `runAsUser`. In single-user mode `runAsUser` bypasses sudo because
      // the username matches the server-process user.
      const result = await generateRepositoryDescription({
        repositoryPath: repo.path,
        agent,
        requestUser: authUser.username,
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
    const { repositoryManager, fetchGitHubIssue } = c.get('appContext');
    const authUser = c.get('authUser');
    const repo = repositoryManager.getRepository(repoId);

    if (!repo) {
      throw new NotFoundError('Repository');
    }

    const body = c.req.valid('json');

    try {
      // Thread the authenticated OS username so multi-user mode runs
      // `gh api` as the requesting user (with that user's per-user gh
      // auth token). In single-user mode `runAsUser` bypasses elevation.
      const issue: GitHubIssueSummary = await fetchGitHubIssue(
        body.reference,
        repo.path,
        authUser.username,
      );
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
    const authUser = c.get('authUser');
    const repo = repositoryManager.getRepository(repoId);

    if (!repo) {
      throw new NotFoundError('Repository');
    }

    // Thread the authenticated username so multi-user mode runs the git
    // invocations as the requesting user. The user's PATH, ~/.gitconfig,
    // and SSH_AUTH_SOCK are picked up from their login shell via `sudo -i`;
    // without this elevation the server's `agentconsole` identity has no
    // SSH credentials and hits `dubious ownership` against user-owned
    // source repos.
    const branches = await worktreeService.listBranches(repo.path, authUser.username);
    return c.json(branches);
  })
  // Refresh default branch from remote for a repository
  .post('/:id/refresh-default-branch', async (c) => {
    const repoId = c.req.param('id');
    const { repositoryManager, worktreeService } = c.get('appContext');
    const authUser = c.get('authUser');
    const repo = repositoryManager.getRepository(repoId);

    if (!repo) {
      throw new NotFoundError('Repository');
    }

    try {
      // Same rationale as GET /:id/branches above — the network
      // `git remote set-head` runs as the requesting user so SSH-using git
      // can authenticate.
      const defaultBranch = await worktreeService.refreshDefaultBranch(repo.path, authUser.username);
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
    const authUser = c.get('authUser');
    const repo = repositoryManager.getRepository(repoId);

    if (!repo) {
      throw new NotFoundError('Repository');
    }

    try {
      // Thread the authenticated username so multi-user mode runs the network
      // fetch as the requesting user (picks up their SSH_AUTH_SOCK / gitconfig
      // via sudo -i); otherwise SSH-URL remotes fail with Permission denied.
      await fetchRemote(branch, repo.path, authUser.username);

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
    const authUser = c.get('authUser');
    const repo = repositoryManager.getRepository(repoId);

    if (!repo) {
      throw new NotFoundError('Repository');
    }

    try {
      // Same rationale as the per-branch remote-status fetch above — elevate
      // the network fetch so SSH-URL remotes authenticate as the user.
      await fetchAllRemote(repo.path, authUser.username);
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
