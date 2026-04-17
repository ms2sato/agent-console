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
import { JOB_TYPES } from '@agent-console/shared';
import type { CleanupSessionOutputsPayload, CleanupWorkerOutputPayload } from '@agent-console/shared';
import type { JobQueue, JobHandler } from '../job-queue.js';
import { registerJobHandlers } from '../handlers.js';
import type { WorkerOutputFileManager } from '../../lib/worker-output-file.js';

describe('cleanup job handlers', () => {
  let handlers: Map<string, JobHandler<unknown>>;
  let workerOutputFileManager: WorkerOutputFileManager;
  let deleteSessionOutputs: ReturnType<typeof mock>;
  let deleteWorkerOutput: ReturnType<typeof mock>;

  beforeEach(() => {
    handlers = new Map();
    deleteSessionOutputs = mock(async () => {});
    deleteWorkerOutput = mock(async () => {});
    workerOutputFileManager = {
      deleteSessionOutputs,
      deleteWorkerOutput,
    } as unknown as WorkerOutputFileManager;

    const fakeQueue: JobQueue = {
      registerHandler: <T>(type: string, handler: JobHandler<T>) => {
        handlers.set(type, handler as JobHandler<unknown>);
      },
    } as unknown as JobQueue;

    process.env.AGENT_CONSOLE_HOME = '/test/config';
    registerJobHandlers(fakeQueue, workerOutputFileManager);
  });

  describe('CLEANUP_SESSION_OUTPUTS', () => {
    async function runPayload(payload: CleanupSessionOutputsPayload): Promise<void> {
      const handler = handlers.get(JOB_TYPES.CLEANUP_SESSION_OUTPUTS)!;
      await handler(payload);
    }

    it('executes cleanup for valid repository scope', async () => {
      await runPayload({ sessionId: 'sid-1', scope: 'repository', slug: 'owner/repo' });
      expect(deleteSessionOutputs).toHaveBeenCalledTimes(1);
    });

    it('executes cleanup for valid quick scope', async () => {
      await runPayload({ sessionId: 'sid-1', scope: 'quick', slug: null });
      expect(deleteSessionOutputs).toHaveBeenCalledTimes(1);
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

    it('executes cleanup for valid repository scope', async () => {
      await runPayload({ sessionId: 'sid', workerId: 'wid', scope: 'repository', slug: 'owner/repo' });
      expect(deleteWorkerOutput).toHaveBeenCalledTimes(1);
    });

    it('logs and skips on invalid slug', async () => {
      await runPayload({ sessionId: 'sid', workerId: 'wid', scope: 'repository', slug: '/absolute/path' });
      expect(deleteWorkerOutput).not.toHaveBeenCalled();
    });
  });
});
