import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { PersistedSession } from '../persistence-service.js';
import type { SessionRepository } from '../../repositories/index.js';
import type { WorkerOutputFileManager } from '../../lib/worker-output-file.js';
import type { JobQueue } from '../../jobs/index.js';
import { SessionDataPathResolver } from '../../lib/session-data-path-resolver.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { SessionInitializationService } from '../session-initialization-service.js';

const TEST_SERVER_PID = 99999;

function createMockSessionRepository(sessions: PersistedSession[]): SessionRepository {
  let storedSessions = [...sessions];
  return {
    findAll: async () => [...storedSessions],
    findById: async (id: string) => storedSessions.find(s => s.id === id) ?? null,
    findByServerPid: async (pid: number) => storedSessions.filter(s => s.serverPid === pid),
    save: async (session: PersistedSession) => {
      storedSessions = storedSessions.filter(s => s.id !== session.id);
      storedSessions.push(session);
    },
    saveAll: async (newSessions: PersistedSession[]) => {
      storedSessions = [...newSessions];
    },
    update: async () => true,
    delete: async (id: string) => {
      storedSessions = storedSessions.filter(s => s.id !== id);
    },
    findPaused: async () => storedSessions.filter(s => s.serverPid === null),
  } as SessionRepository;
}

function createMockWorkerOutputFileManager(): WorkerOutputFileManager {
  return {
    deleteSessionOutputs: mock(async () => {}),
  } as unknown as WorkerOutputFileManager;
}

function createMockJobQueue(): JobQueue {
  return {
    enqueue: mock(async () => 'job-id'),
  } as unknown as JobQueue;
}

describe('SessionInitializationService', () => {
  beforeEach(() => {
    resetProcessMock();
  });

  afterEach(() => {
    resetProcessMock();
  });

  function createService(options: {
    sessions: PersistedSession[];
    pathExists?: (path: string) => Promise<boolean>;
    inMemorySessionIds?: Set<string>;
    jobQueue?: JobQueue | null;
  }) {
    const sessionRepository = createMockSessionRepository(options.sessions);
    const workerOutputFileManager = createMockWorkerOutputFileManager();
    const jobQueue = options.jobQueue === undefined ? createMockJobQueue() : options.jobQueue;
    const inMemoryIds = options.inMemorySessionIds ?? new Set<string>();

    const service = new SessionInitializationService({
      sessionRepository,
      pathExists: options.pathExists ?? (async () => true),
      isSessionInMemory: (id) => inMemoryIds.has(id),
      workerOutputFileManager,
      jobQueue,
      getPathResolverForPersistedSession: () => new SessionDataPathResolver(),
      getServerPid: () => TEST_SERVER_PID,
    });

    return { service, sessionRepository, workerOutputFileManager, jobQueue };
  }

  describe('initializeSessions (via initialize)', () => {
    it('should mark sessions with dead serverPid as paused', async () => {
      const session: PersistedSession = {
        id: 'session-1',
        type: 'quick',
        locationPath: '/some/path',
        workers: [],
        serverPid: 12345,
        createdAt: '2024-01-01T00:00:00.000Z',
      };
      // serverPid 12345 is dead (not marked alive)

      const { service, sessionRepository } = createService({ sessions: [session] });
      await service.initialize();

      const saved = await sessionRepository.findAll();
      const updated = saved.find(s => s.id === 'session-1');
      expect(updated).toBeDefined();
      expect(updated!.serverPid).toBeNull();
      expect(updated!.pausedAt).toBeDefined();
    });

    it('should preserve sessions owned by live servers', async () => {
      const session: PersistedSession = {
        id: 'session-1',
        type: 'quick',
        locationPath: '/some/path',
        workers: [],
        serverPid: 12345,
        createdAt: '2024-01-01T00:00:00.000Z',
      };
      mockProcess.markAlive(12345);

      const { service, sessionRepository } = createService({ sessions: [session] });
      await service.initialize();

      const saved = await sessionRepository.findAll();
      const preserved = saved.find(s => s.id === 'session-1');
      expect(preserved).toBeDefined();
      expect(preserved!.serverPid).toBe(12345);
    });

    it('should keep paused sessions (serverPid === null) unchanged', async () => {
      const session: PersistedSession = {
        id: 'session-1',
        type: 'quick',
        locationPath: '/some/path',
        workers: [],
        serverPid: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        pausedAt: '2024-01-01T01:00:00.000Z',
      };

      const { service, sessionRepository } = createService({ sessions: [session] });
      await service.initialize();

      const saved = await sessionRepository.findAll();
      const preserved = saved.find(s => s.id === 'session-1');
      expect(preserved).toBeDefined();
      expect(preserved!.serverPid).toBeNull();
    });

    it('should remove sessions whose locationPath no longer exists', async () => {
      const session: PersistedSession = {
        id: 'orphan-session',
        type: 'quick',
        locationPath: '/nonexistent/path',
        workers: [],
        serverPid: 12345,
        createdAt: '2024-01-01T00:00:00.000Z',
      };
      // serverPid 12345 is dead (not marked alive)

      const { service, sessionRepository, workerOutputFileManager } = createService({
        sessions: [session],
        pathExists: async () => false,
      });
      await service.initialize();

      // Session should be deleted
      const saved = await sessionRepository.findAll();
      expect(saved.find(s => s.id === 'orphan-session')).toBeUndefined();

      // Output files should be cleaned up
      expect(workerOutputFileManager.deleteSessionOutputs).toHaveBeenCalledTimes(1);
    });

    it('should kill orphan worker processes before marking session as paused', async () => {
      const session: PersistedSession = {
        id: 'session-1',
        type: 'quick',
        locationPath: '/some/path',
        workers: [
          {
            id: 'worker-1',
            type: 'agent',
            name: 'Claude',
            agentId: 'claude-code',
            pid: 11111,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        serverPid: 12345,
        createdAt: '2024-01-01T00:00:00.000Z',
      };
      mockProcess.markAlive(11111);
      // serverPid 12345 is dead

      const { service } = createService({ sessions: [session] });
      await service.initialize();

      expect(mockProcess.wasKilled(11111)).toBe(true);
    });

    it('should skip sessions already in memory', async () => {
      const session: PersistedSession = {
        id: 'in-memory-session',
        type: 'quick',
        locationPath: '/some/path',
        workers: [
          {
            id: 'worker-1',
            type: 'agent',
            name: 'Claude',
            agentId: 'claude-code',
            pid: 11111,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        serverPid: 12345,
        createdAt: '2024-01-01T00:00:00.000Z',
      };
      mockProcess.markAlive(11111);

      const { service } = createService({
        sessions: [session],
        inMemorySessionIds: new Set(['in-memory-session']),
      });
      await service.initialize();

      // Workers should not be killed since session is in memory
      expect(mockProcess.wasKilled(11111)).toBe(false);
    });
  });

  describe('killOrphanWorkers (static)', () => {
    it('should kill alive worker processes and return count', () => {
      mockProcess.markAlive(1001);
      mockProcess.markAlive(1002);

      const session: PersistedSession = {
        id: 'session-1',
        type: 'quick',
        locationPath: '/some/path',
        workers: [
          { id: 'w1', type: 'agent', name: 'Agent', agentId: 'claude-code', pid: 1001, createdAt: '2024-01-01T00:00:00.000Z' },
          { id: 'w2', type: 'terminal', name: 'Term', pid: 1002, createdAt: '2024-01-01T00:00:00.000Z' },
        ],
        serverPid: 999,
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      const count = SessionInitializationService.killOrphanWorkers(session);
      expect(count).toBe(2);
      expect(mockProcess.wasKilled(1001)).toBe(true);
      expect(mockProcess.wasKilled(1002)).toBe(true);
    });

    it('should skip git-diff workers', () => {
      const session: PersistedSession = {
        id: 'session-1',
        type: 'quick',
        locationPath: '/some/path',
        workers: [
          { id: 'w1', type: 'git-diff', name: 'Diff', baseCommit: 'abc123', createdAt: '2024-01-01T00:00:00.000Z' },
        ],
        serverPid: 999,
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      const count = SessionInitializationService.killOrphanWorkers(session);
      expect(count).toBe(0);
    });

    it('should skip workers with no pid', () => {
      const session: PersistedSession = {
        id: 'session-1',
        type: 'quick',
        locationPath: '/some/path',
        workers: [
          { id: 'w1', type: 'agent', name: 'Agent', agentId: 'claude-code', pid: null, createdAt: '2024-01-01T00:00:00.000Z' },
        ],
        serverPid: 999,
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      const count = SessionInitializationService.killOrphanWorkers(session);
      expect(count).toBe(0);
    });

    it('should skip workers whose process is already dead', () => {
      // pid 2001 is not marked alive
      const session: PersistedSession = {
        id: 'session-1',
        type: 'quick',
        locationPath: '/some/path',
        workers: [
          { id: 'w1', type: 'agent', name: 'Agent', agentId: 'claude-code', pid: 2001, createdAt: '2024-01-01T00:00:00.000Z' },
        ],
        serverPid: 999,
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      const count = SessionInitializationService.killOrphanWorkers(session);
      expect(count).toBe(0);
      expect(mockProcess.wasKilled(2001)).toBe(false);
    });
  });

  describe('initialize with empty data', () => {
    it('should handle empty session list without errors', async () => {
      const { service } = createService({ sessions: [] });
      await service.initialize();
      // Should complete without errors
    });
  });
});
