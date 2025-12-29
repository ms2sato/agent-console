import { Hono } from 'hono';
import { homedir } from 'node:os';
import { resolve as resolvePath, dirname, sep as pathSep } from 'node:path';
import { stat } from 'node:fs/promises';
import open from 'open';
import { validateSessionPath } from '../lib/path-validator.js';
import { getRepositoriesDir } from '../lib/config.js';
import type {
  CreateWorktreeRequest,
  CreateAgentRequest,
  UpdateAgentRequest,
  CreateSessionRequest,
  UpdateSessionRequest,
  CreateWorkerRequest,
  RestartWorkerRequest,
  CreateRepositoryRequest,
  UpdateRepositoryRequest,
  SystemOpenRequest,
  BranchNameFallback,
  Repository,
  SetupCommandResult,
  FetchGitHubIssueRequest,
  GitHubIssueSummary,
} from '@agent-console/shared';
import {
  CreateSessionRequestSchema,
  UpdateSessionRequestSchema,
  CreateWorkerRequestSchema,
  RestartWorkerRequestSchema,
  CreateRepositoryRequestSchema,
  UpdateRepositoryRequestSchema,
  CreateWorktreeRequestSchema,
  FetchGitHubIssueRequestSchema,
  CreateAgentRequestSchema,
  UpdateAgentRequestSchema,
  SystemOpenRequestSchema,
} from '@agent-console/shared';
import { getSessionManager } from '../services/session-manager.js';
import { getRepositoryManager } from '../services/repository-manager.js';
import { worktreeService } from '../services/worktree-service.js';
import { getAgentManager, CLAUDE_CODE_AGENT_ID } from '../services/agent-manager.js';
import { suggestSessionMetadata } from '../services/session-metadata-suggester.js';
import { createSessionValidationService } from '../services/session-validation-service.js';
import { fetchGitHubIssue } from '../services/github-issue-service.js';
import { fetchPullRequestUrl } from '../services/github-pr-service.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { validateBody, getValidatedBody } from '../middleware/validation.js';
import { getRemoteUrl, parseOrgRepo, getOrgRepoFromPath } from '../lib/git.js';
import { createLogger } from '../lib/logger.js';
import { getJobQueue, JOB_STATUSES, type JobRecord, type JobStatus } from '../jobs/index.js';

const logger = createLogger('api');

/**
 * Transform a JobRecord from database format (snake_case) to API response format (camelCase).
 * Also parses the payload JSON string.
 */
interface JobResponse {
  id: string;
  type: string;
  payload: unknown;
  status: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: number;
  lastError: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

function toJobResponse(job: JobRecord): JobResponse {
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(job.payload);
  } catch (error) {
    // Log warning and include parse error indicator for debugging
    logger.warn({ jobId: job.id, err: error }, 'Failed to parse job payload');
    parsedPayload = { _parseError: true, raw: job.payload };
  }

  return {
    id: job.id,
    type: job.type,
    payload: parsedPayload,
    status: job.status,
    priority: job.priority,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    nextRetryAt: job.next_retry_at,
    lastError: job.last_error,
    createdAt: job.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
  };
}

const api = new Hono();

async function withRepositoryRemote(repository: Repository): Promise<Repository> {
  const remoteUrl = await getRemoteUrl(repository.path);
  return {
    ...repository,
    remoteUrl: remoteUrl ?? undefined,
  };
}

// API info
api.get('/', (c) => {
  return c.json({ message: 'Agent Console API' });
});

// Get server config
api.get('/config', (c) => {
  return c.json({ homeDir: homedir() });
});

// Validate all sessions
api.get('/sessions/validate', async (c) => {
  const sessionManager = getSessionManager();
  const validationService = createSessionValidationService(sessionManager.getSessionRepository());
  const response = await validationService.validateAllSessions();
  return c.json(response);
});

// Delete an invalid session (removes from persistence without trying to stop workers)
api.delete('/sessions/:id/invalid', async (c) => {
  const sessionId = c.req.param('id');
  const sessionManager = getSessionManager();
  const deleted = await sessionManager.forceDeleteSession(sessionId);
  if (!deleted) {
    throw new NotFoundError('Session');
  }
  return c.json({ success: true });
});

// Get a single session
api.get('/sessions/:id', async (c) => {
  const sessionId = c.req.param('id');
  const sessionManager = getSessionManager();

  // First check if session is active
  const session = sessionManager.getSession(sessionId);
  if (session) {
    return c.json({ session });
  }

  // Check persisted metadata for inactive sessions
  const metadata = await sessionManager.getSessionMetadata(sessionId);
  if (metadata) {
    // Return persisted data with inactive status
    return c.json({
      session: {
        ...metadata,
        status: 'inactive',
      },
    });
  }

  throw new NotFoundError('Session');
});

// Create a new session
api.post('/sessions', validateBody(CreateSessionRequestSchema), async (c) => {
  const body = getValidatedBody<CreateSessionRequest>(c);

  // Validate that locationPath is safe and exists
  const validation = await validateSessionPath(body.locationPath);
  if (!validation.valid) {
    throw new ValidationError(validation.error || 'Invalid path');
  }

  const sessionManager = getSessionManager();
  const session = await sessionManager.createSession(body);

  return c.json({ session }, 201);
});

// Delete a session
api.delete('/sessions/:id', async (c) => {
  const sessionId = c.req.param('id');
  const sessionManager = getSessionManager();
  const success = await sessionManager.deleteSession(sessionId);

  if (!success) {
    throw new NotFoundError('Session');
  }

  return c.json({ success: true });
});

// Update session metadata (title and/or branch)
// If branch is changed, agent worker is automatically restarted
api.patch('/sessions/:id', validateBody(UpdateSessionRequestSchema), async (c) => {
  const sessionId = c.req.param('id');
  const body = getValidatedBody<UpdateSessionRequest>(c);
  const { title, branch } = body;

  const updates: { title?: string; branch?: string } = {};
  if (title !== undefined) {
    updates.title = title.trim();
  }
  if (branch !== undefined) {
    updates.branch = branch.trim();
  }

  const sessionManager = getSessionManager();
  const result = await sessionManager.updateSessionMetadata(sessionId, updates);

  if (!result.success) {
    if (result.error === 'session_not_found') {
      throw new NotFoundError('Session');
    }
    throw new ValidationError(result.error || 'Failed to update session');
  }

  return c.json({
    success: true,
    ...(result.title !== undefined && { title: result.title }),
    ...(result.branch !== undefined && { branch: result.branch }),
  });
});

// Get workers for a session
api.get('/sessions/:sessionId/workers', async (c) => {
  const sessionId = c.req.param('sessionId');
  const sessionManager = getSessionManager();
  const session = sessionManager.getSession(sessionId);

  if (!session) {
    throw new NotFoundError('Session');
  }

  return c.json({ workers: session.workers });
});

// Get branches for a session's repository
api.get('/sessions/:sessionId/branches', async (c) => {
  const sessionId = c.req.param('sessionId');
  const sessionManager = getSessionManager();
  const session = sessionManager.getSession(sessionId);

  if (!session) {
    throw new NotFoundError('Session');
  }

  const branches = await worktreeService.listBranches(session.locationPath);
  return c.json(branches);
});

// Get commits created in this branch (since base commit)
api.get('/sessions/:sessionId/commits', async (c) => {
  const sessionId = c.req.param('sessionId');
  const baseRef = c.req.query('base');

  const sessionManager = getSessionManager();
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    throw new NotFoundError('Session');
  }

  if (!baseRef) {
    throw new ValidationError('base query parameter is required');
  }

  const { getBranchCommits } = await import('../lib/git.js');
  const commits = await getBranchCommits(baseRef, session.locationPath);
  return c.json({ commits });
});

// Get PR link for a session (worktree sessions only)
api.get('/sessions/:sessionId/pr-link', async (c) => {
  const sessionId = c.req.param('sessionId');
  const sessionManager = getSessionManager();
  const session = sessionManager.getSession(sessionId);

  if (!session) {
    throw new NotFoundError('Session');
  }

  if (session.type !== 'worktree') {
    throw new ValidationError('PR link is only available for worktree sessions');
  }

  const branchName = session.worktreeId;
  const orgRepo = await getOrgRepoFromPath(session.locationPath);

  const prUrl = await fetchPullRequestUrl(branchName, session.locationPath);

  return c.json({
    prUrl,
    branchName,
    orgRepo,
  });
});

// Create a worker in a session
api.post('/sessions/:sessionId/workers', validateBody(CreateWorkerRequestSchema), async (c) => {
  const sessionId = c.req.param('sessionId');
  const body = getValidatedBody<CreateWorkerRequest>(c);

  const sessionManager = getSessionManager();
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    throw new NotFoundError('Session');
  }

  // Extract continueConversation (terminal workers always support PTY)
  const continueConversation = body.continueConversation === true;

  const worker = await sessionManager.createWorker(sessionId, body, continueConversation);

  if (!worker) {
    throw new ValidationError('Failed to create worker');
  }

  return c.json({ worker }, 201);
});

// Delete a worker
api.delete('/sessions/:sessionId/workers/:workerId', async (c) => {
  const sessionId = c.req.param('sessionId');
  const workerId = c.req.param('workerId');

  const sessionManager = getSessionManager();
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    throw new NotFoundError('Session');
  }

  const success = await sessionManager.deleteWorker(sessionId, workerId);
  if (!success) {
    throw new NotFoundError('Worker');
  }

  return c.json({ success: true });
});

// Restart an agent worker
api.post('/sessions/:sessionId/workers/:workerId/restart', validateBody(RestartWorkerRequestSchema), async (c) => {
  const sessionId = c.req.param('sessionId');
  const workerId = c.req.param('workerId');
  const body = getValidatedBody<RestartWorkerRequest>(c);
  const { continueConversation = false } = body;

  const sessionManager = getSessionManager();
  const worker = await sessionManager.restartAgentWorker(sessionId, workerId, continueConversation);

  if (!worker) {
    throw new NotFoundError('Worker');
  }

  return c.json({ worker });
});

// Get diff data for a git-diff worker
api.get('/sessions/:sessionId/workers/:workerId/diff', async (c) => {
  const sessionId = c.req.param('sessionId');
  const workerId = c.req.param('workerId');

  const sessionManager = getSessionManager();
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    throw new NotFoundError('Session');
  }

  const worker = session.workers.find(w => w.id === workerId);
  if (!worker) {
    throw new NotFoundError('Worker');
  }

  if (worker.type !== 'git-diff') {
    throw new ValidationError('Worker is not a git-diff worker');
  }

  const { getDiffData } = await import('../services/git-diff-service.js');
  const diffData = await getDiffData(session.locationPath, worker.baseCommit);

  return c.json(diffData);
});

// Get diff for a specific file
api.get('/sessions/:sessionId/workers/:workerId/diff/file', async (c) => {
  const sessionId = c.req.param('sessionId');
  const workerId = c.req.param('workerId');
  const filePath = c.req.query('path');

  if (!filePath) {
    throw new ValidationError('path query parameter is required');
  }

  const sessionManager = getSessionManager();
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    throw new NotFoundError('Session');
  }

  const worker = session.workers.find(w => w.id === workerId);
  if (!worker) {
    throw new NotFoundError('Worker');
  }

  if (worker.type !== 'git-diff') {
    throw new ValidationError('Worker is not a git-diff worker');
  }

  const { getFileDiff } = await import('../services/git-diff-service.js');
  const rawDiff = await getFileDiff(session.locationPath, worker.baseCommit, filePath);

  return c.json({ rawDiff });
});

// Get all repositories
api.get('/repositories', async (c) => {
  const repositoryManager = getRepositoryManager();
  const repositories = repositoryManager.getAllRepositories();
  const repositoriesWithRemote = await Promise.all(repositories.map(withRepositoryRemote));
  return c.json({ repositories: repositoriesWithRemote });
});

// Redirect to repository GitHub URL
api.get('/repositories/:id/github', async (c) => {
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

// Register a repository
api.post('/repositories', validateBody(CreateRepositoryRequestSchema), async (c) => {
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

// Unregister a repository
api.delete('/repositories/:id', async (c) => {
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

  const success = await repositoryManager.unregisterRepository(repoId);

  if (!success) {
    // Repository was likely deleted between the check and unregister (race condition)
    throw new NotFoundError('Repository');
  }

  return c.json({ success: true });
});

// Update a repository
api.patch('/repositories/:id', validateBody(UpdateRepositoryRequestSchema), async (c) => {
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

// Get worktrees for a repository
api.get('/repositories/:id/worktrees', async (c) => {
  const repoId = c.req.param('id');
  const repositoryManager = getRepositoryManager();
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    throw new NotFoundError('Repository');
  }

  const worktrees = await worktreeService.listWorktrees(repo.path, repoId);
  return c.json({ worktrees });
});

// Fetch a GitHub issue for a repository
api.post('/repositories/:id/github-issue', validateBody(FetchGitHubIssueRequestSchema), async (c) => {
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

// Create a worktree
api.post('/repositories/:id/worktrees', validateBody(CreateWorktreeRequestSchema), async (c) => {
  const repoId = c.req.param('id');
  const repositoryManager = getRepositoryManager();
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    throw new NotFoundError('Repository');
  }

  const body = getValidatedBody<CreateWorktreeRequest>(c);
  const { mode, autoStartSession, agentId, initialPrompt, title } = body;

  let branch: string;
  let baseBranch: string | undefined;
  let effectiveTitle: string | undefined = title;
  let branchNameFallback: BranchNameFallback | undefined;

  // Get the agent for branch name generation (if prompt mode)
  const selectedAgentId = agentId || CLAUDE_CODE_AGENT_ID;
  const agentManager = await getAgentManager();
  const agent = agentManager.getAgent(selectedAgentId);
  if (!agent) {
    throw new ValidationError(`Agent not found: ${selectedAgentId}`);
  }

  switch (mode) {
    case 'prompt':
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
    case 'custom':
      branch = body.branch!;
      baseBranch = body.baseBranch || await worktreeService.getDefaultBranch(repo.path) || 'main';
      break;
    case 'existing':
      branch = body.branch!;
      baseBranch = undefined;
      break;
  }

  const result = await worktreeService.createWorktree(repo.path, branch, baseBranch);

  if (result.error) {
    throw new ValidationError(result.error);
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

  return c.json({ worktree, session, branchNameFallback, setupCommandResult }, 201);
});

// Delete a worktree
api.delete('/repositories/:id/worktrees/*', async (c) => {
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

// Get branches for a repository
api.get('/repositories/:id/branches', async (c) => {
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
api.post('/repositories/:id/refresh-default-branch', async (c) => {
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

// Get all agents
api.get('/agents', async (c) => {
  const agentManager = await getAgentManager();
  const agents = agentManager.getAllAgents();
  return c.json({ agents });
});

// Get a single agent
api.get('/agents/:id', async (c) => {
  const agentId = c.req.param('id');
  const agentManager = await getAgentManager();
  const agent = agentManager.getAgent(agentId);

  if (!agent) {
    throw new NotFoundError('Agent');
  }

  return c.json({ agent });
});

// Register a new agent
api.post('/agents', validateBody(CreateAgentRequestSchema), async (c) => {
  const body = getValidatedBody<CreateAgentRequest>(c);
  const agentManager = await getAgentManager();

  const agent = await agentManager.registerAgent(body);

  return c.json({ agent }, 201);
});

// Update an agent
api.patch('/agents/:id', validateBody(UpdateAgentRequestSchema), async (c) => {
  const agentId = c.req.param('id');
  const body = getValidatedBody<UpdateAgentRequest>(c);
  const agentManager = await getAgentManager();

  const agent = await agentManager.updateAgent(agentId, body);

  if (!agent) {
    throw new NotFoundError('Agent');
  }

  return c.json({ agent });
});

// Delete an agent
api.delete('/agents/:id', async (c) => {
  const agentId = c.req.param('id');
  const agentManager = await getAgentManager();

  // Check if agent exists
  const agent = agentManager.getAgent(agentId);
  if (!agent) {
    throw new NotFoundError('Agent');
  }

  // Built-in agents cannot be deleted
  if (agent.isBuiltIn) {
    throw new ValidationError('Built-in agents cannot be deleted');
  }

  // Check if agent is in use by any active sessions
  const sessionManager = getSessionManager();
  const activeSessions = sessionManager.getSessionsUsingAgent(agentId);
  const activeSessionIds = new Set(activeSessions.map(s => s.id));

  // Also check persisted (inactive) sessions
  const persistedSessions = await sessionManager.getAllPersistedSessions();
  const inactiveSessions = persistedSessions.filter(ps =>
    !activeSessionIds.has(ps.id) &&
    ps.workers.some(w => w.type === 'agent' && w.agentId === agentId)
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
      `Agent is in use by ${totalCount} session(s)${details}: ${allNames}`
    );
  }

  const success = await agentManager.unregisterAgent(agentId);

  if (!success) {
    // Agent was likely deleted between the check and unregister (race condition)
    // Return 404 for idempotent behavior
    throw new NotFoundError('Agent');
  }

  return c.json({ success: true });
});

// Open a file or directory in the default application (Finder/Explorer)
api.post('/system/open', validateBody(SystemOpenRequestSchema), async (c) => {
  const { path } = getValidatedBody<SystemOpenRequest>(c);

  // Resolve to absolute path
  const absolutePath = resolvePath(path);

  try {
    // Check if path exists and get stats in one call
    const stats = await stat(absolutePath);
    // For files, open the containing directory
    if (stats.isFile()) {
      // Open the parent directory
      await open(dirname(absolutePath));
    } else {
      // Open the directory directly
      await open(absolutePath);
    }
    return c.json({ success: true });
  } catch (error) {
    // ENOENT means path does not exist
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new NotFoundError('Path');
    }
    const message = error instanceof Error ? error.message : 'Failed to open path';
    throw new ValidationError(message);
  }
});

// ===========================================================================
// Job Queue Management
// ===========================================================================

// Get jobs with optional filtering and pagination
api.get('/jobs', async (c) => {
  const statusParam = c.req.query('status');
  const type = c.req.query('type');
  const limitParam = c.req.query('limit');
  const offsetParam = c.req.query('offset');

  // Validate status parameter
  let status: JobStatus | undefined;
  if (statusParam) {
    if (!JOB_STATUSES.includes(statusParam as JobStatus)) {
      throw new ValidationError(`status must be one of: ${JOB_STATUSES.join(', ')}`);
    }
    status = statusParam as JobStatus;
  }

  const limit = limitParam ? parseInt(limitParam, 10) : 50;
  const offset = offsetParam ? parseInt(offsetParam, 10) : 0;

  // Validate limit and offset
  if (isNaN(limit) || limit < 1 || limit > 1000) {
    throw new ValidationError('limit must be a number between 1 and 1000');
  }
  if (isNaN(offset) || offset < 0) {
    throw new ValidationError('offset must be a non-negative number');
  }

  const jobQueue = getJobQueue();
  const jobs = await jobQueue.getJobs({ status, type, limit, offset });
  const total = await jobQueue.countJobs({ status, type });

  return c.json({
    jobs: jobs.map(toJobResponse),
    total,
  });
});

// Get job statistics
api.get('/jobs/stats', async (c) => {
  const jobQueue = getJobQueue();
  const stats = await jobQueue.getStats();
  return c.json(stats);
});

// Get a single job by ID
api.get('/jobs/:id', async (c) => {
  const jobId = c.req.param('id');
  const jobQueue = getJobQueue();
  const job = await jobQueue.getJob(jobId);

  if (!job) {
    throw new NotFoundError('Job');
  }

  return c.json(toJobResponse(job));
});

// Retry a stalled job
api.post('/jobs/:id/retry', async (c) => {
  const jobId = c.req.param('id');
  const jobQueue = getJobQueue();

  // Use atomic operation - retryJob only succeeds for stalled jobs
  const success = await jobQueue.retryJob(jobId);
  if (!success) {
    // Re-fetch to provide accurate error message (avoids TOCTOU race condition)
    const job = await jobQueue.getJob(jobId);
    if (!job) {
      throw new NotFoundError('Job');
    }
    // Job exists but has wrong status
    throw new ValidationError('Only stalled jobs can be retried');
  }

  return c.json({ success: true });
});

// Cancel a pending or stalled job
api.delete('/jobs/:id', async (c) => {
  const jobId = c.req.param('id');
  const jobQueue = getJobQueue();

  // Use atomic operation - cancelJob only succeeds for pending or stalled jobs
  const success = await jobQueue.cancelJob(jobId);
  if (!success) {
    // Re-fetch to provide accurate error message (avoids TOCTOU race condition)
    const job = await jobQueue.getJob(jobId);
    if (!job) {
      throw new NotFoundError('Job');
    }
    // Job exists but has wrong status
    throw new ValidationError('Only pending or stalled jobs can be canceled');
  }

  return c.json({ success: true });
});

export { api };
