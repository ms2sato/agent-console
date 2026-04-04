import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SessionDeletionService, type SessionDeletionDeps } from '../session-deletion-service.js';
import type { InternalSession, InternalWorktreeSession } from '../internal-types.js';
import type { InternalWorker } from '../worker-types.js';
import type { PersistedSession } from '../persistence-service.js';
import { SessionDataPathResolver } from '../../lib/session-data-path-resolver.js';

// Mock git-diff-service stopWatching at module level
import path from 'path';
const gitDiffServicePath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../git-diff-service.js'
);
const mockStopWatching = mock(() => {});
mock.module(gitDiffServicePath, () => ({
  stopWatching: mockStopWatching,
}));

function createMockWorker(overrides: Partial<InternalWorker> & { id: string; type: InternalWorker['type'] }): InternalWorker {
  const base = {
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  if (base.type === 'git-diff') {
    return base as InternalWorker;
  }
  return {
    ...base,
    pty: null,
    callbacks: null,
    exitReason: null,
  } as unknown as InternalWorker;
}

function createMockSession(overrides?: Partial<InternalWorktreeSession>): InternalWorktreeSession {
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

function createMockPersistedSession(overrides?: Partial<PersistedSession>): PersistedSession {
  return {
    id: 'session-1',
    type: 'worktree',
    locationPath: '/test/worktree',
    createdAt: new Date().toISOString(),
    workers: [],
    repositoryId: 'repo-1',
    worktreeId: 'wt-1',
    serverPid: 12345,
    ...overrides,
  } as PersistedSession;
}

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
    getPathResolverForSession: () => new SessionDataPathResolver('test-repo'),
    getPathResolverForPersistedSession: () => new SessionDataPathResolver('test-repo'),
    getSessionLifecycleCallbacks: () => undefined,
    getWebSocketCallbacks: () => null,
    getTimerCleanupCallback: () => undefined,
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
      const agentWorker = createMockWorker({ id: 'w1', type: 'agent' });
      const terminalWorker = createMockWorker({ id: 'w2', type: 'terminal' });
      const gitDiffWorker = createMockWorker({ id: 'w3', type: 'git-diff' });

      const session = createMockSession({
        workers: new Map([
          ['w1', agentWorker],
          ['w2', terminalWorker],
          ['w3', gitDiffWorker],
        ]),
      });

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
      const session = createMockSession({
        workers: new Map([
          ['w1', createMockWorker({ id: 'w1', type: 'agent' })],
        ]),
      });

      const onSessionDeleted = mock(() => {});
      const notifySessionDeleted = mock(() => {});

      const deps = createMockDeps({
        getSession: (id) => id === 'session-1' ? session : undefined,
        getSessionLifecycleCallbacks: () => ({ onSessionDeleted }),
        getWebSocketCallbacks: () => ({ notifySessionDeleted }),
      });
      const service = new SessionDeletionService(deps);

      const result = await service.deleteSession('session-1');

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
      const session = createMockSession();

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
      const session = createMockSession({
        workers: new Map([
          ['w1', createMockWorker({ id: 'w1', type: 'agent' })],
        ]),
      });

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
      const session = createMockSession();
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
      const gitDiffWorker = createMockWorker({ id: 'w1', type: 'git-diff' });
      const session = createMockSession({
        workers: new Map([['w1', gitDiffWorker]]),
      });

      const deps = createMockDeps({
        getSession: () => session,
      });
      const service = new SessionDeletionService(deps);

      await service.deleteSession('session-1');

      expect(mockStopWatching).toHaveBeenCalledWith('/test/worktree');
      expect(deps.workerManager.killWorker).not.toHaveBeenCalled();
    });

    it('should not fail if inter-session message cleanup throws', async () => {
      const session = createMockSession();

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
      const session = createMockSession();

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
  });

  describe('forceDeleteSession', () => {
    it('should delegate to deleteSession for in-memory sessions', async () => {
      const session = createMockSession();

      const deps = createMockDeps({
        getSession: (id) => id === 'session-1' ? session : undefined,
      });
      const service = new SessionDeletionService(deps);

      const result = await service.forceDeleteSession('session-1');

      expect(result).toBe(true);
      expect(deps.sessionRepository.delete).toHaveBeenCalledWith('session-1');
    });

    it('should delete from persistence for orphaned sessions', async () => {
      const persisted = createMockPersistedSession({ id: 'orphan-1' });
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
      const persisted = createMockPersistedSession({ id: 'orphan-1' });

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
      const persisted = createMockPersistedSession({ id: 'orphan-1' });

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
