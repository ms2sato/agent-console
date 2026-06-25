import { Hono } from 'hono';
import * as v from 'valibot';
import { join } from 'path';
import { tmpdir } from 'os';
import { lstat, mkdir, unlink } from 'fs/promises';
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

const logger = createLogger('api:workers');

// Upload directory is per-uid under the OS temp directory so that:
//   1. Different users on the same host (e.g. Model B service user `agentconsole`
//      vs. an interactive dev user) do not collide on a single host-wide
//      `/tmp/agent-console-uploads` (the original EACCES symptom of issue #821).
//   2. Uploads remain transient: /tmp is reaped by the OS (systemd-tmpfiles,
//      tmpwatch, reboot), so abandoned upload buffers do not accumulate. The
//      server has no read-completion signal for `injectMessage`, so a
//      persistent location (e.g. AGENT_CONSOLE_HOME) would leak disk over time.
//
// Mode and group depend on AUTH_MODE (Issue #830):
//   - AUTH_MODE=none (single-user): mode 0700, owner-only. Prevents other
//     users on the same host from reading buffered file contents.
//   - AUTH_MODE=multi-user: mode 2750 (setgid + group-rx), owner = service
//     user, group = shared group (the server process's primary gid — the
//     bootstrap script sets `Group=<shared-group>` on the systemd unit, so
//     `process.getgid()` is the shared group at runtime). This lets the
//     per-user PTY (running as the logged-in user, who is also a member of
//     the shared group) traverse into the buffer to read attachments.
//
// Setgid is applied via an explicit chmod(1) AFTER mkdir (#830 follow-up):
//   - Bun 1.3.10 strips the special bits (setgid 0o2000 / setuid 0o4000 /
//     sticky 0o1000) in its JS layer BEFORE the syscall, for both
//     `fs.mkdir({ mode })` and `fs.chmod(dir, mode)`. Verified by strace:
//     `await mkdir(dir, { mode: 0o2750 })` issues `mkdirat(..., 0750)`
//     (setgid dropped) and `await chmod(dir, 0o2750)` issues
//     `fchmodat(..., 0750)` (likewise). The kernel and the underlying
//     filesystem both honour setgid when called directly (e.g. shell
//     `mkdir --mode=2750` or `chmod 2750` produce `drwxr-s---`), but the
//     Bun bindings never pass the bit through.
//   - GNU chmod (coreutils) does pass the bit through. We therefore shell
//     out to /bin/chmod via Bun.spawn under the multi-user (mode > 0o777)
//     branch only. Cost is one spawn per upload on the multi-user
//     multipart path, which is already disk-bound. The single-user 0o700
//     path does not need this and stays mkdir-only.
//   - If a future Bun release fixes its JS-layer mode stripping, the
//     `workers-upload-dir-real-fs.test.ts` kernel-level probe will flag
//     the change and the in-process chmod step can replace the shell-out.
//
// No in-process readiness cache (Issue #830): the directory is re-verified
// on every upload so that if /tmp is reaped by systemd-tmpfiles during a
// long-running server's uptime, the next upload recreates the directory.
// `mkdir(..., { recursive: true })` is a cheap idempotent no-op when the
// directory exists, and the per-upload cost is one mkdir + one lstat —
// negligible at upload frequency.
const SINGLE_USER_UPLOAD_DIR_MODE = 0o700;
const MULTI_USER_UPLOAD_DIR_MODE = 0o2750;

interface UploadDirContract {
  mode: number;
  expectedGid: number | null;
}

function resolveUploadDir(): string {
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : 'shared';
  return join(tmpdir(), `agent-console-uploads-${uid}`);
}

function resolveUploadDirContract(): UploadDirContract {
  if (process.env.AUTH_MODE === 'multi-user' && typeof process.getgid === 'function') {
    return { mode: MULTI_USER_UPLOAD_DIR_MODE, expectedGid: process.getgid() };
  }
  return { mode: SINGLE_USER_UPLOAD_DIR_MODE, expectedGid: null };
}

/**
 * Apply a mode containing special bits (setgid / setuid / sticky) via the
 * external chmod(1) program.
 *
 * Bun 1.3.10 strips special bits in its JS layer for both `fs.mkdir` and
 * `fs.chmod` (verified via strace: setgid / setuid / sticky never reach
 * the syscall). GNU chmod does pass them through. coreutils chmod is
 * present on every Debian / Ubuntu / RHEL / Alpine host the server is
 * expected to run on.
 *
 * See the file-header comment block and the kernel-level probe in
 * `workers-upload-dir-real-fs.test.ts` for the empirical assumptions
 * this workaround locks in.
 */
async function applyModeViaSpawnChmod(dir: string, mode: number): Promise<void> {
  // chmod accepts an octal string (e.g. "2750"); pass full mode including
  // special bits, masked at 0o7777 to defend against accidental higher-bit
  // garbage in the caller.
  const modeStr = (mode & 0o7777).toString(8);
  const proc = Bun.spawn(['chmod', modeStr, dir], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `chmod ${modeStr} failed (exit=${exitCode}) for ${dir}: ${stderr.trim()}`,
    );
  }
}

async function ensureUploadDir(): Promise<string> {
  const dir = resolveUploadDir();
  const contract = resolveUploadDirContract();
  // TOCTOU defense (security review HIGH, #821 follow-up): POSIX mkdir is a
  // no-op when the target already exists, so a pre-created symlink or a
  // wider-mode dir would silently slip past `mkdir(..., { mode })`. After
  // mkdir, lstat the path (no symlink follow) and reject anything that does
  // not match the expected owner / mode / group.
  try {
    await mkdir(dir, { recursive: true, mode: contract.mode });
    // Validate the path BEFORE any chmod(1) shell-out. chmod(2) follows
    // symlinks, so applying it on a pre-created symlink would mutate the
    // symlink target's mode before we ever reject the symlink. Lstat
    // first, confirm symlink / dir / owner / gid, THEN re-apply setgid
    // via chmod (which is now operating on a path we have just
    // verified). CodeRabbit #831-review TOCTOU finding.
    let st = await lstat(dir);
    if (st.isSymbolicLink()) {
      throw new Error(`Upload directory is a symlink: ${dir}`);
    }
    if (!st.isDirectory()) {
      throw new Error(`Upload directory path is not a directory: ${dir}`);
    }
    // POSIX-only ownership check; on Windows (or any platform without
    // geteuid) the fallback path is the shared 'shared' suffix and there is
    // no uid to compare against.
    if (typeof process.geteuid === 'function' && st.uid !== process.geteuid()) {
      throw new Error(
        `Upload directory has unexpected owner uid=${st.uid} (expected ${process.geteuid()}): ${dir}`,
      );
    }
    if (contract.expectedGid !== null && st.gid !== contract.expectedGid) {
      throw new Error(
        `Upload directory has unexpected group gid=${st.gid} (expected ${contract.expectedGid}): ${dir}`,
      );
    }

    // Bun 1.3.10 strips setgid / setuid / sticky in its fs.mkdir JS
    // layer before the syscall; for the multi-user 2750 contract we
    // re-apply the bit via chmod(1) — now that we have lstat-confirmed
    // the path is the expected directory. Skip when the contract has
    // no special bits (single-user 0o700) OR when the existing mode
    // already matches (idempotent recovery of a previously-prepared
    // directory). See the file header comment for the upstream-gap
    // rationale.
    if ((contract.mode & ~0o777) !== 0 && (st.mode & 0o7777) !== contract.mode) {
      await applyModeViaSpawnChmod(dir, contract.mode);
      // Re-stat (no symlink follow) to guard against a rename race
      // between the validating lstat and the chmod spawn; if anything
      // unexpected happened, surface it now rather than handing the
      // directory back to the caller.
      st = await lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error(
          `Upload directory changed unexpectedly during mode apply: ${dir}`,
        );
      }
    }

    const actualMode = st.mode & 0o7777;
    if (actualMode !== contract.mode) {
      throw new Error(
        `Upload directory has unexpected mode ${actualMode.toString(8)} (expected ${contract.mode.toString(8)}): ${dir}`,
      );
    }
  } catch (err) {
    logger.error({ err, dir }, 'Upload directory verification failed');
    throw err;
  }
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
    // Issue #869: thread the authenticated OS username so multi-user mode
    // runs the worktree's git ops as the worktree owner (avoiding
    // "dubious ownership in repository"). `runAsUser` bypasses elevation
    // in single-user mode regardless of this value.
    const authUser = c.get('authUser');

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
    const resolved = await resolveBaseSpec(worker.baseCommit, session.locationPath, authUser.username);
    if (!resolved) {
      throw new ValidationError(`Could not resolve diff base: ${worker.baseCommit}`);
    }
    const diffData = await getDiffData(session.locationPath, resolved, authUser.username);

    return c.json(diffData);
  })
  // Get diff for a specific file
  .get('/:sessionId/workers/:workerId/diff/file', async (c) => {
    const sessionId = c.req.param('sessionId');
    const workerId = c.req.param('workerId');
    const filePath = c.req.query('path');
    // Issue #869: thread the authenticated OS username so multi-user mode
    // runs the worktree's git ops as the worktree owner.
    const authUser = c.get('authUser');

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
    const resolved = await resolveBaseSpec(worker.baseCommit, session.locationPath, authUser.username);
    if (!resolved) {
      throw new ValidationError(`Could not resolve diff base: ${worker.baseCommit}`);
    }
    const rawDiff = await getFileDiff(session.locationPath, resolved, filePath, authUser.username);

    return c.json({ rawDiff });
  });

export { workers };

/**
 * @internal Exported for the real-fs regression test in
 * `workers-upload-dir-real-fs.test.ts` (Issue #830 follow-up). Production
 * callers should never reach for these; they go through the route handler.
 */
export const __TESTING__ = {
  ensureUploadDir,
  resolveUploadDir,
  resolveUploadDirContract,
};
