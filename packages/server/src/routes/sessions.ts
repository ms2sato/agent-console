import { Hono } from 'hono';
import * as v from 'valibot';
import { validateSessionPath } from '../lib/path-validator.js';
import {
  CreateSessionRequestSchema,
  UpdateSessionRequestSchema,
} from '@agent-console/shared';
import { worktreeService } from '../services/worktree-service.js';
import { createSessionValidationService } from '../services/session-validation-service.js';
import { fetchPullRequestUrl } from '../services/github-pr-service.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { vValidator, vQueryValidator } from '../middleware/validation.js';
import { getOrgRepoFromPath } from '../lib/git.js';
import type { AppBindings } from '../app-context.js';

const sessions = new Hono<AppBindings>()
  // Validate all sessions
  .get('/validate', async (c) => {
    const { sessionManager } = c.get('appContext');
    const validationService = createSessionValidationService(sessionManager.getSessionRepository());
    const response = await validationService.validateAllSessions();
    return c.json(response);
  })
  // Delete an invalid session (removes from persistence without trying to stop workers)
  .delete('/:id/invalid', async (c) => {
    const sessionId = c.req.param('id');
    const { sessionManager } = c.get('appContext');
    const deleted = await sessionManager.forceDeleteSession(sessionId);
    if (!deleted) {
      throw new NotFoundError('Session');
    }
    return c.json({ success: true });
  })
  // Get a single session
  .get('/:id', async (c) => {
    const sessionId = c.req.param('id');
    const { sessionManager } = c.get('appContext');

    // First check if session is active
    const session = sessionManager.getSession(sessionId);
    if (session) {
      return c.json({ session });
    }

    // Check persisted data for inactive/paused sessions
    const persistedSession = await sessionManager.getPersistedSession(sessionId);
    if (persistedSession) {
      return c.json({ session: persistedSession });
    }

    throw new NotFoundError('Session');
  })
  // Create a new session
  .post('/', vValidator(CreateSessionRequestSchema), async (c) => {
    const body = c.req.valid('json');

    // Validate that locationPath is safe and exists
    const validation = await validateSessionPath(body.locationPath);
    if (!validation.valid) {
      throw new ValidationError(validation.error || 'Invalid path');
    }

    const { sessionManager } = c.get('appContext');
    const authUser = c.get('authUser');
    const session = await sessionManager.createSession(body, { createdBy: authUser.id });

    return c.json({ session }, 201);
  })
  // Get memo for a session
  .get('/:id/memo', async (c) => {
    const sessionId = c.req.param('id');
    const { sessionManager } = c.get('appContext');

    const session = sessionManager.getSession(sessionId);
    if (!session) {
      throw new NotFoundError('Session');
    }

    const content = await sessionManager.readMemo(sessionId);
    return c.json({ content });
  })
  // Delete a session (synchronous)
  // For worktree sessions with async deletion, use the worktree deletion endpoint instead.
  .delete('/:id', async (c) => {
    const sessionId = c.req.param('id');
    const { sessionManager } = c.get('appContext');

    const success = await sessionManager.deleteSession(sessionId);

    if (!success) {
      throw new NotFoundError('Session');
    }

    return c.json({ success: true });
  })
  // Pause a session (worktree sessions only)
  // Kills PTY processes, removes from memory, preserves persistence
  .post('/:id/pause', async (c) => {
    const sessionId = c.req.param('id');
    const { sessionManager } = c.get('appContext');

    // Check if session exists in memory first
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      throw new NotFoundError('Session');
    }

    // Quick sessions cannot be paused
    if (session.type === 'quick') {
      throw new ValidationError('Quick sessions cannot be paused. Use delete instead.');
    }

    const success = await sessionManager.pauseSession(sessionId);
    if (!success) {
      throw new NotFoundError('Session');
    }

    return c.json({ success: true });
  })
  // Resume a paused session
  // Loads from DB, creates in-memory session, restores workers
  .post('/:id/resume', async (c) => {
    const sessionId = c.req.param('id');
    const { sessionManager } = c.get('appContext');

    const session = await sessionManager.resumeSession(sessionId);
    if (!session) {
      throw new NotFoundError('Session');
    }

    return c.json({ session });
  })
  // Update session metadata (title)
  .patch('/:id', vValidator(UpdateSessionRequestSchema), async (c) => {
    const sessionId = c.req.param('id');
    const body = c.req.valid('json');
    const { title } = body;

    const updates: { title?: string } = {};
    if (title !== undefined) {
      updates.title = title.trim();
    }

    const { sessionManager } = c.get('appContext');
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
    });
  })
  // Get branches for a session's repository
  .get('/:sessionId/branches', async (c) => {
    const sessionId = c.req.param('sessionId');
    const { sessionManager } = c.get('appContext');
    const session = sessionManager.getSession(sessionId);

    if (!session) {
      throw new NotFoundError('Session');
    }

    const branches = await worktreeService.listBranches(session.locationPath);
    return c.json(branches);
  })
  // Get commits created in this branch (since base commit)
  .get('/:sessionId/commits',
    vQueryValidator(v.object({ base: v.pipe(v.string(), v.minLength(1, 'base query parameter is required')) })),
    async (c) => {
    const sessionId = c.req.param('sessionId');
    const { base: baseRef } = c.req.valid('query');

    const { sessionManager } = c.get('appContext');
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      throw new NotFoundError('Session');
    }

    const { getBranchCommits } = await import('../lib/git.js');
    const commits = await getBranchCommits(baseRef, session.locationPath);
    return c.json({ commits });
  })
  // Get PR link for a session (worktree sessions only)
  .get('/:sessionId/pr-link', async (c) => {
    const sessionId = c.req.param('sessionId');
    const { sessionManager } = c.get('appContext');
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

export { sessions };
