import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SessionPauseResumeService, type SessionPauseResumeDeps } from '../session-pause-resume-service.js';
import type { InternalSession, InternalWorktreeSession, InternalQuickSession } from '../internal-types.js';
import type { InternalWorker } from '../worker-types.js';
import type { PersistedSession } from '../persistence-service.js';
import type { Session } from '@agent-console/shared';

const mockStopWatching = mock(() => {});

function createMockWorker(overrides: Partial<InternalWorker> & { id: string; type: InternalWorker['type'] }): InternalWorker {
  const base = {
    createdAt: new Date().toISOString(),
    name: overrides.type === 'agent' ? 'Agent' : overrides.type === 'terminal' ? 'Terminal' : 'Diff',
    ...overrides,
  };
  if (base.type === 'git-diff') {
    return { ...base, baseCommit: 'abc123' } as InternalWorker;
  }
  return {
    ...base,
    pty: null,
    callbacks: null,
    exitReason: null,
    ...(base.type === 'agent' ? { agentId: 'test-agent' } : {}),
  } as unknown as InternalWorker;
}

function createMockWorktreeSession(overrides?: Partial<InternalWorktreeSession>): InternalWorktreeSession {
  return {
    id: 'session-1',
    type: 'worktree',
    locationPath: '/test/worktree',
    status: 'active',
    createdAt: new Date().toISOString(),
    workers: new Map(),
    repositoryId: 'repo-1',
    worktreeId: 'wt-1',
    ...overrides,
  };
}

function createMockQuickSession(overrides?: Partial<InternalQuickSession>): InternalQuickSession {
  return {
    id: 'session-2',
    type: 'quick',
    locationPath: '/test/quick',
    status: 'active',
    createdAt: new Date().toISOString(),
    workers: new Map(),
    ...overrides,
  };
}

function createMockPersistedSession(overrides?: Partial<PersistedSession>): PersistedSession {
  return {
    id: 'session-1',
    type: 'worktree',
    locationPath: '/test/worktree',
    createdAt: new Date().toISOString(),
    workers: [],
    repositoryId: 'repo-1',
    worktreeId: 'wt-1',
    serverPid: null,
    pausedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as PersistedSession;
}

function createMockDeps(overrides?: Partial<SessionPauseResumeDeps>): SessionPauseResumeDeps {
  const sessions = new Map<string, InternalSession>();
  return {
    getSession: (id) => sessions.get(id),
    setSession: mock((id: string, session: InternalSession) => { sessions.set(id, session); }),
    deleteSession: mock((id: string) => { sessions.delete(id); }),
    sessionRepository: {
      findAll: mock(async () => []),
      findById: mock(async () => null),
      findByServerPid: mock(async () => []),
      save: mock(async () => {}),
      saveAll: mock(async () => {}),
      update: mock(async () => true),
      delete: mock(async () => {}),
      findPaused: mock(async () => []),
    },
    workerManager: {
      killWorker: mock(async () => {}),
      restoreWorkersFromPersistence: mock((_workers: unknown[]) => new Map()),
      activateAgentWorkerPty: mock(async () => {}),
      activateTerminalWorkerPty: mock(() => {}),
    } as unknown as SessionPauseResumeDeps['workerManager'],
    pathExists: mock(async () => true),
    getRepositoryEnvVars: mock(async () => ({})),
    getPathResolverForSession: mock(() => ({ getRepositoryName: () => 'test-repo' })) as unknown as SessionPauseResumeDeps['getPathResolverForSession'],
    toPublicSession: mock((session: InternalSession) => ({
      id: session.id,
      type: session.type,
      locationPath: session.locationPath,
      status: session.status,
      activationState: 'running' as const,
      createdAt: session.createdAt,
      workers: [],
    } as unknown as Session)),
    toPersistedSessionWithServerPid: mock((session: InternalSession, serverPid: number | null) => ({
      id: session.id,
      type: session.type,
      locationPath: session.locationPath,
      createdAt: session.createdAt,
      workers: [],
      serverPid,
      ...(session.type === 'worktree' ? { repositoryId: session.repositoryId, worktreeId: session.worktreeId } : {}),
    } as unknown as PersistedSession)),
    persistedToPublicSession: mock((p: PersistedSession) => ({
      id: p.id,
      type: p.type,
      locationPath: p.locationPath,
      status: 'active' as const,
      activationState: 'hibernated' as const,
      createdAt: p.createdAt,
      workers: [],
      pausedAt: p.pausedAt,
    } as unknown as Session)),
    getWorkerActivityState: mock(() => undefined),
    getSessionLifecycleCallbacks: () => undefined,
    getWebSocketCallbacks: () => null,
    notificationManager: {
      cleanupSession: mock(() => {}),
    } as unknown as SessionPauseResumeDeps['notificationManager'],
    messageService: {
      clearSession: mock(() => {}),
    } as unknown as SessionPauseResumeDeps['messageService'],
    userRepository: null,
    resolveSpawnUsername: mock(async () => 'testuser'),
    stopWatching: mockStopWatching,
    getServerPid: () => 99999,
    ...overrides,
  };
}

describe('SessionPauseResumeService', () => {
  beforeEach(() => {
    mockStopWatching.mockClear();
  });

  describe('pauseSession', () => {
    it('should return false if session is not found', async () => {
      const deps = createMockDeps();
      const service = new SessionPauseResumeService(deps);

      const result = await service.pauseSession('non-existent');

      expect(result).toBe(false);
    });

    it('should return false for quick sessions', async () => {
      const session = createMockQuickSession();
      const deps = createMockDeps({
        getSession: () => session,
      });
      const service = new SessionPauseResumeService(deps);

      const result = await service.pauseSession('session-2');

      expect(result).toBe(false);
    });

    it('should pause a worktree session successfully', async () => {
      const agentWorker = createMockWorker({ id: 'w1', type: 'agent' });
      const gitDiffWorker = createMockWorker({ id: 'w2', type: 'git-diff' });
      const session = createMockWorktreeSession({
        workers: new Map([
          ['w1', agentWorker],
          ['w2', gitDiffWorker],
        ]),
      });

      const notifySessionPaused = mock(() => {});
      const onSessionPaused = mock(() => {});

      const deps = createMockDeps({
        getSession: () => session,
        getWebSocketCallbacks: () => ({
          notifySessionPaused,
          notifySessionDeleted: mock(() => {}),
          broadcastToApp: mock(() => {}),
        }),
        getSessionLifecycleCallbacks: () => ({ onSessionPaused }),
      });
      const service = new SessionPauseResumeService(deps);

      const result = await service.pauseSession('session-1');

      expect(result).toBe(true);
      // WebSocket notification before killing
      expect(notifySessionPaused).toHaveBeenCalledWith('session-1');
      // Agent worker killed
      expect(deps.workerManager.killWorker).toHaveBeenCalledTimes(1);
      // git-diff watcher stopped
      expect(mockStopWatching).toHaveBeenCalledWith('/test/worktree');
      // Notification cleanup
      expect(deps.notificationManager!.cleanupSession).toHaveBeenCalledWith('session-1');
      // Message cleanup
      expect(deps.messageService.clearSession).toHaveBeenCalledWith('session-1');
      // Persisted with serverPid = null
      expect(deps.toPersistedSessionWithServerPid).toHaveBeenCalledWith(session, null);
      expect(deps.sessionRepository.save).toHaveBeenCalledTimes(1);
      // Session removed from memory
      expect(deps.deleteSession).toHaveBeenCalled();
      // Lifecycle callback fired
      expect(onSessionPaused).toHaveBeenCalledTimes(1);
    });

    it('should kill both agent and terminal workers', async () => {
      const agentWorker = createMockWorker({ id: 'w1', type: 'agent' });
      const terminalWorker = createMockWorker({ id: 'w2', type: 'terminal' });
      const session = createMockWorktreeSession({
        workers: new Map([
          ['w1', agentWorker],
          ['w2', terminalWorker],
        ]),
      });

      const deps = createMockDeps({
        getSession: () => session,
      });
      const service = new SessionPauseResumeService(deps);

      await service.pauseSession('session-1');

      expect(deps.workerManager.killWorker).toHaveBeenCalledTimes(2);
    });
  });

  describe('resumeSession', () => {
    it('should return existing session if already active', async () => {
      const session = createMockWorktreeSession();
      const mockPublicSession = { id: 'session-1' } as unknown as Session;

      const deps = createMockDeps({
        getSession: () => session,
        toPublicSession: mock(() => mockPublicSession),
      });
      const service = new SessionPauseResumeService(deps);

      const result = await service.resumeSession('session-1');

      expect(result).toBe(mockPublicSession);
      // Should not touch DB
      expect(deps.sessionRepository.findById).not.toHaveBeenCalled();
    });

    it('should return null if not found in database', async () => {
      const deps = createMockDeps();
      const service = new SessionPauseResumeService(deps);

      const result = await service.resumeSession('non-existent');

      expect(result).toBeNull();
    });

    it('should return null if path no longer exists', async () => {
      const persisted = createMockPersistedSession();
      const deps = createMockDeps({
        sessionRepository: {
          ...createMockDeps().sessionRepository,
          findById: mock(async () => persisted),
        },
        pathExists: mock(async () => false),
      });
      const service = new SessionPauseResumeService(deps);

      const result = await service.resumeSession('session-1');

      expect(result).toBeNull();
    });

    it('should resume a paused session successfully', async () => {
      const agentWorker = createMockWorker({ id: 'w1', type: 'agent' });
      const restoredWorkers = new Map([['w1', agentWorker]]);
      const persisted = createMockPersistedSession({
        workers: [{ id: 'w1', type: 'agent', name: 'Agent', createdAt: new Date().toISOString(), agentId: 'test-agent', pid: null }],
      });

      const onSessionResumed = mock(() => {});
      const mockPublicSession = {
        id: 'session-1',
        type: 'worktree' as const,
        workers: [{ id: 'w1', type: 'agent' as const }],
      } as unknown as Session;

      const deps = createMockDeps({
        sessionRepository: {
          ...createMockDeps().sessionRepository,
          findById: mock(async () => persisted),
          update: mock(async () => true),
        },
        workerManager: {
          killWorker: mock(async () => {}),
          restoreWorkersFromPersistence: mock(() => restoredWorkers),
          activateAgentWorkerPty: mock(async () => {}),
          activateTerminalWorkerPty: mock(() => {}),
        } as unknown as SessionPauseResumeDeps['workerManager'],
        toPublicSession: mock(() => mockPublicSession),
        getSessionLifecycleCallbacks: () => ({ onSessionResumed }),
      });
      const service = new SessionPauseResumeService(deps);

      const result = await service.resumeSession('session-1');

      expect(result).toBe(mockPublicSession);
      // Workers restored from persistence
      expect(deps.workerManager.restoreWorkersFromPersistence).toHaveBeenCalledTimes(1);
      // Agent worker PTY activated
      expect(deps.workerManager.activateAgentWorkerPty).toHaveBeenCalledTimes(1);
      // Session added to memory
      expect(deps.setSession).toHaveBeenCalled();
      // DB updated with serverPid and cleared pausedAt
      expect(deps.sessionRepository.update).toHaveBeenCalledWith('session-1', { serverPid: 99999, pausedAt: null });
      // Lifecycle callback fired
      expect(onSessionResumed).toHaveBeenCalledTimes(1);
    });

    it('should prevent concurrent resume attempts for the same session', async () => {
      const persisted = createMockPersistedSession();

      // Create a slow resume that we can control
      let resolveResume: () => void;
      const slowPromise = new Promise<void>((resolve) => { resolveResume = resolve; });

      const deps = createMockDeps({
        sessionRepository: {
          ...createMockDeps().sessionRepository,
          findById: mock(async () => {
            await slowPromise;
            return persisted;
          }),
          update: mock(async () => true),
        },
        workerManager: {
          killWorker: mock(async () => {}),
          restoreWorkersFromPersistence: mock(() => new Map()),
          activateAgentWorkerPty: mock(async () => {}),
          activateTerminalWorkerPty: mock(() => {}),
        } as unknown as SessionPauseResumeDeps['workerManager'],
      });
      const service = new SessionPauseResumeService(deps);

      // Start first resume (will be blocked)
      const resume1 = service.resumeSession('session-1');

      // Second resume should return null immediately due to concurrency guard
      const result2 = await service.resumeSession('session-1');
      expect(result2).toBeNull();

      // Unblock first resume
      resolveResume!();
      await resume1;
    });

    it('should roll back on PTY activation failure', async () => {
      const agentWorker = createMockWorker({ id: 'w1', type: 'agent' });
      const restoredWorkers = new Map([['w1', agentWorker]]);
      const persisted = createMockPersistedSession({
        pausedAt: '2026-01-01T00:00:00.000Z',
      });

      const deps = createMockDeps({
        sessionRepository: {
          ...createMockDeps().sessionRepository,
          findById: mock(async () => persisted),
          update: mock(async () => true),
        },
        workerManager: {
          killWorker: mock(async () => {}),
          restoreWorkersFromPersistence: mock(() => restoredWorkers),
          activateAgentWorkerPty: mock(async () => { throw new Error('PTY activation failed'); }),
          activateTerminalWorkerPty: mock(() => {}),
        } as unknown as SessionPauseResumeDeps['workerManager'],
      });
      const service = new SessionPauseResumeService(deps);

      const result = await service.resumeSession('session-1');

      expect(result).toBeNull();
      // Session removed from memory
      expect(deps.deleteSession).toHaveBeenCalledWith('session-1');
      // Paused state restored in DB
      expect(deps.sessionRepository.update).toHaveBeenCalledWith('session-1', {
        serverPid: null,
        pausedAt: '2026-01-01T00:00:00.000Z',
      });
    });

    it('should roll back on DB persistence failure after successful PTY activation', async () => {
      const agentWorker = createMockWorker({ id: 'w1', type: 'agent' });
      const restoredWorkers = new Map([['w1', agentWorker]]);
      const persisted = createMockPersistedSession({
        pausedAt: '2026-01-01T00:00:00.000Z',
      });

      let updateCallCount = 0;

      const deps = createMockDeps({
        sessionRepository: {
          ...createMockDeps().sessionRepository,
          findById: mock(async () => persisted),
          update: mock(async () => {
            updateCallCount++;
            if (updateCallCount === 1) {
              throw new Error('DB write failed');
            }
            return true;
          }),
        },
        workerManager: {
          killWorker: mock(async () => {}),
          restoreWorkersFromPersistence: mock(() => restoredWorkers),
          activateAgentWorkerPty: mock(async () => {}),
          activateTerminalWorkerPty: mock(() => {}),
        } as unknown as SessionPauseResumeDeps['workerManager'],
      });
      const service = new SessionPauseResumeService(deps);

      const result = await service.resumeSession('session-1');

      expect(result).toBeNull();
      // Workers killed on rollback
      expect(deps.workerManager.killWorker).toHaveBeenCalledTimes(1);
      // Session removed from memory
      expect(deps.deleteSession).toHaveBeenCalledWith('session-1');
    });

    it('should restore terminal workers during resume', async () => {
      const terminalWorker = createMockWorker({ id: 'w1', type: 'terminal' });
      const restoredWorkers = new Map([['w1', terminalWorker]]);
      const persisted = createMockPersistedSession({
        workers: [{ id: 'w1', type: 'terminal', name: 'Terminal', createdAt: new Date().toISOString(), pid: null }],
      });

      const deps = createMockDeps({
        sessionRepository: {
          ...createMockDeps().sessionRepository,
          findById: mock(async () => persisted),
          update: mock(async () => true),
        },
        workerManager: {
          killWorker: mock(async () => {}),
          restoreWorkersFromPersistence: mock(() => restoredWorkers),
          activateAgentWorkerPty: mock(async () => {}),
          activateTerminalWorkerPty: mock(() => {}),
        } as unknown as SessionPauseResumeDeps['workerManager'],
      });
      const service = new SessionPauseResumeService(deps);

      await service.resumeSession('session-1');

      expect(deps.workerManager.activateTerminalWorkerPty).toHaveBeenCalledTimes(1);
    });
  });
});
