/**
 * Tests for cleanup job handlers.
 *
 * Key invariants (see docs/design/session-data-path.md §4):
 * - Handler MUST reconstruct the resolver from `(scope, slug)` via
 *   `computeSessionDataBaseDir` — not from a legacy `repositoryName` field.
 * - Invalid payloads (bad scope, path-escape slug) MUST be logged and skipped
 *   without any filesystem operation.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as os from 'os';
import * as path from 'path';
import { JOB_TYPES } from '@agent-console/shared';
import type {
  CleanupRepositoryPayload,
  CleanupSessionOutputsPayload,
  CleanupWorkerOutputPayload,
} from '@agent-console/shared';
import type { JobQueue, JobHandler } from '../job-queue.js';
import { registerJobHandlers } from '../handlers.js';
import { WorkerOutputFileManager } from '../../lib/worker-output-file.js';
import { SessionDataPathResolver } from '../../lib/session-data-path-resolver.js';
import type { RunAsUserResult } from '../../services/privilege-elevation.js';

const TEST_CONFIG = '/test/config';

/**
 * Captured arguments for `rmRecursiveAsUser` (PR #888). Mirrors the helper's
 * positional signature so the test seam can assert path / username / opts
 * directly — no need to inspect the underlying `rm -rf -- '<...>'` command
 * shape (the helper's own unit tests already cover that argv).
 */
interface RmRecursiveAsUserCall {
  path: string;
  username: string | null | undefined;
  opts: { timeoutMs?: number } | undefined;
}

/**
 * Capture-and-respond fake for `rmRecursiveAsUser`. Default response succeeds;
 * tests override `responder.fn` for failure / timeout scenarios.
 */
function createRmRecursiveAsUserMock() {
  const calls: RmRecursiveAsUserCall[] = [];
  const responder = {
    fn: async (
      _path: string,
      _username: string | null | undefined,
      _opts: { timeoutMs?: number } | undefined,
    ): Promise<RunAsUserResult> => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }),
  };
  const rmRecursiveAsUserImpl = (
    path: string,
    username: string | null | undefined,
    opts?: { timeoutMs?: number },
  ) => {
    calls.push({ path, username, opts });
    return responder.fn(path, username, opts);
  };
  return { calls, rmRecursiveAsUserImpl, responder };
}

describe('cleanup job handlers', () => {
  let handlers: Map<string, JobHandler<unknown>>;
  let workerOutputFileManager: WorkerOutputFileManager;
  let deleteSessionOutputs: ReturnType<typeof mock>;
  let deleteWorkerOutput: ReturnType<typeof mock>;
  let rmRecursiveAsUserMock: ReturnType<typeof createRmRecursiveAsUserMock>;
  const originalAuthMode = process.env.AUTH_MODE;

  beforeEach(() => {
    handlers = new Map();
    deleteSessionOutputs = mock(async (_sessionId: string, _resolver: SessionDataPathResolver) => {});
    deleteWorkerOutput = mock(
      async (_sessionId: string, _workerId: string, _resolver: SessionDataPathResolver) => {}
    );
    // Stub only the two cleanup methods we care about. Using a real instance
    // as the prototype keeps the type contract honest (no unsafe casts) and
    // the spies still capture every call.
    workerOutputFileManager = new WorkerOutputFileManager();
    workerOutputFileManager.deleteSessionOutputs =
      deleteSessionOutputs as unknown as WorkerOutputFileManager['deleteSessionOutputs'];
    workerOutputFileManager.deleteWorkerOutput =
      deleteWorkerOutput as unknown as WorkerOutputFileManager['deleteWorkerOutput'];

    const fakeQueue: JobQueue = {
      registerHandler: <T>(type: string, handler: JobHandler<T>) => {
        handlers.set(type, handler as JobHandler<unknown>);
      },
      // The handler-registration entry point only needs registerHandler;
      // the rest of the JobQueue surface is intentionally unused here.
    } as unknown as JobQueue;

    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG;
    rmRecursiveAsUserMock = createRmRecursiveAsUserMock();
    registerJobHandlers(fakeQueue, workerOutputFileManager, {
      rmRecursiveAsUserImpl: rmRecursiveAsUserMock.rmRecursiveAsUserImpl,
    });
  });

  afterEach(() => {
    if (originalAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = originalAuthMode;
    }
  });

  describe('CLEANUP_SESSION_OUTPUTS', () => {
    async function runPayload(payload: CleanupSessionOutputsPayload): Promise<void> {
      const handler = handlers.get(JOB_TYPES.CLEANUP_SESSION_OUTPUTS)!;
      await handler(payload);
    }

    it('executes cleanup for valid repository scope and uses the repository base dir', async () => {
      await runPayload({ sessionId: 'sid-1', scope: 'repository', slug: 'owner/repo' });
      expect(deleteSessionOutputs).toHaveBeenCalledTimes(1);

      const [sessionId, resolver] = deleteSessionOutputs.mock.calls[0] as [string, SessionDataPathResolver];
      expect(sessionId).toBe('sid-1');
      // The resolver's outputs dir should be rooted at the repository scope path,
      // never the `_quick` fallback.
      expect(resolver.getOutputsDir()).toBe(path.resolve(TEST_CONFIG, 'repositories', 'owner', 'repo', 'outputs'));
    });

    it('executes cleanup for valid quick scope and uses the _quick base dir', async () => {
      await runPayload({ sessionId: 'sid-1', scope: 'quick', slug: null });
      expect(deleteSessionOutputs).toHaveBeenCalledTimes(1);

      const [sessionId, resolver] = deleteSessionOutputs.mock.calls[0] as [string, SessionDataPathResolver];
      expect(sessionId).toBe('sid-1');
      expect(resolver.getOutputsDir()).toBe(path.resolve(TEST_CONFIG, '_quick', 'outputs'));
    });

    it('logs and skips on invalid slug (path traversal attempt)', async () => {
      await runPayload({ sessionId: 'sid-1', scope: 'repository', slug: '../etc' });
      expect(deleteSessionOutputs).not.toHaveBeenCalled();
    });

    it('logs and skips when scope=quick has a non-null slug', async () => {
      await runPayload({ sessionId: 'sid-1', scope: 'quick', slug: 'unexpected' });
      expect(deleteSessionOutputs).not.toHaveBeenCalled();
    });

    it('logs and skips when scope=repository has no slug', async () => {
      await runPayload({ sessionId: 'sid-1', scope: 'repository', slug: null });
      expect(deleteSessionOutputs).not.toHaveBeenCalled();
    });
  });

  describe('CLEANUP_WORKER_OUTPUT', () => {
    async function runPayload(payload: CleanupWorkerOutputPayload): Promise<void> {
      const handler = handlers.get(JOB_TYPES.CLEANUP_WORKER_OUTPUT)!;
      await handler(payload);
    }

    it('executes cleanup for valid repository scope and resolves the per-worker file path', async () => {
      await runPayload({ sessionId: 'sid', workerId: 'wid', scope: 'repository', slug: 'owner/repo' });
      expect(deleteWorkerOutput).toHaveBeenCalledTimes(1);

      const [sessionId, workerId, resolver] = deleteWorkerOutput.mock.calls[0] as [
        string,
        string,
        SessionDataPathResolver,
      ];
      expect(sessionId).toBe('sid');
      expect(workerId).toBe('wid');
      expect(resolver.getOutputFilePath('sid', 'wid')).toBe(
        path.resolve(TEST_CONFIG, 'repositories', 'owner', 'repo', 'outputs', 'sid', 'wid.log')
      );
    });

    it('logs and skips on invalid slug', async () => {
      await runPayload({ sessionId: 'sid', workerId: 'wid', scope: 'repository', slug: '/absolute/path' });
      expect(deleteWorkerOutput).not.toHaveBeenCalled();
    });
  });

  describe('CLEANUP_REPOSITORY (Issue #884)', () => {
    async function runPayload(payload: CleanupRepositoryPayload): Promise<void> {
      const handler = handlers.get(JOB_TYPES.CLEANUP_REPOSITORY)!;
      await handler(payload);
    }

    /**
     * Pick a username guaranteed to differ from the server process user so
     * `shouldElevateForUser` returns true under `AUTH_MODE=multi-user`. We
     * avoid hard-coding 'ms2sato' / similar because tests must pass on any
     * developer's box.
     */
    function pickOtherUser(): string {
      const me = os.userInfo().username;
      return me === 'tester' ? 'other-user' : 'tester';
    }

    it('bypasses rmRecursiveAsUser when requestUsername is null (direct fs.rm path)', async () => {
      // Multi-user mode still falls back to direct fs.rm when no username is
      // threaded (e.g., a non-route caller). The ENOENT on the non-existent
      // path is swallowed by the handler's idempotent-skip branch -- no throw.
      process.env.AUTH_MODE = 'multi-user';
      await runPayload({
        repoDir: '/var/lib/agent-console/repositories/no-such-org/no-such-repo',
        requestUsername: null,
      });
      expect(rmRecursiveAsUserMock.calls.length).toBe(0);
    });

    it('treats ENOENT as success on the direct fs.rm path (idempotent)', async () => {
      delete process.env.AUTH_MODE;
      await runPayload({
        repoDir: '/var/lib/agent-console/repositories/missing/' + Date.now(),
        requestUsername: null,
      });
      // No throw = success. The helper must not have been touched.
      expect(rmRecursiveAsUserMock.calls.length).toBe(0);
    });

    it('elevates via rmRecursiveAsUser when AUTH_MODE=multi-user and requestUsername targets another user', async () => {
      process.env.AUTH_MODE = 'multi-user';
      const other = pickOtherUser();
      const repoDir = '/var/lib/agent-console/repositories/org/repo';

      await runPayload({ repoDir, requestUsername: other });

      // Layering contract: handler invokes rmRecursiveAsUser with the raw
      // path + username and a timeout. The helper's own unit tests cover the
      // underlying `rm -rf --` argv shape -- the handler test does not
      // re-assert it here (would be a layer leak from the handler to the
      // helper).
      expect(rmRecursiveAsUserMock.calls.length).toBe(1);
      const call = rmRecursiveAsUserMock.calls[0]!;
      expect(call.path).toBe(repoDir);
      expect(call.username).toBe(other);
      expect(call.opts?.timeoutMs).toBeGreaterThan(0);
    });

    it('falls back to direct fs.rm when AUTH_MODE is none (single-user) even with a username', async () => {
      // Same-user / non-multi-user means shouldElevateForUser returns false,
      // so the handler stays on the direct fs.rm path. We pass a missing
      // path so the ENOENT branch silently returns.
      delete process.env.AUTH_MODE;
      await runPayload({
        repoDir: '/var/lib/agent-console/repositories/no-such-org/no-such-repo',
        requestUsername: 'someone',
      });
      expect(rmRecursiveAsUserMock.calls.length).toBe(0);
    });

    it('throws when the elevated rm returns non-zero so the job queue retries', async () => {
      process.env.AUTH_MODE = 'multi-user';
      rmRecursiveAsUserMock.responder.fn = async () => ({
        stdout: '',
        stderr: "rm: cannot remove '...': Permission denied\n",
        exitCode: 1,
        timedOut: false,
      });
      await expect(
        runPayload({
          repoDir: '/var/lib/agent-console/repositories/org/repo',
          requestUsername: pickOtherUser(),
        })
      ).rejects.toThrow(/cleanup:repository elevated rm failed: rm: cannot remove/);
    });

    it('throws when the elevated rm times out', async () => {
      process.env.AUTH_MODE = 'multi-user';
      rmRecursiveAsUserMock.responder.fn = async () => ({
        stdout: '',
        stderr: '',
        exitCode: 137,
        timedOut: true,
      });
      await expect(
        runPayload({
          repoDir: '/var/lib/agent-console/repositories/org/repo',
          requestUsername: pickOtherUser(),
        })
      ).rejects.toThrow(/cleanup:repository elevated rm failed/);
    });

    it('propagates spawn failures from the helper', async () => {
      process.env.AUTH_MODE = 'multi-user';
      rmRecursiveAsUserMock.responder.fn = async () => {
        throw new Error('sudo: command not found');
      };
      await expect(
        runPayload({
          repoDir: '/var/lib/agent-console/repositories/org/repo',
          requestUsername: pickOtherUser(),
        })
      ).rejects.toThrow(/sudo: command not found/);
    });
  });
});
