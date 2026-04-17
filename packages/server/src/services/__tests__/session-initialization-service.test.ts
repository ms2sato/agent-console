import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Kysely } from 'kysely';
import type { PersistedSession } from '../persistence-service.js';
import type { SessionRepository, SessionUpdateFields } from '../../repositories/index.js';
import type { WorkerOutputFileManager } from '../../lib/worker-output-file.js';
import type { JobQueue } from '../../jobs/index.js';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteSessionRepository } from '../../repositories/sqlite-session-repository.js';
import { SessionDataPathResolver } from '../../lib/session-data-path-resolver.js';
import { InvalidSessionDataScopeError } from '../../lib/session-data-path.js';
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
    update: async (id: string, updates: SessionUpdateFields) => {
      const idx = storedSessions.findIndex(s => s.id === id);
      if (idx === -1) return false;
      const current = storedSessions[idx];
      // Apply only provided (non-undefined) fields. Null is a meaningful value.
      const patch: Partial<PersistedSession> = {};
      for (const key of Object.keys(updates) as Array<keyof SessionUpdateFields>) {
        const value = updates[key];
        if (value !== undefined) {
          (patch as Record<string, unknown>)[key] = value;
        }
      }
      storedSessions[idx] = { ...current, ...patch } as PersistedSession;
      return true;
    },
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
      getPathResolverForPersistedSession: () => new SessionDataPathResolver('/test/config/_quick'),
      baseDirForPersistedSession: () => '/test/config/_quick',
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

  describe('cleanupOrphanProcesses (via initialize)', () => {
    // cleanupOrphanProcesses only removes paused worktree sessions whose
    // serverPid is still set to a dead pid (initializeSessions preserves
    // sessions with pausedAt set, so they survive into cleanupOrphanProcesses).
    it('should delete orphan session without enqueueing cleanup job when dataScope is missing', async () => {
      // An orphaned paused worktree session owned by a dead server, missing
      // dataScope (legacy/unbackfilled row). `cleanupOrphanProcesses` must
      // delete the DB row but must NOT enqueue a CLEANUP_SESSION_OUTPUTS
      // job — falling back to _quick/ would risk cross-scope deletion.
      const orphanWorktreeNoScope: PersistedSession = {
        id: 'orphan-worktree-no-scope',
        type: 'worktree',
        locationPath: '/some/path',
        repositoryId: 'repo-1',
        worktreeId: 'main',
        serverPid: 88888, // dead pid (not marked alive)
        pausedAt: '2024-01-01T01:00:00.000Z', // paused → preserved by initializeSessions
        createdAt: '2026-01-01T00:00:00.000Z',
        workers: [],
        // dataScope intentionally undefined → orphan with no scope
      };

      const { service, sessionRepository, jobQueue } = createService({
        sessions: [orphanWorktreeNoScope],
      });

      // Sanity check — the session exists before initialize.
      expect(await sessionRepository.findById('orphan-worktree-no-scope')).not.toBeNull();

      await service.initialize();

      // The session must have been deleted from persistence.
      expect(await sessionRepository.findById('orphan-worktree-no-scope')).toBeNull();

      // No cleanup job may have been enqueued — we only seeded one session,
      // so zero calls confirms the scope-missing branch was taken.
      expect(jobQueue!.enqueue).not.toHaveBeenCalled();
    });

    it('should enqueue cleanup job for orphan session with valid dataScope', async () => {
      // Baseline: when the orphan has a valid scope, we DO enqueue cleanup.
      // This guards against the fix accidentally becoming a no-op.
      const orphanWithScope: PersistedSession = {
        id: 'orphan-with-scope',
        type: 'worktree',
        locationPath: '/some/path',
        repositoryId: 'repo-1',
        worktreeId: 'main',
        serverPid: 77777, // dead pid
        pausedAt: '2024-01-01T01:00:00.000Z', // paused → preserved by initializeSessions
        createdAt: '2026-01-01T00:00:00.000Z',
        workers: [],
        dataScope: 'repository',
        dataScopeSlug: 'my-repo',
      };

      const { service, sessionRepository, jobQueue } = createService({
        sessions: [orphanWithScope],
      });

      await service.initialize();

      // Session removed.
      expect(await sessionRepository.findById('orphan-with-scope')).toBeNull();
      // Cleanup enqueued with the scope payload.
      expect(jobQueue!.enqueue).toHaveBeenCalledTimes(1);
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
      getPathResolverForPersistedSession: () => new SessionDataPathResolver('/test/config/_quick'),
      baseDirForPersistedSession: () => '/test/config/_quick',
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

  describe('orphan detection', () => {
    function createServiceWithOrphanThrowingBaseDir(
      opts: { throwFor?: Set<string> } = {},
    ) {
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
        getPathResolverForPersistedSession: () => new SessionDataPathResolver('/test/config/_quick'),
        baseDirForPersistedSession: (persisted) => {
          if (opts.throwFor?.has(persisted.id)) {
            throw new InvalidSessionDataScopeError(
              `session ${persisted.id} has no persisted data scope`,
            );
          }
          return '/test/config/_quick';
        },
        getServerPid: () => TEST_SERVER_PID,
      });
      return { service };
    }

    it('marks sessions whose (scope, slug) cannot be resolved as orphaned', async () => {
      const session = buildPersistedQuickSession({
        id: 'orphan-candidate',
        locationPath: '/some/path',
        serverPid: null,
        pausedAt: '2024-01-01T01:00:00.000Z',
      });
      await sessionRepository.save(session);

      const { service } = createServiceWithOrphanThrowingBaseDir({
        throwFor: new Set(['orphan-candidate']),
      });
      await service.initialize();

      const persisted = await sessionRepository.findById('orphan-candidate');
      expect(persisted).not.toBeNull();
      expect(persisted!.recoveryState).toBe('orphaned');
      expect(persisted!.orphanedReason).toBe('path_resolution_failed');
      expect(persisted!.orphanedAt).toBeGreaterThan(0);
    });

    it('fragmentation report runs without throwing when directories are missing', async () => {
      // No _quick/outputs or outputs dirs exist in memfs; the report should
      // silently succeed rather than crashing startup.
      const session = buildPersistedQuickSession({
        id: 'healthy',
        locationPath: '/some/path',
      });
      await sessionRepository.save(session);

      const { service } = createServiceWithOrphanThrowingBaseDir();
      // If initialize() throws, this expect will fail. Reaching the assertion
      // demonstrates the fragmentation scan and orphan-detection steps both
      // completed without crashing.
      const autoResumeIds = await service.initialize();
      expect(Array.isArray(autoResumeIds)).toBe(true);
    });

    it('excludes orphaned sessions from auto-resume', async () => {
      // Seed an orphaned session with dead serverPid — would normally auto-resume.
      const session = buildPersistedQuickSession({
        id: 'orphaned-dead',
        locationPath: '/some/path',
        serverPid: 12345,
      });
      await sessionRepository.save(session);
      // Mark it orphaned directly in the DB so the detector's update is a no-op
      // for this session (the detector runs first and preserves the flag).
      await sessionRepository.update('orphaned-dead', {
        recoveryState: 'orphaned',
        orphanedAt: Date.now(),
        orphanedReason: 'path_resolution_failed',
      });
      // serverPid 12345 is dead (not marked alive).

      const { service } = createServiceWithOrphanThrowingBaseDir();
      const autoResumeIds = await service.initialize();

      expect(autoResumeIds).not.toContain('orphaned-dead');
    });
  });
});
