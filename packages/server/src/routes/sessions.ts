import { Hono } from 'hono';
import * as v from 'valibot';
import { validateSessionPath } from '../lib/path-validator.js';
import {
  CreateSessionRequestSchema,
  UpdateSessionRequestSchema,
  UpdateSessionMemoRequestSchema,
} from '@agent-console/shared';
import { createSessionValidationService } from '../services/session-validation-service.js';
import { ForbiddenError, InternalError, NotFoundError, ValidationError } from '../lib/errors.js';
import { vValidator, vQueryValidator } from '../middleware/validation.js';
import { getOrgRepoFromPath } from '../lib/git.js';
import { resolveSpawnUsername } from '../services/resolve-spawn-username.js';
import type { AppBindings } from '../app-context.js';

const sessions = new Hono<AppBindings>()
  // Restart all active agent workers across all sessions
  .post('/restart-all-agents', async (c) => {
    const { sessionManager } = c.get('appContext');
    const result = await sessionManager.restartAllAgentWorkers();
    return c.json(result);
  })
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

    const { sessionManager, sharedAccountRegistry, agentDirectory } = c.get('appContext');
    const authUser = c.get('authUser');

    // Validate the embedded agent exists before returning accepted (fail
    // fast for invalid config, mirrors POST /:id/worktrees).
    if (body.embeddedAgentId) {
      const embeddedAgent = agentDirectory.get('embedded', body.embeddedAgentId)?.agent;
      if (!embeddedAgent) {
        throw new ValidationError(`Embedded agent not found: ${body.embeddedAgentId}`);
      }
    }

    // Determine session ownership. For shared sessions, createdBy is the
    // shared account (PTY spawn identity) and initiatedBy is the
    // authenticated user (audit trail). For personal sessions, createdBy is
    // the authenticated user and initiatedBy is left undefined — they would
    // be equal, and leaving the column null makes shared/personal sessions
    // observable from the DB.
    let createdBy: string;
    let initiatedBy: string | undefined;
    if (body.shared === true) {
      if (!sharedAccountRegistry.isEnabled()) {
        throw new ValidationError('Shared sessions are not enabled on this server.');
      }
      const sharedUserId = sharedAccountRegistry.getDefaultUserId();
      if (!sharedUserId) {
        // isEnabled() returned true but no default — unreachable in
        // practice; surface as 500 since it indicates server-side
        // inconsistency, not a client input error.
        throw new InternalError('Shared account registry is enabled but has no default user.');
      }
      createdBy = sharedUserId;
      initiatedBy = authUser.id;
    } else {
      createdBy = authUser.id;
      initiatedBy = undefined;
    }

    const session = await sessionManager.createSession(body, { createdBy, initiatedBy });

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
  // Write (or delete, on empty content) the memo for a session.
  // Ownership: the authenticated user must be the session's owner, or the
  // session must be a shared session (any authenticated user may write to a
  // shared session's memo). This single check is correct for both
  // single-user and multi-user mode -- see embedded-agents.ts's PATCH /:id
  // for the precedent ("In single-user mode there is only one user id, so
  // the check is trivially satisfied").
  .put('/:id/memo', vValidator(UpdateSessionMemoRequestSchema), async (c) => {
    const sessionId = c.req.param('id');
    const body = c.req.valid('json');
    const { sessionManager, sharedAccountRegistry } = c.get('appContext');
    const authUser = c.get('authUser');

    const session = sessionManager.getSession(sessionId);
    if (!session) {
      throw new NotFoundError('Session');
    }

    const isOwner = session.createdBy === authUser.id;
    const isSharedSession = session.createdBy != null && sharedAccountRegistry.isSharedUserId(session.createdBy);
    if (!isOwner && !isSharedSession) {
      throw new ForbiddenError('Only the session owner can write this memo');
    }

    // R4: a save whose trimmed content is empty DELETES the memo file
    // rather than writing an empty one. Writing '' would make readMemo
    // return '' forever instead of null, which the client can no longer
    // distinguish from "no memo" -- this is a deliberate ruling, not a
    // bug. The `memo-updated` broadcast still fires, carrying `content: ''`
    // -- on that wire message `''` (never `null`) is the deletion signal;
    // `null` is a REST-response-only value. See docs/design/session-worker-design.md#session-memo.
    if (body.content.trim().length === 0) {
      await sessionManager.deleteMemo(sessionId);
      return c.json({ content: null });
    }

    try {
      await sessionManager.writeMemo(sessionId, body.content);
    } catch (err) {
      throw new ValidationError(err instanceof Error ? err.message : 'Failed to write memo');
    }
    return c.json({ content: body.content });
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
  .get('/:sessionId/branches', async (c) => {
    const sessionId = c.req.param('sessionId');
    const { sessionManager, worktreeService, userRepository } = c.get('appContext');
    const session = sessionManager.getSession(sessionId);

    if (!session) {
      throw new NotFoundError('Session');
    }

    // Multi-user mode must run the git invocations as the session's
    // effective spawn user (the OS user that owns the worktree), not as the
    // authenticated viewer. For shared sessions the spawn user is the shared
    // account; using the viewer's identity would reintroduce
    // dubious-ownership / missing-credential failures and silently fall back
    // to empty branches. `resolveSpawnUsername` mirrors the resolution
    // `SessionManager` uses when launching the session's PTY workers and
    // falls back to the server username when the session has no `createdBy`
    // or the lookup fails.
    const spawnUsername = await resolveSpawnUsername(session.createdBy, userRepository);
    const branches = await worktreeService.listBranches(session.locationPath, spawnUsername);
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
  .get('/:sessionId/pr-link', async (c) => {
    const sessionId = c.req.param('sessionId');
    const { sessionManager } = c.get('appContext');
    const authUser = c.get('authUser');
    const session = sessionManager.getSession(sessionId);

    if (!session) {
      throw new NotFoundError('Session');
    }

    if (session.type !== 'worktree') {
      throw new ValidationError('PR link is only available for worktree sessions');
    }

    const branchName = session.worktreeId;
    const orgRepo = await getOrgRepoFromPath(session.locationPath);

    const { fetchPullRequestUrl } = c.get('appContext');
    // Thread the authenticated OS username so multi-user mode runs
    // `gh pr view` as the requesting user (with that user's per-user gh auth
    // token). In single-user mode `runAsUser` bypasses elevation.
    const prUrl = await fetchPullRequestUrl(branchName, session.locationPath, authUser.username);

    return c.json({
      prUrl,
      branchName,
      orgRepo,
    });
  });

export { sessions };
