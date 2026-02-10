import { Hono } from 'hono';
import * as v from 'valibot';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import { validateSessionPath } from '../lib/path-validator.js';
import {
  CreateSessionRequestSchema,
  UpdateSessionRequestSchema,
  CreateWorkerRequestSchema,
  RestartWorkerRequestSchema,
  SendWorkerMessageRequestSchema,
  MAX_MESSAGE_FILES,
  MAX_TOTAL_FILE_SIZE,
} from '@agent-console/shared';
import { getSessionManager } from '../services/session-manager.js';
import { worktreeService } from '../services/worktree-service.js';
import { createSessionValidationService } from '../services/session-validation-service.js';
import { fetchPullRequestUrl } from '../services/github-pr-service.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { vValidator, vQueryValidator } from '../middleware/validation.js';
import { getOrgRepoFromPath } from '../lib/git.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('sessions-route');

const FILE_UPLOAD_DIR = join(tmpdir(), 'agent-console-uploads');
const uploadDirReady = mkdir(FILE_UPLOAD_DIR, { recursive: true }).catch((err) => {
  logger.error({ err, dir: FILE_UPLOAD_DIR }, 'Failed to create upload directory');
});

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
  .post('/', vValidator(CreateSessionRequestSchema), async (c) => {
    const body = c.req.valid('json');

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
  // Pause a session (worktree sessions only)
  // Kills PTY processes, removes from memory, preserves persistence
  .post('/:id/pause', async (c) => {
    const sessionId = c.req.param('id');
    const sessionManager = getSessionManager();

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
    const sessionManager = getSessionManager();

    const session = await sessionManager.resumeSession(sessionId);
    if (!session) {
      throw new NotFoundError('Session');
    }

    return c.json({ session });
  })
  // Update session metadata (title and/or branch)
  // If branch is changed, agent worker is automatically restarted
  .patch('/:id', vValidator(UpdateSessionRequestSchema), async (c) => {
    const sessionId = c.req.param('id');
    const body = c.req.valid('json');
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
  .get('/:sessionId/commits',
    vQueryValidator(v.object({ base: v.pipe(v.string(), v.minLength(1, 'base query parameter is required')) })),
    async (c) => {
    const sessionId = c.req.param('sessionId');
    const { base: baseRef } = c.req.valid('query');

    const sessionManager = getSessionManager();
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
  // Send a message to a worker (multipart/form-data for file upload support)
  .post('/:sessionId/messages', async (c) => {
    const sessionId = c.req.param('sessionId');

    const body = await c.req.parseBody({ all: true });

    const toWorkerId = typeof body.toWorkerId === 'string' ? body.toWorkerId : '';
    const content = typeof body.content === 'string' ? body.content : '';

    // Validate text fields with schema
    const validated = v.parse(SendWorkerMessageRequestSchema, { toWorkerId, content });

    // Extract files
    const rawFiles = body.files;
    const files: File[] = [];
    if (rawFiles instanceof File) {
      files.push(rawFiles);
    } else if (Array.isArray(rawFiles)) {
      for (const f of rawFiles) {
        if (f instanceof File) {
          files.push(f);
        }
      }
    }

    // Require at least content or files
    if (!validated.content && files.length === 0) {
      throw new ValidationError('Message must have content or at least one file');
    }

    // Validate file constraints
    if (files.length > MAX_MESSAGE_FILES) {
      throw new ValidationError(`Too many files (max ${MAX_MESSAGE_FILES})`);
    }

    let totalSize = 0;
    for (const file of files) {
      totalSize += file.size;
    }
    if (totalSize > MAX_TOTAL_FILE_SIZE) {
      throw new ValidationError(`Total file size exceeds limit (max ${MAX_TOTAL_FILE_SIZE} bytes)`);
    }

    // Ensure upload directory is ready before writing files
    await uploadDirReady;

    // Save files to disk
    const savedPaths: string[] = [];
    for (const file of files) {
      // Sanitize filename: remove directory separators to prevent path traversal
      const sanitizedName = file.name.replace(/[/\\]/g, '_');
      const uniqueName = `${randomUUID()}-${sanitizedName}`;
      const filePath = join(FILE_UPLOAD_DIR, uniqueName);
      const buffer = Buffer.from(await file.arrayBuffer());
      await Bun.write(filePath, buffer);
      savedPaths.push(filePath);
    }

    const sessionManager = getSessionManager();
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      throw new NotFoundError('Session');
    }

    const message = sessionManager.sendMessage(sessionId, null, validated.toWorkerId, validated.content, savedPaths);
    if (!message) {
      throw new ValidationError('Failed to send message (target worker not found or PTY inactive)');
    }

    return c.json({ message }, 201);
  })
  // Create a worker in a session
  .post('/:sessionId/workers', vValidator(CreateWorkerRequestSchema), async (c) => {
    const sessionId = c.req.param('sessionId');
    const body = c.req.valid('json');

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
  .post('/:sessionId/workers/:workerId/restart', vValidator(RestartWorkerRequestSchema), async (c) => {
    const sessionId = c.req.param('sessionId');
    const workerId = c.req.param('workerId');
    const body = c.req.valid('json');
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
