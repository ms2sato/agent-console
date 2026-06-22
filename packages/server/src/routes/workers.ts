import { Hono } from 'hono';
import * as v from 'valibot';
import { join } from 'path';
import { mkdir, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import {
  CreateWorkerRequestSchema,
  RestartWorkerRequestSchema,
  SendWorkerMessageRequestSchema,
  MAX_MESSAGE_FILES,
  MAX_TOTAL_FILE_SIZE,
} from '@agent-console/shared';
import type { AppBindings } from '../app-context.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { vValidator } from '../middleware/validation.js';
import { createLogger } from '../lib/logger.js';
import { getConfigDir } from '../lib/config.js';

const logger = createLogger('api:workers');

// Upload directory is resolved lazily under AGENT_CONSOLE_HOME so that each
// install (each Model B service user, each dev worktree) owns its own
// directory instead of fighting over a host-wide path like /tmp/agent-console-uploads.
// See issue #821.
const uploadDirReady = new Map<string, Promise<void>>();

async function ensureUploadDir(): Promise<string> {
  const dir = join(getConfigDir(), 'uploads');
  let ready = uploadDirReady.get(dir);
  if (!ready) {
    ready = mkdir(dir, { recursive: true })
      .then(() => undefined)
      .catch((err) => {
        uploadDirReady.delete(dir);
        logger.error({ err, dir }, 'Failed to create upload directory');
        throw err;
      });
    uploadDirReady.set(dir, ready);
  }
  await ready;
  return dir;
}

const workers = new Hono<AppBindings>()
  // Get workers for a session
  .get('/:sessionId/workers', async (c) => {
    const sessionId = c.req.param('sessionId');
    const { sessionManager } = c.get('appContext');
    const session = sessionManager.getSession(sessionId);

    if (!session) {
      throw new NotFoundError('Session');
    }

    return c.json({ workers: session.workers });
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

    // Validate session exists BEFORE writing files to avoid orphan files on disk
    const { sessionManager } = c.get('appContext');
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      throw new NotFoundError('Session');
    }

    // Ensure upload directory is ready before writing files
    const uploadDir = await ensureUploadDir();

    // Save files to disk
    const savedPaths: string[] = [];
    for (const file of files) {
      // Sanitize filename: remove directory separators to prevent path traversal
      const sanitizedName = file.name.replace(/[/\\]/g, '_');
      const uniqueName = `${randomUUID()}-${sanitizedName}`;
      const filePath = join(uploadDir, uniqueName);
      const buffer = Buffer.from(await file.arrayBuffer());
      await Bun.write(filePath, buffer);
      savedPaths.push(filePath);
    }

    const message = sessionManager.sendMessage(sessionId, null, validated.toWorkerId, validated.content, savedPaths);
    if (!message) {
      // Clean up saved files since the message was not delivered
      await Promise.allSettled(savedPaths.map((p) => unlink(p)));
      throw new ValidationError('Failed to send message (target worker not found or PTY inactive)');
    }

    return c.json({ message }, 201);
  })
  // Create a worker in a session
  .post('/:sessionId/workers', vValidator(CreateWorkerRequestSchema), async (c) => {
    const sessionId = c.req.param('sessionId');
    const body = c.req.valid('json');

    const { sessionManager } = c.get('appContext');
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

    const { sessionManager } = c.get('appContext');
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
    const { continueConversation = false, agentId, branch } = body;

    const { sessionManager } = c.get('appContext');
    const worker = await sessionManager.restartAgentWorker(sessionId, workerId, continueConversation, agentId, branch);

    if (!worker) {
      throw new NotFoundError('Worker');
    }

    return c.json({ worker });
  })
  // Get diff data for a git-diff worker
  .get('/:sessionId/workers/:workerId/diff', async (c) => {
    const sessionId = c.req.param('sessionId');
    const workerId = c.req.param('workerId');

    const { sessionManager } = c.get('appContext');
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

    const { resolveBaseSpec, getDiffData } = await import('../services/git-diff-service.js');
    const resolved = await resolveBaseSpec(worker.baseCommit, session.locationPath);
    if (!resolved) {
      throw new ValidationError(`Could not resolve diff base: ${worker.baseCommit}`);
    }
    const diffData = await getDiffData(session.locationPath, resolved);

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

    const { sessionManager } = c.get('appContext');
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

    const { resolveBaseSpec, getFileDiff } = await import('../services/git-diff-service.js');
    const resolved = await resolveBaseSpec(worker.baseCommit, session.locationPath);
    if (!resolved) {
      throw new ValidationError(`Could not resolve diff base: ${worker.baseCommit}`);
    }
    const rawDiff = await getFileDiff(session.locationPath, resolved, filePath);

    return c.json({ rawDiff });
  });

export { workers };
