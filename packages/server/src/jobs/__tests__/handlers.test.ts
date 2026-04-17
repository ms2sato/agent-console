/**
 * Tests for cleanup job handlers.
 *
 * Key invariants (see docs/design/session-data-path.md §4):
 * - Handler MUST reconstruct the resolver from `(scope, slug)` via
 *   `computeSessionDataBaseDir` — not from a legacy `repositoryName` field.
 * - Invalid payloads (bad scope, path-escape slug) MUST be logged and skipped
 *   without any filesystem operation.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import * as path from 'path';
import { JOB_TYPES } from '@agent-console/shared';
import type { CleanupSessionOutputsPayload, CleanupWorkerOutputPayload } from '@agent-console/shared';
import type { JobQueue, JobHandler } from '../job-queue.js';
import { registerJobHandlers } from '../handlers.js';
import { WorkerOutputFileManager } from '../../lib/worker-output-file.js';
import { SessionDataPathResolver } from '../../lib/session-data-path-resolver.js';

const TEST_CONFIG = '/test/config';

describe('cleanup job handlers', () => {
  let handlers: Map<string, JobHandler<unknown>>;
  let workerOutputFileManager: WorkerOutputFileManager;
  let deleteSessionOutputs: ReturnType<typeof mock>;
  let deleteWorkerOutput: ReturnType<typeof mock>;

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
    registerJobHandlers(fakeQueue, workerOutputFileManager);
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
});
