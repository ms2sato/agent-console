import { describe, it, expect, beforeEach, afterEach, mock, spyOn, setSystemTime } from 'bun:test';
import * as fs from 'fs';
import type { Worker } from '@agent-console/shared';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { defaultRepositoryLookup, makeRepositoryEnvLookup } from '../../__tests__/utils/repository-lookup-mock.js';
import {
  buildPersistedAgentWorker,
  buildPersistedGitDiffWorker,
  buildPersistedTerminalWorker,
  buildPersistedWorktreeSession,
} from '../../__tests__/utils/build-test-data.js';
import { createTestSessionRepository } from '../../__tests__/utils/test-session-repository.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { rootLogger } from '../../lib/logger.js';
import { AgentManager } from '../agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { SqliteSessionRepository } from '../../repositories/sqlite-session-repository.js';
import { SqliteDeferredWorkerNotificationRepository } from '../../repositories/sqlite-deferred-worker-notification-repository.js';
import type {
  DeferredWorkerNotificationRecord,
  DeferredWorkerNotificationRepository,
  NewDeferredWorkerNotification,
} from '../../repositories/deferred-worker-notification-repository.js';
import { SingleUserMode } from '../user-mode.js';
import { McpTokenRegistry } from '../../mcp/mcp-auth.js';
import type { PtyNotificationParams } from '../../lib/pty-notification.js';
import type { ExecuteHookCommand, SessionManager, WorkerReadinessConfig } from '../session-manager.js';
import { WORKER_READY_CAP_MS, WORKER_READY_MIN_OUTPUT_BYTES, WORKER_READY_SETTLE_MS } from '../session-manager.js';

type HookResult = Awaited<ReturnType<ExecuteHookCommand>>;

const TEST_CONFIG_DIR = '/test/config';
const EMBEDDED_DEF = {
  id: 'stub-embedded-agent',
  name: 'Stub Model',
  engine: 'openai-api' as const,
  isBuiltIn: false,
  provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
  createdBy: 'test-user-id',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const TIMER_PARAMS: PtyNotificationParams = {
  kind: 'internal-timer',
  tag: 'internal:timer',
  fields: {
    timerId: 't1',
    action: 'check the build',
    fireCount: '1',
    nextIntervalSeconds: '60',
    nextFireAt: '2026-01-01T00:01:00.000Z',
  },
  intent: 'inform',
};

function messageParams(path = '/messages/m1.md'): PtyNotificationParams {
  return {
    kind: 'internal-message',
    tag: 'internal:message',
    fields: { source: 'session', from: 'sender', summary: 'Message from session sender', path },
    intent: 'triage',
  };
}

const INTERRUPTED_PARAMS: PtyNotificationParams = {
  kind: 'internal-worker-interrupted',
  tag: 'internal:worker-interrupted',
  fields: {
    sessionId: 's',
    workerId: 'w',
    turnId: 't',
    cause: 'exit',
    exitReason: 'unexpected',
    exitCode: '1',
    summary: 'A delegated worker was interrupted',
    hint: 'check the delegate',
  },
  intent: 'triage',
};

const REVIEW_COMMENT_PARAMS: PtyNotificationParams = {
  kind: 'internal-review-comment',
  tag: 'internal:review-comment',
  fields: { session: 's', file: 'a.ts', line: '1', body: 'nit' },
  intent: 'triage',
};

/** Short floor/settle so the output-quiet rule can run on real timers; the production constants are pinned in their own test. */
const TEST_READINESS: WorkerReadinessConfig = { minOutputBytes: 100, settleMs: 60, capMs: 10_000 };

const ptyFactory = createMockPtyFactory(10000);
let importCounter = 0;
let agentManager: AgentManager;

async function until(condition: () => boolean | Promise<boolean>, attempts = 400): Promise<void> {
  for (let i = 0; i < attempts && !(await condition()); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await condition()).toBe(true);
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

describe('SessionManager: notifications deferred while a session is paused or pausing', () => {
  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '', '/test/path/.keep': '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    await initializeDatabase(':memory:');
    resetProcessMock();
    mockProcess.markAlive(process.pid);
    ptyFactory.reset();
    resetGitMocks();
    agentManager = await AgentManager.create(new SqliteAgentRepository(getDatabase()));
  });

  afterEach(async () => {
    setSystemTime();
    await closeDatabase();
    cleanupMemfs();
    delete process.env.AGENT_CONSOLE_HOME;
  });

  /**
   * A manager over the real SQLite session repository and the real deferred
   * repository (default over `db`), so the foreign keys are the production ones.
   * The pause command hook stays pending until `resolveHook` when `holdPause`.
   */
  async function setup(opts: { holdPause?: boolean; deferredRepository?: DeferredWorkerNotificationRepository; readiness?: Partial<WorkerReadinessConfig> } = {}) {
    let resolveHook: (result: HookResult) => void = () => {};
    const executeHookCommand = mock<ExecuteHookCommand>(
      () => (opts.holdPause ? new Promise<HookResult>((resolve) => { resolveHook = resolve; }) : Promise.resolve({ success: true })),
    );
    const module = await import(`../session-manager.js?v=${++importCounter}`) as typeof import('../session-manager.js');
    const manager: SessionManager = await module.SessionManager.create({
      sessionRepository: new SqliteSessionRepository(getDatabase()),
      db: getDatabase(),
      ...(opts.deferredRepository ? { deferredNotificationRepository: opts.deferredRepository } : {}),
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      agentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      embeddedAgentManager: {
        getEmbeddedAgent: (id: string) => (id === EMBEDDED_DEF.id ? EMBEDDED_DEF : undefined),
      },
      repositoryLookup: defaultRepositoryLookup,
      repositoryEnvLookup: makeRepositoryEnvLookup({
        mapping: () => ({ name: 'test-repo', path: '/test/repo', pauseCommand: 'docker compose stop' }),
        getWorktreeIndexNumber: async () => 5,
      }),
      executeHookCommand,
      readiness: { ...TEST_READINESS, ...opts.readiness },
    });
    return { manager, executeHookCommand, resolveHook: (r: HookResult = { success: true }) => resolveHook(r) };
  }

  async function createSession(manager: SessionManager, kind: 'agent' | 'embedded' = 'agent') {
    return manager.createSession({
      type: 'worktree',
      locationPath: '/test/path',
      repositoryId: 'repo-1',
      worktreeId: `branch-${Math.random().toString(36).slice(2, 8)}`,
      ...(kind === 'embedded' ? { embeddedAgentId: EMBEDDED_DEF.id } : { agentId: 'claude-code' }),
    });
  }

  function workerOfType(session: { workers: Worker[] }, type: Worker['type']): Worker {
    const worker = session.workers.find((w) => w.type === type);
    if (!worker) throw new Error(`no ${type} worker`);
    return worker;
  }

  async function rowsOf(sessionId: string): Promise<DeferredWorkerNotificationRecord[]> {
    return new SqliteDeferredWorkerNotificationRepository(getDatabase()).listBySession(sessionId);
  }

  async function holdPausing(manager: SessionManager, hook: { mock: { calls: unknown[] } }, sessionId: string) {
    const pause = manager.pauseSession(sessionId);
    await until(() => hook.mock.calls.length > 0);
    expect(manager.isPausing(sessionId)).toBe(true);
    // Wrapped: returning the promise itself would make the caller await the whole pause.
    return { pause };
  }

  /**
   * An agent PTY worker whose command injection is a deferred the test settles by hand.
   * `output(n)` feeds the same state WorkerManager's post-sentinel handler maintains
   * (bytes, last-chunk time, waiter notification); the real handler is tested in
   * worker-manager.test.ts.
   */
  async function pendingInjectionAgent(manager: SessionManager) {
    const session = await createSession(manager);
    const agent = workerOfType(session, 'agent');
    const internal = manager.getWorker(session.id, agent.id);
    if (!internal || internal.type !== 'agent') throw new Error('no internal agent worker');
    let inject: () => void = () => {};
    const promise = new Promise<void>((resolve) => { inject = resolve; });
    internal.commandInjection = { promise, resolve: inject };
    const output = (bytes: number): void => {
      internal.postInjectionOutputBytes += bytes;
      internal.lastOutputAt = Date.now();
      for (const notify of [...internal.postInjectionOutputWaiters]) notify();
    };
    let ready = false;
    const track = (p: Promise<void>) => p.then(() => { ready = true; });
    return { session, agent, internal, inject, output, isReady: () => ready, track };
  }

  describe('the delivery seam', () => {
    it('a paused session: an internal-message to its agent worker is stored with sender and source, and reported deferred', async () => {
      const { manager } = await setup();
      const target = await createSession(manager);
      const sender = await createSession(manager);
      const agent = workerOfType(target, 'agent');
      await manager.pauseSession(target.id);
      const writesBefore = ptyFactory.instances.reduce((n, p) => n + p.writtenData.length, 0);

      const params = messageParams('/messages/m1.md');
      const result = await manager.deliverWorkerNotification(target.id, agent.id, params, {
        replyToSessionId: sender.id,
        sourceId: '/messages/m1.md',
      });

      expect(result).toEqual({ ok: true, deferred: true });
      const rows = await rowsOf(target.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sessionId: target.id,
        workerId: agent.id,
        kind: 'internal-message',
        sourceId: '/messages/m1.md',
        replyToSessionId: sender.id,
      });
      expect(JSON.parse(rows[0].paramsJson)).toEqual(params);
      // Nothing reached any PTY.
      expect(ptyFactory.instances.reduce((n, p) => n + p.writtenData.length, 0)).toBe(writesBefore);
    });

    it('a repository insert that throws returns deferral-failed (not not-found) and logs at error level', async () => {
      const failing: DeferredWorkerNotificationRepository = {
        insert: async () => { throw new Error('disk full'); },
        listBySession: async () => [],
        countBySession: async () => 0,
        deleteByIds: async () => 0,
      };
      const { manager } = await setup({ deferredRepository: failing });
      const target = await createSession(manager);
      const agent = workerOfType(target, 'agent');
      await manager.pauseSession(target.id);
      const errorSpy = spyOn(rootLogger, 'error');
      errorSpy.mockClear();
      try {
        const result = await manager.deliverWorkerNotification(target.id, agent.id, messageParams());

        expect(result).toEqual({ ok: false, error: 'disk full', reason: 'deferral-failed' });
        expect(errorSpy.mock.calls.some((c) => String(c[1]).startsWith('Failed to store a deferred notification'))).toBe(true);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('a paused session: internal-worker-interrupted to the parent is deferred, not not-found', async () => {
      const { manager } = await setup();
      const parent = await createSession(manager);
      const agent = workerOfType(parent, 'agent');
      await manager.pauseSession(parent.id);

      const result = await manager.deliverWorkerNotification(parent.id, agent.id, INTERRUPTED_PARAMS);

      expect(result).toEqual({ ok: true, deferred: true });
      expect((await rowsOf(parent.id)).map((r) => r.kind)).toEqual(['internal-worker-interrupted']);
    });

    it('a paused session: a terminal worker and an embedded-agent worker are deferral targets too', async () => {
      const { manager } = await setup();
      const session = await createSession(manager, 'embedded');
      const terminal = (await manager.createWorker(session.id, { type: 'terminal', name: 'Terminal' }))!;
      const embedded = workerOfType(session, 'embedded-agent');
      await manager.pauseSession(session.id);

      expect(await manager.deliverWorkerNotification(session.id, terminal.id, messageParams())).toEqual({ ok: true, deferred: true });
      expect(await manager.deliverWorkerNotification(session.id, embedded.id, messageParams())).toEqual({ ok: true, deferred: true });
      expect((await rowsOf(session.id)).map((r) => r.workerId).sort()).toEqual([terminal.id, embedded.id].sort());
    });

    it('a paused session: internal-timer is not stored, fails not-found and warns once naming the kind', async () => {
      const { manager } = await setup();
      const session = await createSession(manager);
      const agent = workerOfType(session, 'agent');
      await manager.pauseSession(session.id);
      const warnSpy = spyOn(rootLogger, 'warn');
      warnSpy.mockClear();

      try {
        const result = await manager.deliverWorkerNotification(session.id, agent.id, TIMER_PARAMS);

        expect(result).toMatchObject({ ok: false, reason: 'not-found' });
        expect(await rowsOf(session.id)).toHaveLength(0);
        const kindWarns = warnSpy.mock.calls.filter((c) => (c[0] as { kind?: string })?.kind === 'internal-timer');
        expect(kindWarns).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('a paused session: a live-only kind (internal-review-comment) is not stored and fails not-found', async () => {
      const { manager } = await setup();
      const session = await createSession(manager);
      const agent = workerOfType(session, 'agent');
      await manager.pauseSession(session.id);

      const result = await manager.deliverWorkerNotification(session.id, agent.id, REVIEW_COMMENT_PARAMS);

      expect(result).toMatchObject({ ok: false, reason: 'not-found' });
      expect(await rowsOf(session.id)).toHaveLength(0);
    });

    it('an unknown (e.g. deleted) session, an unknown worker and a git-diff worker all fail not-found with no row', async () => {
      const { manager } = await setup();
      const session = await createSession(manager);
      await manager.pauseSession(session.id);
      // A paused session that also holds a git-diff worker.
      const withDiff = buildPersistedWorktreeSession({
        id: 'with-diff',
        repositoryId: 'repo-1',
        worktreeId: 'diff-branch',
        locationPath: '/test/path',
        dataScope: 'repository',
        dataScopeSlug: 'test-repo',
        serverPid: undefined,
        workers: [buildPersistedGitDiffWorker({ id: 'diff-worker' })],
      });
      await new SqliteSessionRepository(getDatabase()).save(withDiff);

      for (const [sessionId, workerId] of [
        ['no-such-session', 'w'],
        [session.id, 'no-such-worker'],
        ['with-diff', 'diff-worker'],
      ]) {
        const result = await manager.deliverWorkerNotification(sessionId, workerId, messageParams());
        expect(result).toMatchObject({ ok: false, reason: 'not-found' });
      }
      expect(await rowsOf(session.id)).toHaveLength(0);
      expect(await rowsOf('with-diff')).toHaveLength(0);
    });

    it('an orphaned session fails not-found with no row', async () => {
      const { manager } = await setup();
      await new SqliteSessionRepository(getDatabase()).save(
        buildPersistedWorktreeSession({
          id: 'orphan',
          repositoryId: 'repo-1',
          worktreeId: 'orphan-branch',
          locationPath: '/test/path',
          serverPid: undefined,
          recoveryState: 'orphaned',
          orphanedAt: 1,
          orphanedReason: 'missing_scope',
          workers: [buildPersistedAgentWorker({ id: 'orphan-agent' })],
        }),
      );

      const result = await manager.deliverWorkerNotification('orphan', 'orphan-agent', messageParams());

      expect(result).toMatchObject({ ok: false, reason: 'not-found' });
      expect(await rowsOf('orphan')).toHaveLength(0);
    });

    it('during pausing: a PTY target defers instead of failing pty-inactive', async () => {
      const { manager, executeHookCommand, resolveHook } = await setup({ holdPause: true });
      const session = await createSession(manager);
      const agent = workerOfType(session, 'agent');
      const { pause } = await holdPausing(manager, executeHookCommand, session.id);

      const result = await manager.deliverWorkerNotification(session.id, agent.id, messageParams());

      expect(result).toEqual({ ok: true, deferred: true });
      expect(await rowsOf(session.id)).toHaveLength(1);
      resolveHook();
      await pause;
    });

    it('during pausing: an embedded target defers instead of failing embedded-delivery-failed', async () => {
      const { manager, executeHookCommand, resolveHook } = await setup({ holdPause: true });
      const session = await createSession(manager, 'embedded');
      const embedded = workerOfType(session, 'embedded-agent');
      const { pause } = await holdPausing(manager, executeHookCommand, session.id);

      const result = await manager.deliverWorkerNotification(session.id, embedded.id, messageParams());

      expect(result).toEqual({ ok: true, deferred: true });
      expect(await rowsOf(session.id)).toHaveLength(1);
      resolveHook();
      await pause;
    });

    it('during pausing: a kind that is not deferred keeps today\'s failure and stores nothing', async () => {
      const { manager, executeHookCommand, resolveHook } = await setup({ holdPause: true });
      const session = await createSession(manager);
      const agent = workerOfType(session, 'agent');
      const { pause } = await holdPausing(manager, executeHookCommand, session.id);

      const result = await manager.deliverWorkerNotification(session.id, agent.id, TIMER_PARAMS);

      expect(result).toMatchObject({ ok: false, reason: 'pty-inactive' });
      expect(await rowsOf(session.id)).toHaveLength(0);
      resolveHook();
      await pause;
    });

    it('the 101st stored notification evicts the oldest', async () => {
      const { manager } = await setup();
      const session = await createSession(manager);
      const agent = workerOfType(session, 'agent');
      await manager.pauseSession(session.id);

      for (let i = 0; i < 101; i++) {
        setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)));
        await manager.deliverWorkerNotification(session.id, agent.id, messageParams(`/messages/${i}.md`), {
          sourceId: `/messages/${i}.md`,
        });
      }
      setSystemTime();

      const rows = await rowsOf(session.id);
      expect(rows).toHaveLength(100);
      expect(rows[0].sourceId).toBe('/messages/1.md');
      expect(rows.some((r) => r.sourceId === '/messages/0.md')).toBe(false);
    });

    it('a live session is untouched: the notification is written to its PTY and nothing is stored', async () => {
      const { manager } = await setup();
      const session = await createSession(manager);
      const agent = workerOfType(session, 'agent');

      const result = await manager.deliverWorkerNotification(session.id, agent.id, messageParams());

      expect(result).toEqual({ ok: true });
      expect(await rowsOf(session.id)).toHaveLength(0);
    });
  });

  describe('waitForWorkerReady', () => {
    const FLOOR = TEST_READINESS.minOutputBytes;
    const SETTLE = TEST_READINESS.settleMs;
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    it('does NOT resolve before the injection, whatever the worker reads or emits', async () => {
      const { manager } = await setup();
      const { session, agent, output, isReady, track } = await pendingInjectionAgent(manager);
      const waiting = track(manager.waitForWorkerReady(session.id, agent.id));

      output(FLOOR * 10);
      await wait(SETTLE * 2);
      expect(isReady()).toBe(false);
      void waiting;
    });

    it('does NOT resolve on injection + echo-sized output (below the floor), even long after the settle time', async () => {
      const { manager } = await setup();
      const { session, agent, inject, output, isReady, track } = await pendingInjectionAgent(manager);
      const waiting = track(manager.waitForWorkerReady(session.id, agent.id));

      inject();
      output(FLOOR - 1);
      await wait(SETTLE * 3);
      expect(isReady()).toBe(false);
      void waiting;
    });

    it('does NOT resolve at the floor while chunks keep coming inside the settle window (a spinner); resolves settleMs after the last chunk', async () => {
      const { manager } = await setup();
      const { session, agent, inject, output, isReady, track } = await pendingInjectionAgent(manager);
      const waiting = track(manager.waitForWorkerReady(session.id, agent.id));

      inject();
      const startedAt = Date.now();
      for (let i = 0; i < 6; i++) {
        output(FLOOR);
        await wait(SETTLE / 3);
      }
      expect(Date.now() - startedAt).toBeGreaterThan(SETTLE); // longer than one settle window in total
      expect(isReady()).toBe(false);

      const lastChunkAt = Date.now();
      await waiting;
      expect(Date.now() - lastChunkAt).toBeGreaterThanOrEqual(SETTLE / 3);
      expect(isReady()).toBe(true);
    });

    it('resolves for at least the floor followed by quiet, and not before the settle time has passed', async () => {
      const { manager } = await setup();
      const { session, agent, inject, output, isReady, track } = await pendingInjectionAgent(manager);
      const waiting = track(manager.waitForWorkerReady(session.id, agent.id));

      inject();
      output(FLOOR);
      await wait(SETTLE / 3);
      expect(isReady()).toBe(false);
      await waiting;
      expect(isReady()).toBe(true);
    });

    it('accumulates the floor across several chunks', async () => {
      const { manager } = await setup();
      const { session, agent, inject, output, isReady, track } = await pendingInjectionAgent(manager);
      const waiting = track(manager.waitForWorkerReady(session.id, agent.id));

      inject();
      for (let i = 0; i < 4; i++) output(FLOOR / 4);
      await waiting;
      expect(isReady()).toBe(true);
    });

    it('resolves at the cap with a warn when the floor is never reached', async () => {
      const { manager } = await setup({ readiness: { capMs: 40 } });
      const { session, agent, inject, output } = await pendingInjectionAgent(manager);
      const warnSpy = spyOn(rootLogger, 'warn');
      warnSpy.mockClear();
      try {
        inject();
        output(FLOOR - 1);
        await manager.waitForWorkerReady(session.id, agent.id);
        expect(warnSpy.mock.calls.some((c) => String(c[1]).startsWith('Agent worker was not ready'))).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('resolves at the cap when the injection never happens', async () => {
      const { manager } = await setup({ readiness: { capMs: 30 } });
      const { session, agent } = await pendingInjectionAgent(manager);

      await manager.waitForWorkerReady(session.id, agent.id);
    });

    it('honors injected constants: a larger floor and a longer settle change when it resolves', async () => {
      const { manager } = await setup({ readiness: { minOutputBytes: FLOOR * 5, settleMs: SETTLE * 4 } });
      const { session, agent, inject, output, isReady, track } = await pendingInjectionAgent(manager);
      const waiting = track(manager.waitForWorkerReady(session.id, agent.id));

      inject();
      output(FLOOR * 2); // above the default test floor, below the injected one
      await wait(SETTLE * 2);
      expect(isReady()).toBe(false);
      output(FLOOR * 3);
      await wait(SETTLE * 2); // past the default settle, inside the injected one
      expect(isReady()).toBe(false);
      await waiting;
    });

    it('resolves when the worker exits before the sentinel (the exit clear settles the injection and the PTY is gone)', async () => {
      const { manager } = await setup();
      const { session, agent, internal, isReady, track } = await pendingInjectionAgent(manager);
      const waiting = track(manager.waitForWorkerReady(session.id, agent.id));
      expect(isReady()).toBe(false);

      internal.pty = null; // what WorkerManager's exit handling does ...
      internal.commandInjection!.resolve(); // ... together with the exit clear
      await waiting;
      expect(isReady()).toBe(true);
    });

    it('resolves when the worker exits after the injection while it waits for output', async () => {
      const { manager } = await setup();
      const { session, agent, internal, inject, isReady, track } = await pendingInjectionAgent(manager);
      const waiting = track(manager.waitForWorkerReady(session.id, agent.id));
      inject();
      await wait(5);
      expect(isReady()).toBe(false);

      internal.pty = null;
      for (const notify of [...internal.postInjectionOutputWaiters]) notify();
      await waiting;
      expect(isReady()).toBe(true);
    });

    it('resolves promptly, without the cap warn, when the worker is killed while it waits for the injection', async () => {
      const { manager } = await setup({ readiness: { capMs: 3000 } });
      const { session, agent, isReady, track } = await pendingInjectionAgent(manager);
      const waiting = track(manager.waitForWorkerReady(session.id, agent.id));
      await wait(10);
      expect(isReady()).toBe(false);
      const warnSpy = spyOn(rootLogger, 'warn');
      warnSpy.mockClear();
      try {
        const startedAt = Date.now();
        await manager.deleteWorker(session.id, agent.id);
        await waiting;

        expect(Date.now() - startedAt).toBeLessThan(1500);
        expect(warnSpy.mock.calls.some((c) => String(c[1]).startsWith('Agent worker was not ready'))).toBe(false);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('resolves immediately for a terminal worker and for an embedded-agent worker', async () => {
      const { manager } = await setup();
      const session = await createSession(manager);
      const terminal = (await manager.createWorker(session.id, { type: 'terminal', name: 'Terminal' }))!;
      const embeddedSession = await createSession(manager, 'embedded');
      const embedded = workerOfType(embeddedSession, 'embedded-agent');

      await manager.waitForWorkerReady(session.id, terminal.id);
      await manager.waitForWorkerReady(embeddedSession.id, embedded.id);
    });

    it('production defaults: 2048 bytes, 3 s settle, 60 s cap', () => {
      expect([WORKER_READY_MIN_OUTPUT_BYTES, WORKER_READY_SETTLE_MS, WORKER_READY_CAP_MS]).toEqual([2048, 3000, 60_000]);
    });
  });

  describe('flushDeferredNotifications', () => {
    /** Insert a stored notification straight into the real repository. */
    async function store(
      sessionId: string,
      workerId: string,
      createdAt: string,
      overrides: Partial<NewDeferredWorkerNotification> = {},
    ) {
        const params = messageParams(`/messages/${createdAt}.md`);
      await new SqliteDeferredWorkerNotificationRepository(getDatabase()).insert(
        {
          id: `row-${createdAt}-${workerId}`,
          sessionId,
          workerId,
          kind: 'internal-message',
          sourceId: `/messages/${createdAt}.md`,
          paramsJson: JSON.stringify(params),
          replyToSessionId: null,
          createdAt,
          ...overrides,
        },
        100,
      );
    }

    /** Replace the seam with a recorder (the flush calls `this.deliverWorkerNotification`). */
    function fakeSeam(manager: SessionManager, result: { ok: true } | { ok: false; error: string; reason: 'not-found' } = { ok: true }) {
      const calls: Array<{ workerId: string; params: PtyNotificationParams; sourceId?: string; fileExisted: boolean; rowsLeft: number }> = [];
      const seam = spyOn(manager, 'deliverWorkerNotification').mockImplementation(async (sessionId, workerId, params, opts) => {
        const path = (params.fields as { path?: string }).path ?? '';
        calls.push({
          workerId,
          params,
          sourceId: opts?.sourceId,
          fileExisted: fs.existsSync(path),
          rowsLeft: (await rowsOf(sessionId)).filter((r) => r.workerId === workerId).length,
        });
        return result;
      });
      return { calls, seam };
    }

    async function twoWorkerSession(manager: SessionManager) {
      spyOn(manager, 'waitForWorkerReady').mockResolvedValue();
      const session = await createSession(manager);
      const agent = workerOfType(session, 'agent');
      const terminal = (await manager.createWorker(session.id, { type: 'terminal', name: 'Terminal' }))!;
      return { session, agent, terminal };
    }

    it('delivers exactly one internal-paused-digest per worker, in worker order, never one per row', async () => {
      const { manager } = await setup();
      const { session, agent, terminal } = await twoWorkerSession(manager);
      await store(session.id, terminal.id, '2026-01-01T00:00:01.000Z');
      await store(session.id, agent.id, '2026-01-01T00:00:02.000Z');
      await store(session.id, agent.id, '2026-01-01T00:00:03.000Z');
      await store(session.id, agent.id, '2026-01-01T00:00:04.000Z');
      const { calls } = fakeSeam(manager);

      await manager.flushDeferredNotifications(session.id, '2026-01-01T00:00:00.000Z');

      expect(calls.map((c) => [c.workerId, c.params.kind])).toEqual([
        [agent.id, 'internal-paused-digest'],
        [terminal.id, 'internal-paused-digest'],
      ]);
      expect(calls.map((c) => (c.params.fields as { count: string }).count)).toEqual(['3', '1']);
      expect(await rowsOf(session.id)).toHaveLength(0);
    });

    it('writes the read-more file BEFORE deleting any row, and every digest names that file', async () => {
      const real = new SqliteDeferredWorkerNotificationRepository(getDatabase());
      let deferredDir = '';
      const filesAtDelete: string[][] = [];
      const recording: DeferredWorkerNotificationRepository = {
        insert: (row, cap) => real.insert(row, cap),
        listBySession: (sessionId) => real.listBySession(sessionId),
        countBySession: (sessionId) => real.countBySession(sessionId),
        deleteByIds: async (ids) => {
          filesAtDelete.push(fs.existsSync(deferredDir) ? fs.readdirSync(deferredDir) : []);
          return real.deleteByIds(ids);
        },
      };
      const { manager } = await setup({ deferredRepository: recording });
      const { session, agent, terminal } = await twoWorkerSession(manager);
      deferredDir = manager.getPathResolverForSessionId(session.id)!.getDeferredDir();
      await store(session.id, agent.id, '2026-01-01T00:00:02.000Z');
      await store(session.id, terminal.id, '2026-01-01T00:00:03.000Z');
      const { calls } = fakeSeam(manager);

      await manager.flushDeferredNotifications(session.id, '2026-01-01T00:00:00.000Z');

      // One delete per worker, and the file was already there for the FIRST one.
      expect(filesAtDelete).toHaveLength(2);
      expect(filesAtDelete[0]).toHaveLength(1);
      const paths = calls.map((c) => (c.params.fields as { path: string }).path);
      expect(new Set(paths).size).toBe(1);
      expect(paths[0]).toBe(`${deferredDir}/${filesAtDelete[0][0]}`);
      expect(calls.every((c) => c.sourceId === paths[0])).toBe(true);
      expect(calls.every((c) => c.fileExisted)).toBe(true);
      const file = fs.readFileSync(paths[0], 'utf-8');
      expect(file).toContain('/messages/2026-01-01T00:00:02.000Z.md');
      expect(file).toContain('/messages/2026-01-01T00:00:03.000Z.md');
    });

    it('does not delete any row when the read-more file cannot be written', async () => {
      const { manager } = await setup();
      const { session, agent } = await twoWorkerSession(manager);
      await store(session.id, agent.id, '2026-01-01T00:00:02.000Z');
      const { calls } = fakeSeam(manager);
      // A regular file where the deferred directory has to be created.
      const resolver = manager.getPathResolverForSessionId(session.id)!;
      fs.mkdirSync(resolver.getTrustedRoot(), { recursive: true });
      fs.writeFileSync(resolver.getDeferredDir(), 'in the way');

      await manager.flushDeferredNotifications(session.id);

      expect(calls).toHaveLength(0);
      expect(await rowsOf(session.id)).toHaveLength(1);
    });

    it('logs a failed delivery at warn with the reason, and the rows stay deleted', async () => {
      const { manager } = await setup();
      const { session, agent } = await twoWorkerSession(manager);
      await store(session.id, agent.id, '2026-01-01T00:00:02.000Z');
      fakeSeam(manager, { ok: false, error: 'gone', reason: 'not-found' });
      const warnSpy = spyOn(rootLogger, 'warn');
      warnSpy.mockClear();

      try {
        await manager.flushDeferredNotifications(session.id);

        const warn = warnSpy.mock.calls.find((c) => String(c[1]).startsWith('Failed to deliver the paused-session digest'));
        expect(warn?.[0]).toMatchObject({ reason: 'not-found', workerId: agent.id });
        expect(await rowsOf(session.id)).toHaveLength(0);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('returns at once when a pause is in flight: no seam call, rows intact', async () => {
      const { manager, executeHookCommand, resolveHook } = await setup({ holdPause: true });
      const { session, agent } = await twoWorkerSession(manager);
      await store(session.id, agent.id, '2026-01-01T00:00:02.000Z');
      const { calls } = fakeSeam(manager);
      const { pause } = await holdPausing(manager, executeHookCommand, session.id);

      await manager.flushDeferredNotifications(session.id);

      expect(calls).toHaveLength(0);
      expect(await rowsOf(session.id)).toHaveLength(1);
      resolveHook();
      await pause;
    });

    it('with zero rows makes no seam call but still waits for an agent PTY worker to be ready', async () => {
      const { manager } = await setup();
      const { session, inject, output } = await pendingInjectionAgent(manager);
      const { calls } = fakeSeam(manager);
      let done = false;
      const flush = manager.flushDeferredNotifications(session.id).then(() => { done = true; });

      await settle();
      expect(done).toBe(false);

      inject();
      output(TEST_READINESS.minOutputBytes);
      await flush;
      expect(done).toBe(true);
      expect(calls).toHaveLength(0);
    });

    it('delivers to an agent PTY worker only after it is ready, and does not wait for a terminal worker', async () => {
      const { manager } = await setup();
      const { session, agent, inject, output } = await pendingInjectionAgent(manager);
      const terminal = (await manager.createWorker(session.id, { type: 'terminal', name: 'Terminal' }))!;
      await store(session.id, agent.id, '2026-01-01T00:00:02.000Z');
      await store(session.id, terminal.id, '2026-01-01T00:00:03.000Z');
      const order: string[] = [];
      spyOn(manager, 'deliverWorkerNotification').mockImplementation(async (_s, workerId) => {
        order.push(`deliver:${workerId === agent.id ? 'agent' : 'terminal'}`);
        return { ok: true };
      });
      const flush = manager.flushDeferredNotifications(session.id);

      await settle();
      expect(order).toEqual([]);

      inject();
      output(TEST_READINESS.minOutputBytes);
      order.push('ready');
      await flush;
      expect(order).toEqual(['ready', 'deliver:agent', 'deliver:terminal']);
    });

    it('a session whose only capable workers are a terminal and an embedded agent needs no activity: the flush completes at once', async () => {
      const { manager } = await setup();
      const session = await createSession(manager, 'embedded');
      const terminal = (await manager.createWorker(session.id, { type: 'terminal', name: 'Terminal' }))!;
      await store(session.id, terminal.id, '2026-01-01T00:00:03.000Z');
      const { calls } = fakeSeam(manager);

      await manager.flushDeferredNotifications(session.id);

      expect(calls).toHaveLength(1);
    });

    it('a terminal-only session needs no idle: the flush completes without any activity event', async () => {
      const { manager } = await setup();
      manager.setGlobalActivityCallback(() => {});
      const session = await createSession(manager);
      await manager.deleteWorker(session.id, workerOfType(session, 'agent').id);
      const terminal = (await manager.createWorker(session.id, { type: 'terminal', name: 'Terminal' }))!;
      await store(session.id, terminal.id, '2026-01-01T00:00:03.000Z');
      const { calls } = fakeSeam(manager);

      await manager.flushDeferredNotifications(session.id);

      expect(calls).toHaveLength(1);
    });

    it('leaves the rows when a pause begins while it waits for readiness', async () => {
      const { manager, executeHookCommand, resolveHook } = await setup({ holdPause: true });
      const { session, agent, inject, output } = await pendingInjectionAgent(manager);
      await store(session.id, agent.id, '2026-01-01T00:00:02.000Z');
      const { calls } = fakeSeam(manager);
      const flush = manager.flushDeferredNotifications(session.id);
      const { pause } = await holdPausing(manager, executeHookCommand, session.id);

      inject();
      output(TEST_READINESS.minOutputBytes);
      await flush;

      expect(calls).toHaveLength(0);
      expect(await rowsOf(session.id)).toHaveLength(1);
      resolveHook();
      await pause;
    });

    it('a flush made stale by a pause + resume during its readiness wait delivers nothing and leaves the rows to the resume flush', async () => {
      const { manager } = await setup();
      const session = await createSession(manager);
      const agent = workerOfType(session, 'agent');
      await store(session.id, agent.id, '2026-01-01T00:00:02.000Z');
      // The first readiness wait (the soon-stale flush) and the second (the resume's own flush) are held by hand.
      const gates: Array<() => void> = [];
      spyOn(manager, 'waitForWorkerReady').mockImplementation(
        () => new Promise<void>((resolve) => { gates.push(resolve); }),
      );
      const { calls } = fakeSeam(manager);
      const liveBefore = manager.getWorker(session.id, agent.id);
      const staleFlush = manager.flushDeferredNotifications(session.id);
      await until(() => gates.length === 1);

      await manager.pauseSession(session.id);
      await manager.resumeSession(session.id);
      await until(() => gates.length === 2);
      // Positive control: the cycle really replaced the in-memory session object.
      expect(manager.getWorker(session.id, agent.id)).not.toBe(liveBefore);

      gates[0]();
      await staleFlush;
      expect(calls).toHaveLength(0);
      expect(await rowsOf(session.id)).toHaveLength(1);

      gates[1]();
      await until(() => calls.length === 1);
      await until(async () => (await rowsOf(session.id)).length === 0);
      expect(calls).toHaveLength(1);
    });

    it('a corrupt row is skipped with a warn but still deleted; the valid ones are delivered', async () => {
      const { manager } = await setup();
      const { session, agent } = await twoWorkerSession(manager);
      await store(session.id, agent.id, '2026-01-01T00:00:02.000Z');
      await store(session.id, agent.id, '2026-01-01T00:00:03.000Z', { kind: 'not-a-known-kind' as never });
      const { calls } = fakeSeam(manager);

      await manager.flushDeferredNotifications(session.id);

      expect(calls).toHaveLength(1);
      expect((calls[0].params.fields as { count: string }).count).toBe('1');
      expect(await rowsOf(session.id)).toHaveLength(0);
    });

    it('digest race: a pause that begins between the row delete and the digest delivery stores the digest itself as ONE row', async () => {
      const real = new SqliteDeferredWorkerNotificationRepository(getDatabase());
      let onDelete: () => Promise<void> = async () => {};
      const racing: DeferredWorkerNotificationRepository = {
        insert: (row, cap) => real.insert(row, cap),
        listBySession: (sessionId) => real.listBySession(sessionId),
        countBySession: (sessionId) => real.countBySession(sessionId),
        deleteByIds: async (ids) => {
          const deleted = await real.deleteByIds(ids);
          await onDelete();
          return deleted;
        },
      };
      const { manager, executeHookCommand, resolveHook } = await setup({ holdPause: true, deferredRepository: racing });
      const { session, agent } = await twoWorkerSession(manager);
      await store(session.id, agent.id, '2026-01-01T00:00:02.000Z');
      await store(session.id, agent.id, '2026-01-01T00:00:03.000Z');
      let pause: Promise<unknown> | undefined;
      onDelete = async () => {
        pause = manager.pauseSession(session.id);
        await until(() => executeHookCommand.mock.calls.length > 0);
      };

      await manager.flushDeferredNotifications(session.id);

      const rows = await rowsOf(session.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('internal-paused-digest');
      expect(rows[0].sourceId).toContain('/deferred/');
      expect((JSON.parse(rows[0].paramsJson) as { fields: { count: string } }).fields.count).toBe('2');
      resolveHook();
      await pause;
    });

    it('a schedule that came due during the pause fires after the digest (seam sequence: digest, then timer)', async () => {
      const { manager } = await setup();
      spyOn(manager, 'waitForWorkerReady').mockResolvedValue();
      const session = await createSession(manager);
      const agent = workerOfType(session, 'agent');
      // A timer whose remaining wait is 0 fires on the next macrotask after its resume.
      manager.registerPauseParticipant('due-timer', {
        suspend: () => {},
        resume: (id) => { setTimeout(() => { void manager.deliverWorkerNotification(id, agent.id, TIMER_PARAMS); }, 0); },
      });
      await manager.pauseSession(session.id);
      await manager.deliverWorkerNotification(session.id, agent.id, messageParams());
      const sequence: string[] = [];
      const seam = manager.deliverWorkerNotification.bind(manager);
      spyOn(manager, 'deliverWorkerNotification').mockImplementation(async (s, w, params, opts) => {
        const result = await seam(s, w, params, opts);
        sequence.push(params.kind);
        return result;
      });

      await manager.resumeSession(session.id);
      await until(() => sequence.length >= 2);

      expect(sequence).toEqual(['internal-paused-digest', 'internal-timer']);
    });
  });
});

/** In-memory stand-in for the boot test, where the session store is the JSON file (no database foreign keys). */
class FakeDeferredRepository implements DeferredWorkerNotificationRepository {
  rows: DeferredWorkerNotificationRecord[] = [];
  async insert(row: NewDeferredWorkerNotification): Promise<void> { this.rows.push(row); }
  async listBySession(sessionId: string) { return this.rows.filter((r) => r.sessionId === sessionId); }
  async deleteByIds(ids: string[]) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !ids.includes(r.id));
    return before - this.rows.length;
  }
  async countBySession(sessionId: string) { return this.rows.filter((r) => r.sessionId === sessionId).length; }
}

describe('SessionManager: auto-resume at server start flushes deferred notifications', () => {
  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '', '/path/to/worktree/.keep': '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    await initializeDatabase(':memory:');
    resetProcessMock();
    ptyFactory.reset();
    fs.writeFileSync(`${TEST_CONFIG_DIR}/agents.json`, JSON.stringify([]));
  });

  afterEach(async () => {
    await closeDatabase();
    cleanupMemfs();
    delete process.env.AGENT_CONSOLE_HOME;
  });

  it('delivers one digest to a terminal worker of an auto-resumed session and removes the rows', async () => {
    // A server pid that is not alive: the session is picked up for auto-resume.
    fs.writeFileSync(
      `${TEST_CONFIG_DIR}/sessions.json`,
      JSON.stringify([
        buildPersistedWorktreeSession({
          id: 'boot-session',
          locationPath: '/path/to/worktree',
          repositoryId: 'repo-1',
          dataScope: 'repository',
          dataScopeSlug: 'test-repo',
          serverPid: 424242,
          workers: [buildPersistedTerminalWorker({ id: 'boot-terminal', pid: 1 })],
        }),
      ]),
    );
    const repository = new FakeDeferredRepository();
    await repository.insert({
      id: 'r1',
      sessionId: 'boot-session',
      workerId: 'boot-terminal',
      kind: 'internal-message',
      sourceId: '/messages/m.md',
      paramsJson: JSON.stringify(messageParams('/messages/m.md')),
      replyToSessionId: null,
      createdAt: '2026-01-01T00:00:02.000Z',
    });
    const module = await import(`../session-manager.js?v=${++importCounter}`) as typeof import('../session-manager.js');
    const agentManager = await AgentManager.create(new SqliteAgentRepository(getDatabase()));

    await module.SessionManager.create({
      sessionRepository: await createTestSessionRepository(),
      deferredNotificationRepository: repository,
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      agentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      repositoryLookup: defaultRepositoryLookup,
      repositoryEnvLookup: makeRepositoryEnvLookup({ mapping: () => ({ name: 'test-repo', path: '/test/repo' }) }),
      pathExists: async () => true,
    });

    await until(() => repository.rows.length === 0);
    const written = ptyFactory.instances.flatMap((p) => p.writtenData).join('');
    expect(written).toContain('[internal:paused-digest]');
    expect(written).toContain('count=1');
  });
});

