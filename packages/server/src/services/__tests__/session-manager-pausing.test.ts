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
import { SessionDeletingError, SessionPausingError } from '../../lib/errors.js';
import type { PtyNotificationParams } from '../../lib/pty-notification.js';
import type { ExecuteHookCommand, SessionManager } from '../session-manager.js';
import type { JobQueue } from '../../jobs/index.js';
import type { PauseSessionOutcome } from '../session-pause-resume-service.js';
import type { UserRepository } from '../../repositories/user-repository.js';
import type { LookupOsUserFn } from '../os-user-lookup.js';
import type { runAsUser } from '../privilege-elevation.js';

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

  // A session owned by this user resolves to an OS username other than the test process's, so the agent PTY
  // activation takes the multi-user branch that mints an MCP token (it also needs AUTH_MODE=multi-user).
  const OWNER_ID = 'user-alice-uuid';
  const ownerRepository: UserRepository = {
    async upsertByOsUid() {
      throw new Error('not used');
    },
    async findById(id: string) {
      return id === OWNER_ID ? { id, username: 'alice', homeDir: '/home/alice' } : null;
    },
    async findByUsername() {
      return null;
    },
    async findAll() {
      return [];
    },
    async getOsUidById() {
      throw new Error('not used');
    },
    async refreshOsIdentity() {
      throw new Error('not used');
    },
    async getPreferences() {
      return null;
    },
    async setPreferences() {
      return true;
    },
  };
  const okRunAsUser: typeof runAsUser = async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false, cwdFailed: false });
  const lookupAlice: LookupOsUserFn = async () => ({ uid: 4242, homeDir: '/home/alice' });

  async function setup(hookOverride?: ExecuteHookCommand, jobQueue?: JobQueue, tokenMinting = false) {
    let resolveHook!: (result: HookResult) => void;
    let rejectHook!: (reason: unknown) => void;
    const executeHookCommand = mock<ExecuteHookCommand>(
      () =>
        new Promise<HookResult>((resolve, reject) => {
          resolveHook = resolve;
          rejectHook = reject;
        }),
    );
    const mcpTokenRegistry = new McpTokenRegistry();
    const module = await import(`../session-manager.js?v=${++importCounter}`) as typeof import('../session-manager.js');
    const manager: SessionManager = await module.SessionManager.create({
      sessionRepository: await createTestSessionRepository(),
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      agentManager,
      mcpTokenRegistry,
      embeddedAgentManager: {
        getEmbeddedAgent: (id: string) => (id === EMBEDDED_DEF.id ? EMBEDDED_DEF : undefined),
      },
      repositoryLookup: defaultRepositoryLookup,
      repositoryEnvLookup: makeRepositoryEnvLookup({
        mapping: () => ({ name: 'test-repo', path: '/test/repo', pauseCommand: 'docker compose stop' }),
        getWorktreeIndexNumber: async () => 5,
      }),
      executeHookCommand: hookOverride ?? executeHookCommand,
      ...(jobQueue ? { jobQueue } : {}),
      ...(tokenMinting
        ? { userRepository: ownerRepository, runAsUserImpl: okRunAsUser, lookupOsUserFn: lookupAlice, assertSpawnCwdFn: async () => {} }
        : {}),
    });
    return {
      manager,
      mcpTokenRegistry,
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

  it('activateEmbeddedAgentWorker rejects with SessionDeletingError while the session is being deleted', async () => {
    const { manager } = await setup();
    const session = await createSession(manager, true);
    const embedded = workerOfType(session, 'embedded-agent');
    // A PTY worker whose kill is held keeps the deletion parked in its awaited cleanup.
    await manager.createWorker(session.id, { type: 'terminal', name: 'Shell' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let killStarted = false;
    const killSpy = spyOn(manager['workerManager'], 'killWorker').mockImplementation(async () => {
      killStarted = true;
      await gate;
    });
    const deletion = manager.deleteSession(session.id);
    for (let i = 0; i < 400 && !killStarted; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(manager.isDeleting(session.id)).toBe(true);

    await expect(manager.activateEmbeddedAgentWorker(session.id, embedded.id)).rejects.toBeInstanceOf(SessionDeletingError);

    release();
    // This harness has no job queue, so the deletion itself fails after the window under test.
    await deletion.catch(() => undefined);
    killSpy.mockRestore();
    expect(manager.isDeleting(session.id)).toBe(false);
  });

  // A terminal worker's PTY activation is parked before its spawn (first cwd check held) while the session is
  // deleted, or paused and resumed (a new session object), by the time it resumes. Each ends with no marker set.
  function holdFirstSpawnCwdCheck(manager: SessionManager) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    manager['workerManager']['assertSpawnCwdFn'] = async () => {
      calls++;
      if (calls === 1) await gate;
    };
    return {
      release,
      reached: async () => {
        for (let i = 0; i < 400 && calls === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
        expect(calls).toBeGreaterThan(0);
      },
    };
  }

  it('a worker activation parked before its spawn when the session is deleted spawns nothing and rejects with SessionDeletingError', async () => {
    const { manager } = await setup();
    const session = await createSession(manager);
    const held = holdFirstSpawnCwdCheck(manager);
    const creation = manager.createWorker(session.id, { type: 'terminal', name: 'Shell' }).then(
      () => null,
      (err: unknown) => err,
    );
    await held.reached();

    // This harness has no job queue, so a real deletion fails and restores the session; its observable end state
    // (marker cleared, session gone from the registry) is set directly.
    manager['sessions'].delete(session.id);
    expect(manager['sessions'].has(session.id)).toBe(false);
    expect(manager.isDeleting(session.id)).toBe(false);
    const spawnsBefore = ptyFactory.instances.length;
    held.release();

    expect(await creation).toBeInstanceOf(SessionDeletingError);
    expect(ptyFactory.instances.length).toBe(spawnsBefore);
  });

  it('a worker activation parked before its spawn when the session is paused and resumed spawns nothing and rejects with SessionPausingError', async () => {
    const { manager, executeHookCommand, resolveHook } = await setup();
    const session = await createSession(manager);
    const held = holdFirstSpawnCwdCheck(manager);
    const creation = manager.createWorker(session.id, { type: 'terminal', name: 'Shell' }).then(
      () => null,
      (err: unknown) => err,
    );
    await held.reached();

    const pause = manager.pauseSession(session.id);
    await hookStarted(executeHookCommand);
    resolveHook({ success: true });
    await pause;
    const resumed = await manager.resumeSession(session.id);
    expect(resumed?.session.id).toBe(session.id);
    expect(manager.isPausing(session.id)).toBe(false);
    const spawnsBefore = ptyFactory.instances.length;
    held.release();

    expect(await creation).toBeInstanceOf(SessionPausingError);
    expect(ptyFactory.instances.length).toBe(spawnsBefore);
  });

  it('a worker activation parked before its spawn while a pause is still in flight spawns nothing and rejects with SessionPausingError', async () => {
    const { manager, executeHookCommand, resolveHook } = await setup();
    const session = await createSession(manager);
    const held = holdFirstSpawnCwdCheck(manager);
    const creation = manager.createWorker(session.id, { type: 'terminal', name: 'Shell' }).then(
      () => null,
      (err: unknown) => err,
    );
    await held.reached();

    const pause = manager.pauseSession(session.id);
    await hookStarted(executeHookCommand);
    expect(manager.isPausing(session.id)).toBe(true);
    const spawnsBefore = ptyFactory.instances.length;
    held.release();

    expect(await creation).toBeInstanceOf(SessionPausingError);
    expect(ptyFactory.instances.length).toBe(spawnsBefore);
    resolveHook({ success: true });
    await pause;
  });

  // A completed pause and a completed deletion both leave the registry with both markers clear; the tombstone on
  // the captured session object tells them apart. Each case parks an activation, ends the session, then releases.
  for (const kind of ['agent', 'terminal'] as const) {
    const create = (manager: SessionManager, sessionId: string) =>
      manager
        .createWorker(
          sessionId,
          kind === 'agent'
            ? { type: 'agent', agentId: 'claude-code', name: 'Second agent' }
            : { type: 'terminal', name: 'Shell' },
        )
        .then(
          () => null,
          (err: unknown) => err,
        );

    it(`a ${kind} activation parked before its spawn across a COMPLETED pause spawns nothing and rejects with SessionPausingError`, async () => {
      const { manager, executeHookCommand, resolveHook } = await setup();
      const session = await createSession(manager);
      const held = holdFirstSpawnCwdCheck(manager);
      const creation = create(manager, session.id);
      await held.reached();

      const pause = manager.pauseSession(session.id);
      await hookStarted(executeHookCommand);
      resolveHook({ success: true });
      await pause;
      expect(manager['sessions'].has(session.id)).toBe(false);
      expect(manager.isPausing(session.id)).toBe(false);
      expect(manager.isDeleting(session.id)).toBe(false);
      const spawnsBefore = ptyFactory.instances.length;
      held.release();

      expect(await creation).toBeInstanceOf(SessionPausingError);
      expect(ptyFactory.instances.length).toBe(spawnsBefore);
    });

    it(`a ${kind} activation parked before its spawn across a COMPLETED deletion spawns nothing and rejects with SessionDeletingError`, async () => {
      const { manager } = await setup();
      const session = await createSession(manager);
      const held = holdFirstSpawnCwdCheck(manager);
      const creation = create(manager, session.id);
      await held.reached();

      // Same end state the deletion service leaves: out of the registry, tombstoned, marker cleared.
      const internal = manager['sessions'].get(session.id)!;
      manager['sessions'].delete(session.id);
      internal.endedBy = 'delete';
      expect(manager.isDeleting(session.id)).toBe(false);
      const spawnsBefore = ptyFactory.instances.length;
      held.release();

      expect(await creation).toBeInstanceOf(SessionDeletingError);
      expect(ptyFactory.instances.length).toBe(spawnsBefore);
    });
  }

  // Only an agent PTY activation under AUTH_MODE=multi-user mints an MCP token, and only for a session with an owner,
  // so the token claim needs that setup; the minted tokens are then checked through the registry's public verify().
  for (const ending of ['pause', 'delete'] as const) {
    it(`an agent activation parked before its spawn across a COMPLETED ${ending} revokes the token it minted`, async () => {
      const originalAuthMode = process.env.AUTH_MODE;
      process.env.AUTH_MODE = 'multi-user';
      try {
        const { manager, mcpTokenRegistry, executeHookCommand, resolveHook } = await setup(undefined, undefined, true);
        const mint = spyOn(mcpTokenRegistry, 'mint');
        const session = await manager.createSession(
          { type: 'worktree', locationPath: '/test/path', repositoryId: 'repo-1', worktreeId: 'feature-branch', agentId: 'claude-code' },
          { createdBy: OWNER_ID },
        );
        const mintedBeforePark = mint.mock.results.length;
        const held = holdFirstSpawnCwdCheck(manager);
        const creation = manager
          .createWorker(session.id, { type: 'agent', agentId: 'claude-code', name: 'Second agent' })
          .then(
            () => null,
            (err: unknown) => err,
          );
        await held.reached();

        // The parked activation has minted its own token and it is live: the revoke below has something to revoke.
        expect(mint.mock.results.length).toBe(mintedBeforePark + 1);
        const parkedToken = mint.mock.results[mintedBeforePark]!.value as string;
        expect(mcpTokenRegistry.verify(parkedToken)).not.toBeNull();

        let expected: typeof SessionPausingError | typeof SessionDeletingError;
        if (ending === 'pause') {
          const pause = manager.pauseSession(session.id);
          await hookStarted(executeHookCommand);
          resolveHook({ success: true });
          await pause;
          expected = SessionPausingError;
        } else {
          const internal = manager['sessions'].get(session.id)!;
          manager['sessions'].delete(session.id);
          internal.endedBy = 'delete';
          expected = SessionDeletingError;
        }
        const spawnsBefore = ptyFactory.instances.length;
        held.release();

        expect(await creation).toBeInstanceOf(expected);
        expect(ptyFactory.instances.length).toBe(spawnsBefore);
        expect(mcpTokenRegistry.verify(parkedToken)).toBeNull();
        mint.mockRestore();
      } finally {
        if (originalAuthMode === undefined) delete process.env.AUTH_MODE;
        else process.env.AUTH_MODE = originalAuthMode;
      }
    });
  }

  it('a terminal activation parked across a deletion that FAILED and rolled back spawns normally', async () => {
    // The cleanup-job enqueue fails after the session has left memory, so the deletion rolls back.
    const failingJobQueue: Partial<JobQueue> = {
      enqueue: async () => {
        throw new Error('enqueue failed');
      },
    };
    const { manager } = await setup(undefined, failingJobQueue as JobQueue);
    const session = await createSession(manager);
    const held = holdFirstSpawnCwdCheck(manager);
    const creation = manager.createWorker(session.id, { type: 'terminal', name: 'Shell' }).then(
      () => null,
      (err: unknown) => err,
    );
    await held.reached();

    // The deletion removes the session from memory, fails, and puts the same object back.
    await manager.deleteSession(session.id).catch(() => undefined);
    const restored = manager['sessions'].get(session.id);
    expect(restored).toBeDefined();
    expect(restored?.endedBy).toBeUndefined();
    const spawnsBefore = ptyFactory.instances.length;
    held.release();

    expect(await creation).toBeNull();
    expect(ptyFactory.instances.length).toBe(spawnsBefore + 1);
  });

  it('a worker activation with nothing happening to the session during the gate spawns as before', async () => {
    const { manager } = await setup();
    const session = await createSession(manager);
    const held = holdFirstSpawnCwdCheck(manager);
    const creation = manager.createWorker(session.id, { type: 'terminal', name: 'Shell' });
    await held.reached();
    const spawnsBefore = ptyFactory.instances.length;
    held.release();

    const worker = await creation;
    expect(worker?.type).toBe('terminal');
    expect(ptyFactory.instances.length).toBe(spawnsBefore + 1);
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

  it('restartAllAgentWorkers yields no result entry for a file-viewer worker of a pausing session (no process, like git-diff)', async () => {
    const { manager, executeHookCommand, resolveHook } = await setup();
    const session = await createSession(manager);
    const viewer = await manager.createWorker(session.id, { type: 'file-viewer' });
    const agent = workerOfType(session, 'agent');
    const pause = manager.pauseSession(session.id);
    await hookStarted(executeHookCommand);

    const result = await manager.restartAllAgentWorkers({ kind: 'all' });

    expect(result.results.map((r) => r.workerId)).toEqual([agent.id]);
    expect(result.results.map((r) => r.workerId)).not.toContain(viewer!.id);
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

  // The guard property behind the time box: when the elevated helper never
  // settles (a grandchild holds its pipes open), the pause still completes
  // within the deadline and the session stops being "pausing".
  it('a pause whose elevated command never settles completes within the time box and clears the guard', async () => {
    const originalAuthMode = process.env.AUTH_MODE;
    process.env.AUTH_MODE = 'multi-user';
    try {
      const { WorktreeService } = await import('../worktree-service.js');
      const worktreeService = new WorktreeService({
        worktreeRepository: { records: [] } as never,
        runAsUserImpl: () => new Promise(() => {}),
      });
      const boundedHook = mock<ExecuteHookCommand>((command, worktreePath, vars) =>
        worktreeService.executeHookCommand(command, worktreePath, vars, 'alice-multiuser-test', 200),
      );
      const { manager } = await setup(boundedHook);
      const session = await createSession(manager);

      const startedAt = Date.now();
      const outcome = await manager.pauseSession(session.id);

      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(outcome).toEqual({
        paused: true,
        pauseCommandResult: { success: false, error: 'Command timed out after 200 ms' },
      });
      expect(manager.isPausing(session.id)).toBe(false);
    } finally {
      if (originalAuthMode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = originalAuthMode;
    }
  }, 5000);
});
