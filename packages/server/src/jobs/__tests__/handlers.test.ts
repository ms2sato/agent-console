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
import type { RunAsUserOpts, RunAsUserResult } from '../../services/privilege-elevation.js';

const TEST_CONFIG = '/test/config';

/**
 * Capture-and-respond fake for `runAsUser`, mirroring the pattern used by
 * `repository-manager.test.ts`. Default response succeeds; tests override
 * `responder.fn` for failure / timeout scenarios.
 */
function createRunAsUserMock() {
  const calls: RunAsUserOpts[] = [];
  const responder = {
    fn: async (_opts: RunAsUserOpts): Promise<RunAsUserResult> => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }),
  };
  const runAsUserImpl = (opts: RunAsUserOpts) => {
    calls.push(opts);
    return responder.fn(opts);
  };
  return { calls, runAsUserImpl, responder };
}

describe('cleanup job handlers', () => {
  let handlers: Map<string, JobHandler<unknown>>;
  let workerOutputFileManager: WorkerOutputFileManager;
  let deleteSessionOutputs: ReturnType<typeof mock>;
  let deleteWorkerOutput: ReturnType<typeof mock>;
  let runAsUserMock: ReturnType<typeof createRunAsUserMock>;
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
    runAsUserMock = createRunAsUserMock();
    registerJobHandlers(fakeQueue, workerOutputFileManager, {
      runAsUserImpl: runAsUserMock.runAsUserImpl,
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

    it('bypasses runAsUser when requestUsername is null (direct fs.rm path)', async () => {
      // Multi-user mode still falls back to direct fs.rm when no username is
      // threaded (e.g., a non-route caller). The ENOENT on the non-existent
      // path is swallowed by the handler's idempotent-skip branch -- no throw.
      process.env.AUTH_MODE = 'multi-user';
      await runPayload({
        repoDir: '/var/lib/agent-console/repositories/no-such-org/no-such-repo',
        requestUsername: null,
      });
      expect(runAsUserMock.calls.length).toBe(0);
    });

    it('treats ENOENT as success on the direct fs.rm path (idempotent)', async () => {
      delete process.env.AUTH_MODE;
      await runPayload({
        repoDir: '/var/lib/agent-console/repositories/missing/' + Date.now(),
        requestUsername: null,
      });
      // No throw = success. runAsUser must not have been touched.
      expect(runAsUserMock.calls.length).toBe(0);
    });

    it('elevates via runAsUser when AUTH_MODE=multi-user and requestUsername targets another user', async () => {
      process.env.AUTH_MODE = 'multi-user';
      const other = pickOtherUser();
      const repoDir = '/var/lib/agent-console/repositories/org/repo';

      await runPayload({ repoDir, requestUsername: other });

      expect(runAsUserMock.calls.length).toBe(1);
      const call = runAsUserMock.calls[0]!;
      expect(call.username).toBe(other);
      // shell-escaped repoDir guards against future drift in how repoDir is composed.
      expect(call.command).toBe(`rm -rf -- '${repoDir}'`);
      // cwd is NOT set: runAsUser pins the outer spawn to SUDO_NEUTRAL_CWD and
      // the inner command operates on an absolute path.
      expect(call.cwd).toBeUndefined();
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
      expect(runAsUserMock.calls.length).toBe(0);
    });

    it('throws when the elevated rm returns non-zero so the job queue retries', async () => {
      process.env.AUTH_MODE = 'multi-user';
      runAsUserMock.responder.fn = async () => ({
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
      runAsUserMock.responder.fn = async () => ({
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

    it('propagates spawn failures from runAsUser', async () => {
      process.env.AUTH_MODE = 'multi-user';
      runAsUserMock.responder.fn = async () => {
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
