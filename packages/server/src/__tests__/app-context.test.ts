import { describe, it, expect, afterEach, jest } from 'bun:test';
import { JOB_TYPES, type AppServerMessage, type WorktreeDeletePayload } from '@agent-console/shared';
import {
  createAppContext,
  createTestContext,
  shutdownAppContext,
  type AppContext,
} from '../app-context.js';
import type { PtyNotificationParams } from '../lib/pty-notification.js';
import { InterSessionMessageService } from '../services/inter-session-message-service.js';

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitForCondition(
  cond: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitForCondition timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

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
      //
      // Since Issue #1591, the wiring goes through `routeProcessExit`'s
      // per-process delivery tail in process-output-router.ts rather than a
      // direct inline call -- but the underlying deliverWorkerNotification
      // call shape (args, kind/tag/fields/intent) is unchanged, so this
      // remains a valid regression pin for that shape. See the
      // "routeProcessExit ordering" tests below for the ordering fix itself.
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

  describe('routeProcessExit ordering, wiring-level polarity (Issue #1591)', () => {
    /**
     * Boots a real `createAppContext` instance, creates a process-target
     * worker via `createTarget`, stubs both notification-producing seams
     * `deliverWorkerNotification` (recording seam) and
     * `interSessionMessageService.sendMessage` (deferred, so the test
     * controls when the message-mode stdout write "completes") -- then
     * drives a real `outputMode: 'message'` process through
     * `interactiveProcessManager.runProcess` and asserts the exit
     * notification does not fire until the stdout content notification has.
     *
     * This is the load-bearing pin for Issue #1591: it exercises the real
     * `app-context.ts` `onExit` wiring (`routeProcessExit`), not a synthetic
     * call into `process-output-router.ts` directly.
     */
    async function runOrderingPolarityCheck(
      createTarget: (ctx: AppContext) => Promise<{ sessionId: string; workerId: string }>,
    ): Promise<void> {
      const order: string[] = [];

      // `createAppContext` wires `processRouterDeps.sendMessage` via
      // `interSessionMessageService.sendMessage.bind(interSessionMessageService)`
      // -- a BOUND reference captured once, at construction time, not a live
      // per-call property lookup. Spying on `appContext.interSessionMessageService`
      // AFTER construction (the pattern that works fine for
      // `deliverWorkerNotification` below, which IS a live lookup) would
      // therefore never be observed by the already-bound reference. Spy on
      // the CLASS PROTOTYPE before construction instead, so the bind inside
      // `createAppContext` picks up the mock through the prototype chain.
      const deferred = createDeferred<{ messageId: string; path: string }>();
      const sendMessageSpy = jest
        .spyOn(InterSessionMessageService.prototype, 'sendMessage')
        .mockImplementation(async () => deferred.promise);

      appContext = await createAppContext({ dbPath: ':memory:' });
      const ctx = appContext;

      const deliverSpy = jest
        .spyOn(ctx.sessionManager, 'deliverWorkerNotification')
        .mockImplementation(async (_sessionId, _workerId, params: PtyNotificationParams) => {
          const message = (params.fields as { message: string }).message;
          order.push(message.startsWith('Process exited') ? 'exit' : 'stdout-brief');
          return { ok: true };
        });

      try {
        const { sessionId, workerId } = await createTarget(ctx);

        const process = await ctx.interactiveProcessManager.runProcess({
          sessionId,
          workerId,
          command: 'echo notify-order',
          outputMode: 'message',
        });

        // Poll for the process to reach a terminal state. By this point,
        // per InteractiveProcessManager's ordering guarantee, the onOutput
        // callback (hence routeProcessContent) has already been invoked for
        // the process's stdout, and onExit (hence routeProcessExit) has too
        // -- but the stdout step is still blocked on `deferred`.
        await waitForCondition(
          () => ctx.interactiveProcessManager.getProcess(process.id)?.status === 'exited',
        );

        // The actual polarity assertion: on unmodified app-context.ts (the
        // pre-fix onExit calling deliverWorkerNotification directly rather
        // than through routeProcessExit's delivery tail), `order` would
        // already contain 'exit' here, because the exit notification never
        // waited on anything. After the fix, nothing has been recorded yet.
        expect(order).toEqual([]);

        deferred.resolve({ messageId: 'msg-order', path: '/tmp/messages/order.json' });

        await waitForCondition(() => order.length >= 2);

        expect(order).toEqual(['stdout-brief', 'exit']);
      } finally {
        deliverSpy.mockRestore();
        sendMessageSpy.mockRestore();
      }
    }

    it('exit notification waits for a still-pending message-mode stdout notification (PTY-backed target)', async () => {
      await runOrderingPolarityCheck(async (ctx) => {
        const session = await ctx.sessionManager.createSession({
          type: 'quick',
          locationPath: process.cwd(),
        });
        const worker = await ctx.sessionManager.createWorker(session.id, { type: 'terminal' });
        return { sessionId: session.id, workerId: worker!.id };
      });
    });

    it('exit notification waits for a still-pending message-mode stdout notification (embedded-agent target)', async () => {
      await runOrderingPolarityCheck(async (ctx) => {
        const session = await ctx.sessionManager.createSession({
          type: 'quick',
          locationPath: process.cwd(),
        });
        const owner = await ctx.userRepository.upsertByOsUid(
          900123,
          'issue-1591-owner',
          '/home/issue-1591-owner',
        );
        const definition = await ctx.embeddedAgentManager.createEmbeddedAgent(
          {
            name: 'Issue #1591 ordering test agent',
            provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
          },
          owner.id,
        );
        const worker = await ctx.sessionManager.createWorker(session.id, {
          type: 'embedded-agent',
          embeddedAgentId: definition.id,
        });
        return { sessionId: session.id, workerId: worker!.id };
      });
    });
  });
});
