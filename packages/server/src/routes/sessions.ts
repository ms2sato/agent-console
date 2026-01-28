import { Hono } from 'hono';
import { validateSessionPath } from '../lib/path-validator.js';
import type {
  CreateSessionRequest,
  UpdateSessionRequest,
  CreateWorkerRequest,
  RestartWorkerRequest,
} from '@agent-console/shared';
import {
  CreateSessionRequestSchema,
  UpdateSessionRequestSchema,
  CreateWorkerRequestSchema,
  RestartWorkerRequestSchema,
} from '@agent-console/shared';
import { getSessionManager } from '../services/session-manager.js';
import { worktreeService } from '../services/worktree-service.js';
import { createSessionValidationService } from '../services/session-validation-service.js';
import { fetchPullRequestUrl } from '../services/github-pr-service.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { validateBody, getValidatedBody } from '../middleware/validation.js';
import { getOrgRepoFromPath } from '../lib/git.js';

const sessions = new Hono()
  // Validate all sessions
  .get('/validate', async (c) => {
    const sessionManager = getSessionManager();
    const validationService = createSessionValidationService(sessionManager.getSessionRepository());
    const response = await validationService.validateAllSessions();
    return c.json(response);
  })
  // Delete an invalid session (removes from persistence without trying to stop workers)
  .delete('/:id/invalid', async (c) => {
    const sessionId = c.req.param('id');
    const sessionManager = getSessionManager();
    const deleted = await sessionManager.forceDeleteSession(sessionId);
    if (!deleted) {
      throw new NotFoundError('Session');
    }
    return c.json({ success: true });
  })
  // Get a single session
  .get('/:id', async (c) => {
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
  })
  // Create a new session
  .post('/', validateBody(CreateSessionRequestSchema), async (c) => {
    const body = getValidatedBody<CreateSessionRequest>(c);

    // Validate that locationPath is safe and exists
    const validation = await validateSessionPath(body.locationPath);
    if (!validation.valid) {
      throw new ValidationError(validation.error || 'Invalid path');
    }

    const sessionManager = getSessionManager();
    const session = await sessionManager.createSession(body);

    return c.json({ session }, 201);
  })
  // Delete a session (synchronous)
  // For worktree sessions with async deletion, use the worktree deletion endpoint instead.
  .delete('/:id', async (c) => {
    const sessionId = c.req.param('id');
    const sessionManager = getSessionManager();

    const success = await sessionManager.deleteSession(sessionId);

    if (!success) {
      throw new NotFoundError('Session');
    }

    return c.json({ success: true });
  })
  // Update session metadata (title and/or branch)
  // If branch is changed, agent worker is automatically restarted
  .patch('/:id', validateBody(UpdateSessionRequestSchema), async (c) => {
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
  })
  // Get workers for a session
  .get('/:sessionId/workers', async (c) => {
    const sessionId = c.req.param('sessionId');
    const sessionManager = getSessionManager();
    const session = sessionManager.getSession(sessionId);

    if (!session) {
      throw new NotFoundError('Session');
    }

    return c.json({ workers: session.workers });
  })
  // Get branches for a session's repository
  .get('/:sessionId/branches', async (c) => {
    const sessionId = c.req.param('sessionId');
    const sessionManager = getSessionManager();
    const session = sessionManager.getSession(sessionId);

    if (!session) {
      throw new NotFoundError('Session');
    }

    const branches = await worktreeService.listBranches(session.locationPath);
    return c.json(branches);
  })
  // Get commits created in this branch (since base commit)
  .get('/:sessionId/commits', async (c) => {
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
  })
  // Get PR link for a session (worktree sessions only)
  .get('/:sessionId/pr-link', async (c) => {
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
  })
  // Create a worker in a session
  .post('/:sessionId/workers', validateBody(CreateWorkerRequestSchema), async (c) => {
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
  })
  // Delete a worker
  .delete('/:sessionId/workers/:workerId', async (c) => {
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
  })
  // Restart an agent worker
  .post('/:sessionId/workers/:workerId/restart', validateBody(RestartWorkerRequestSchema), async (c) => {
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
  })
  // Get diff data for a git-diff worker
  .get('/:sessionId/workers/:workerId/diff', async (c) => {
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
  })
  // Get diff for a specific file
  .get('/:sessionId/workers/:workerId/diff/file', async (c) => {
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

export { sessions };
