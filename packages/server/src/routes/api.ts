import { Hono } from 'hono';
import { homedir } from 'node:os';
import { resolve as resolvePath, dirname } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import open from 'open';
import type {
  CreateWorktreeRequest,
  CreateAgentRequest,
  UpdateAgentRequest,
  CreateSessionRequest,
  CreateWorkerRequest,
} from '@agent-console/shared';
import { sessionManager } from '../services/session-manager.js';
import { repositoryManager } from '../services/repository-manager.js';
import { worktreeService } from '../services/worktree-service.js';
import { agentManager, CLAUDE_CODE_AGENT_ID } from '../services/agent-manager.js';
import { suggestBranchName } from '../services/branch-name-suggester.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';

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
api.post('/sessions', async (c) => {
  const body = await c.req.json<CreateSessionRequest>();

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

// Rename branch for a session
api.patch('/sessions/:id/branch', async (c) => {
  const sessionId = c.req.param('id');
  const body = await c.req.json<{ newBranch: string }>();
  const { newBranch } = body;

  if (!newBranch?.trim()) {
    throw new ValidationError('newBranch is required');
  }

  const result = sessionManager.renameBranch(sessionId, newBranch.trim());

  if (!result.success) {
    if (result.error === 'session_not_found') {
      throw new NotFoundError('Session');
    }
    throw new ValidationError(result.error || 'Failed to rename branch');
  }

  return c.json({ success: true, branch: result.branch });
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

// Create a worker in a session
api.post('/sessions/:sessionId/workers', async (c) => {
  const sessionId = c.req.param('sessionId');
  const body = await c.req.json<CreateWorkerRequest & { continueConversation?: boolean }>();

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    throw new NotFoundError('Session');
  }

  const { continueConversation = false, ...workerRequest } = body;
  const worker = sessionManager.createWorker(sessionId, workerRequest, continueConversation);

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
api.post('/sessions/:sessionId/workers/:workerId/restart', async (c) => {
  const sessionId = c.req.param('sessionId');
  const workerId = c.req.param('workerId');
  const body = await c.req.json<{ continueConversation?: boolean }>();
  const { continueConversation = false } = body;

  const worker = sessionManager.restartAgentWorker(sessionId, workerId, continueConversation);

  if (!worker) {
    throw new NotFoundError('Worker');
  }

  return c.json({ worker });
});

// Get all repositories
api.get('/repositories', (c) => {
  const repositories = repositoryManager.getAllRepositories();
  return c.json({ repositories });
});

// Register a repository
api.post('/repositories', async (c) => {
  const body = await c.req.json<{ path: string }>();
  const { path } = body;

  if (!path) {
    throw new ValidationError('path is required');
  }

  try {
    const repository = repositoryManager.registerRepository(path);
    return c.json({ repository }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new ValidationError(message);
  }
});

// Unregister a repository
api.delete('/repositories/:id', (c) => {
  const repoId = c.req.param('id');
  const success = repositoryManager.unregisterRepository(repoId);

  if (!success) {
    throw new NotFoundError('Repository');
  }

  return c.json({ success: true });
});

// Get worktrees for a repository
api.get('/repositories/:id/worktrees', (c) => {
  const repoId = c.req.param('id');
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    throw new NotFoundError('Repository');
  }

  const worktrees = worktreeService.listWorktrees(repo.path, repoId);
  return c.json({ worktrees });
});

// Create a worktree
api.post('/repositories/:id/worktrees', async (c) => {
  const repoId = c.req.param('id');
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    throw new NotFoundError('Repository');
  }

  const body = await c.req.json<CreateWorktreeRequest>();
  const { mode, autoStartSession, agentId, initialPrompt } = body;

  let branch: string;
  let baseBranch: string | undefined;

  // Get the agent for branch name generation (if prompt mode)
  const selectedAgentId = agentId || CLAUDE_CODE_AGENT_ID;
  const agent = agentManager.getAgent(selectedAgentId);
  if (!agent) {
    throw new ValidationError(`Agent not found: ${selectedAgentId}`);
  }

  switch (mode) {
    case 'prompt':
      if (!body.initialPrompt?.trim()) {
        throw new ValidationError('initialPrompt is required for prompt mode');
      }
      // Generate branch name from prompt using the selected agent
      const suggestion = await suggestBranchName({
        prompt: body.initialPrompt.trim(),
        repositoryPath: repo.path,
        agent,
      });
      if (suggestion.error || !suggestion.branch) {
        throw new ValidationError(suggestion.error || 'Failed to generate branch name');
      }
      branch = suggestion.branch;
      baseBranch = body.baseBranch || worktreeService.getDefaultBranch(repo.path) || 'main';
      break;
    case 'custom':
      branch = body.branch;
      baseBranch = body.baseBranch || worktreeService.getDefaultBranch(repo.path) || 'main';
      break;
    case 'existing':
      branch = body.branch;
      baseBranch = undefined;
      break;
    default:
      throw new ValidationError('Invalid mode. Must be "prompt", "custom", or "existing"');
  }

  const result = await worktreeService.createWorktree(repo.path, branch, baseBranch);

  if (result.error) {
    throw new ValidationError(result.error);
  }

  // Get the created worktree info
  const worktrees = worktreeService.listWorktrees(repo.path, repoId);
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
  if (!worktreeService.isWorktreeOf(repo.path, worktreePath)) {
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
api.get('/repositories/:id/branches', (c) => {
  const repoId = c.req.param('id');
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    throw new NotFoundError('Repository');
  }

  const branches = worktreeService.listBranches(repo.path);
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
api.post('/agents', async (c) => {
  const body = await c.req.json<CreateAgentRequest>();
  const { name, command, description, icon, activityPatterns } = body;

  if (!name || !command) {
    throw new ValidationError('name and command are required');
  }

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
api.patch('/agents/:id', async (c) => {
  const agentId = c.req.param('id');
  const body = await c.req.json<UpdateAgentRequest>();

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

  // Check if path exists
  if (!existsSync(absolutePath)) {
    throw new NotFoundError('Path');
  }

  try {
    // For files, open the containing directory
    const stats = statSync(absolutePath);
    if (stats.isFile()) {
      // Open the parent directory
      await open(dirname(absolutePath));
    } else {
      // Open the directory directly
      await open(absolutePath);
    }
    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to open path';
    throw new ValidationError(message);
  }
});

export { api };
