import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';
import { SessionPauseResumeService, type SessionPauseResumeDeps } from '../session-pause-resume-service.js';
import type { InternalSession } from '../internal-types.js';
import type { InternalWorker, InternalAgentWorker, InternalTerminalWorker } from '../worker-types.js';
import type { PersistedSession } from '../../repositories/persisted-types.js';
import type { Session, AgentWorker, EmbeddedAgentWorker } from '@agent-console/shared';
import type { NotificationManager } from '../notifications/notification-manager.js';
import type { MessageService } from '../message-service.js';
import { SessionDataPathResolver } from '../../lib/session-data-path-resolver.js';
import { SessionOrphanedError } from '../../lib/errors.js';
import { rootLogger } from '../../lib/logger.js';
import {
  buildInternalAgentWorker,
  buildInternalTerminalWorker,
  buildInternalGitDiffWorker,
  buildInternalFileViewerWorker,
  buildInternalEmbeddedAgentWorker,
  buildInternalWorktreeSession,
  buildInternalQuickSession,
  buildPersistedWorktreeSession,
  buildPersistedQuickSession,
  buildPersistedAgentWorker,
  buildPersistedTerminalWorker,
  buildWorktreeSession,
  buildQuickSession,
} from '../../__tests__/utils/build-test-data.js';


// NotificationManager / MessageService are concrete classes with private
// fields, so a plain object implementing only the methods a test actually
// exercises cannot satisfy the class type structurally. Each helper types
// its parameter as `Partial<X>`, so every provided method name/signature is
// checked against the real class, and performs exactly one assertion inside
// the helper body to bridge the private-member gap.
function asNotificationManager(stub: Partial<NotificationManager>): NotificationManager {
  return stub as NotificationManager;
}

function asMessageService(stub: Partial<MessageService>): MessageService {
  return stub as MessageService;
}

// Minimal-but-valid public Worker fixtures. Production only ever reads
// `.id` / `.type` off these in the code paths exercised here (see
// resumeSession's activity-state collection loop); the remaining fields
// exist to satisfy the discriminated Worker union's required shape.
function buildAgentWorkerFixture(
  overrides: Partial<AgentWorker> & Pick<AgentWorker, 'id'>,
): AgentWorker {
  return {
    name: overrides.id,
    createdAt: '2024-01-01T00:00:00.000Z',
    type: 'agent',
    agentId: 'test-agent',
    activated: true,
    ...overrides,
  };
}

function buildEmbeddedAgentWorkerFixture(
  overrides: Partial<EmbeddedAgentWorker> & Pick<EmbeddedAgentWorker, 'id'>,
): EmbeddedAgentWorker {
  return {
    name: overrides.id,
    createdAt: '2024-01-01T00:00:00.000Z',
    type: 'embedded-agent',
    embeddedAgentId: 'def-1',
    activated: true,
    autoCompaction: true,
    reasoningEffort: null,
    hasParameterOverride: false,
    ...overrides,
  };
}

const PARTICIPANT_NAMES = ['timer', 'conditional-wakeup'] as const;

/**
 * Pause participants that append `<operation>:<name>:<sessionId>` to `calls`.
 * `throwOn` lists the names whose given operation throws after recording.
 */
function recordingParticipants(
  calls: string[],
  throwOn: { suspend?: readonly string[]; resume?: readonly string[] } = {},
): SessionPauseResumeDeps['getPauseParticipants'] {
  return () =>
    PARTICIPANT_NAMES.map((name) => [
      name,
      {
        suspend: (id: string) => {
          calls.push(`suspend:${name}:${id}`);
          if (throwOn.suspend?.includes(name)) throw new Error(`${name} suspend failed`);
        },
        resume: (id: string) => {
          calls.push(`resume:${name}:${id}`);
          if (throwOn.resume?.includes(name)) throw new Error(`${name} resume failed`);
        },
      },
    ] as const);
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
      activateTerminalWorkerPty: mock(async () => {}),
    } satisfies SessionPauseResumeDeps['workerManager'],
    deactivateEmbeddedAgentWorker: mock(async () => {}),
    activateEmbeddedAgentWorker: mock(async () => {}),
    pathExists: mock(async () => true),
    getRepositoryEnvVars: mock(async () => ({})),
    getPathResolverForSession: mock((_session: InternalSession) => new SessionDataPathResolver('/dummy', '/')),
    toPublicSession: mock((session: InternalSession): Session => {
      const base = {
        id: session.id,
        locationPath: session.locationPath,
        status: session.status,
        activationState: 'running' as const,
        createdAt: session.createdAt,
        workers: [],
      };
      return session.type === 'worktree'
        ? buildWorktreeSession({ ...base, repositoryId: session.repositoryId, worktreeId: session.worktreeId })
        : buildQuickSession(base);
    }),
    toPersistedSessionWithServerPid: mock((session: InternalSession, serverPid: number | null): PersistedSession => {
      const base = { id: session.id, locationPath: session.locationPath, createdAt: session.createdAt, workers: [], serverPid };
      return session.type === 'worktree'
        ? buildPersistedWorktreeSession({ ...base, repositoryId: session.repositoryId, worktreeId: session.worktreeId })
        : buildPersistedQuickSession(base);
    }),
    persistedToPublicSession: mock((p: PersistedSession): Session => {
      const base = {
        id: p.id,
        locationPath: p.locationPath,
        status: 'active' as const,
        activationState: 'hibernated' as const,
        createdAt: p.createdAt,
        workers: [],
        pausedAt: p.pausedAt,
      };
      return p.type === 'worktree'
        ? buildWorktreeSession({ ...base, repositoryId: p.repositoryId, worktreeId: p.worktreeId })
        : buildQuickSession(base);
    }),
    getWorkerActivityState: mock(() => undefined),
    getSessionLifecycleCallbacks: () => undefined,
    getWebSocketCallbacks: () => null,
    notificationManager: asNotificationManager({
      cleanupSession: mock(() => {}),
    }),
    messageService: asMessageService({
      clearSession: mock(() => {}),
    }),
    userRepository: null,
    resolveSpawnUsername: mock(async () => 'testuser'),
    startBranchWatching: async () => {},
    stopBranchWatching: () => {},
    getPauseParticipants: () => [],
    getServerPid: () => 99999,
    hasSessionHookCommand: mock(() => false),
    runSessionHookCommand: mock(async () => undefined),
    appendRestoreBoundaryMarker: mock(async () => {}),
    ...overrides,
  };
}

describe('SessionPauseResumeService', () => {
  beforeEach(() => {
  });

  describe('pauseSession', () => {
    it('should return false if session is not found', async () => {
      const deps = createMockDeps();
      const service = new SessionPauseResumeService(deps);

      const result = await service.pauseSession('non-existent');

      expect(result).toEqual({ paused: false });
    });

    it('should return false for quick sessions', async () => {
      const session = buildInternalQuickSession();
      const deps = createMockDeps({
        getSession: () => session,
      });
      const service = new SessionPauseResumeService(deps);

      const result = await service.pauseSession('session-2');

      expect(result).toEqual({ paused: false });
      expect(deps.runSessionHookCommand).not.toHaveBeenCalled();
    });

    it('should pause a worktree session successfully', async () => {
      const agentWorker = buildInternalAgentWorker({ id: 'w1' });
      const gitDiffWorker = buildInternalGitDiffWorker({ id: 'w2' });
      const session = buildInternalWorktreeSession([agentWorker, gitDiffWorker]);

      const notifySessionPaused = mock(() => {});
      const onSessionPaused = mock(() => {});
      const stopWorkerWatching = mock((_sessionId: string, _workerId: string) => {});

      const deps = createMockDeps({
        getSession: () => session,
        getWebSocketCallbacks: () => ({
          notifySessionPaused,
          notifySessionDeleted: mock(() => {}),
          broadcastToApp: mock(() => {}),
          stopWorkerWatching,
        }),
        getSessionLifecycleCallbacks: () => ({ onSessionPaused }),
      });
      const service = new SessionPauseResumeService(deps);

      const result = await service.pauseSession('session-1');

      expect(result).toEqual({ paused: true });
      // WebSocket notification before killing
      expect(notifySessionPaused).toHaveBeenCalledWith('session-1');
      // Agent worker killed
      expect(deps.workerManager.killWorker).toHaveBeenCalledTimes(1);
      // git-diff worker's watch stopped, by worker
      expect(stopWorkerWatching).toHaveBeenCalledWith('session-1', 'w2');
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

    it('should pause a session with a file-viewer worker: stop its watch once, without killing or deactivating it', async () => {
      const agentWorker = buildInternalAgentWorker({ id: 'w1' });
      const viewer = buildInternalFileViewerWorker({ id: 'w-fv' });
      const session = buildInternalWorktreeSession([agentWorker, viewer]);
      const deactivateEmbeddedAgentWorker = mock(async () => {});
      const stopWorkerWatching = mock((_sessionId: string, _workerId: string) => {});
        const deps = createMockDeps({
        getSession: () => session,
        deactivateEmbeddedAgentWorker,
        getWebSocketCallbacks: () => ({
          notifySessionPaused: mock(() => {}),
          notifySessionDeleted: mock(() => {}),
          broadcastToApp: mock(() => {}),
          stopWorkerWatching,
        }),
      });
      const service = new SessionPauseResumeService(deps);

      expect((await service.pauseSession('session-1')).paused).toBe(true);

      expect(stopWorkerWatching).toHaveBeenCalledTimes(1);
      expect(stopWorkerWatching).toHaveBeenCalledWith('session-1', 'w-fv');

      expect(deps.workerManager.killWorker).toHaveBeenCalledTimes(1);
      expect(deps.workerManager.killWorker).toHaveBeenCalledWith(agentWorker, 'session-1');
      expect(deactivateEmbeddedAgentWorker).not.toHaveBeenCalled();
    });

    it('should stop one watch per git-diff worker AND per file-viewer worker on pause', async () => {
      const session = buildInternalWorktreeSession([
        buildInternalAgentWorker({ id: 'w1' }),
        buildInternalGitDiffWorker({ id: 'w2' }),
        buildInternalFileViewerWorker({ id: 'w3' }),
      ]);
      const stopWorkerWatching = mock((_sessionId: string, _workerId: string) => {});
      const deps = createMockDeps({
        getSession: () => session,
        getWebSocketCallbacks: () => ({
          notifySessionPaused: mock(() => {}),
          notifySessionDeleted: mock(() => {}),
          broadcastToApp: mock(() => {}),
          stopWorkerWatching,
        }),
      });

      await new SessionPauseResumeService(deps).pauseSession('session-1');

      expect(stopWorkerWatching.mock.calls).toEqual([
        ['session-1', 'w2'],
        ['session-1', 'w3'],
      ]);
    });

    it('should stop no worker watch for a session without a git-diff or file-viewer worker (the empty case)', async () => {
      const session = buildInternalWorktreeSession([buildInternalAgentWorker({ id: 'w1' }), buildInternalTerminalWorker({ id: 'w2' })]);
      const stopWorkerWatching = mock((_sessionId: string, _workerId: string) => {});
      const deps = createMockDeps({
        getSession: () => session,
        getWebSocketCallbacks: () => ({
          notifySessionPaused: mock(() => {}),
          notifySessionDeleted: mock(() => {}),
          broadcastToApp: mock(() => {}),
          stopWorkerWatching,
        }),
      });

      await new SessionPauseResumeService(deps).pauseSession('session-1');

      expect(stopWorkerWatching).not.toHaveBeenCalled();
    });

    it('should kill both agent and terminal workers', async () => {
      const agentWorker = buildInternalAgentWorker({ id: 'w1' });
      const terminalWorker = buildInternalTerminalWorker({ id: 'w2' });
      const session = buildInternalWorktreeSession([agentWorker, terminalWorker]);

      const deps = createMockDeps({
        getSession: () => session,
      });
      const service = new SessionPauseResumeService(deps);

      await service.pauseSession('session-1');

      expect(deps.workerManager.killWorker).toHaveBeenCalledTimes(2);
    });

    it('should deactivate embedded-agent workers on pause (polarity guard)', async () => {
      const embeddedWorker = buildInternalEmbeddedAgentWorker({ id: 'w-emb' });
      const session = buildInternalWorktreeSession([embeddedWorker]);

      const deactivateEmbeddedAgentWorker = mock(async () => {});
      const deps = createMockDeps({
        getSession: () => session,
        deactivateEmbeddedAgentWorker,
      });
      const service = new SessionPauseResumeService(deps);

      await service.pauseSession('session-1');

      // Without this branch the subprocess leaks (killWorker no-ops on it).
      expect(deactivateEmbeddedAgentWorker).toHaveBeenCalledWith('session-1', 'w-emb');
      expect(deps.workerManager.killWorker).not.toHaveBeenCalled();
    });
  });

  describe('schedule suspension on pause', () => {
    it('suspends every participant in registration order before notifying, stopping watchers, or killing any worker', async () => {
      const session = buildInternalWorktreeSession([buildInternalAgentWorker({ id: 'w1' })]);
      const calls: string[] = [];
      const deps = createMockDeps({
        getSession: () => session,
        getPauseParticipants: recordingParticipants(calls),
        stopBranchWatching: () => { calls.push('stopBranchWatching'); },
        getWebSocketCallbacks: () => ({
          notifySessionPaused: mock(() => { calls.push('notifySessionPaused'); }),
          notifySessionDeleted: mock(() => {}),
          broadcastToApp: mock(() => {}),
          stopWorkerWatching: mock(() => {}),
        }),
        workerManager: {
          killWorker: mock(async () => { calls.push('killWorker'); }),
          restoreWorkersFromPersistence: mock(() => new Map()),
          activateAgentWorkerPty: mock(async () => {}),
          activateTerminalWorkerPty: mock(async () => {}),
        } satisfies SessionPauseResumeDeps['workerManager'],
      });
      const service = new SessionPauseResumeService(deps);

      await service.pauseSession('session-1');

      expect(calls.slice(0, 2)).toEqual(['suspend:timer:session-1', 'suspend:conditional-wakeup:session-1']);
      const lastSuspend = calls.indexOf('suspend:conditional-wakeup:session-1');
      expect(lastSuspend).toBeLessThan(calls.indexOf('killWorker'));
      expect(lastSuspend).toBeLessThan(calls.indexOf('notifySessionPaused'));
      expect(lastSuspend).toBeLessThan(calls.indexOf('stopBranchWatching'));
    });

    it('does not resume participants on a successful pause', async () => {
      const session = buildInternalWorktreeSession([buildInternalAgentWorker({ id: 'w1' })]);
      const calls: string[] = [];
      const deps = createMockDeps({ getSession: () => session, getPauseParticipants: recordingParticipants(calls) });
      const service = new SessionPauseResumeService(deps);

      await service.pauseSession('session-1');

      expect(calls.filter((c) => c.startsWith('resume:'))).toEqual([]);
    });

    it('keeps pausing when a participant suspend throws, and still runs the others', async () => {
      const session = buildInternalWorktreeSession([buildInternalAgentWorker({ id: 'w1' })]);
      const calls: string[] = [];
      const deps = createMockDeps({
        getSession: () => session,
        getPauseParticipants: recordingParticipants(calls, { suspend: ['timer'] }),
      });
      const service = new SessionPauseResumeService(deps);

      await expect(service.pauseSession('session-1')).resolves.toEqual({ paused: true });

      expect(calls).toEqual(['suspend:timer:session-1', 'suspend:conditional-wakeup:session-1']);
      expect(deps.workerManager.killWorker).toHaveBeenCalled();
    });

    it('resumes participants in registration order and rethrows when the save rejects and the session stays live', async () => {
      const session = buildInternalWorktreeSession([buildInternalAgentWorker({ id: 'w1' })]);
      const base = createMockDeps();
      const calls: string[] = [];
      const deps = createMockDeps({
        getSession: () => session,
        getPauseParticipants: recordingParticipants(calls),
        sessionRepository: {
          ...base.sessionRepository,
          save: mock(async () => { throw new Error('DB write failed'); }),
        },
      });
      const service = new SessionPauseResumeService(deps);

      await expect(service.pauseSession('session-1')).rejects.toThrow('DB write failed');

      expect(calls).toEqual([
        'suspend:timer:session-1',
        'suspend:conditional-wakeup:session-1',
        'resume:timer:session-1',
        'resume:conditional-wakeup:session-1',
      ]);
    });

    it('still rethrows the pause failure when a participant resume throws during rollback', async () => {
      const session = buildInternalWorktreeSession([buildInternalAgentWorker({ id: 'w1' })]);
      const base = createMockDeps();
      const calls: string[] = [];
      const deps = createMockDeps({
        getSession: () => session,
        getPauseParticipants: recordingParticipants(calls, { resume: ['timer'] }),
        sessionRepository: {
          ...base.sessionRepository,
          save: mock(async () => { throw new Error('DB write failed'); }),
        },
      });

      await expect(new SessionPauseResumeService(deps).pauseSession('session-1')).rejects.toThrow('DB write failed');

      expect(calls.slice(-2)).toEqual(['resume:timer:session-1', 'resume:conditional-wakeup:session-1']);
    });

    it('does not resume participants when a failure happens after the session has left memory', async () => {
      const session = buildInternalWorktreeSession([buildInternalAgentWorker({ id: 'w1' })]);
      let inMemory = true;
      const calls: string[] = [];
      const deps = createMockDeps({
        getPauseParticipants: recordingParticipants(calls),
        getSession: () => (inMemory ? session : undefined),
        deleteSession: mock(() => { inMemory = false; }),
        getSessionLifecycleCallbacks: () => ({
          onSessionPaused: () => { throw new Error('callback failed'); },
        }),
      });
      const service = new SessionPauseResumeService(deps);

      await expect(service.pauseSession('session-1')).rejects.toThrow('callback failed');

      expect(calls.filter((c) => c.startsWith('resume:'))).toEqual([]);
    });

    it('does not suspend schedules for a quick session or an unknown session', async () => {
      const quick = buildInternalQuickSession();
      const calls: string[] = [];
      const quickDeps = createMockDeps({ getSession: () => quick, getPauseParticipants: recordingParticipants(calls) });
      await new SessionPauseResumeService(quickDeps).pauseSession('session-2');
      const missingDeps = createMockDeps({ getPauseParticipants: recordingParticipants(calls) });
      await new SessionPauseResumeService(missingDeps).pauseSession('nope');

      expect(calls).toEqual([]);
    });
  });

  describe('pause and resume commands', () => {
    function buildResumeDeps(
      overrides: Partial<SessionPauseResumeDeps> = {},
      persistedOverrides: Parameters<typeof buildPersistedWorktreeSession>[0] = {},
    ) {
      const agentWorker = buildInternalAgentWorker({ id: 'w1' });
      const persisted = buildPersistedWorktreeSession({
        id: 'session-1',
        serverPid: null,
        pausedAt: '2026-01-01T00:00:00.000Z',
        createdBy: 'owner-1',
        workers: [buildPersistedAgentWorker({ id: 'w1', agentId: 'test-agent' })],
        ...persistedOverrides,
      });
      return createMockDeps({
        sessionRepository: {
          ...createMockDeps().sessionRepository,
          findById: mock(async () => persisted),
          update: mock(async () => true),
        },
        workerManager: {
          killWorker: mock(async () => {}),
          restoreWorkersFromPersistence: mock(() => new Map([['w1', agentWorker]])),
          activateAgentWorkerPty: mock(async () => {}),
          activateTerminalWorkerPty: mock(async () => {}),
        } satisfies SessionPauseResumeDeps['workerManager'],
        toPublicSession: mock(() => buildWorktreeSession({ id: 'session-1' })),
        ...overrides,
      });
    }

    it('runs the pause command once, after every worker is down and before the session is saved', async () => {
      const log: string[] = [];
      const session = buildInternalWorktreeSession(
        [buildInternalAgentWorker({ id: 'w1' }), buildInternalEmbeddedAgentWorker({ id: 'w-emb' })],
        { createdBy: 'owner-1' },
      );
      const base = createMockDeps();
      const runSessionHookCommand = mock(async () => {
        log.push('hook');
        return { success: true, output: 'stopped' };
      });
      const deps = createMockDeps({
        getSession: () => session,
        workerManager: {
          ...base.workerManager,
          killWorker: mock(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            log.push('kill-done');
          }),
        },
        deactivateEmbeddedAgentWorker: mock(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          log.push('deactivate-done');
        }),
        sessionRepository: {
          ...base.sessionRepository,
          save: mock(async () => {
            log.push('save');
          }),
        },
        resolveSpawnUsername: mock(async () => 'hook-user'),
        runSessionHookCommand,
      });
      const service = new SessionPauseResumeService(deps);

      const result = await service.pauseSession('session-1');

      expect(result).toEqual({ paused: true, pauseCommandResult: { success: true, output: 'stopped' } });
      expect(runSessionHookCommand).toHaveBeenCalledTimes(1);
      expect(runSessionHookCommand).toHaveBeenCalledWith('pause', session, 'hook-user');
      expect(deps.resolveSpawnUsername).toHaveBeenCalledWith('owner-1', deps.userRepository);
      expect(log.slice(0, 2).sort()).toEqual(['deactivate-done', 'kill-done']);
      expect(log.slice(2)).toEqual(['hook', 'save']);
    });

    it('still pauses and returns the result when the pause command fails', async () => {
      const session = buildInternalWorktreeSession([buildInternalAgentWorker({ id: 'w1' })]);
      const deps = createMockDeps({
        getSession: () => session,
        runSessionHookCommand: mock(async () => ({ success: false, error: 'exit 3' })),
      });
      const service = new SessionPauseResumeService(deps);

      const result = await service.pauseSession('session-1');

      expect(result).toEqual({ paused: true, pauseCommandResult: { success: false, error: 'exit 3' } });
      expect(deps.sessionRepository.save).toHaveBeenCalledTimes(1);
      expect(deps.deleteSession).toHaveBeenCalled();
    });

    it('still pauses with a failed result when the pause command runner throws', async () => {
      const session = buildInternalWorktreeSession([buildInternalAgentWorker({ id: 'w1' })]);
      const deps = createMockDeps({
        getSession: () => session,
        runSessionHookCommand: mock(async () => {
          throw new Error('spawn exploded');
        }),
      });
      const service = new SessionPauseResumeService(deps);

      const result = await service.pauseSession('session-1');

      expect(result).toEqual({ paused: true, pauseCommandResult: { success: false, error: 'spawn exploded' } });
      expect(deps.sessionRepository.save).toHaveBeenCalledTimes(1);
    });

    it('omits pauseCommandResult when no command ran', async () => {
      const session = buildInternalWorktreeSession([]);
      const deps = createMockDeps({ getSession: () => session });
      const service = new SessionPauseResumeService(deps);

      const result = await service.pauseSession('session-1');

      expect(result).toEqual({ paused: true });
      expect('pauseCommandResult' in result).toBe(false);
    });

    it('runs the resume command before any worker is activated, with the persisted owner', async () => {
      const log: string[] = [];
      const base = buildResumeDeps();
      const runSessionHookCommand = mock(async (..._args: unknown[]) => {
        log.push('hook');
        return { success: true, output: 'started' };
      });
      const deps = buildResumeDeps({
        workerManager: {
          ...base.workerManager,
          activateAgentWorkerPty: mock(async () => {
            log.push('activate');
          }),
        },
        setSession: mock(() => {
          log.push('setSession');
        }),
        resolveSpawnUsername: mock(async () => 'hook-user'),
        runSessionHookCommand,
      });
      const service = new SessionPauseResumeService(deps);

      const result = await service.resumeSession('session-1');

      expect(result?.resumeCommandResult).toEqual({ success: true, output: 'started' });
      expect(runSessionHookCommand).toHaveBeenCalledTimes(1);
      expect(runSessionHookCommand.mock.calls[0]).toEqual(['resume', expect.anything(), 'hook-user']);
      expect(deps.resolveSpawnUsername).toHaveBeenCalledWith('owner-1', deps.userRepository);
      expect(log).toEqual(['hook', 'setSession', 'activate']);
    });

    it('does not run the resume command when runResumeCommand is false, and still activates the workers', async () => {
      const runSessionHookCommand = mock(async () => ({ success: true }));
      const deps = buildResumeDeps({ runSessionHookCommand });
      const service = new SessionPauseResumeService(deps);

      const result = await service.resumeSession('session-1', false);

      expect(result).not.toBeNull();
      expect(result!.resumeCommandResult).toBeUndefined();
      expect(runSessionHookCommand).not.toHaveBeenCalled();
      expect(deps.workerManager.activateAgentWorkerPty).toHaveBeenCalledTimes(1);
      expect(deps.sessionRepository.save).toHaveBeenCalledTimes(1);
    });

    // The service logger is a child created at import time, so the spy on
    // `rootLogger.child` is installed before a fresh import of the module.
    async function resumeWithRecordingLogger(hasCommand: boolean) {
      const infos: unknown[][] = [];
      const original = rootLogger.child.bind(rootLogger);
      const childSpy = spyOn(rootLogger, 'child').mockImplementation(((bindings: { service?: string }) => {
        const child = original(bindings);
        if (bindings?.service !== 'session-pause-resume') return child;
        return new Proxy(child, {
          get: (target, prop) => {
            if (prop === 'info') return (...args: unknown[]) => infos.push(args);
            return Reflect.get(target, prop);
          },
        });
      }) as unknown as typeof rootLogger.child);
      try {
        const fresh = await import(`../session-pause-resume-service.js?v=${Math.random()}`) as typeof import('../session-pause-resume-service.js');
        const deps = buildResumeDeps({ hasSessionHookCommand: mock(() => hasCommand) });
        const service = new fresh.SessionPauseResumeService(deps);
        const result = await service.resumeSession('session-1', false);
        expect(result).not.toBeNull();
        return infos.filter((args) => String(args[1]).includes('Skipping the resume command'));
      } finally {
        childSpy.mockRestore();
      }
    }

    it('logs one INFO line when the auto-resume skips a configured resume command', async () => {
      const skips = await resumeWithRecordingLogger(true);

      expect(skips).toHaveLength(1);
      expect(skips[0][0]).toMatchObject({ sessionId: 'session-1', reason: 'server-start' });
    });

    it('logs nothing when the auto-resume has no resume command to skip', async () => {
      expect(await resumeWithRecordingLogger(false)).toHaveLength(0);
    });

    it('still resumes when the resume command fails or throws', async () => {
      for (const runSessionHookCommand of [
        mock(async () => ({ success: false, error: 'compose down' })),
        mock(async () => {
          throw new Error('boom');
        }),
      ]) {
        const deps = buildResumeDeps({ runSessionHookCommand });
        const service = new SessionPauseResumeService(deps);

        const result = await service.resumeSession('session-1');

        expect(result).not.toBeNull();
        expect(result!.resumeCommandResult?.success).toBe(false);
        expect(deps.workerManager.activateAgentWorkerPty).toHaveBeenCalledTimes(1);
        expect(deps.sessionRepository.save).toHaveBeenCalledTimes(1);
      }
    });

    it('does not run the resume command for a session that is already active', async () => {
      const deps = createMockDeps({ getSession: () => buildInternalWorktreeSession() });
      const service = new SessionPauseResumeService(deps);

      await service.resumeSession('session-1');

      expect(deps.runSessionHookCommand).not.toHaveBeenCalled();
    });

    it('does not run the resume command when the resume is refused', async () => {
      const deps = buildResumeDeps({ pathExists: mock(async () => false) });
      const service = new SessionPauseResumeService(deps);

      expect(await service.resumeSession('session-1')).toBeNull();
      expect(deps.runSessionHookCommand).not.toHaveBeenCalled();
    });

    it('does not run the resume command for a quick session', async () => {
      const persisted = buildPersistedQuickSession({ id: 'session-q', serverPid: null });
      const deps = createMockDeps({
        sessionRepository: {
          ...createMockDeps().sessionRepository,
          findById: mock(async () => persisted),
        },
      });
      const service = new SessionPauseResumeService(deps);

      await service.resumeSession('session-q');

      expect(deps.runSessionHookCommand).not.toHaveBeenCalled();
    });
  });

  describe('resumeSession', () => {
    it('should return existing session if already active', async () => {
      const session = buildInternalWorktreeSession();
      const mockPublicSession = buildWorktreeSession({ id: 'session-1' });

      const deps = createMockDeps({
        getSession: () => session,
        toPublicSession: mock(() => mockPublicSession),
      });
      const service = new SessionPauseResumeService(deps);

      const result = await service.resumeSession('session-1');

      expect(result).toEqual({ session: mockPublicSession });
      // Should not touch DB
      expect(deps.runSessionHookCommand).not.toHaveBeenCalled();
      expect(deps.sessionRepository.findById).not.toHaveBeenCalled();
    });

    it('should return null if not found in database', async () => {
      const deps = createMockDeps();
      const service = new SessionPauseResumeService(deps);

      const result = await service.resumeSession('non-existent');

      expect(result).toBeNull();
    });

    it('should throw SessionOrphanedError for sessions marked as orphaned', async () => {
      const persisted = buildPersistedWorktreeSession({
        id: 'session-orphan',
        serverPid: null,
        pausedAt: '2026-01-01T00:00:00.000Z',
        recoveryState: 'orphaned',
        orphanedReason: 'path_resolution_failed',
      });
      const deps = createMockDeps({
        sessionRepository: {
          ...createMockDeps().sessionRepository,
          findById: mock(async () => persisted),
        },
      });
      const service = new SessionPauseResumeService(deps);

      // A typed error lets the route layer return 409 with a machine-readable
      // `session_orphaned` code instead of a generic 404.
      await expect(service.resumeSession('session-orphan')).rejects.toThrow(
        SessionOrphanedError
      );
      // Path existence must not even be checked for orphaned sessions.
      expect(deps.pathExists).not.toHaveBeenCalled();
      // No session-mutating side effects must occur for orphaned sessions.
      expect(deps.workerManager.restoreWorkersFromPersistence).not.toHaveBeenCalled();
      expect(deps.setSession).not.toHaveBeenCalled();
      expect(deps.sessionRepository.update).not.toHaveBeenCalled();
      expect(deps.sessionRepository.save).not.toHaveBeenCalled();
    });

    it('should return null if path no longer exists', async () => {
      const persisted = buildPersistedWorktreeSession({ id: 'session-1', serverPid: null, pausedAt: '2026-01-01T00:00:00.000Z' });
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

    it('should activate the agent worker on resume without carrying any templateVars', async () => {
      const agentWorker = buildInternalAgentWorker({ id: 'w1' });
      const persisted = buildPersistedWorktreeSession({
        id: 'session-1',
        serverPid: null,
        pausedAt: '2026-01-01T00:00:00.000Z',
        workers: [buildPersistedAgentWorker({ id: 'w1', agentId: 'test-agent' })],
      });
      const activate = mock(async (..._args: unknown[]) => {});
      const deps = createMockDeps({
        sessionRepository: {
          ...createMockDeps().sessionRepository,
          findById: mock(async () => persisted),
          update: mock(async () => true),
        },
        workerManager: {
          killWorker: mock(async () => {}),
          restoreWorkersFromPersistence: mock(() => new Map([['w1', agentWorker]])),
          activateAgentWorkerPty: activate,
          activateTerminalWorkerPty: mock(async () => {}),
        } satisfies SessionPauseResumeDeps['workerManager'],
        toPublicSession: mock(() => buildWorktreeSession({ id: 'session-1' })),
      });
      const service = new SessionPauseResumeService(deps);

      await service.resumeSession('session-1');

      expect(activate).toHaveBeenCalledTimes(1);
      const options = activate.mock.calls[0][1] as { context: Record<string, unknown> };
      expect(options.context.templateVars).toBeUndefined();
      expect('templateVars' in options.context).toBe(false);
    });

    // The activation context carries the session object that resume put in the
    // registry (the one handed to setSession), so activation can recheck at spawn
    // time that the session is still that object. Identity (toBe), not equality.
    it('hands the registered session object to both PTY activations on resume', async () => {
      const agentWorker = buildInternalAgentWorker({ id: 'w1' });
      const terminalWorker = buildInternalTerminalWorker({ id: 'w2' });
      const restoredWorkers = new Map<string, InternalWorker>([
        ['w1', agentWorker],
        ['w2', terminalWorker],
      ]);
      const persisted = buildPersistedWorktreeSession({
        id: 'session-1',
        serverPid: null,
        pausedAt: '2026-01-01T00:00:00.000Z',
        workers: [
          buildPersistedAgentWorker({ id: 'w1', agentId: 'test-agent' }),
          buildPersistedTerminalWorker({ id: 'w2' }),
        ],
      });

      const activateAgent = mock(async (_worker: unknown, _params: { session: InternalSession }) => {});
      const activateTerminal = mock(async (_worker: unknown, _params: { session: InternalSession }) => {});
      const deps = createMockDeps({
        sessionRepository: {
          ...createMockDeps().sessionRepository,
          findById: mock(async () => persisted),
          update: mock(async () => true),
        },
        workerManager: {
          killWorker: mock(async () => {}),
          restoreWorkersFromPersistence: mock(() => restoredWorkers),
          activateAgentWorkerPty: activateAgent,
          activateTerminalWorkerPty: activateTerminal,
        } satisfies SessionPauseResumeDeps['workerManager'],
      });
      const service = new SessionPauseResumeService(deps);

      await service.resumeSession('session-1');

      const setSessionMock = deps.setSession as ReturnType<typeof mock>;
      expect(setSessionMock).toHaveBeenCalledTimes(1);
      const registered = setSessionMock.mock.calls[0][1];
      expect(deps.getSession('session-1')).toBe(registered);
      expect(activateAgent).toHaveBeenCalledTimes(1);
      expect(activateAgent.mock.calls[0][1].session).toBe(registered);
      expect(activateTerminal).toHaveBeenCalledTimes(1);
      expect(activateTerminal.mock.calls[0][1].session).toBe(registered);
    });

    it('should resume a paused session successfully', async () => {
      const agentWorker = buildInternalAgentWorker({ id: 'w1' });
      const restoredWorkers = new Map([['w1', agentWorker]]);
      const persisted = buildPersistedWorktreeSession({
        id: 'session-1',
        serverPid: null,
        pausedAt: '2026-01-01T00:00:00.000Z',
        workers: [buildPersistedAgentWorker({ id: 'w1', agentId: 'test-agent' })],
      });

      const onSessionResumed = mock(() => {});
      const mockPublicSession = buildWorktreeSession({
        id: 'session-1',
        workers: [buildAgentWorkerFixture({ id: 'w1' })],
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
          activateTerminalWorkerPty: mock(async () => {}),
        } satisfies SessionPauseResumeDeps['workerManager'],
        toPublicSession: mock(() => mockPublicSession),
        getSessionLifecycleCallbacks: () => ({ onSessionResumed }),
      });
      const service = new SessionPauseResumeService(deps);

      const result = await service.resumeSession('session-1');

      expect(result).toEqual({ session: mockPublicSession });
      // Workers restored from persistence
      expect(deps.workerManager.restoreWorkersFromPersistence).toHaveBeenCalledTimes(1);
      // Agent worker PTY activated
      expect(deps.workerManager.activateAgentWorkerPty).toHaveBeenCalledTimes(1);
      // Session added to memory
      expect(deps.setSession).toHaveBeenCalled();
      // Full session persisted (writes serverPid, cleared pausedAt, and
      // every worker's revived pid) via toPersistedSessionWithServerPid +
      // sessionRepository.save, instead of the narrower sessionRepository.update.
      expect(deps.toPersistedSessionWithServerPid).toHaveBeenCalledWith(expect.anything(), 99999);
      expect(deps.sessionRepository.save).toHaveBeenCalledTimes(1);
      // Lifecycle callback fired
      expect(onSessionResumed).toHaveBeenCalledTimes(1);
    });

    // Issue #1299 AC required test #3: resume maps to explicit 'continue',
    // NOT 'system'. A worker eligible for initial-prompt delivery whose
    // prompt was never delivered still must NOT redeliver on resume --
    // mapping resume to 'system' would (wrongly) redeliver here, since
    // 'system' falls back to 'deliver-initial-prompt' under obligation.
    // 'continue' is honored unconditionally, so resume must always continue.
    it("resumes an agent worker with an undelivered initial-prompt obligation as 'continue', never redelivering [POLARITY]", async () => {
      const agentWorker = buildInternalAgentWorker({ id: 'w1', deliverInitialPromptOnActivation: true });
      const restoredWorkers = new Map([['w1', agentWorker]]);
      const persisted = buildPersistedWorktreeSession({
        id: 'session-1',
        serverPid: null,
        pausedAt: '2026-01-01T00:00:00.000Z',
        workers: [buildPersistedAgentWorker({ id: 'w1', agentId: 'test-agent', deliverInitialPromptOnActivation: true })],
        initialPrompt: 'Please summarize the repo',
        initialPromptDelivered: false,
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
          activateTerminalWorkerPty: mock(async () => {}),
        } satisfies SessionPauseResumeDeps['workerManager'],
      });
      const service = new SessionPauseResumeService(deps);

      const result = await service.resumeSession('session-1');

      expect(result).not.toBeNull();
      expect(deps.workerManager.activateAgentWorkerPty).toHaveBeenCalledTimes(1);
      const params = (deps.workerManager.activateAgentWorkerPty as ReturnType<typeof mock>).mock.calls[0][1];
      expect(params.startupIntent).toBe('continue');
    });

    it('should include embedded-agent worker activity states in the onSessionResumed callback', async () => {
      const embeddedWorker = buildInternalEmbeddedAgentWorker({ id: 'w1' });
      const restoredWorkers = new Map([['w1', embeddedWorker]]);
      const persisted = buildPersistedWorktreeSession({
        id: 'session-1',
        serverPid: null,
        pausedAt: '2026-01-01T00:00:00.000Z',
        workers: [],
      });

      const onSessionResumed = mock(() => {});
      const mockPublicSession = buildWorktreeSession({
        id: 'session-1',
        workers: [buildEmbeddedAgentWorkerFixture({ id: 'w1' })],
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
          activateTerminalWorkerPty: mock(async () => {}),
        } satisfies SessionPauseResumeDeps['workerManager'],
        toPublicSession: mock(() => mockPublicSession),
        getWorkerActivityState: mock((sessionId: string, workerId: string) =>
          sessionId === 'session-1' && workerId === 'w1' ? 'active' : undefined
        ),
        getSessionLifecycleCallbacks: () => ({ onSessionResumed }),
      });
      const service = new SessionPauseResumeService(deps);

      await service.resumeSession('session-1');

      expect(onSessionResumed).toHaveBeenCalledWith(
        mockPublicSession,
        [{ sessionId: 'session-1', workerId: 'w1', activityState: 'active' }]
      );
    });

    it('should prevent concurrent resume attempts for the same session', async () => {
      const persisted = buildPersistedWorktreeSession({ id: 'session-1', serverPid: null, pausedAt: '2026-01-01T00:00:00.000Z' });

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
          activateTerminalWorkerPty: mock(async () => {}),
        } satisfies SessionPauseResumeDeps['workerManager'],
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

    describe('schedule re-arm on resume', () => {
      function resumableDeps(overrides?: Partial<SessionPauseResumeDeps>) {
        const agentWorker = buildInternalAgentWorker({ id: 'w1' });
        const persisted = buildPersistedWorktreeSession({
          id: 'session-1',
          serverPid: null,
          pausedAt: '2026-01-01T00:00:00.000Z',
        });
        const base = createMockDeps();
        return createMockDeps({
          sessionRepository: {
            ...base.sessionRepository,
            findById: mock(async () => persisted),
            update: mock(async () => true),
          },
          workerManager: {
            killWorker: mock(async () => {}),
            restoreWorkersFromPersistence: mock(() => new Map([['w1', agentWorker]])),
            activateAgentWorkerPty: mock(async () => {}),
            activateTerminalWorkerPty: mock(async () => {}),
          } satisfies SessionPauseResumeDeps['workerManager'],
          ...overrides,
        });
      }

      it('resumes every participant in registration order, after onSessionResumed', async () => {
        const calls: string[] = [];
        const deps = resumableDeps({
          getSessionLifecycleCallbacks: () => ({ onSessionResumed: () => { calls.push('onSessionResumed'); } }),
          getPauseParticipants: recordingParticipants(calls),
        });

        const result = await new SessionPauseResumeService(deps).resumeSession('session-1');

        expect(result).not.toBeNull();
        expect(calls).toEqual([
          'onSessionResumed',
          'resume:timer:session-1',
          'resume:conditional-wakeup:session-1',
        ]);
      });

      it('returns the resumed session and still runs the others when a participant resume throws', async () => {
        const calls: string[] = [];
        const deps = resumableDeps({
          getPauseParticipants: recordingParticipants(calls, { resume: ['timer'] }),
        });

        const result = await new SessionPauseResumeService(deps).resumeSession('session-1');

        expect(result).not.toBeNull();
        expect(calls).toEqual(['resume:timer:session-1', 'resume:conditional-wakeup:session-1']);
      });

      it('never resumes participants when PTY activation fails', async () => {
        const calls: string[] = [];
        const deps = resumableDeps({
          getPauseParticipants: recordingParticipants(calls),
          workerManager: {
            killWorker: mock(async () => {}),
            restoreWorkersFromPersistence: mock(() => new Map([['w1', buildInternalAgentWorker({ id: 'w1' })]])),
            activateAgentWorkerPty: mock(async () => { throw new Error('PTY activation failed'); }),
            activateTerminalWorkerPty: mock(async () => {}),
          } satisfies SessionPauseResumeDeps['workerManager'],
        });

        const result = await new SessionPauseResumeService(deps).resumeSession('session-1');

        expect(result).toBeNull();
        expect(calls).toEqual([]);
      });

      it('never resumes participants when persistence fails after activation (rollback)', async () => {
        const base = resumableDeps();
        const calls: string[] = [];
        const deps = resumableDeps({
          getPauseParticipants: recordingParticipants(calls),
          sessionRepository: {
            ...base.sessionRepository,
            save: mock(async () => { throw new Error('DB write failed'); }),
          },
        });

        const result = await new SessionPauseResumeService(deps).resumeSession('session-1');

        expect(result).toBeNull();
        expect(calls).toEqual([]);
      });

      it('does not resume participants when the session was already active', async () => {
        const session = buildInternalWorktreeSession([buildInternalAgentWorker({ id: 'w1' })]);
        const calls: string[] = [];
        const deps = createMockDeps({ getSession: () => session, getPauseParticipants: recordingParticipants(calls) });

        await new SessionPauseResumeService(deps).resumeSession('session-1');

        expect(calls).toEqual([]);
      });
    });

    it('should roll back on PTY activation failure', async () => {
      const agentWorker = buildInternalAgentWorker({ id: 'w1' });
      const restoredWorkers = new Map([['w1', agentWorker]]);
      const persisted = buildPersistedWorktreeSession({
        id: 'session-1',
        serverPid: null,
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
          activateTerminalWorkerPty: mock(async () => {}),
        } satisfies SessionPauseResumeDeps['workerManager'],
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
      const agentWorker = buildInternalAgentWorker({ id: 'w1' });
      const restoredWorkers = new Map([['w1', agentWorker]]);
      const persisted = buildPersistedWorktreeSession({
        id: 'session-1',
        serverPid: null,
        pausedAt: '2026-01-01T00:00:00.000Z',
      });

      const deps = createMockDeps({
        sessionRepository: {
          ...createMockDeps().sessionRepository,
          findById: mock(async () => persisted),
          update: mock(async () => true),
          // The success-path DB write is now sessionRepository.save (full
          // session persist), not sessionRepository.update -- throw there
          // to reach the rollback branch.
          save: mock(async () => { throw new Error('DB write failed'); }),
        },
        workerManager: {
          killWorker: mock(async () => {}),
          restoreWorkersFromPersistence: mock(() => restoredWorkers),
          activateAgentWorkerPty: mock(async () => {}),
          activateTerminalWorkerPty: mock(async () => {}),
        } satisfies SessionPauseResumeDeps['workerManager'],
      });
      const service = new SessionPauseResumeService(deps);

      const result = await service.resumeSession('session-1');

      expect(result).toBeNull();
      // Workers killed on rollback
      expect(deps.workerManager.killWorker).toHaveBeenCalledTimes(1);
      // Session removed from memory
      expect(deps.deleteSession).toHaveBeenCalledWith('session-1');
      // Paused state restored via the rollback's own sessionRepository.update call
      expect(deps.sessionRepository.update).toHaveBeenCalledWith('session-1', {
        serverPid: null,
        pausedAt: '2026-01-01T00:00:00.000Z',
      });
    });

    // Issue #769: paused-session resume is a "revived" PTY activation path,
    // so the worker's outputOffset must be seeded from the persisted output
    // file size. The contract is enforced by passing `revived: true` to the
    // worker-manager activation methods, which then read the file size before
    // spawning the PTY. See docs/design/websocket-protocol.md "Output offset
    // semantics".
    // Issue #1264 follow-up (CodeRabbit finding on PR #1276): an embedded-agent
    // worker auto-activated by the revival hook must be torn down on rollback,
    // just like PTY workers are. Otherwise its subprocess/MCP token leaks and a
    // future resume attempt spawns a second, orphaned subprocess for the same
    // worker.
    it('should deactivate an auto-activated embedded-agent worker on PTY activation failure', async () => {
      const embeddedWorker = buildInternalEmbeddedAgentWorker({
        id: 'w-emb',
        deliverInitialPromptOnActivation: true,
      });
      const agentWorker = buildInternalAgentWorker({ id: 'w1' });
      // Insertion order matters: the embedded-agent worker must be restored
      // (and successfully activated) BEFORE the PTY worker whose activation
      // throws, reproducing the exact leak scenario.
      const restoredWorkers = new Map<string, InternalWorker>([
        ['w-emb', embeddedWorker],
        ['w1', agentWorker],
      ]);
      const persisted = buildPersistedWorktreeSession({
        id: 'session-1',
        serverPid: null,
        pausedAt: '2026-01-01T00:00:00.000Z',
        initialPrompt: 'Please summarize the repo',
        initialPromptDelivered: false,
      });

      // Ordering tracker: deactivateEmbeddedAgentWorker looks up the session
      // via getSession, so it MUST run before deleteSession removes it from
      // memory — otherwise it would silently no-op on an already-gone
      // session. Record call order to lock this in.
      const callOrder: string[] = [];
      const activateEmbeddedAgentWorker = mock(async () => {});
      const deactivateEmbeddedAgentWorker = mock(async () => {
        callOrder.push('deactivateEmbeddedAgentWorker');
      });
      const deps = createMockDeps({
        deleteSession: mock((_sessionId: string) => {
          callOrder.push('deleteSession');
        }),
        sessionRepository: {
          ...createMockDeps().sessionRepository,
          findById: mock(async () => persisted),
          update: mock(async () => true),
        },
        workerManager: {
          killWorker: mock(async () => {}),
          restoreWorkersFromPersistence: mock(() => restoredWorkers),
          activateAgentWorkerPty: mock(async () => { throw new Error('PTY activation failed'); }),
          activateTerminalWorkerPty: mock(async () => {}),
        } satisfies SessionPauseResumeDeps['workerManager'],
        activateEmbeddedAgentWorker,
        deactivateEmbeddedAgentWorker,
      });
      const service = new SessionPauseResumeService(deps);

      const result = await service.resumeSession('session-1');

      expect(result).toBeNull();
      // The embedded-agent worker activated successfully before the PTY
      // worker's activation threw.
      expect(activateEmbeddedAgentWorker).toHaveBeenCalledWith('session-1', 'w-emb');
      // It must be deactivated during rollback so its subprocess/MCP token
      // isn't leaked. This is the assertion that fails without the fix.
      expect(deactivateEmbeddedAgentWorker).toHaveBeenCalledWith('session-1', 'w-emb');
      // Existing rollback behavior preserved.
      expect(deps.deleteSession).toHaveBeenCalledWith('session-1');
      // Ordering: deactivate must happen BEFORE deleteSession, or the worker
      // lookup inside deactivateEmbeddedAgentWorker would silently no-op on
      // an already-removed session.
      expect(callOrder).toEqual(['deactivateEmbeddedAgentWorker', 'deleteSession']);
    });

    it('should deactivate an auto-activated embedded-agent worker on DB persistence failure after successful activation', async () => {
      const embeddedWorker = buildInternalEmbeddedAgentWorker({
        id: 'w-emb',
        deliverInitialPromptOnActivation: true,
      });
      const agentWorker = buildInternalAgentWorker({ id: 'w1' });
      const restoredWorkers = new Map<string, InternalWorker>([
        ['w-emb', embeddedWorker],
        ['w1', agentWorker],
      ]);
      const persisted = buildPersistedWorktreeSession({
        id: 'session-1',
        serverPid: null,
        pausedAt: '2026-01-01T00:00:00.000Z',
        initialPrompt: 'Please summarize the repo',
        initialPromptDelivered: false,
      });

      const activateEmbeddedAgentWorker = mock(async () => {});
      const deactivateEmbeddedAgentWorker = mock(async () => {});

      const deps = createMockDeps({
        sessionRepository: {
          ...createMockDeps().sessionRepository,
          findById: mock(async () => persisted),
          update: mock(async () => true),
          // The success-path DB write is now sessionRepository.save (full
          // session persist), not sessionRepository.update -- throw there
          // to reach the rollback branch.
          save: mock(async () => { throw new Error('DB write failed'); }),
        },
        workerManager: {
          killWorker: mock(async () => {}),
          restoreWorkersFromPersistence: mock(() => restoredWorkers),
          activateAgentWorkerPty: mock(async () => {}),
          activateTerminalWorkerPty: mock(async () => {}),
        } satisfies SessionPauseResumeDeps['workerManager'],
        activateEmbeddedAgentWorker,
        deactivateEmbeddedAgentWorker,
      });
      const service = new SessionPauseResumeService(deps);

      const result = await service.resumeSession('session-1');

      expect(result).toBeNull();
      expect(deactivateEmbeddedAgentWorker).toHaveBeenCalledWith('session-1', 'w-emb');
      // PTY worker cleanup preserved.
      expect(deps.workerManager.killWorker).toHaveBeenCalledTimes(1);
      expect(deps.deleteSession).toHaveBeenCalledWith('session-1');
    });

    it('should pass revived: true when activating agent worker on resume', async () => {
      const agentWorker = buildInternalAgentWorker({ id: 'w1' });
      const restoredWorkers = new Map([['w1', agentWorker]]);
      const persisted = buildPersistedWorktreeSession({
        id: 'session-1',
        serverPid: null,
        pausedAt: '2026-01-01T00:00:00.000Z',
        workers: [buildPersistedAgentWorker({ id: 'w1', agentId: 'test-agent' })],
      });

      // Cast to two-arg signature so the mock's `calls[0][1]` is typed as the
      // params record. Bun's `mock(async () => {})` infers `args: []`, which
      // would otherwise make `[1]` a tuple-out-of-range type error (TS2493).
      const activateAgentMock = mock(
        async (_worker: unknown, _params: { revived: boolean }) => {},
      );
      const deps = createMockDeps({
        sessionRepository: {
          ...createMockDeps().sessionRepository,
          findById: mock(async () => persisted),
          update: mock(async () => true),
        },
        workerManager: {
          killWorker: mock(async () => {}),
          restoreWorkersFromPersistence: mock(() => restoredWorkers),
          activateAgentWorkerPty: activateAgentMock,
          activateTerminalWorkerPty: mock(async () => {}),
        } satisfies SessionPauseResumeDeps['workerManager'],
      });
      const service = new SessionPauseResumeService(deps);

      await service.resumeSession('session-1');

      expect(activateAgentMock).toHaveBeenCalledTimes(1);
      expect(activateAgentMock.mock.calls[0][1].revived).toBe(true);
    });

    it('should pass revived: true when activating terminal worker on resume', async () => {
      const terminalWorker = buildInternalTerminalWorker({ id: 'w1' });
      const restoredWorkers = new Map([['w1', terminalWorker]]);
      const persisted = buildPersistedWorktreeSession({
        id: 'session-1',
        serverPid: null,
        pausedAt: '2026-01-01T00:00:00.000Z',
        workers: [buildPersistedTerminalWorker({ id: 'w1' })],
      });

      const activateTerminalMock = mock(
        async (_worker: unknown, _params: { revived: boolean }) => {},
      );
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
          activateTerminalWorkerPty: activateTerminalMock,
        } satisfies SessionPauseResumeDeps['workerManager'],
      });
      const service = new SessionPauseResumeService(deps);

      await service.resumeSession('session-1');

      expect(activateTerminalMock).toHaveBeenCalledTimes(1);
      expect(activateTerminalMock.mock.calls[0][1].revived).toBe(true);
    });

    // initialPromptDelivered must survive resume/restart so the
    // embedded-agent worker's re-fire guard (`if (session.initialPromptDelivered)
    // return;`) still holds after the session is reloaded from the database.
    it('should preserve initialPromptDelivered when resuming a session', async () => {
      const agentWorker = buildInternalAgentWorker({ id: 'w1' });
      const restoredWorkers = new Map([['w1', agentWorker]]);
      const persisted = buildPersistedWorktreeSession({
        id: 'session-1',
        serverPid: null,
        pausedAt: '2026-01-01T00:00:00.000Z',
        initialPromptDelivered: true,
        workers: [buildPersistedAgentWorker({ id: 'w1', agentId: 'test-agent' })],
      });

      const setSessionMock = mock((_id: string, _session: InternalSession) => {});
      const deps = createMockDeps({
        setSession: setSessionMock,
        sessionRepository: {
          ...createMockDeps().sessionRepository,
          findById: mock(async () => persisted),
          update: mock(async () => true),
        },
        workerManager: {
          killWorker: mock(async () => {}),
          restoreWorkersFromPersistence: mock(() => restoredWorkers),
          activateAgentWorkerPty: mock(async () => {}),
          activateTerminalWorkerPty: mock(async () => {}),
        } satisfies SessionPauseResumeDeps['workerManager'],
      });
      const service = new SessionPauseResumeService(deps);

      await service.resumeSession('session-1');

      expect(setSessionMock).toHaveBeenCalledTimes(1);
      const [, internalSession] = setSessionMock.mock.calls[0];
      expect(internalSession.initialPromptDelivered).toBe(true);
    });

    it('should restore terminal workers during resume', async () => {
      const terminalWorker = buildInternalTerminalWorker({ id: 'w1' });
      const restoredWorkers = new Map([['w1', terminalWorker]]);
      const persisted = buildPersistedWorktreeSession({
        id: 'session-1',
        serverPid: null,
        pausedAt: '2026-01-01T00:00:00.000Z',
        workers: [buildPersistedTerminalWorker({ id: 'w1' })],
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
          activateTerminalWorkerPty: mock(async () => {}),
        } satisfies SessionPauseResumeDeps['workerManager'],
      });
      const service = new SessionPauseResumeService(deps);

      await service.resumeSession('session-1');

      expect(deps.workerManager.activateTerminalWorkerPty).toHaveBeenCalledTimes(1);
    });

    describe('Issue #1344: revived PTY pids are persisted, restore-boundary marker is appended', () => {
      // Mutation: reverting the fix (sessionRepository.update instead of
      // toPersistedSessionWithServerPid + sessionRepository.save) makes this
      // fail -- the toPersistedSessionWithServerPid spy is never called, so
      // `.mock.calls[0]` is empty and this assertion throws before it can
      // read `.pty.pid`.
      it('persists the InternalSession with the revived worker pid, not the stale persisted pid', async () => {
        const agentWorker = buildInternalAgentWorker({ id: 'w1' });
        const terminalWorker = buildInternalTerminalWorker({ id: 'w2' });
        const restoredWorkers = new Map<string, InternalWorker>([
          ['w1', agentWorker],
          ['w2', terminalWorker],
        ]);
        const persisted = buildPersistedWorktreeSession({
          id: 'session-1',
          serverPid: null,
          pausedAt: '2026-01-01T00:00:00.000Z',
          workers: [
            // Stale pid from before the server restart -- the dead process
            // this Issue is about. The fix must overwrite this, not keep it.
            buildPersistedAgentWorker({ id: 'w1', agentId: 'test-agent', pid: 11111 }),
            buildPersistedTerminalWorker({ id: 'w2', pid: 22222 }),
          ],
        });

        const NEW_AGENT_PID = 33333;
        const NEW_TERMINAL_PID = 44444;
        // Spy that delegates to the default mock's own mapping logic, so
        // this test observes exactly what the service passed in as its
        // first argument (the live InternalSession, post-activation)
        // without re-implementing the InternalSession -> PersistedSession
        // mapping here.
        const defaultToPersistedSessionWithServerPid = createMockDeps().toPersistedSessionWithServerPid;
        const toPersistedSessionWithServerPid = mock(
          (session: InternalSession, serverPid: number | null) =>
            defaultToPersistedSessionWithServerPid(session, serverPid),
        );
        const save = mock(async () => {});
        const deps = createMockDeps({
          sessionRepository: {
            ...createMockDeps().sessionRepository,
            findById: mock(async () => persisted),
            update: mock(async () => true),
            save,
          },
          toPersistedSessionWithServerPid,
          workerManager: {
            killWorker: mock(async () => {}),
            restoreWorkersFromPersistence: mock(() => restoredWorkers),
            // Simulate real PTY activation: assigns a freshly-spawned PTY
            // (with a new pid) onto the worker object in place, exactly as
            // `activateAgentWorkerPty` / `activateTerminalWorkerPty` do.
            activateAgentWorkerPty: mock(async (worker: InternalAgentWorker) => {
              worker.pty = { pid: NEW_AGENT_PID } as InternalAgentWorker['pty'];
            }),
            activateTerminalWorkerPty: mock(async (worker: InternalTerminalWorker) => {
              worker.pty = { pid: NEW_TERMINAL_PID } as InternalTerminalWorker['pty'];
            }),
          } satisfies SessionPauseResumeDeps['workerManager'],
        });
        const service = new SessionPauseResumeService(deps);

        const result = await service.resumeSession('session-1');

        expect(result).not.toBeNull();
        expect(toPersistedSessionWithServerPid).toHaveBeenCalledTimes(1);
        const [persistedInternalSession] = toPersistedSessionWithServerPid.mock.calls[0];
        const persistedAgent = persistedInternalSession.workers.get('w1') as InternalAgentWorker;
        const persistedTerminal = persistedInternalSession.workers.get('w2') as InternalTerminalWorker;
        expect(persistedAgent.pty?.pid).toBe(NEW_AGENT_PID);
        expect(persistedTerminal.pty?.pid).toBe(NEW_TERMINAL_PID);
        expect(save).toHaveBeenCalledTimes(1);
      });

      // Mutation: calling the marker inside the embedded-agent or git-diff
      // branches (or omitting it from either PTY branch) changes this call
      // count and/or which workers it names.
      it('appends the restore-boundary marker exactly once per PTY worker, never for embedded-agent or git-diff workers', async () => {
        const agentWorker = buildInternalAgentWorker({ id: 'w1' });
        const terminalWorker = buildInternalTerminalWorker({ id: 'w2' });
        const embeddedWorker = buildInternalEmbeddedAgentWorker({ id: 'w3' });
        const gitDiffWorker = buildInternalGitDiffWorker({ id: 'w4' });
        const restoredWorkers = new Map<string, InternalWorker>([
          ['w1', agentWorker],
          ['w2', terminalWorker],
          ['w3', embeddedWorker],
          ['w4', gitDiffWorker],
        ]);
        const persisted = buildPersistedWorktreeSession({
          id: 'session-1',
          serverPid: null,
          pausedAt: '2026-01-01T00:00:00.000Z',
        });

        const appendRestoreBoundaryMarker = mock(async (_worker: InternalWorker) => {});
        const deps = createMockDeps({
          sessionRepository: {
            ...createMockDeps().sessionRepository,
            findById: mock(async () => persisted),
            update: mock(async () => true),
          },
          appendRestoreBoundaryMarker,
          workerManager: {
            killWorker: mock(async () => {}),
            restoreWorkersFromPersistence: mock(() => restoredWorkers),
            activateAgentWorkerPty: mock(async () => {}),
            activateTerminalWorkerPty: mock(async () => {}),
          } satisfies SessionPauseResumeDeps['workerManager'],
        });
        const service = new SessionPauseResumeService(deps);

        await service.resumeSession('session-1');

        expect(appendRestoreBoundaryMarker).toHaveBeenCalledTimes(2);
        const notifiedWorkerIds = appendRestoreBoundaryMarker.mock.calls.map((call) => call[0].id);
        expect(notifiedWorkerIds.sort()).toEqual(['w1', 'w2']);
      });

      it('calls appendRestoreBoundaryMarker before sessionRepository.save', async () => {
        const agentWorker = buildInternalAgentWorker({ id: 'w1' });
        const restoredWorkers = new Map<string, InternalWorker>([['w1', agentWorker]]);
        const persisted = buildPersistedWorktreeSession({
          id: 'session-1',
          serverPid: null,
          pausedAt: '2026-01-01T00:00:00.000Z',
        });

        const callOrder: string[] = [];
        const appendRestoreBoundaryMarker = mock(async () => {
          callOrder.push('appendRestoreBoundaryMarker');
        });
        const save = mock(async () => {
          callOrder.push('sessionRepository.save');
        });
        const deps = createMockDeps({
          sessionRepository: {
            ...createMockDeps().sessionRepository,
            findById: mock(async () => persisted),
            update: mock(async () => true),
            save,
          },
          appendRestoreBoundaryMarker,
          workerManager: {
            killWorker: mock(async () => {}),
            restoreWorkersFromPersistence: mock(() => restoredWorkers),
            activateAgentWorkerPty: mock(async () => {}),
            activateTerminalWorkerPty: mock(async () => {}),
          } satisfies SessionPauseResumeDeps['workerManager'],
        });
        const service = new SessionPauseResumeService(deps);

        await service.resumeSession('session-1');

        expect(callOrder).toEqual(['appendRestoreBoundaryMarker', 'sessionRepository.save']);
      });
    });

    describe('embedded-agent worker revival (Issue #1264)', () => {
      it('auto-activates a revived embedded-agent worker with an undelivered initial-prompt obligation', async () => {
        const embeddedWorker = buildInternalEmbeddedAgentWorker({
          id: 'w-emb',
          deliverInitialPromptOnActivation: true,
        });
        const restoredWorkers = new Map([['w-emb', embeddedWorker]]);
        const persisted = buildPersistedWorktreeSession({
          id: 'session-1',
          serverPid: null,
          pausedAt: '2026-01-01T00:00:00.000Z',
          initialPrompt: 'Please summarize the repo',
          initialPromptDelivered: false,
        });

        const activateEmbeddedAgentWorker = mock(async () => {});
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
            activateTerminalWorkerPty: mock(async () => {}),
          } satisfies SessionPauseResumeDeps['workerManager'],
          activateEmbeddedAgentWorker,
        });
        const service = new SessionPauseResumeService(deps);

        const result = await service.resumeSession('session-1');

        expect(result).not.toBeNull();
        expect(activateEmbeddedAgentWorker).toHaveBeenCalledWith('session-1', 'w-emb');
      });

      it('does NOT auto-activate a revived embedded-agent worker whose prompt was already delivered', async () => {
        const embeddedWorker = buildInternalEmbeddedAgentWorker({
          id: 'w-emb',
          deliverInitialPromptOnActivation: true,
        });
        const restoredWorkers = new Map([['w-emb', embeddedWorker]]);
        const persisted = buildPersistedWorktreeSession({
          id: 'session-1',
          serverPid: null,
          pausedAt: '2026-01-01T00:00:00.000Z',
          initialPrompt: 'Please summarize the repo',
          initialPromptDelivered: true,
        });

        const activateEmbeddedAgentWorker = mock(async () => {});
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
            activateTerminalWorkerPty: mock(async () => {}),
          } satisfies SessionPauseResumeDeps['workerManager'],
          activateEmbeddedAgentWorker,
        });
        const service = new SessionPauseResumeService(deps);

        await service.resumeSession('session-1');

        expect(activateEmbeddedAgentWorker).not.toHaveBeenCalled();
      });

      it('does NOT auto-activate a revived embedded-agent worker that never opted into delivery', async () => {
        const embeddedWorker = buildInternalEmbeddedAgentWorker({
          id: 'w-emb',
          deliverInitialPromptOnActivation: false,
        });
        const restoredWorkers = new Map([['w-emb', embeddedWorker]]);
        const persisted = buildPersistedWorktreeSession({
          id: 'session-1',
          serverPid: null,
          pausedAt: '2026-01-01T00:00:00.000Z',
          initialPrompt: 'Please summarize the repo',
          initialPromptDelivered: false,
        });

        const activateEmbeddedAgentWorker = mock(async () => {});
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
            activateTerminalWorkerPty: mock(async () => {}),
          } satisfies SessionPauseResumeDeps['workerManager'],
          activateEmbeddedAgentWorker,
        });
        const service = new SessionPauseResumeService(deps);

        await service.resumeSession('session-1');

        expect(activateEmbeddedAgentWorker).not.toHaveBeenCalled();
      });

      it('does NOT auto-activate when session.initialPrompt is undefined', async () => {
        const embeddedWorker = buildInternalEmbeddedAgentWorker({
          id: 'w-emb',
          deliverInitialPromptOnActivation: true,
        });
        const restoredWorkers = new Map([['w-emb', embeddedWorker]]);
        const persisted = buildPersistedWorktreeSession({
          id: 'session-1',
          serverPid: null,
          pausedAt: '2026-01-01T00:00:00.000Z',
          initialPromptDelivered: false,
        });

        const activateEmbeddedAgentWorker = mock(async () => {});
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
            activateTerminalWorkerPty: mock(async () => {}),
          } satisfies SessionPauseResumeDeps['workerManager'],
          activateEmbeddedAgentWorker,
        });
        const service = new SessionPauseResumeService(deps);

        await service.resumeSession('session-1');

        expect(activateEmbeddedAgentWorker).not.toHaveBeenCalled();
      });

      it('does NOT auto-activate when session.initialPrompt is whitespace-only', async () => {
        const embeddedWorker = buildInternalEmbeddedAgentWorker({
          id: 'w-emb',
          deliverInitialPromptOnActivation: true,
        });
        const restoredWorkers = new Map([['w-emb', embeddedWorker]]);
        const persisted = buildPersistedWorktreeSession({
          id: 'session-1',
          serverPid: null,
          pausedAt: '2026-01-01T00:00:00.000Z',
          initialPrompt: '   \n\t  ',
          initialPromptDelivered: false,
        });

        const activateEmbeddedAgentWorker = mock(async () => {});
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
            activateTerminalWorkerPty: mock(async () => {}),
          } satisfies SessionPauseResumeDeps['workerManager'],
          activateEmbeddedAgentWorker,
        });
        const service = new SessionPauseResumeService(deps);

        await service.resumeSession('session-1');

        expect(activateEmbeddedAgentWorker).not.toHaveBeenCalled();
      });

      it('logs and isolates a failure in one eligible worker\'s activation without aborting resume or affecting a second eligible worker', async () => {
        const failingWorker = buildInternalEmbeddedAgentWorker({
          id: 'w-emb-fail',
          deliverInitialPromptOnActivation: true,
        });
        const okWorker = buildInternalEmbeddedAgentWorker({
          id: 'w-emb-ok',
          deliverInitialPromptOnActivation: true,
        });
        const restoredWorkers = new Map([
          ['w-emb-fail', failingWorker],
          ['w-emb-ok', okWorker],
        ]);
        const persisted = buildPersistedWorktreeSession({
          id: 'session-1',
          serverPid: null,
          pausedAt: '2026-01-01T00:00:00.000Z',
          initialPrompt: 'Please summarize the repo',
          initialPromptDelivered: false,
        });

        const activateEmbeddedAgentWorker = mock(async (_sessionId: string, workerId: string) => {
          if (workerId === 'w-emb-fail') {
            throw new Error('activation exploded');
          }
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
            activateTerminalWorkerPty: mock(async () => {}),
          } satisfies SessionPauseResumeDeps['workerManager'],
          activateEmbeddedAgentWorker,
        });
        const service = new SessionPauseResumeService(deps);

        // Must not reject/throw — the outer resume flow completes normally.
        const result = await service.resumeSession('session-1');

        expect(result).not.toBeNull();
        // Both workers were attempted...
        expect(activateEmbeddedAgentWorker).toHaveBeenCalledWith('session-1', 'w-emb-fail');
        // ...and the second worker's revival was not skipped/aborted by the first's throw.
        expect(activateEmbeddedAgentWorker).toHaveBeenCalledWith('session-1', 'w-emb-ok');
        expect(activateEmbeddedAgentWorker).toHaveBeenCalledTimes(2);
        // No rollback: the session was not removed/killed as a result of this failure.
        expect(deps.deleteSession).not.toHaveBeenCalled();
        expect(deps.workerManager.killWorker).not.toHaveBeenCalled();
      });

      it('never calls activateEmbeddedAgentWorker for a session with no embedded-agent workers, and PTY activation is unaffected', async () => {
        const agentWorker = buildInternalAgentWorker({ id: 'w1' });
        const terminalWorker = buildInternalTerminalWorker({ id: 'w2' });
        const restoredWorkers = new Map<string, InternalWorker>([
          ['w1', agentWorker],
          ['w2', terminalWorker],
        ]);
        const persisted = buildPersistedWorktreeSession({
          id: 'session-1',
          serverPid: null,
          pausedAt: '2026-01-01T00:00:00.000Z',
          workers: [
            buildPersistedAgentWorker({ id: 'w1', agentId: 'test-agent' }),
            buildPersistedTerminalWorker({ id: 'w2' }),
          ],
        });

        const activateEmbeddedAgentWorker = mock(async () => {});
        const activateAgentWorkerPty = mock(async () => {});
        const activateTerminalWorkerPty = mock(async () => {});
        const deps = createMockDeps({
          sessionRepository: {
            ...createMockDeps().sessionRepository,
            findById: mock(async () => persisted),
            update: mock(async () => true),
          },
          workerManager: {
            killWorker: mock(async () => {}),
            restoreWorkersFromPersistence: mock(() => restoredWorkers),
            activateAgentWorkerPty,
            activateTerminalWorkerPty,
          } satisfies SessionPauseResumeDeps['workerManager'],
          activateEmbeddedAgentWorker,
        });
        const service = new SessionPauseResumeService(deps);

        await service.resumeSession('session-1');

        expect(activateEmbeddedAgentWorker).not.toHaveBeenCalled();
        expect(activateAgentWorkerPty).toHaveBeenCalledTimes(1);
        expect(activateTerminalWorkerPty).toHaveBeenCalledTimes(1);
      });
    });
  });
});
