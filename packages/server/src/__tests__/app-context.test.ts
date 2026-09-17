import { describe, it, expect, beforeEach, afterEach, jest, spyOn } from 'bun:test';
import { JOB_TYPES, type AppServerMessage, type WorktreeDeletePayload } from '@agent-console/shared';
import {
  createAppContext,
  createTestContext,
  shutdownAppContext,
  type AppContext,
} from '../app-context.js';
import type { PtyNotificationParams } from '../lib/pty-notification.js';
import { InterSessionMessageService } from '../services/inter-session-message-service.js';
import type { EnsureMemoryDirFn } from '../lib/memory-dir.js';
import type { SpawnAsUserFn, SpawnAsUserOpts, SpawnAsUserResult } from '../services/privilege-elevation.js';
import { mkdir, realpath, rm } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SqliteEmbeddedAgentRepository } from '../repositories/sqlite-embedded-agent-repository.js';
import type { EmbeddedAgentDefinition } from '@agent-console/shared';

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

    it('flushes and closes workerOutputFileManager before stopping the job queue (Issue #1719)', async () => {
      appContext = await createTestContext();

      const order: string[] = [];
      // Capture the real implementations BEFORE spying, so the mocks below
      // can call through and leave the context genuinely shut down.
      const originalShutdown = appContext.workerOutputFileManager.shutdown.bind(appContext.workerOutputFileManager);
      const originalStop = appContext.jobQueue.stop.bind(appContext.jobQueue);
      const shutdownSpy = spyOn(appContext.workerOutputFileManager, 'shutdown').mockImplementation(async () => {
        order.push('workerOutputFileManager.shutdown');
        return originalShutdown();
      });
      const stopSpy = spyOn(appContext.jobQueue, 'stop').mockImplementation(async () => {
        order.push('jobQueue.stop');
        return originalStop();
      });

      try {
        await shutdownAppContext(appContext);
        appContext = null;

        expect(shutdownSpy).toHaveBeenCalledTimes(1);
        expect(stopSpy).toHaveBeenCalledTimes(1);
        // Mutation measured: removing the `await context.workerOutputFileManager.shutdown();`
        // call from `shutdownAppContext` fails this test (shutdownSpy is
        // never called, order is `['jobQueue.stop']`); swapping its position
        // to AFTER `jobQueue.stop()` fails the order assertion below
        // (`['jobQueue.stop', 'workerOutputFileManager.shutdown']`);
        // restored -> passes.
        expect(order).toEqual(['workerOutputFileManager.shutdown', 'jobQueue.stop']);
      } finally {
        shutdownSpy.mockRestore();
        stopSpy.mockRestore();
      }
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

  describe('ensureMemoryDirFn test/polarity seam (Issue #1709 PR-3b)', () => {
    /**
     * Uses a REAL, isolated `AGENT_CONSOLE_HOME` temp directory scoped to
     * this describe block only -- NOT memfs. This file also gains a
     * file-backed-`dbPath` describe below whose real-file `bun:sqlite`
     * migrations do their own recursive-backup copy via `fs/promises`
     * (`backupDatabaseFile` in `connection.ts`); `bun:test`'s `mock.module`
     * is process-global and permanent for the life of the test process (see
     * `.claude/rules/testing.md` Anti-Pattern #2), so importing memfs
     * anywhere in this file -- even scoped to a single describe's
     * `beforeEach` -- would silently redirect that real-disk copy at a
     * virtual filesystem that never saw the real sqlite file, breaking the
     * dbPath describe with an unrelated ENOENT. Real embedded-agent
     * activation (`sendMessage`'s activate-on-delivery path) composes and
     * verifies a real memory directory (`ensureMemoryDir`) that works fine
     * against a real temp directory, so memfs was never load-bearing here --
     * `packages/integration/src/embedded-agent-memory-boundary.test.ts`
     * uses memfs only because ITS suite already runs everything through
     * `test-utils.js` for unrelated reasons, not because this specific
     * assertion requires a virtual filesystem.
     */
    // `WorkerOutputFileManager` used to buffer appended output and flush it
    // on its own `WORKER_OUTPUT_FLUSH_INTERVAL` timer (default 100ms,
    // `server-config.ts`) without ever being told the context was shutting
    // down, so a pending timer for a worker whose fake subprocess never
    // attached a real WebSocket client could fire AFTER a per-test removal
    // of `memoryHomeDir`, recreating a `_quick/outputs/...` file under a home
    // that no longer existed (Issue #1719's flush-after-shutdown
    // reappearance). `shutdownAppContext` now calls
    // `context.workerOutputFileManager.shutdown()`, which flushes every
    // pending buffer and then closes the manager to further writes -- so by
    // the time `afterEach` below removes `memoryHomeDir`, no timer remains
    // that could resurrect it. Per-test removal right after
    // `shutdownAppContext` is therefore safe; no bounded wait or deferred,
    // once-per-file cleanup is needed anymore.
    let memoryHomeDir: string;
    let originalAgentConsoleHome: string | undefined;

    beforeEach(async () => {
      originalAgentConsoleHome = process.env.AGENT_CONSOLE_HOME;
      memoryHomeDir = path.join(
        os.tmpdir(),
        `app-context-memory-seam-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      await mkdir(memoryHomeDir, { recursive: true });
      process.env.AGENT_CONSOLE_HOME = memoryHomeDir;
    });

    afterEach(async () => {
      if (appContext) {
        await shutdownAppContext(appContext);
        appContext = null;
      }
      if (originalAgentConsoleHome === undefined) {
        delete process.env.AGENT_CONSOLE_HOME;
      } else {
        process.env.AGENT_CONSOLE_HOME = originalAgentConsoleHome;
      }
      await rm(memoryHomeDir, { recursive: true, force: true });
    });

    /** Minimal subset of Bun's FileSink consumed by EmbeddedAgentWorkerService. */
    interface FakeFileSink {
      write: (chunk: string | Uint8Array) => number;
      end: () => void;
      flush: () => number;
    }

    /**
     * Exitable fake streams/exited-promise (mirrors `makeFakeSpawn` in
     * `session-manager.test.ts`'s "threads the spawnAsUserFn option through"
     * test): lets `activateAndCaptureInit` deactivate the worker afterward
     * instead of leaving a background stdout/stderr reader and the
     * exit-observer's `subprocess.exited` await pending forever; before
     * `shutdownAppContext` flushed and closed the output manager, such a
     * dangling worker was also the source of the stray-write race this
     * describe used to work around.
     */
    function makeFakeSpawn(): {
      fn: SpawnAsUserFn;
      stdinWrites: string[];
      simulateExit: (code: number) => void;
    } {
      const stdinWrites: string[] = [];
      let stdoutCtrl!: ReadableStreamDefaultController<Uint8Array>;
      let stderrCtrl!: ReadableStreamDefaultController<Uint8Array>;
      const stdout = new ReadableStream<Uint8Array>({ start(c) { stdoutCtrl = c; } });
      const stderr = new ReadableStream<Uint8Array>({ start(c) { stderrCtrl = c; } });
      let resolveExited!: (code: number) => void;
      const exited = new Promise<number>((resolve) => { resolveExited = resolve; });
      let exitSimulated = false;
      const simulateExit = (code: number) => {
        if (exitSimulated) return;
        exitSimulated = true;
        resolveExited(code);
        stdoutCtrl.close();
        stderrCtrl.close();
      };
      const stdin: FakeFileSink = {
        write: (chunk) => {
          stdinWrites.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
          return 0;
        },
        end: () => {},
        flush: () => 0,
      };
      const subprocess = { pid: 9997, exited, stdin, stdout, stderr, kill: () => {} };
      const fn: SpawnAsUserFn = (_opts: SpawnAsUserOpts) =>
        ({ subprocess, stdin, elevated: false }) as unknown as SpawnAsUserResult;
      return { fn, stdinWrites, simulateExit };
    }

    /**
     * Drives a real quick-session embedded-agent worker through activation
     * (`sendMessage`'s activate-on-delivery path), returns the parsed `init`
     * command captured off the faked subprocess's stdin -- the same wire
     * shape `embedded-agent-memory-boundary.test.ts` asserts against -- and
     * deactivates the worker before returning (see `makeFakeSpawn`'s doc
     * comment for why).
     */
    async function activateAndCaptureInit(
      overrides?: { ensureMemoryDirFn?: EnsureMemoryDirFn },
    ): Promise<{ type: string; context: Record<string, unknown> }> {
      const fake = makeFakeSpawn();
      appContext = await createTestContext({ spawnAsUserFn: fake.fn, ...overrides });

      const owner = await appContext.userRepository.upsertByOsUid(
        24681,
        'seam-owner',
        '/home/seam-owner',
      );
      const definition = await appContext.embeddedAgentManager.createEmbeddedAgent(
        { name: 'Seam agent', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
        owner.id,
      );
      const scratch = path.join(memoryHomeDir, 'quick-seam-cwd');
      await mkdir(scratch, { recursive: true });
      const realCwd = await realpath(scratch);
      const session = await appContext.sessionManager.createSession(
        { type: 'quick', locationPath: realCwd },
        { createdBy: owner.id },
      );
      const worker = await appContext.sessionManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: definition.id,
      });
      expect(worker).not.toBeNull();

      await appContext.sessionManager.sendMessage(session.id, null, worker!.id, 'hello');

      await waitForCondition(() => fake.stdinWrites.length >= 1);
      const initCommand = JSON.parse(fake.stdinWrites[0]) as { type: string; context: Record<string, unknown> };

      // Teardown: same pattern as `EmbeddedAgentWorkerService.deactivate
      // escalation` -- issue deactivate, then simulate the exit immediately
      // so the grace-timeout race resolves via the real exit path.
      const deactivatePromise = appContext.sessionManager.deactivateEmbeddedAgentWorker(session.id, worker!.id);
      fake.simulateExit(0);
      await deactivatePromise;

      return initCommand;
    }

    it('omits context.memoryDir from the init frame when ensureMemoryDirFn is overridden to resolve undefined', async () => {
      // Mutation measured: dropping `ensureMemoryDirFn: options.ensureMemoryDirFn`
      // from SessionManager's construction of EmbeddedAgentWorkerService
      // (session-manager.ts) fails this test -- the override never reaches
      // the service, its default `prepareMemoryDir` runs instead, and
      // `context.memoryDir` is present.
      const initCommand = await activateAndCaptureInit({
        ensureMemoryDirFn: async () => undefined,
      });

      expect(initCommand.type).toBe('init');
      expect('memoryDir' in initCommand.context).toBe(false);
    });

    it('includes context.memoryDir in the init frame with no override -- the polarity of the seam above', async () => {
      const initCommand = await activateAndCaptureInit();

      expect(initCommand.type).toBe('init');
      expect(typeof initCommand.context.memoryDir).toBe('string');
    });
  });

  describe('createTestContext dbPath option (file-backed test database)', () => {
    /**
     * `bun:sqlite`'s `Database` does its file I/O through a native binding,
     * never through Node's `fs` module -- so it is unaffected by the
     * process-global memfs mock other describes in this file install via
     * `test-utils.js`. Cleanup of the real tmp file below therefore uses a
     * spawned `rm -f` rather than `node:fs/promises`, which -- once memfs
     * has been installed anywhere in this process -- would silently target
     * the virtual filesystem instead of the real one and leave the real
     * file behind.
     */
    function makeTmpDbPath(): string {
      return path.join(os.tmpdir(), `app-context-dbpath-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    }

    function removeTmpDbPath(dbPath: string): void {
      // `dbPath*` also catches the `<dbPath>.bak.v18-to-v19.<timestamp>`
      // sibling `backupDatabaseFile` (connection.ts) writes when a
      // fresh file-backed database runs the full migration chain.
      Bun.spawnSync(['sh', '-c', `rm -f -- ${dbPath}*`]);
    }

    function buildDefinition(id: string, name: string): EmbeddedAgentDefinition {
      const now = new Date().toISOString();
      return {
        id,
        name,
        engine: 'openai-api',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
        isBuiltIn: false,
        createdBy: 'test-user-id',
        createdAt: now,
        updatedAt: now,
      };
    }

    it('a second context booted with the same dbPath loads a row the first context persisted', async () => {
      // Mutation measured: reverting `createDatabaseForTest` to always pass
      // ':memory:' to `new BunDatabase(...)` (ignoring the `dbPath`
      // parameter) fails this test -- ctx2 boots a fresh, empty in-memory
      // database and never sees `persisted-def`.
      //
      // This test is ALSO the memfs polarity pin for `createDatabaseForTest`
      // passing `IN_MEMORY_DB_PATH` (not the real `dbPath`) into
      // `runMigrations` (`connection.ts`): with `runMigrations` given the
      // real `dbPath` instead, this test still passes when the file is run
      // alone, but FAILS under the full server suite (`cd packages/server
      // && bun test src/`), because some sibling test file's import of
      // `test-utils.js` mocks `fs/promises` to memfs process-wide before
      // this test runs, and the v19 migration's pre-flight backup
      // (`backupDatabaseFile`) then tries to `copyFile` the real,
      // real-disk-backed sqlite file through that virtual filesystem:
      // `ENOENT: no such file or directory, open
      // '.../app-context-dbpath-<...>.sqlite'` from memfs's own
      // `_copyFile`. With the `IN_MEMORY_DB_PATH` sentinel (the actual
      // production code), this test passes in both isolation and the full
      // suite. Reproduced 2026-09-17.
      const dbPath = makeTmpDbPath();
      try {
        const ctx1 = await createTestContext({ dbPath });
        await new SqliteEmbeddedAgentRepository(ctx1.db).save(buildDefinition('persisted-def', 'Persisted'));
        await shutdownAppContext(ctx1);

        const ctx2 = await createTestContext({ dbPath });
        try {
          expect(ctx2.embeddedAgentManager.getEmbeddedAgent('persisted-def')?.name).toBe('Persisted');
        } finally {
          await shutdownAppContext(ctx2);
        }
      } finally {
        removeTmpDbPath(dbPath);
      }
    });

    it('two contexts without dbPath do not share data -- the polarity of the option above', async () => {
      const ctx1 = await createTestContext();
      await new SqliteEmbeddedAgentRepository(ctx1.db).save(buildDefinition('not-shared-def', 'NotShared'));
      await shutdownAppContext(ctx1);

      const ctx2 = await createTestContext();
      try {
        expect(ctx2.embeddedAgentManager.getEmbeddedAgent('not-shared-def')).toBeUndefined();
      } finally {
        await shutdownAppContext(ctx2);
      }
    });
  });
});
