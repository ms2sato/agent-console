import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import type { Worker } from '@agent-console/shared';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { defaultRepositoryLookup, makeRepositoryEnvLookup } from '../../__tests__/utils/repository-lookup-mock.js';
import { createTestSessionRepository } from '../../__tests__/utils/test-session-repository.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { AgentManager } from '../agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { SingleUserMode } from '../user-mode.js';
import { McpTokenRegistry } from '../../mcp/mcp-auth.js';
import { SessionPausingError } from '../../lib/errors.js';
import type { PtyNotificationParams } from '../../lib/pty-notification.js';
import type { ExecuteHookCommand, SessionManager } from '../session-manager.js';
import type { PauseSessionOutcome } from '../session-pause-resume-service.js';

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

const ptyFactory = createMockPtyFactory(10000);
let importCounter = 0;
let agentManager: AgentManager;

// A session between "workers killed" and "removed from memory" is still in
// memory with every PTY cleared. The pause command makes that window as long as
// the time box, so these tests hold it open with a hook that stays pending.
describe('SessionManager: a session that is pausing refuses worker activation', () => {
  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    await initializeDatabase(':memory:');
    resetProcessMock();
    mockProcess.markAlive(process.pid);
    ptyFactory.reset();
    resetGitMocks();
    agentManager = await AgentManager.create(new SqliteAgentRepository(getDatabase()));
  });

  afterEach(async () => {
    await closeDatabase();
    cleanupMemfs();
    delete process.env.AGENT_CONSOLE_HOME;
  });

  async function setup() {
    let resolveHook!: (result: HookResult) => void;
    let rejectHook!: (reason: unknown) => void;
    const executeHookCommand = mock<ExecuteHookCommand>(
      () =>
        new Promise<HookResult>((resolve, reject) => {
          resolveHook = resolve;
          rejectHook = reject;
        }),
    );
    const module = await import(`../session-manager.js?v=${++importCounter}`) as typeof import('../session-manager.js');
    const manager: SessionManager = await module.SessionManager.create({
      sessionRepository: await createTestSessionRepository(),
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
    });
    return {
      manager,
      executeHookCommand,
      resolveHook: (result: HookResult) => resolveHook(result),
      rejectHook: (reason: unknown) => rejectHook(reason),
    };
  }

  async function createSession(manager: SessionManager, embedded = false) {
    return manager.createSession({
      type: 'worktree',
      locationPath: '/test/path',
      repositoryId: 'repo-1',
      worktreeId: 'feature-branch',
      ...(embedded ? { embeddedAgentId: EMBEDDED_DEF.id } : { agentId: 'claude-code' }),
    });
  }

  async function hookStarted(hook: { mock: { calls: unknown[] } }): Promise<void> {
    for (let i = 0; i < 400 && hook.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(hook.mock.calls.length).toBeGreaterThan(0);
  }

  function workerOfType(session: { workers: Worker[] }, type: Worker['type']): Worker {
    const worker = session.workers.find((w) => w.type === type);
    if (!worker) throw new Error(`no ${type} worker`);
    return worker;
  }

  it('restoreWorker rejects with SessionPausingError and never spawns a PTY', async () => {
    const { manager, executeHookCommand, resolveHook } = await setup();
    const session = await createSession(manager);
    const agent = workerOfType(session, 'agent');
    const pause = manager.pauseSession(session.id);
    await hookStarted(executeHookCommand);
    expect(manager.isPausing(session.id)).toBe(true);
    const spawnsBefore = ptyFactory.instances.length;

    await expect(manager.restoreWorker(session.id, agent.id)).rejects.toBeInstanceOf(SessionPausingError);

    expect(ptyFactory.instances.length).toBe(spawnsBefore);
    resolveHook({ success: true });
    await pause;
  });

  it('createWorker, getAvailableWorker and both restart entry points reject with SessionPausingError', async () => {
    const { manager, executeHookCommand, resolveHook } = await setup();
    const session = await createSession(manager);
    const agent = workerOfType(session, 'agent');
    const pause = manager.pauseSession(session.id);
    await hookStarted(executeHookCommand);
    const spawnsBefore = ptyFactory.instances.length;

    await expect(manager.createWorker(session.id, { type: 'terminal', name: 'Shell' })).rejects.toBeInstanceOf(SessionPausingError);
    await expect(manager.getAvailableWorker(session.id, agent.id)).rejects.toBeInstanceOf(SessionPausingError);
    await expect(manager.restartAgentWorker(session.id, agent.id, 'fresh')).rejects.toBeInstanceOf(SessionPausingError);
    await expect(
      manager.restartAgentWorkerAsEmbedded(session.id, agent.id, EMBEDDED_DEF.id),
    ).rejects.toBeInstanceOf(SessionPausingError);

    expect(ptyFactory.instances.length).toBe(spawnsBefore);
    resolveHook({ success: true });
    await pause;
  });

  it('activateEmbeddedAgentWorker rejects with SessionPausingError', async () => {
    const { manager, executeHookCommand, resolveHook } = await setup();
    const session = await createSession(manager, true);
    const embedded = workerOfType(session, 'embedded-agent');
    const pause = manager.pauseSession(session.id);
    await hookStarted(executeHookCommand);

    await expect(manager.activateEmbeddedAgentWorker(session.id, embedded.id)).rejects.toBeInstanceOf(SessionPausingError);

    resolveHook({ success: true });
    await pause;
  });

  it('a notification for an embedded worker reports a delivery failure instead of waking the worker', async () => {
    const { manager, executeHookCommand, resolveHook } = await setup();
    const session = await createSession(manager, true);
    const embedded = workerOfType(session, 'embedded-agent');
    const pause = manager.pauseSession(session.id);
    await hookStarted(executeHookCommand);

    const result = await manager.deliverWorkerNotification(session.id, embedded.id, TIMER_PARAMS);

    // The guard's rejection reaches the caller as an ordinary delivery failure
    // (the worker was not woken), the same answer any activation failure gives.
    expect(result).toMatchObject({ ok: false, reason: 'embedded-delivery-failed' });
    resolveHook({ success: true });
    await pause;
  });

  it('restartAllAgentWorkers skips every worker of a pausing session and still restarts a non-pausing one in the same call', async () => {
    const { manager, executeHookCommand, resolveHook } = await setup();
    const pausingSession = await createSession(manager);
    // A second worker so the assertion covers every non-git-diff worker, not one.
    await manager.createWorker(pausingSession.id, { type: 'terminal', name: 'Shell' });
    const idleSession = await manager.createSession({
      type: 'worktree',
      locationPath: '/test/path',
      repositoryId: 'repo-1',
      worktreeId: 'other-branch',
      agentId: 'claude-code',
    });
    const idleAgent = workerOfType(idleSession, 'agent');
    const pause = manager.pauseSession(pausingSession.id);
    await hookStarted(executeHookCommand);
    expect(manager.isPausing(idleSession.id)).toBe(false);

    const result = await manager.restartAllAgentWorkers({ kind: 'all' });

    const pausingEntries = result.results.filter((r) => r.sessionId === pausingSession.id);
    const pausingWorkers = manager.getSession(pausingSession.id)!.workers.filter((w) => w.type !== 'git-diff');
    expect(pausingWorkers.length).toBeGreaterThanOrEqual(2);
    expect(pausingEntries.map((r) => r.workerId).sort()).toEqual(pausingWorkers.map((w) => w.id).sort());
    for (const entry of pausingEntries) {
      expect(entry.outcome).toBe('skipped');
      expect(entry.error).toBe('Session is pausing');
    }
    expect(result.results.filter((r) => r.sessionId === idleSession.id)).toEqual([
      { sessionId: idleSession.id, workerId: idleAgent.id, workerType: 'agent', outcome: 'restarted' },
    ]);
    resolveHook({ success: true });
    await pause;
  });

  it('a second pauseSession joins the one in flight: same outcome, one hook run', async () => {
    const { manager, executeHookCommand, resolveHook } = await setup();
    const session = await createSession(manager);
    const first = manager.pauseSession(session.id);
    await hookStarted(executeHookCommand);

    const second = manager.pauseSession(session.id);
    resolveHook({ success: true, output: 'stopped' });
    const [firstOutcome, secondOutcome]: PauseSessionOutcome[] = await Promise.all([first, second]);

    expect(secondOutcome).toBe(firstOutcome);
    expect(firstOutcome).toEqual({ paused: true, pauseCommandResult: { success: true, output: 'stopped' } });
    expect(executeHookCommand).toHaveBeenCalledTimes(1);
  });

  it('resumeSession during a pause returns the existing session and activates nothing', async () => {
    const { manager, executeHookCommand, resolveHook } = await setup();
    const session = await createSession(manager);
    const pause = manager.pauseSession(session.id);
    await hookStarted(executeHookCommand);
    const spawnsBefore = ptyFactory.instances.length;

    const resumed = await manager.resumeSession(session.id);

    expect(resumed?.session.id).toBe(session.id);
    expect(ptyFactory.instances.length).toBe(spawnsBefore);
    expect(executeHookCommand).toHaveBeenCalledTimes(1);
    resolveHook({ success: true });
    await pause;
  });

  it('once the pause settles the guard is gone and the session is paused', async () => {
    const { manager, executeHookCommand, resolveHook } = await setup();
    const session = await createSession(manager);
    const agent = workerOfType(session, 'agent');
    const pause = manager.pauseSession(session.id);
    await hookStarted(executeHookCommand);

    resolveHook({ success: true });
    await pause;

    expect(manager.isPausing(session.id)).toBe(false);
    expect(manager.getSession(session.id)).toBeUndefined();
    // The saved row is not in memory, so the normal not-found answer applies
    // (not SessionPausingError).
    const restored = await manager.restoreWorker(session.id, agent.id);
    expect(restored.success).toBe(false);
  });

  it('a pause command that rejects still clears the guard and pauses the session', async () => {
    const { manager, executeHookCommand, rejectHook } = await setup();
    const session = await createSession(manager);
    const pause = manager.pauseSession(session.id);
    await hookStarted(executeHookCommand);

    rejectHook(new Error('runner down'));
    const outcome = await pause;

    expect(outcome).toEqual({ paused: true, pauseCommandResult: { success: false, error: 'runner down' } });
    expect(manager.isPausing(session.id)).toBe(false);
    expect(manager.getSession(session.id)).toBeUndefined();
  });

  it('a pause that fails after the command clears the guard so the pause can be retried', async () => {
    const { manager, executeHookCommand, resolveHook } = await setup();
    const session = await createSession(manager);
    const saveSpy = spyOn(manager.getSessionRepository(), 'save').mockRejectedValueOnce(new Error('disk full'));
    try {
      const pause = manager.pauseSession(session.id);
      await hookStarted(executeHookCommand);
      expect(manager.isPausing(session.id)).toBe(true);

      resolveHook({ success: true });
      await expect(pause).rejects.toThrow('disk full');

      expect(manager.isPausing(session.id)).toBe(false);
      expect(manager.getSession(session.id)).toBeDefined();
    } finally {
      saveSpy.mockRestore();
    }
  });
});
