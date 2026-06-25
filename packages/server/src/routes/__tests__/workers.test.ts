import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as os from 'os';
import { join as pathJoin } from 'path';
import { Hono } from 'hono';
import { onApiError } from '../../lib/error-handler.js';
import { api } from '../api.js';
import type { AppBindings } from '../../app-context.js';
import { asAppContext } from '../../__tests__/test-utils.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { mockGit, resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { AgentManager } from '../../services/agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { SingleUserMode } from '../../services/user-mode.js';
import { JobQueue } from '../../jobs/job-queue.js';
import { registerJobHandlers } from '../../jobs/handlers.js';
import { WorkerOutputFileManager } from '../../lib/worker-output-file.js';
import { SessionManager } from '../../services/session-manager.js';
import { JsonSessionRepository } from '../../repositories/index.js';
import { MAX_MESSAGE_FILES, MAX_TOTAL_FILE_SIZE } from '@agent-console/shared';

// Config dir is memfs-only; uploads target a per-uid /tmp dir by spec (see #821).
// memfs hooks fs/promises so the route's mkdir lands in memfs, which we then
// inspect for the requested mode via memfs's `vol.statSync`. (Bun.write is
// native and would land on real disk, but its parent-dir auto-creation uses
// the default mode and would shadow the route's mkdir mode contract — so we
// do not rely on real-disk stat for the mode assertion.)
const TEST_CONFIG_DIR = '/test/config';

const ptyFactory = createMockPtyFactory(20000);

describe('Workers API', () => {
  let app: Hono<AppBindings>;
  let sessionManager: SessionManager;
  let testJobQueue: JobQueue;

  beforeEach(async () => {
    await closeDatabase();

    resetGitMocks();
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    await initializeDatabase(':memory:');

    testJobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(testJobQueue, new WorkerOutputFileManager());

    resetProcessMock();
    mockProcess.markAlive(process.pid);

    ptyFactory.reset();

    const db = getDatabase();
    const agentMgr = await AgentManager.create(new SqliteAgentRepository(db));

    const sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);

    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager: agentMgr,
      repositoryLookup: { getRepositorySlug: () => 'test-repo' },
      repositoryEnvLookup: {
        getRepositoryInfo: () => ({ name: 'test-repo', path: '/test/repo' }),
        getWorktreeIndexNumber: async () => 0,
      },
    });

    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', asAppContext({ sessionManager }));
      await next();
    });
    app.onError(onApiError);
    app.route('/api', api);
  });

  afterEach(async () => {
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
    resetProcessMock();
    // Note: per-uid upload dir under os.tmpdir() is intentionally NOT cleaned
    // up here — the production design relies on OS-level /tmp reapers
    // (systemd-tmpfiles / tmpwatch / reboot) and the path is shared across
    // every test run for this uid. See #821.
  });

  // ===========================================================================
  // GET /api/sessions/:sessionId/workers
  // ===========================================================================

  describe('GET /api/sessions/:sessionId/workers', () => {
    it('should return 404 for non-existent session', async () => {
      const res = await app.request('/api/sessions/non-existent-id/workers', {
        method: 'GET',
      });

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Session');
    });

    it('should return empty worker list for a new session', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const res = await app.request(`/api/sessions/${session.id}/workers`, {
        method: 'GET',
      });

      expect(res.status).toBe(200);

      const body = (await res.json()) as { workers: unknown[] };
      expect(body.workers).toBeArray();
    });
  });

  // ===========================================================================
  // POST /api/sessions/:sessionId/messages — Security-critical
  // ===========================================================================

  describe('POST /api/sessions/:sessionId/messages', () => {
    it('should return 404 when sending to non-existent session', async () => {
      const formData = new FormData();
      formData.append('toWorkerId', 'some-worker-id');
      formData.append('content', 'hello');

      const res = await app.request('/api/sessions/non-existent-id/messages', {
        method: 'POST',
        body: formData,
      });

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Session');
    });

    it('should return 400 when message has no content and no files', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Need a real worker ID for toWorkerId validation
      const formData = new FormData();
      formData.append('toWorkerId', 'some-worker-id');
      formData.append('content', '');

      const res = await app.request(`/api/sessions/${session.id}/messages`, {
        method: 'POST',
        body: formData,
      });

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('content or at least one file');
    });

    it('should return 400 when too many files are attached', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const formData = new FormData();
      formData.append('toWorkerId', 'some-worker-id');
      formData.append('content', 'hello');

      // Attach more than MAX_MESSAGE_FILES
      for (let i = 0; i < MAX_MESSAGE_FILES + 1; i++) {
        const file = new File(['content'], `file-${i}.txt`, { type: 'text/plain' });
        formData.append('files', file);
      }

      const res = await app.request(`/api/sessions/${session.id}/messages`, {
        method: 'POST',
        body: formData,
      });

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Too many files');
    });

    it('should return 400 when total file size exceeds limit', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const formData = new FormData();
      formData.append('toWorkerId', 'some-worker-id');
      formData.append('content', 'hello');

      // Create a file that exceeds MAX_TOTAL_FILE_SIZE
      const largeContent = new Uint8Array(MAX_TOTAL_FILE_SIZE + 1);
      const file = new File([largeContent], 'large-file.bin', { type: 'application/octet-stream' });
      formData.append('files', file);

      const res = await app.request(`/api/sessions/${session.id}/messages`, {
        method: 'POST',
        body: formData,
      });

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Total file size exceeds limit');
    });

    // Issue #830 removed the in-process readiness cache; ensureUploadDir() now
    // mkdir+lstat-verifies on every upload, so the order of tests within this
    // describe block no longer matters.
    it('should save uploaded files under /tmp/agent-console-uploads-<uid>/ with mode 0700 (#821)', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const worker = await sessionManager.createWorker(session.id, {
        type: 'agent',
        agentId: 'claude-code',
      });
      expect(worker).not.toBeNull();

      // Spy on Bun.write to capture the actual file path the route writes to.
      // Bun.write is a native API and is not trapped by the memfs fs/promises
      // mock, so a path-based assertion via the spy is the cleanest cross-check
      // for the destination path.
      const writtenPaths: string[] = [];
      const originalBunWrite = Bun.write;
      Bun.write = ((dest: unknown, input: unknown, options?: unknown) => {
        if (typeof dest === 'string') {
          writtenPaths.push(dest);
        }
        return originalBunWrite(
          dest as Parameters<typeof originalBunWrite>[0],
          input as Parameters<typeof originalBunWrite>[1],
          options as Parameters<typeof originalBunWrite>[2],
        );
      }) as typeof Bun.write;

      try {
        const formData = new FormData();
        formData.append('toWorkerId', worker!.id);
        formData.append('content', 'msg');
        formData.append('files', new File(['data'], 'test.txt', { type: 'text/plain' }));

        const res = await app.request(`/api/sessions/${session.id}/messages`, {
          method: 'POST',
          body: formData,
        });
        expect(res.status).toBe(201);

        expect(writtenPaths.length).toBeGreaterThan(0);

        const euid: number | 'shared' =
          typeof process.geteuid === 'function' ? process.geteuid() : 'shared';
        const expectedUploadDir = pathJoin(os.tmpdir(), `agent-console-uploads-${euid}`);
        const hostSharedLegacy = pathJoin(os.tmpdir(), 'agent-console-uploads');
        for (const filePath of writtenPaths) {
          // Path scoping: per-uid dir under os.tmpdir(), never the host-shared
          // legacy bare dir.
          expect(filePath.startsWith(expectedUploadDir + '/')).toBe(true);
          expect(filePath === hostSharedLegacy).toBe(false);
          expect(filePath.startsWith(hostSharedLegacy + '/')).toBe(false);
        }

        // Verify mode 0700 on the upload directory via memfs's vol — the
        // route's `mkdir(..., { mode: 0o700 })` is intercepted by memfs and
        // recorded with mode preserved.
        const { vol } = await import('memfs');
        const stat = vol.statSync(expectedUploadDir);
        // mode includes the file-type bits; mask to perm bits only.
        const perm = (stat.mode & 0o777).toString(8);
        expect(perm).toBe('700');
      } finally {
        Bun.write = originalBunWrite;
      }
    });

    // TOCTOU defense (security review HIGH, #821 follow-up): a pre-created
    // symlink at the upload-dir path would silently slip past
    // `mkdir(..., { mode: 0o700 })`, so the route must lstat after mkdir and
    // reject the symlink before any Bun.write touches real disk.
    it('should reject a pre-existing symlink at the upload directory path (#821 TOCTOU defense)', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const worker = await sessionManager.createWorker(session.id, {
        type: 'agent',
        agentId: 'claude-code',
      });
      expect(worker).not.toBeNull();

      const euid: number | 'shared' =
        typeof process.geteuid === 'function' ? process.geteuid() : 'shared';
      const expectedUploadDir = pathJoin(os.tmpdir(), `agent-console-uploads-${euid}`);

      const { vol } = await import('memfs');
      // The earlier mode-0700 test may have created the dir; remove it before
      // symlinking. Either way we end up with a symlink at the path.
      try {
        vol.rmdirSync(expectedUploadDir);
      } catch {
        // ignore: not present
      }
      // The symlink's parent directory must exist in memfs for symlinkSync to
      // succeed. The OS tmpdir is real, but memfs is a separate volume.
      vol.mkdirSync(os.tmpdir(), { recursive: true });
      // The symlink target must also exist in memfs.
      vol.symlinkSync(TEST_CONFIG_DIR, expectedUploadDir);

      // Count Bun.write calls to assert the route rejected BEFORE any write —
      // without this, a generic Bun.write failure (e.g. ENOENT) could pass an
      // any-5xx assertion and the test would not actually exercise the lstat
      // verification path.
      const writtenPaths: string[] = [];
      const originalBunWrite = Bun.write;
      Bun.write = ((dest: unknown) => {
        if (typeof dest === 'string') {
          writtenPaths.push(dest);
        }
        // Return a rejected promise so that if verification fails to block
        // the write, the route still surfaces a 5xx but our paths-count
        // assertion exposes the bypass.
        return Promise.reject(new Error('Bun.write must not be called'));
      }) as typeof Bun.write;

      try {
        const formData = new FormData();
        formData.append('toWorkerId', worker!.id);
        formData.append('content', 'msg');
        formData.append('files', new File(['data'], 'test.txt', { type: 'text/plain' }));

        const res = await app.request(`/api/sessions/${session.id}/messages`, {
          method: 'POST',
          body: formData,
        });

        // Production code rejects with a thrown Error; the global error
        // handler maps unhandled errors to 5xx.
        expect(res.status).toBeGreaterThanOrEqual(500);
        // The TOCTOU guard rejects before any file is written. Without the
        // guard, Bun.write would be invoked once per attached file.
        expect(writtenPaths).toEqual([]);
      } finally {
        Bun.write = originalBunWrite;
        try {
          vol.unlinkSync(expectedUploadDir);
        } catch {
          // ignore
        }
      }
    });

    // TOCTOU defense (security review HIGH, #821 follow-up): a pre-existing
    // dir with a wider mode (e.g. 0o777) lets other users on the same host
    // read buffered upload contents. mkdir is a no-op when the path exists,
    // so the route must lstat-verify the actual mode.
    it('should reject a pre-existing upload directory with the wrong mode (#821 TOCTOU defense)', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const worker = await sessionManager.createWorker(session.id, {
        type: 'agent',
        agentId: 'claude-code',
      });
      expect(worker).not.toBeNull();

      const euid: number | 'shared' =
        typeof process.geteuid === 'function' ? process.geteuid() : 'shared';
      const expectedUploadDir = pathJoin(os.tmpdir(), `agent-console-uploads-${euid}`);

      const { vol } = await import('memfs');
      try {
        vol.rmdirSync(expectedUploadDir);
      } catch {
        // ignore
      }
      // Pre-create with world-writable mode. mkdir(..., {mode: 0o700}) is a
      // POSIX no-op for an existing dir, so the mode stays 0o777.
      vol.mkdirSync(os.tmpdir(), { recursive: true });
      vol.mkdirSync(expectedUploadDir, { recursive: true, mode: 0o777 });

      const writtenPaths: string[] = [];
      const originalBunWrite = Bun.write;
      Bun.write = ((dest: unknown) => {
        if (typeof dest === 'string') {
          writtenPaths.push(dest);
        }
        return Promise.reject(new Error('Bun.write must not be called'));
      }) as typeof Bun.write;

      try {
        const formData = new FormData();
        formData.append('toWorkerId', worker!.id);
        formData.append('content', 'msg');
        formData.append('files', new File(['data'], 'test.txt', { type: 'text/plain' }));

        const res = await app.request(`/api/sessions/${session.id}/messages`, {
          method: 'POST',
          body: formData,
        });

        expect(res.status).toBeGreaterThanOrEqual(500);
        // The TOCTOU guard rejects before any file is written.
        expect(writtenPaths).toEqual([]);
      } finally {
        Bun.write = originalBunWrite;
        try {
          vol.rmdirSync(expectedUploadDir);
        } catch {
          // ignore
        }
      }
    });

    // Issue #830 follow-up: the regression test for Bun's JS-layer mode
    // stripping (which causes fs.mkdir({ mode: 0o2750 }) to issue
    // mkdirat(..., 0750)) lives in workers-upload-dir-real-fs.test.ts —
    // a separate file that does NOT import the memfs hook. mock.module is
    // process-global and irreversible in bun:test (see testing.md
    // "Module-Level Mocking" anti-pattern), so the only way to exercise
    // the real Bun fs binding is via a sibling test file with no memfs
    // hook AND via Bun.spawn-based shell probes that bypass fs/promises
    // altogether.
    //
    // The memfs-based multi-user test that previously lived here passed
    // for the wrong reason: memfs's mkdir honours the mode arg literally,
    // including special bits, so the Bun JS-layer setgid stripping was
    // never exercised and the production bug shipped to a real Ubuntu
    // host.

    // Issue #830: the in-process readiness cache was removed so that a long-
    // running multi-user deployment recovers if /tmp is reaped by
    // systemd-tmpfiles during uptime. After a successful upload, remove the
    // directory and verify the next upload re-creates it (no stale-cache
    // short-circuit).
    it('should re-create the upload directory if it is reaped during runtime (#830)', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const worker = await sessionManager.createWorker(session.id, {
        type: 'agent',
        agentId: 'claude-code',
      });
      expect(worker).not.toBeNull();

      const euid: number | 'shared' =
        typeof process.geteuid === 'function' ? process.geteuid() : 'shared';
      const expectedUploadDir = pathJoin(os.tmpdir(), `agent-console-uploads-${euid}`);

      const { vol } = await import('memfs');

      const originalBunWrite = Bun.write;
      Bun.write = ((dest: unknown, input: unknown, options?: unknown) => {
        return originalBunWrite(
          dest as Parameters<typeof originalBunWrite>[0],
          input as Parameters<typeof originalBunWrite>[1],
          options as Parameters<typeof originalBunWrite>[2],
        );
      }) as typeof Bun.write;

      try {
        // First upload — creates the directory.
        const firstForm = new FormData();
        firstForm.append('toWorkerId', worker!.id);
        firstForm.append('content', 'first');
        firstForm.append('files', new File(['a'], 'first.txt', { type: 'text/plain' }));
        const first = await app.request(`/api/sessions/${session.id}/messages`, {
          method: 'POST',
          body: firstForm,
        });
        expect(first.status).toBe(201);

        // Simulate systemd-tmpfiles reaping /tmp under us.
        // Remove file children first so rmdirSync succeeds.
        const entries = vol.readdirSync(expectedUploadDir);
        for (const entry of entries) {
          vol.unlinkSync(pathJoin(expectedUploadDir, String(entry)));
        }
        vol.rmdirSync(expectedUploadDir);
        // Confirm the dir is actually gone before the second upload.
        let removed = false;
        try {
          vol.statSync(expectedUploadDir);
        } catch {
          removed = true;
        }
        expect(removed).toBe(true);

        // Second upload — must re-create the directory (no stale cache).
        const secondForm = new FormData();
        secondForm.append('toWorkerId', worker!.id);
        secondForm.append('content', 'second');
        secondForm.append('files', new File(['b'], 'second.txt', { type: 'text/plain' }));
        const second = await app.request(`/api/sessions/${session.id}/messages`, {
          method: 'POST',
          body: secondForm,
        });
        expect(second.status).toBe(201);

        // The directory must exist again.
        const stat = vol.statSync(expectedUploadDir);
        expect(stat.isDirectory()).toBe(true);
      } finally {
        Bun.write = originalBunWrite;
      }
    });

    it('should sanitize path traversal in filenames', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Create a worker so the message can be delivered
      const worker = await sessionManager.createWorker(session.id, {
        type: 'agent',
        agentId: 'claude-code',
      });
      expect(worker).not.toBeNull();

      const formData = new FormData();
      formData.append('toWorkerId', worker!.id);
      formData.append('content', 'test message');

      // Attach a file with a path traversal filename
      const maliciousFile = new File(['malicious content'], '../../etc/passwd', {
        type: 'text/plain',
      });
      formData.append('files', maliciousFile);

      const res = await app.request(`/api/sessions/${session.id}/messages`, {
        method: 'POST',
        body: formData,
      });

      // The request should succeed (201) because the filename is sanitized
      expect(res.status).toBe(201);

      const body = (await res.json()) as { message: { filePaths?: string[] } };
      expect(body.message).toBeDefined();

      // Verify the saved file path does not contain directory traversal sequences
      if (body.message.filePaths && body.message.filePaths.length > 0) {
        for (const filePath of body.message.filePaths) {
          expect(filePath).not.toContain('..');
          expect(filePath).not.toMatch(/[/\\]\.\.[/\\]/);
        }
      }
    });

    it('should validate session exists before writing files to disk', async () => {
      // Sending to a non-existent session with files should return 404
      // without writing any files to disk (session check happens before file write)
      const formData = new FormData();
      formData.append('toWorkerId', 'some-worker-id');
      formData.append('content', 'hello');

      const file = new File(['test content'], 'test.txt', { type: 'text/plain' });
      formData.append('files', file);

      const res = await app.request('/api/sessions/non-existent-id/messages', {
        method: 'POST',
        body: formData,
      });

      // Session validation happens BEFORE file writing, so we get 404
      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Session');
    });
  });

  // ===========================================================================
  // POST /api/sessions/:sessionId/workers — Create worker
  // ===========================================================================

  describe('POST /api/sessions/:sessionId/workers', () => {
    it('should return 404 for non-existent session', async () => {
      const res = await app.request('/api/sessions/non-existent-id/workers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'terminal' }),
      });

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Session');
    });

    it('should create a terminal worker successfully', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const res = await app.request(`/api/sessions/${session.id}/workers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'terminal' }),
      });

      expect(res.status).toBe(201);

      const body = (await res.json()) as { worker: { id: string; type: string } };
      expect(body.worker).toBeDefined();
      expect(body.worker.id).toBeString();
      expect(body.worker.type).toBe('terminal');
    });
  });

  // ===========================================================================
  // DELETE /api/sessions/:sessionId/workers/:workerId
  // ===========================================================================

  describe('DELETE /api/sessions/:sessionId/workers/:workerId', () => {
    it('should return 404 for non-existent session', async () => {
      const res = await app.request('/api/sessions/non-existent-id/workers/some-worker-id', {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Session');
    });

    it('should return 404 for non-existent worker in existing session', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const res = await app.request(`/api/sessions/${session.id}/workers/non-existent-worker`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Worker');
    });
  });

  // ===========================================================================
  // POST /api/sessions/:sessionId/workers/:workerId/restart
  // ===========================================================================

  describe('POST /api/sessions/:sessionId/workers/:workerId/restart', () => {
    it('should return 404 for non-existent worker', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const res = await app.request(
        `/api/sessions/${session.id}/workers/non-existent-worker/restart`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Worker');
    });
  });

  // ===========================================================================
  // GET /api/sessions/:sessionId/workers/:workerId/diff
  // Re-resolves the persisted base *spec* to a concrete hash at diff time (#800)
  // ===========================================================================

  describe('GET /api/sessions/:sessionId/workers/:workerId/diff', () => {
    it('resolves the base spec to a hash and diffs against the resolved hash', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Create a git-diff worker whose persisted baseCommit is a SPEC (not a hash).
      const worker = await sessionManager.createWorker(session.id, {
        type: 'git-diff',
        baseCommit: 'merge-base:origin/main',
      });
      expect(worker).not.toBeNull();
      expect(worker!.type).toBe('git-diff');

      // resolveBaseSpec for a `merge-base:` spec calls getMergeBaseSafe(ref, HEAD).
      mockGit.getMergeBaseSafe.mockImplementation((ref1: string) =>
        Promise.resolve(ref1 === 'origin/main' ? 'resolvedbase999' : null),
      );
      // getDiffData reads these; defaults are empty, set a numstat so a file appears.
      mockGit.getDiff.mockImplementation(() => Promise.resolve('diff --git a/foo b/foo\n'));
      mockGit.getDiffNumstat.mockImplementation(() => Promise.resolve('1\t0\tfoo\n'));

      const res = await app.request(
        `/api/sessions/${session.id}/workers/${worker!.id}/diff`,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        summary: { baseCommit: string; files: { path: string }[] };
        rawDiff: string;
      };

      // The diff must have been computed against the RESOLVED hash, not the raw spec.
      expect(body.summary.baseCommit).toBe('resolvedbase999');
      expect(body.summary.baseCommit).not.toBe('merge-base:origin/main');
      expect(body.summary.files.map((f) => f.path)).toContain('foo');
      // getDiff was invoked with the resolved hash as its base ref.
      const getDiffCalls = mockGit.getDiff.mock.calls;
      expect(getDiffCalls.length).toBeGreaterThan(0);
      expect(getDiffCalls[0][0]).toBe('resolvedbase999');
    });

    it('surfaces a 4xx error when the base spec cannot be resolved (no silent empty diff)', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const worker = await sessionManager.createWorker(session.id, {
        type: 'git-diff',
        baseCommit: 'merge-base:origin/main',
      });
      expect(worker).not.toBeNull();

      // Resolution genuinely fails (unrelated histories / deleted ref).
      mockGit.getMergeBaseSafe.mockImplementation(() => Promise.resolve(null));

      const res = await app.request(
        `/api/sessions/${session.id}/workers/${worker!.id}/diff`,
      );

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Could not resolve diff base');
      expect(body.error).toContain('merge-base:origin/main');
    });

    it('threads the session spawn username into the git-diff service (Issue #869 + CodeRabbit lesson)', async () => {
      // The route must forward the SESSION'S spawn user (resolved via
      // resolveSpawnUsername(session.createdBy, userRepository)), NOT the
      // authenticated viewer. For shared sessions the spawn user is the
      // shared account, so using the viewer's identity would reintroduce
      // dubious-ownership / missing-credential errors on user-owned worktrees.
      //
      // Override the route's appContext with a userRepository stub that
      // resolves a known createdBy to a specific OS username. The mockGit.*
      // calls then receive that username as their trailing argument.
      const mockUserRepository: any = {
        findById: (id: string) =>
          id === 'shared-account-id'
            ? Promise.resolve({ id, username: 'sharedacct', homeDir: '/home/sharedacct' })
            : Promise.resolve(null),
      };
      const elevatedApp = new Hono<AppBindings>();
      elevatedApp.use('*', async (c, next) => {
        c.set('appContext', asAppContext({ sessionManager, userRepository: mockUserRepository }));
        await next();
      });
      elevatedApp.onError(onApiError);
      elevatedApp.route('/api', api);

      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      // Patch the internal session's createdBy directly to simulate a shared
      // session. The public Session returned by getSession is a fresh object
      // each call, so we must mutate the internal map entry.
      const internalSessions = (sessionManager as unknown as { sessions: Map<string, { createdBy?: string }> }).sessions;
      const internalSession = internalSessions.get(session.id)!;
      internalSession.createdBy = 'shared-account-id';

      const worker = await sessionManager.createWorker(session.id, {
        type: 'git-diff',
        baseCommit: 'merge-base:origin/main',
      });
      expect(worker).not.toBeNull();

      mockGit.getMergeBaseSafe.mockImplementation(() => Promise.resolve('resolvedbase999'));
      mockGit.getDiff.mockImplementation(() => Promise.resolve(''));
      mockGit.getDiffNumstat.mockImplementation(() => Promise.resolve(''));
      mockGit.getMergeBaseSafe.mockClear();

      const res = await elevatedApp.request(
        `/api/sessions/${session.id}/workers/${worker!.id}/diff`,
      );

      expect(res.status).toBe(200);
      // mockGit.getMergeBaseSafe is called as
      // (ref1, ref2, cwd, requestUser). Assert the SHARED-account username
      // landed there, NOT the authenticated viewer.
      const calls = mockGit.getMergeBaseSafe.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const lastCall = calls[calls.length - 1] as unknown as [string, string, string, string | null];
      expect(lastCall[3]).toBe('sharedacct');
    });
  });

  // ===========================================================================
  // GET /api/sessions/:sessionId/workers/:workerId/diff/file
  // ===========================================================================

  describe('GET /api/sessions/:sessionId/workers/:workerId/diff/file', () => {
    it('resolves the base spec then returns the per-file diff', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const worker = await sessionManager.createWorker(session.id, {
        type: 'git-diff',
        baseCommit: 'merge-base:origin/main',
      });
      expect(worker).not.toBeNull();

      mockGit.getMergeBaseSafe.mockImplementation(() => Promise.resolve('resolvedbase999'));
      // getFileDiff uses gitRaw(['diff', baseCommit, '--', filePath]).
      mockGit.gitRaw.mockImplementation(() =>
        Promise.resolve('diff --git a/foo b/foo\n+added\n'),
      );

      const res = await app.request(
        `/api/sessions/${session.id}/workers/${worker!.id}/diff/file?path=foo`,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { rawDiff: string };
      expect(body.rawDiff).toContain('diff --git a/foo b/foo');
      // The per-file diff resolved the spec to a hash before calling git diff.
      const gitRawCalls = mockGit.gitRaw.mock.calls;
      const fileDiffCall = gitRawCalls.find((args) => args[0]?.[0] === 'diff');
      expect(fileDiffCall).toBeDefined();
      // args[0] is the git arg array: ['diff', <resolvedBase>, '--', 'foo'].
      expect(fileDiffCall![0][1]).toBe('resolvedbase999');
    });

    it('surfaces a 4xx error when the base spec cannot be resolved', async () => {
      const session = await sessionManager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const worker = await sessionManager.createWorker(session.id, {
        type: 'git-diff',
        baseCommit: 'merge-base:origin/main',
      });
      expect(worker).not.toBeNull();

      mockGit.getMergeBaseSafe.mockImplementation(() => Promise.resolve(null));

      const res = await app.request(
        `/api/sessions/${session.id}/workers/${worker!.id}/diff/file?path=foo`,
      );

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Could not resolve diff base');
    });
  });
});
