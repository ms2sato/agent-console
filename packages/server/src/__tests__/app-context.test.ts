import { describe, it, expect, afterEach, jest } from 'bun:test';
import { JOB_TYPES, type AppServerMessage, type WorktreeDeletePayload } from '@agent-console/shared';
import {
  createAppContext,
  createTestContext,
  shutdownAppContext,
  type AppContext,
} from '../app-context.js';

describe('AppContext', () => {
  let appContext: AppContext | null = null;

  afterEach(async () => {
    if (appContext) {
      await shutdownAppContext(appContext);
      appContext = null;
    }
  });

  describe('createTestContext', () => {
    it('should create an AppContext with all required services', async () => {
      appContext = await createTestContext();

      expect(appContext.db).toBeDefined();
      expect(appContext.jobQueue).toBeDefined();
      expect(appContext.sessionRepository).toBeDefined();
      expect(appContext.sessionManager).toBeDefined();
      expect(appContext.repositoryManager).toBeDefined();
      expect(appContext.notificationManager).toBeDefined();
    });

    it('should use in-memory database for isolation', async () => {
      appContext = await createTestContext();

      // Verify database is usable
      const result = await appContext.db
        .selectFrom('sessions')
        .selectAll()
        .execute();

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0); // Fresh database
    });

    it('should allow custom sessionRepository override', async () => {
      // Create a mock session repository
      const mockRepository = {
        findAll: async () => [],
        findById: async () => null,
        findByServerPid: async () => [],
        findPaused: async () => [],
        save: async () => {},
        saveAll: async () => {},
        delete: async () => {},
        update: async () => false,
      };

      appContext = await createTestContext({
        sessionRepository: mockRepository,
      });

      // Verify the mock was used
      expect(appContext.sessionRepository).toBe(mockRepository);
    });

    it('should skip job queue start when requested', async () => {
      appContext = await createTestContext({
        skipJobQueueStart: true,
      });

      // Context should still be created successfully
      expect(appContext.jobQueue).toBeDefined();
    });
  });

  describe('shutdownAppContext', () => {
    it('should clean up all resources', async () => {
      appContext = await createTestContext();

      // Shutdown should complete without errors
      await shutdownAppContext(appContext);
      appContext = null;

      // Database should be closed (creating new one should work)
      const newContext = await createTestContext();
      expect(newContext.db).toBeDefined();
      // Clean up the new context
      await shutdownAppContext(newContext);
    });

    it('should reset global database when using createAppContext', async () => {
      // This test verifies that the global db variable is reset after shutdown,
      // which is important for dev server restart and test re-execution.
      // Uses in-memory database to avoid file system side effects.
      const context1 = await createAppContext({ dbPath: ':memory:' });

      // Verify first context works
      const result1 = await context1.db
        .selectFrom('sessions')
        .selectAll()
        .execute();
      expect(Array.isArray(result1)).toBe(true);

      // Shutdown should reset global db since context uses it
      await shutdownAppContext(context1);

      // Create a second context - this should work because global db was reset
      // If global db was not reset, initializeDatabase would return the destroyed db
      const context2 = await createAppContext({ dbPath: ':memory:' });

      // Verify second context works (not a destroyed database)
      const result2 = await context2.db
        .selectFrom('sessions')
        .selectAll()
        .execute();
      expect(Array.isArray(result2)).toBe(true);

      // Clean up
      await shutdownAppContext(context2);
    });
  });

  describe('service wiring', () => {
    it('should wire cross-dependencies between managers', async () => {
      appContext = await createTestContext();

      // SessionManager should have repository callbacks set
      // We can verify this indirectly by checking that toPublicSession works
      // (it uses repositoryCallbacks to get repository name)
      const sessions = appContext.sessionManager.getAllSessions();
      expect(Array.isArray(sessions)).toBe(true);
    });

    it('should wire notification manager callbacks', async () => {
      appContext = await createTestContext();

      // NotificationManager should be fully initialized
      // We can verify by calling methods that require callbacks
      // cleanupSession should not throw
      expect(() => {
        appContext!.notificationManager.cleanupSession('non-existent');
      }).not.toThrow();
    });

    it('should process an enqueued worktree:delete job end-to-end through the real construction path (Issue #1327)', async () => {
      // Proves `registerWorktreeDeleteJobHandler`'s `deletionDeps` and
      // `broadcastToApp` were both correctly threaded through the real
      // createTestContext() construction path -- not through a hand-built
      // fake queue in a route test (see routes/__tests__/worktrees.test.ts
      // for that layer). A worktreePath outside the managed repositories
      // directory makes `deleteWorktree` fail deterministically and fast
      // (errorType: 'validation'), with no real git/filesystem setup
      // needed.
      const broadcasts: AppServerMessage[] = [];
      appContext = await createTestContext({
        broadcastToApp: (msg) => broadcasts.push(msg),
      });

      const jobId = crypto.randomUUID();
      const payload: WorktreeDeletePayload = {
        jobId,
        repoId: 'nonexistent-repo',
        worktreePath: '/not/a/managed/path',
        force: false,
        requestUsername: null,
      };
      await appContext.jobQueue.enqueue(JOB_TYPES.WORKTREE_DELETE, payload, { jobId, maxAttempts: 1 });

      // createTestContext() starts the job queue by default; poll for the
      // job to reach a terminal state (async processing). Stops on ANY
      // terminal status (not just 'stalled') so an unexpected 'completed'
      // doesn't burn the whole poll budget before the assertion below
      // fails fast with a clear mismatch.
      let job = await appContext.jobQueue.getJob(jobId);
      for (let i = 0; i < 100 && job?.status !== 'stalled' && job?.status !== 'completed'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        job = await appContext.jobQueue.getJob(jobId);
      }

      expect(job?.status).toBe('stalled');
      expect(job?.last_error).toContain('outside managed directory');

      const failedBroadcasts = broadcasts.filter(
        (b) => b.type === 'worktree-deletion-failed' && b.taskId === jobId,
      );
      expect(failedBroadcasts.length).toBe(1);
    });

    it('routes the interactive-process exit notification through sessionManager.deliverWorkerNotification (Issue #1574 PR B)', async () => {
      // createTestContext() wires InteractiveProcessManagerClass with no-op
      // callbacks (see the "Create interactive process manager (no-op
      // callbacks for tests..." comment in app-context.ts), so it does not
      // exercise the production onExit wiring this test targets. Only
      // createAppContext() wires the real callback that forwards exit
      // notifications through deliverWorkerNotification, so this test must
      // boot the full context via createAppContext() rather than the
      // lighter test factory.
      appContext = await createAppContext({ dbPath: ':memory:' });

      const deliverSpy = jest.spyOn(appContext.sessionManager, 'deliverWorkerNotification');

      // The exit callback forwards process.sessionId/workerId verbatim to
      // deliverWorkerNotification, which internally looks up the session --
      // a lookup miss is handled as an `{ok: false}` result and logged as a
      // warning (see the onExit wiring in app-context.ts), not thrown. A
      // fabricated pair is therefore sufficient to observe the wiring
      // itself without needing a real session/worker or a real PTY-backed
      // agent spawn.
      const sessionId = 'fake-session-for-exit-wiring-test';
      const workerId = 'fake-worker-for-exit-wiring-test';

      const process = await appContext.interactiveProcessManager.runProcess({
        sessionId,
        workerId,
        command: 'true',
      });

      // Poll for the process to reach a terminal state (async exit handling
      // -- the manager awaits stream flush before invoking onExit).
      let info = appContext.interactiveProcessManager.getProcess(process.id);
      for (let i = 0; i < 100 && info?.status !== 'exited'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        info = appContext.interactiveProcessManager.getProcess(process.id);
      }
      expect(info?.status).toBe('exited');

      expect(deliverSpy).toHaveBeenCalledTimes(1);
      const [calledSessionId, calledWorkerId, params] = deliverSpy.mock.calls[0] as [
        string,
        string,
        { kind: string; tag: string; fields: { processId: string; command: string; message: string }; intent: string },
      ];
      expect(calledSessionId).toBe(sessionId);
      expect(calledWorkerId).toBe(workerId);
      expect(params.kind).toBe('internal-process');
      expect(params.tag).toBe('internal:process');
      expect(params.fields.processId).toBe(process.id);
      expect(params.fields.command).toBe('true');
      expect(params.fields.message).toContain('Process exited with code');
      expect(params.intent).toBe('inform');

      deliverSpy.mockRestore();
    });
  });
});
