import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Kysely } from 'kysely';
import type { PersistedSession } from '../persistence-service.js';
import type { SessionRepository } from '../../repositories/index.js';
import type { WorkerOutputFileManager } from '../../lib/worker-output-file.js';
import type { JobQueue } from '../../jobs/index.js';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteSessionRepository } from '../../repositories/sqlite-session-repository.js';
import { SessionDataPathResolver } from '../../lib/session-data-path-resolver.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { SessionInitializationService } from '../session-initialization-service.js';
import {
  buildPersistedQuickSession,
  buildPersistedAgentWorker,
  buildPersistedTerminalWorker,
  buildPersistedGitDiffWorker,
} from '../../__tests__/utils/build-test-data.js';

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
    it('should return sessions with dead serverPid as auto-resume targets', async () => {
      const session = buildPersistedQuickSession({
        id: 'session-1',
        locationPath: '/some/path',
        serverPid: 12345,
      });
      // serverPid 12345 is dead (not marked alive)

      const { service, sessionRepository } = createService({ sessions: [session] });
      const autoResumeIds = await service.initialize();

      // Session should be returned as auto-resume target
      expect(autoResumeIds).toContain('session-1');

      // Session should have serverPid=null and pausedAt=undefined (ready for auto-resume)
      const saved = await sessionRepository.findAll();
      const updated = saved.find(s => s.id === 'session-1');
      expect(updated).toBeDefined();
      expect(updated!.serverPid).toBeNull();
      expect(updated!.pausedAt).toBeUndefined();
    });

    it('should preserve sessions owned by live servers and not return them as auto-resume targets', async () => {
      const session = buildPersistedQuickSession({
        id: 'session-1',
        locationPath: '/some/path',
        serverPid: 12345,
      });
      mockProcess.markAlive(12345);

      const { service, sessionRepository } = createService({ sessions: [session] });
      const autoResumeIds = await service.initialize();

      expect(autoResumeIds).not.toContain('session-1');

      const saved = await sessionRepository.findAll();
      const preserved = saved.find(s => s.id === 'session-1');
      expect(preserved).toBeDefined();
      expect(preserved!.serverPid).toBe(12345);
    });

    it('should keep paused sessions (serverPid === null) unchanged and not return them as auto-resume targets', async () => {
      const session = buildPersistedQuickSession({
        id: 'session-1',
        locationPath: '/some/path',
        serverPid: null,
        pausedAt: '2024-01-01T01:00:00.000Z',
      });

      const { service, sessionRepository } = createService({ sessions: [session] });
      const autoResumeIds = await service.initialize();

      expect(autoResumeIds).not.toContain('session-1');

      const saved = await sessionRepository.findAll();
      const preserved = saved.find(s => s.id === 'session-1');
      expect(preserved).toBeDefined();
      expect(preserved!.serverPid).toBeNull();
      expect(preserved!.pausedAt).toBe('2024-01-01T01:00:00.000Z');
    });

    it('should keep paused sessions with serverPid=undefined (from DB mapper) unchanged and not auto-resume them', async () => {
      // DB mapper converts server_pid=null to serverPid=undefined
      // Paused sessions must be detected by pausedAt, not just serverPid === null
      const session = buildPersistedQuickSession({
        id: 'session-paused',
        locationPath: '/some/path',
        serverPid: undefined,
        pausedAt: '2024-01-01T01:00:00.000Z',
      });

      const { service, sessionRepository } = createService({ sessions: [session] });
      const autoResumeIds = await service.initialize();

      expect(autoResumeIds).not.toContain('session-paused');

      const saved = await sessionRepository.findAll();
      const preserved = saved.find(s => s.id === 'session-paused');
      expect(preserved).toBeDefined();
      expect(preserved!.pausedAt).toBe('2024-01-01T01:00:00.000Z');
    });

    it('should remove sessions whose locationPath no longer exists', async () => {
      const session = buildPersistedQuickSession({
        id: 'orphan-session',
        locationPath: '/nonexistent/path',
        serverPid: 12345,
      });
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
      const session = buildPersistedQuickSession({
        id: 'session-1',
        locationPath: '/some/path',
        workers: [
          buildPersistedAgentWorker({
            id: 'worker-1',
            name: 'Claude',
            agentId: 'claude-code',
            pid: 11111,
          }),
        ],
        serverPid: 12345,
      });
      mockProcess.markAlive(11111);
      // serverPid 12345 is dead

      const { service } = createService({ sessions: [session] });
      await service.initialize();

      expect(mockProcess.wasKilled(11111)).toBe(true);
    });

    it('should skip sessions already in memory', async () => {
      const session = buildPersistedQuickSession({
        id: 'in-memory-session',
        locationPath: '/some/path',
        workers: [
          buildPersistedAgentWorker({
            id: 'worker-1',
            name: 'Claude',
            agentId: 'claude-code',
            pid: 11111,
          }),
        ],
        serverPid: 12345,
      });
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

      const session = buildPersistedQuickSession({
        id: 'session-1',
        locationPath: '/some/path',
        workers: [
          buildPersistedAgentWorker({ id: 'w1', name: 'Agent', agentId: 'claude-code', pid: 1001 }),
          buildPersistedTerminalWorker({ id: 'w2', name: 'Term', pid: 1002 }),
        ],
        serverPid: 999,
      });

      const count = SessionInitializationService.killOrphanWorkers(session);
      expect(count).toBe(2);
      expect(mockProcess.wasKilled(1001)).toBe(true);
      expect(mockProcess.wasKilled(1002)).toBe(true);
    });

    it('should skip git-diff workers', () => {
      const session = buildPersistedQuickSession({
        id: 'session-1',
        locationPath: '/some/path',
        workers: [
          buildPersistedGitDiffWorker({ id: 'w1', name: 'Diff', baseCommit: 'abc123' }),
        ],
        serverPid: 999,
      });

      const count = SessionInitializationService.killOrphanWorkers(session);
      expect(count).toBe(0);
    });

    it('should skip workers with no pid', () => {
      const session = buildPersistedQuickSession({
        id: 'session-1',
        locationPath: '/some/path',
        workers: [
          buildPersistedAgentWorker({ id: 'w1', name: 'Agent', agentId: 'claude-code', pid: null }),
        ],
        serverPid: 999,
      });

      const count = SessionInitializationService.killOrphanWorkers(session);
      expect(count).toBe(0);
    });

    it('should skip workers whose process is already dead', () => {
      // pid 2001 is not marked alive
      const session = buildPersistedQuickSession({
        id: 'session-1',
        locationPath: '/some/path',
        workers: [
          buildPersistedAgentWorker({ id: 'w1', name: 'Agent', agentId: 'claude-code', pid: 2001 }),
        ],
        serverPid: 999,
      });

      const count = SessionInitializationService.killOrphanWorkers(session);
      expect(count).toBe(0);
      expect(mockProcess.wasKilled(2001)).toBe(false);
    });
  });

  describe('initialize with empty data', () => {
    it('should handle empty session list without errors and return empty array', async () => {
      const { service } = createService({ sessions: [] });
      const autoResumeIds = await service.initialize();
      expect(autoResumeIds).toEqual([]);
    });
  });
});

describe('SessionInitializationService integration (real DB → mapper → service)', () => {
  let db: Kysely<Database>;
  let sessionRepository: SqliteSessionRepository;

  beforeEach(async () => {
    resetProcessMock();
    db = await createDatabaseForTest();
    sessionRepository = new SqliteSessionRepository(db);
  });

  afterEach(async () => {
    resetProcessMock();
    await db.destroy();
  });

  function createServiceWithRealRepo() {
    const workerOutputFileManager = {
      deleteSessionOutputs: mock(async () => {}),
    } as unknown as WorkerOutputFileManager;
    const jobQueue = {
      enqueue: mock(async () => 'job-id'),
    } as unknown as JobQueue;

    const service = new SessionInitializationService({
      sessionRepository,
      pathExists: async () => true,
      isSessionInMemory: () => false,
      workerOutputFileManager,
      jobQueue,
      getPathResolverForPersistedSession: () => new SessionDataPathResolver(),
      getServerPid: () => TEST_SERVER_PID,
    });

    return { service };
  }

  it('should not auto-resume a paused session read through real DB mapper (null→undefined conversion)', async () => {
    // Save a paused session via the real repository (writes server_pid=null, paused_at=timestamp to DB)
    const pausedSession = buildPersistedQuickSession({
      id: 'paused-via-db',
      locationPath: '/some/path',
      serverPid: null,
      pausedAt: '2024-01-01T01:00:00.000Z',
    });
    await sessionRepository.save(pausedSession);

    // Verify the DB mapper converts server_pid=null → serverPid=undefined
    const sessions = await sessionRepository.findAll();
    const loaded = sessions.find(s => s.id === 'paused-via-db');
    expect(loaded).toBeDefined();
    expect(loaded!.serverPid).toBeUndefined(); // DB mapper converts null → undefined
    expect(loaded!.pausedAt).toBe('2024-01-01T01:00:00.000Z');

    // Run initialization with the real repository — paused session must NOT be auto-resumed
    const { service } = createServiceWithRealRepo();
    const autoResumeIds = await service.initialize();

    expect(autoResumeIds).not.toContain('paused-via-db');

    // Session should still have pausedAt preserved
    const afterInit = await sessionRepository.findAll();
    const preserved = afterInit.find(s => s.id === 'paused-via-db');
    expect(preserved).toBeDefined();
    expect(preserved!.pausedAt).toBe('2024-01-01T01:00:00.000Z');
  });

  it('should auto-resume an active session with dead serverPid read through real DB mapper', async () => {
    // Save an active (non-paused) session with a dead serverPid
    const activeSession = buildPersistedQuickSession({
      id: 'active-via-db',
      locationPath: '/some/path',
      serverPid: 12345,
    });
    await sessionRepository.save(activeSession);
    // serverPid 12345 is dead (not marked alive)

    const { service } = createServiceWithRealRepo();
    const autoResumeIds = await service.initialize();

    expect(autoResumeIds).toContain('active-via-db');
  });
});
