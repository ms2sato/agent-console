import { Hono } from 'hono';
import { homedir } from 'node:os';
import { resolve as resolvePath, dirname } from 'node:path';
import { access, stat } from 'node:fs/promises';
import open from 'open';
import type {
  CreateWorktreeRequest,
  CreateAgentRequest,
  UpdateAgentRequest,
  CreateSessionRequest,
  UpdateSessionRequest,
  CreateWorkerRequest,
  RestartWorkerRequest,
  CreateRepositoryRequest,
} from '@agent-console/shared';
import {
  CreateSessionRequestSchema,
  UpdateSessionRequestSchema,
  CreateWorkerRequestSchema,
  RestartWorkerRequestSchema,
  CreateRepositoryRequestSchema,
  CreateWorktreeRequestSchema,
  CreateAgentRequestSchema,
  UpdateAgentRequestSchema,
} from '@agent-console/shared';
import { sessionManager } from '../services/session-manager.js';
import { repositoryManager } from '../services/repository-manager.js';
import { worktreeService } from '../services/worktree-service.js';
import { agentManager, CLAUDE_CODE_AGENT_ID } from '../services/agent-manager.js';
import { suggestSessionMetadata } from '../services/session-metadata-suggester.js';
import { sessionValidationService } from '../services/session-validation-service.js';
import { persistenceService } from '../services/persistence-service.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { validateBody, getValidatedBody } from '../middleware/validation.js';

const api = new Hono();

// API info
api.get('/', (c) => {
  return c.json({ message: 'Agent Console API' });
});

// Get server config
api.get('/config', (c) => {
  return c.json({ homeDir: homedir() });
});

// Get all sessions
api.get('/sessions', (c) => {
  const sessions = sessionManager.getAllSessions();
  return c.json({ sessions });
});

// Validate all sessions
api.get('/sessions/validate', async (c) => {
  const response = await sessionValidationService.validateAllSessions();
  return c.json(response);
});

// Delete an invalid session (removes from persistence without trying to stop workers)
api.delete('/sessions/:id/invalid', (c) => {
  const sessionId = c.req.param('id');

  // Try to delete via sessionManager first (handles active sessions)
  const deleted = sessionManager.deleteSession(sessionId);
  if (deleted) {
    return c.json({ success: true });
  }

  // If not found in sessionManager, try direct removal from persistence
  // This handles orphaned sessions that exist only in sessions.json
  const metadata = persistenceService.getSessionMetadata(sessionId);
  if (!metadata) {
    throw new NotFoundError('Session');
  }

  persistenceService.removeSession(sessionId);
  return c.json({ success: true });
});

// Get a single session
api.get('/sessions/:id', (c) => {
  const sessionId = c.req.param('id');

  // First check if session is active
  const session = sessionManager.getSession(sessionId);
  if (session) {
    return c.json({ session });
  }

  // Check persisted metadata for inactive sessions
  const metadata = sessionManager.getSessionMetadata(sessionId);
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

  // Validate that locationPath exists
  const absolutePath = resolvePath(body.locationPath);
  try {
    await access(absolutePath);
  } catch {
    throw new ValidationError(`Path does not exist: ${body.locationPath}`);
  }

  const session = sessionManager.createSession(body);

  return c.json({ session }, 201);
});

// Delete a session
api.delete('/sessions/:id', (c) => {
  const sessionId = c.req.param('id');
  const success = sessionManager.deleteSession(sessionId);

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
api.get('/sessions/:sessionId/workers', (c) => {
  const sessionId = c.req.param('sessionId');
  const session = sessionManager.getSession(sessionId);

  if (!session) {
    throw new NotFoundError('Session');
  }

  return c.json({ workers: session.workers });
});

// Get branches for a session's repository
api.get('/sessions/:sessionId/branches', async (c) => {
  const sessionId = c.req.param('sessionId');
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

// Create a worker in a session
api.post('/sessions/:sessionId/workers', validateBody(CreateWorkerRequestSchema), async (c) => {
  const sessionId = c.req.param('sessionId');
  const body = getValidatedBody<CreateWorkerRequest>(c);

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
api.delete('/sessions/:sessionId/workers/:workerId', (c) => {
  const sessionId = c.req.param('sessionId');
  const workerId = c.req.param('workerId');

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    throw new NotFoundError('Session');
  }

  const success = sessionManager.deleteWorker(sessionId, workerId);
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

  const worker = sessionManager.restartAgentWorker(sessionId, workerId, continueConversation);

  if (!worker) {
    throw new NotFoundError('Worker');
  }

  return c.json({ worker });
});

// Get diff data for a git-diff worker
api.get('/sessions/:sessionId/workers/:workerId/diff', async (c) => {
  const sessionId = c.req.param('sessionId');
  const workerId = c.req.param('workerId');

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
api.get('/repositories', (c) => {
  const repositories = repositoryManager.getAllRepositories();
  return c.json({ repositories });
});

// Register a repository
api.post('/repositories', validateBody(CreateRepositoryRequestSchema), async (c) => {
  const body = getValidatedBody<CreateRepositoryRequest>(c);
  const { path } = body;

  try {
    const repository = await repositoryManager.registerRepository(path);
    return c.json({ repository }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new ValidationError(message);
  }
});

// Unregister a repository
api.delete('/repositories/:id', async (c) => {
  const repoId = c.req.param('id');
  const success = await repositoryManager.unregisterRepository(repoId);

  if (!success) {
    throw new NotFoundError('Repository');
  }

  return c.json({ success: true });
});

// Get worktrees for a repository
api.get('/repositories/:id/worktrees', async (c) => {
  const repoId = c.req.param('id');
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    throw new NotFoundError('Repository');
  }

  const worktrees = await worktreeService.listWorktrees(repo.path, repoId);
  return c.json({ worktrees });
});

// Create a worktree
api.post('/repositories/:id/worktrees', validateBody(CreateWorktreeRequestSchema), async (c) => {
  const repoId = c.req.param('id');
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    throw new NotFoundError('Repository');
  }

  const body = getValidatedBody<CreateWorktreeRequest>(c);
  const { mode, autoStartSession, agentId, initialPrompt, title } = body;

  let branch: string;
  let baseBranch: string | undefined;
  let effectiveTitle: string | undefined = title;

  // Get the agent for branch name generation (if prompt mode)
  const selectedAgentId = agentId || CLAUDE_CODE_AGENT_ID;
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

  // Optionally start a session
  let session = null;
  if (autoStartSession && worktree) {
    session = sessionManager.createSession({
      type: 'worktree',
      repositoryId: repoId,
      worktreeId: worktree.branch,
      locationPath: worktree.path,
      agentId: agentId ?? CLAUDE_CODE_AGENT_ID,
      initialPrompt,
      title: effectiveTitle,
    });
  }

  return c.json({ worktree, session }, 201);
});

// Delete a worktree
api.delete('/repositories/:id/worktrees/*', async (c) => {
  const repoId = c.req.param('id');
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
  const sessions = sessionManager.getAllSessions();
  for (const session of sessions) {
    if (session.locationPath === worktreePath) {
      sessionManager.deleteSession(session.id);
    }
  }

  return c.json({ success: true });
});

// Get branches for a repository
api.get('/repositories/:id/branches', async (c) => {
  const repoId = c.req.param('id');
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    throw new NotFoundError('Repository');
  }

  const branches = await worktreeService.listBranches(repo.path);
  return c.json(branches);
});

// Get all agents
api.get('/agents', (c) => {
  const agents = agentManager.getAllAgents();
  return c.json({ agents });
});

// Get a single agent
api.get('/agents/:id', (c) => {
  const agentId = c.req.param('id');
  const agent = agentManager.getAgent(agentId);

  if (!agent) {
    throw new NotFoundError('Agent');
  }

  return c.json({ agent });
});

// Register a new agent
api.post('/agents', validateBody(CreateAgentRequestSchema), async (c) => {
  const body = getValidatedBody<CreateAgentRequest>(c);
  const { name, command, description, icon, activityPatterns } = body;

  const agent = agentManager.registerAgent({
    name,
    command,
    description,
    icon,
    activityPatterns,
  });

  return c.json({ agent }, 201);
});

// Update an agent
api.patch('/agents/:id', validateBody(UpdateAgentRequestSchema), async (c) => {
  const agentId = c.req.param('id');
  const body = getValidatedBody<UpdateAgentRequest>(c);

  const agent = agentManager.updateAgent(agentId, body);

  if (!agent) {
    throw new NotFoundError('Agent');
  }

  return c.json({ agent });
});

// Delete an agent
api.delete('/agents/:id', (c) => {
  const agentId = c.req.param('id');

  // Check if agent exists
  const agent = agentManager.getAgent(agentId);
  if (!agent) {
    throw new NotFoundError('Agent');
  }

  // Built-in agents cannot be deleted
  if (agent.isBuiltIn) {
    throw new ValidationError('Built-in agents cannot be deleted');
  }

  const success = agentManager.unregisterAgent(agentId);

  if (!success) {
    throw new ValidationError('Failed to delete agent');
  }

  return c.json({ success: true });
});

// Open a file or directory in the default application (Finder/Explorer)
api.post('/system/open', async (c) => {
  const body = await c.req.json<{ path: string }>();
  const { path } = body;

  if (!path) {
    throw new ValidationError('path is required');
  }

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

export { api };
