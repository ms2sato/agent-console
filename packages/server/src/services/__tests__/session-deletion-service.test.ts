import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SessionDeletionService, type SessionDeletionDeps } from '../session-deletion-service.js';
import type { InternalSession } from '../internal-types.js';
import { SessionDataPathResolver } from '../../lib/session-data-path-resolver.js';
import {
  buildInternalAgentWorker,
  buildInternalTerminalWorker,
  buildInternalGitDiffWorker,
  buildInternalWorktreeSession,
  buildPersistedWorktreeSession,
} from '../../__tests__/utils/build-test-data.js';

const mockStopWatching = mock(() => {});

function createMockDeps(overrides?: Partial<SessionDeletionDeps>): SessionDeletionDeps {
  const sessions = new Map<string, InternalSession>();
  return {
    getSession: (id) => sessions.get(id),
    setSession: (id, session) => sessions.set(id, session),
    deleteSessionFromMemory: (id) => sessions.delete(id),
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
    } as unknown as SessionDeletionDeps['workerManager'],
    jobQueue: {
      enqueue: mock(async () => 'job-id'),
    } as unknown as SessionDeletionDeps['jobQueue'],
    notificationManager: {
      cleanupSession: mock(() => {}),
    } as unknown as SessionDeletionDeps['notificationManager'],
    messageService: {
      clearSession: mock(() => {}),
    } as unknown as SessionDeletionDeps['messageService'],
    interSessionMessageService: {
      deleteSessionMessages: mock(async () => {}),
    } as unknown as SessionDeletionDeps['interSessionMessageService'],
    memoService: {
      deleteMemo: mock(async () => {}),
    } as unknown as SessionDeletionDeps['memoService'],
    getPathResolverForSession: () => new SessionDataPathResolver('/test/config/repositories/test-repo'),
    getPathResolverForPersistedSession: () => new SessionDataPathResolver('/test/config/repositories/test-repo'),
    getSessionScope: () => ({ scope: 'repository', slug: 'test-repo' }),
    getPersistedSessionScope: () => ({ scope: 'repository', slug: 'test-repo' }),
    getSessionLifecycleCallbacks: () => undefined,
    getWebSocketCallbacks: () => null,
    getTimerCleanupCallback: () => undefined,
    getProcessCleanupCallback: () => undefined,
    stopWatching: mockStopWatching,
    ...overrides,
  };
}

describe('SessionDeletionService', () => {
  beforeEach(() => {
    mockStopWatching.mockClear();
  });

  describe('killSessionWorkers', () => {
    it('should do nothing if session is not found', async () => {
      const deps = createMockDeps();
      const service = new SessionDeletionService(deps);

      await service.killSessionWorkers('non-existent');

      expect(deps.workerManager.killWorker).not.toHaveBeenCalled();
    });

    it('should kill PTY workers but not git-diff workers', async () => {
      const agentWorker = buildInternalAgentWorker({ id: 'w1' });
      const terminalWorker = buildInternalTerminalWorker({ id: 'w2' });
      const gitDiffWorker = buildInternalGitDiffWorker({ id: 'w3' });

      const session = buildInternalWorktreeSession(
        [agentWorker, terminalWorker, gitDiffWorker],
      );

      const deps = createMockDeps({
        getSession: () => session,
      });
      const service = new SessionDeletionService(deps);

      await service.killSessionWorkers('session-1');

      expect(deps.workerManager.killWorker).toHaveBeenCalledTimes(2);
      expect(mockStopWatching).toHaveBeenCalledWith('/test/worktree');
    });
  });

  describe('deleteSession', () => {
    it('should return false if session is not found', async () => {
      const deps = createMockDeps();
      const service = new SessionDeletionService(deps);

      const result = await service.deleteSession('non-existent');

      expect(result).toBe(false);
    });

    it('should delete session and clean up all resources', async () => {
      const session = buildInternalWorktreeSession(
        [buildInternalAgentWorker({ id: 'w1' })],
      );

      const onSessionDeleted = mock(() => {});
      const notifySessionDeleted = mock(() => {});

      const deps = createMockDeps({
        getSession: (id) => id === 'session-1' ? session : undefined,
        getSessionLifecycleCallbacks: () => ({ onSessionDeleted }),
        getWebSocketCallbacks: () => ({ notifySessionDeleted }),
      });
      const service = new SessionDeletionService(deps);

      const result = await service.deleteSession('session-1');

      // Cleanup job payload uses {scope, slug} — not the legacy `repositoryName`.
      const enqueueCall = (deps.jobQueue!.enqueue as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
      expect(enqueueCall[1]).toEqual({
        sessionId: 'session-1',
        scope: 'repository',
        slug: 'test-repo',
      });

      expect(result).toBe(true);
      // WebSocket notification happens before killing
      expect(notifySessionDeleted).toHaveBeenCalledWith('session-1');
      // Worker killed
      expect(deps.workerManager.killWorker).toHaveBeenCalledTimes(1);
      // Cleanup job enqueued
      expect(deps.jobQueue!.enqueue).toHaveBeenCalledTimes(1);
      // Notification cleanup
      expect(deps.notificationManager!.cleanupSession).toHaveBeenCalledWith('session-1');
      // Message cleanup
      expect(deps.messageService.clearSession).toHaveBeenCalledWith('session-1');
      // Inter-session message cleanup
      expect(deps.interSessionMessageService.deleteSessionMessages).toHaveBeenCalledTimes(1);
      // Memo cleanup
      expect(deps.memoService.deleteMemo).toHaveBeenCalledTimes(1);
      // Persistence deletion
      expect(deps.sessionRepository.delete).toHaveBeenCalledWith('session-1');
      // Lifecycle callback
      expect(onSessionDeleted).toHaveBeenCalledWith('session-1');
    });

    it('should throw if jobQueue is not available', async () => {
      const session = buildInternalWorktreeSession();

      const deps = createMockDeps({
        getSession: () => session,
        jobQueue: null,
      });
      const service = new SessionDeletionService(deps);

      await expect(service.deleteSession('session-1')).rejects.toThrow(
        'JobQueue not available'
      );
    });

    it('should restore in-memory session if persistence delete fails', async () => {
      const session = buildInternalWorktreeSession(
        [buildInternalAgentWorker({ id: 'w1' })],
      );

      const setSession = mock(() => {});

      const deps = createMockDeps({
        getSession: (id) => id === 'session-1' ? session : undefined,
        setSession,
        sessionRepository: {
          findAll: mock(async () => []),
          findById: mock(async () => null),
          findByServerPid: mock(async () => []),
          save: mock(async () => {}),
          saveAll: mock(async () => {}),
          update: mock(async () => true),
          delete: mock(async () => { throw new Error('Persistence failure'); }),
          findPaused: mock(async () => []),
        },
      });
      const service = new SessionDeletionService(deps);

      await expect(service.deleteSession('session-1')).rejects.toThrow('Persistence failure');
      expect(setSession).toHaveBeenCalledWith('session-1', session);
    });

    it('should call timer cleanup callback if set', async () => {
      const session = buildInternalWorktreeSession();
      const timerCleanup = mock(() => {});

      const deps = createMockDeps({
        getSession: () => session,
        getTimerCleanupCallback: () => timerCleanup,
      });
      const service = new SessionDeletionService(deps);

      await service.deleteSession('session-1');

      expect(timerCleanup).toHaveBeenCalledWith('session-1');
    });

    it('should stop watching git-diff workers during deletion', async () => {
      const session = buildInternalWorktreeSession(
        [buildInternalGitDiffWorker({ id: 'w1' })],
      );

      const deps = createMockDeps({
        getSession: () => session,
      });
      const service = new SessionDeletionService(deps);

      await service.deleteSession('session-1');

      expect(mockStopWatching).toHaveBeenCalledWith('/test/worktree');
      expect(deps.workerManager.killWorker).not.toHaveBeenCalled();
    });

    it('should not fail if inter-session message cleanup throws', async () => {
      const session = buildInternalWorktreeSession();

      const deps = createMockDeps({
        getSession: () => session,
        interSessionMessageService: {
          deleteSessionMessages: mock(async () => { throw new Error('cleanup error'); }),
        } as unknown as SessionDeletionDeps['interSessionMessageService'],
      });
      const service = new SessionDeletionService(deps);

      const result = await service.deleteSession('session-1');
      expect(result).toBe(true);
    });

    it('should not fail if memo cleanup throws', async () => {
      const session = buildInternalWorktreeSession();

      const deps = createMockDeps({
        getSession: () => session,
        memoService: {
          deleteMemo: mock(async () => { throw new Error('memo error'); }),
        } as unknown as SessionDeletionDeps['memoService'],
      });
      const service = new SessionDeletionService(deps);

      const result = await service.deleteSession('session-1');
      expect(result).toBe(true);
    });

    it('should skip enqueueing cleanup job when getSessionScope returns null (orphaned)', async () => {
      // Simulate an orphaned session whose (scope, slug) cannot be resolved.
      // The service must still delete the DB row and complete successfully,
      // but must NOT enqueue a cleanup job that would fall back to _quick/.
      const session = buildInternalWorktreeSession(
        [buildInternalAgentWorker({ id: 'w1' })],
      );

      const deps = createMockDeps({
        getSession: (id) => id === 'session-1' ? session : undefined,
        getSessionScope: () => null, // orphaned — no scope available
      });
      const service = new SessionDeletionService(deps);

      const result = await service.deleteSession('session-1');

      expect(result).toBe(true);
      // No cleanup job enqueued — we never want to risk cross-scope deletion.
      expect(deps.jobQueue!.enqueue).not.toHaveBeenCalled();
      // Persistence row must still be removed so the orphan does not leak.
      expect(deps.sessionRepository.delete).toHaveBeenCalledWith('session-1');
    });
  });

  describe('forceDeleteSession', () => {
    it('should delegate to deleteSession for in-memory sessions', async () => {
      const session = buildInternalWorktreeSession();

      const deps = createMockDeps({
        getSession: (id) => id === 'session-1' ? session : undefined,
      });
      const service = new SessionDeletionService(deps);

      const result = await service.forceDeleteSession('session-1');

      expect(result).toBe(true);
      expect(deps.sessionRepository.delete).toHaveBeenCalledWith('session-1');
    });

    it('should delete from persistence for orphaned sessions', async () => {
      const persisted = buildPersistedWorktreeSession({ id: 'orphan-1' });
      const onSessionDeleted = mock(() => {});

      const deps = createMockDeps({
        sessionRepository: {
          findAll: mock(async () => []),
          findById: mock(async (id: string) => id === 'orphan-1' ? persisted : null),
          findByServerPid: mock(async () => []),
          save: mock(async () => {}),
          saveAll: mock(async () => {}),
          update: mock(async () => true),
          delete: mock(async () => {}),
          findPaused: mock(async () => []),
        },
        getSessionLifecycleCallbacks: () => ({ onSessionDeleted }),
      });
      const service = new SessionDeletionService(deps);

      const result = await service.forceDeleteSession('orphan-1');

      expect(result).toBe(true);
      expect(deps.sessionRepository.delete).toHaveBeenCalledWith('orphan-1');
      expect(deps.jobQueue!.enqueue).toHaveBeenCalledTimes(1);
      expect(deps.memoService.deleteMemo).toHaveBeenCalledTimes(1);
      expect(onSessionDeleted).toHaveBeenCalledWith('orphan-1');
    });

    it('should return false if session not found anywhere', async () => {
      const deps = createMockDeps();
      const service = new SessionDeletionService(deps);

      const result = await service.forceDeleteSession('non-existent');

      expect(result).toBe(false);
    });

    it('should handle orphaned session without jobQueue', async () => {
      const persisted = buildPersistedWorktreeSession({ id: 'orphan-1' });

      const deps = createMockDeps({
        jobQueue: null,
        sessionRepository: {
          findAll: mock(async () => []),
          findById: mock(async (id: string) => id === 'orphan-1' ? persisted : null),
          findByServerPid: mock(async () => []),
          save: mock(async () => {}),
          saveAll: mock(async () => {}),
          update: mock(async () => true),
          delete: mock(async () => {}),
          findPaused: mock(async () => []),
        },
      });
      const service = new SessionDeletionService(deps);

      const result = await service.forceDeleteSession('orphan-1');

      expect(result).toBe(true);
      expect(deps.sessionRepository.delete).toHaveBeenCalledWith('orphan-1');
    });

    it('should not fail if memo cleanup throws for orphaned session', async () => {
      const persisted = buildPersistedWorktreeSession({ id: 'orphan-1' });

      const deps = createMockDeps({
        sessionRepository: {
          findAll: mock(async () => []),
          findById: mock(async (id: string) => id === 'orphan-1' ? persisted : null),
          findByServerPid: mock(async () => []),
          save: mock(async () => {}),
          saveAll: mock(async () => {}),
          update: mock(async () => true),
          delete: mock(async () => {}),
          findPaused: mock(async () => []),
        },
        memoService: {
          deleteMemo: mock(async () => { throw new Error('memo error'); }),
        } as unknown as SessionDeletionDeps['memoService'],
      });
      const service = new SessionDeletionService(deps);

      const result = await service.forceDeleteSession('orphan-1');
      expect(result).toBe(true);
    });
  });
});
