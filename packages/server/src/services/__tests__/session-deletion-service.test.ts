import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import type { Kysely } from 'kysely';
import { SessionDeletionService, type SessionDeletionDeps } from '../session-deletion-service.js';
import type { InternalSession } from '../internal-types.js';
import { SessionDataPathResolver } from '../../lib/session-data-path-resolver.js';
import type { WorkerManager } from '../worker-manager.js';
import { JobQueue as RealJobQueue, JOB_TYPES, type JobQueue } from '../../jobs/index.js';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteSessionRepository } from '../../repositories/sqlite-session-repository.js';
import { rootLogger } from '../../lib/logger.js';
import type { NotificationManager } from '../notifications/notification-manager.js';
import type { MessageService } from '../message-service.js';
import type { InterSessionMessageService } from '../inter-session-message-service.js';
import type { MemoService } from '../memo-service.js';
import type { sweepOrphanProcesses } from '../orphan-process-sweeper.js';
import {
  buildInternalAgentWorker,
  buildInternalTerminalWorker,
  buildInternalGitDiffWorker,
  buildInternalEmbeddedAgentWorker,
  buildInternalWorktreeSession,
  buildPersistedWorktreeSession,
} from '../../__tests__/utils/build-test-data.js';

const mockStopWatching = mock(() => {});

type SweepFn = typeof sweepOrphanProcesses;

// Default sweep stub: keeps every test off the real `/proc` scan.
function createSweepStub(killedCount = 0): ReturnType<typeof mock<SweepFn>> {
  return mock<SweepFn>(async () => ({
    killedCount,
    raw: { stdout: `SWEPT=${killedCount}\n`, stderr: '', exitCode: 0, timedOut: false },
  }));
}

// WorkerManager / JobQueue / NotificationManager / MessageService /
// InterSessionMessageService / MemoService are concrete classes with
// private fields, so a plain object implementing only the methods a test
// actually exercises cannot satisfy the class type structurally. Each
// helper types its parameter as `Partial<X>`, so every provided method
// name and signature is checked against the real class (a stale or
// misspelled method name is a compile error), and performs exactly one
// assertion inside the helper body to bridge the private-member gap --
// instead of a two-step `unknown`-then-X bypass at every call site, which
// skips both checks.
function asWorkerManager(stub: Partial<WorkerManager>): WorkerManager {
  return stub as WorkerManager;
}

function asJobQueue(stub: Partial<JobQueue>): JobQueue {
  return stub as JobQueue;
}

function asNotificationManager(stub: Partial<NotificationManager>): NotificationManager {
  return stub as NotificationManager;
}

function asMessageService(stub: Partial<MessageService>): MessageService {
  return stub as MessageService;
}

function asInterSessionMessageService(
  stub: Partial<InterSessionMessageService>,
): InterSessionMessageService {
  return stub as InterSessionMessageService;
}

function asMemoService(stub: Partial<MemoService>): MemoService {
  return stub as MemoService;
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
    workerManager: asWorkerManager({
      killWorker: mock(async () => {}),
    }),
    jobQueue: asJobQueue({
      enqueue: mock(async () => 'job-id'),
    }),
    notificationManager: asNotificationManager({
      cleanupSession: mock(() => {}),
    }),
    messageService: asMessageService({
      clearSession: mock(() => {}),
    }),
    interSessionMessageService: asInterSessionMessageService({
      deleteSessionMessages: mock(async () => {}),
    }),
    memoService: asMemoService({
      deleteMemo: mock(async () => {}),
    }),
    getPathResolverForSession: () => new SessionDataPathResolver('/test/config/repositories/test-repo', '/test/config'),
    getPathResolverForPersistedSession: () => new SessionDataPathResolver('/test/config/repositories/test-repo', '/test/config'),
    getSessionScope: () => ({ scope: 'repository', slug: 'test-repo' }),
    getPersistedSessionScope: () => ({ scope: 'repository', slug: 'test-repo' }),
    getSessionLifecycleCallbacks: () => undefined,
    getWebSocketCallbacks: () => null,
    getTimerCleanupCallback: () => undefined,
    getConditionalWakeupCleanupCallback: () => undefined,
    getProcessCleanupCallback: () => undefined,
    stopWatching: mockStopWatching,
    stopBranchWatching: () => {},
    deactivateEmbeddedAgentWorker: mock(async () => {}),
    resolveSpawnUsername: async () => 'target-user',
    sweepOrphanProcessesImpl: createSweepStub(),
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

    it('should deactivate embedded-agent workers instead of killWorker (polarity guard)', async () => {
      const embeddedWorker = buildInternalEmbeddedAgentWorker({ id: 'w-emb' });
      const session = buildInternalWorktreeSession([embeddedWorker]);

      const deactivateEmbeddedAgentWorker = mock(async () => {});
      const deps = createMockDeps({
        getSession: () => session,
        deactivateEmbeddedAgentWorker,
      });
      const service = new SessionDeletionService(deps);

      await service.killSessionWorkers(session.id);

      // killWorker no-ops on embedded-agent workers (not PTY-backed), so the
      // subprocess would leak without this branch.
      expect(deactivateEmbeddedAgentWorker).toHaveBeenCalledWith(session.id, 'w-emb');
      expect(deps.workerManager.killWorker).not.toHaveBeenCalled();
    });
  });

  describe('deleteSession', () => {
    describe('orphan-process sweep', () => {
      it('sweeps once with the session id and resolved username, after the worker kills', async () => {
        const order: string[] = [];
        const session = buildInternalWorktreeSession([buildInternalAgentWorker({ id: 'w1' })]);
        const sweep = mock<SweepFn>(async (sessionId, username) => {
          order.push(`sweep:${sessionId}:${username}`);
          return { killedCount: 0, raw: { stdout: 'SWEPT=0\n', stderr: '', exitCode: 0, timedOut: false } };
        });
        const deps = createMockDeps({
          getSession: (id) => (id === 'session-1' ? session : undefined),
          workerManager: asWorkerManager({
            killWorker: mock(async () => {
              order.push('kill');
            }),
          }),
          resolveSpawnUsername: async (createdBy) => `resolved-for-${createdBy}`,
          sweepOrphanProcessesImpl: sweep,
        });

        const result = await new SessionDeletionService(deps).deleteSession('session-1');

        expect(result).toBe(true);
        expect(sweep).toHaveBeenCalledTimes(1);
        expect(order).toEqual(['kill', `sweep:session-1:resolved-for-${session.createdBy}`]);
      });

      it('does not fail the delete when the sweep rejects', async () => {
        const session = buildInternalWorktreeSession([buildInternalAgentWorker({ id: 'w1' })]);
        const deps = createMockDeps({
          getSession: (id) => (id === 'session-1' ? session : undefined),
          sweepOrphanProcessesImpl: mock<SweepFn>(async () => {
            throw new Error('sweep exploded');
          }),
        });

        expect(await new SessionDeletionService(deps).deleteSession('session-1')).toBe(true);
      });

      it('does not fail the delete when the sweep reports a non-success result', async () => {
        const session = buildInternalWorktreeSession([buildInternalAgentWorker({ id: 'w1' })]);
        const deps = createMockDeps({
          getSession: (id) => (id === 'session-1' ? session : undefined),
          sweepOrphanProcessesImpl: mock<SweepFn>(async () => ({
            killedCount: 0,
            raw: { stdout: '', stderr: 'boom', exitCode: 1, timedOut: true },
          })),
        });

        expect(await new SessionDeletionService(deps).deleteSession('session-1')).toBe(true);
      });

      it('does not fail the delete when resolving the spawn username throws', async () => {
        const session = buildInternalWorktreeSession([buildInternalAgentWorker({ id: 'w1' })]);
        const sweep = createSweepStub();
        const deps = createMockDeps({
          getSession: (id) => (id === 'session-1' ? session : undefined),
          resolveSpawnUsername: async () => {
            throw new Error('no such user');
          },
          sweepOrphanProcessesImpl: sweep,
        });

        expect(await new SessionDeletionService(deps).deleteSession('session-1')).toBe(true);
        expect(sweep).not.toHaveBeenCalled();
      });
    });

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
      const enqueueMock = mock<JobQueue['enqueue']>(async () => 'job-id');

      const deps = createMockDeps({
        getSession: (id) => id === 'session-1' ? session : undefined,
        getSessionLifecycleCallbacks: () => ({ onSessionDeleted }),
        getWebSocketCallbacks: () => ({ notifySessionDeleted }),
        jobQueue: asJobQueue({ enqueue: enqueueMock }),
      });
      const service = new SessionDeletionService(deps);

      const result = await service.deleteSession('session-1');

      // Cleanup job payload uses {scope, slug} — not the legacy `repositoryName`.
      const enqueueCall = enqueueMock.mock.calls[0];
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

    it('should call conditional wakeup cleanup callback if set', async () => {
      const session = buildInternalWorktreeSession();
      const conditionalWakeupCleanup = mock(() => {});

      const deps = createMockDeps({
        getSession: () => session,
        getConditionalWakeupCleanupCallback: () => conditionalWakeupCleanup,
      });
      const service = new SessionDeletionService(deps);

      await service.deleteSession('session-1');

      expect(conditionalWakeupCleanup).toHaveBeenCalledWith('session-1');
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
        interSessionMessageService: asInterSessionMessageService({
          deleteSessionMessages: mock(async () => { throw new Error('cleanup error'); }),
        }),
      });
      const service = new SessionDeletionService(deps);

      const result = await service.deleteSession('session-1');
      expect(result).toBe(true);
    });

    it('should not fail if memo cleanup throws', async () => {
      const session = buildInternalWorktreeSession();

      const deps = createMockDeps({
        getSession: () => session,
        memoService: asMemoService({
          deleteMemo: mock(async () => { throw new Error('memo error'); }),
        }),
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
        memoService: asMemoService({
          deleteMemo: mock(async () => { throw new Error('memo error'); }),
        }),
      });
      const service = new SessionDeletionService(deps);

      const result = await service.forceDeleteSession('orphan-1');
      expect(result).toBe(true);
    });
  });
});

describe('SessionDeletionService delete transaction (real DB, real JobQueue)', () => {
  let db: Kysely<Database>;
  let sessionRepository: SqliteSessionRepository;
  let jobQueue: RealJobQueue;
  let memory: Map<string, InternalSession>;

  // A statement issued on the shared connection from inside an open
  // transaction body never completes (single connection behind a mutex), so a
  // dropped executor shows up as 'hung' here instead of a failure message.
  const settle = <T>(p: Promise<T>): Promise<T | 'hung'> =>
    Promise.race([
      p,
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3000)),
    ]);

  beforeEach(async () => {
    db = await createDatabaseForTest();
    sessionRepository = new SqliteSessionRepository(db);
    jobQueue = new RealJobQueue(db);
    memory = new Map();
  });

  afterEach(async () => {
    // A dropped executor leaves the transaction open, and destroy() would wait on
    // it forever (bun cannot interrupt a never-settling await), hanging the run
    // instead of failing the test; bound it.
    await Promise.race([db.destroy(), new Promise((resolve) => setTimeout(resolve, 1000))]);
  });

  function createService(options: { withDb: boolean }) {
    return new SessionDeletionService(createMockDeps({
      getSession: (id) => memory.get(id),
      setSession: (id, session) => memory.set(id, session),
      deleteSessionFromMemory: (id) => memory.delete(id),
      sessionRepository,
      jobQueue,
      db: options.withDb ? db : null,
    }));
  }

  async function seedSession(id: string, opts: { inMemory: boolean }): Promise<void> {
    await sessionRepository.save(buildPersistedWorktreeSession({ id }));
    if (opts.inMemory) {
      memory.set(id, buildInternalWorktreeSession([], { id }));
    }
  }

  async function jobTypes(): Promise<string[]> {
    const rows = await db.selectFrom('jobs').select('type').execute();
    return rows.map((r) => r.type);
  }

  function recordDeleteAndWake(): string[] {
    const events: string[] = [];
    const realDelete = sessionRepository.delete.bind(sessionRepository);
    spyOn(sessionRepository, 'delete').mockImplementation(async (id, executor) => {
      await realDelete(id, executor);
      events.push('delete-resolved');
    });
    spyOn(jobQueue, 'wake').mockImplementation(() => { events.push('wake'); });
    return events;
  }

  describe('deleteSession', () => {
    it('deletes the row and enqueues exactly one cleanup job, waking the queue once after the delete', async () => {
      await seedSession('s-ok', { inMemory: true });
      const events = recordDeleteAndWake();

      expect(await settle(createService({ withDb: true }).deleteSession('s-ok'))).toBe(true);

      expect(await sessionRepository.findById('s-ok')).toBeNull();
      expect(await jobTypes()).toEqual([JOB_TYPES.CLEANUP_SESSION_OUTPUTS]);
      // An enqueue on a transaction emits nothing itself, so the single wake is
      // the post-commit one.
      expect(events).toEqual(['delete-resolved', 'wake']);
    });

    it('rolls the cleanup job back and restores the session in memory when the row delete fails', async () => {
      await seedSession('s-fail', { inMemory: true });
      spyOn(sessionRepository, 'delete').mockRejectedValue(new Error('injected delete failure'));

      await expect(createService({ withDb: true }).deleteSession('s-fail')).rejects.toThrow('injected delete failure');

      expect(await sessionRepository.findById('s-fail')).not.toBeNull();
      expect(memory.has('s-fail')).toBe(true);
      expect(await jobTypes()).toEqual([]);
    });

    it('without an injected database falls back to the two separate writes and warns once', async () => {
      await seedSession('s-no-db', { inMemory: true });
      const warnSpy = spyOn(rootLogger, 'warn');
      try {
        await createService({ withDb: false }).deleteSession('s-no-db');

        expect(await sessionRepository.findById('s-no-db')).toBeNull();
        expect(await jobTypes()).toEqual([JOB_TYPES.CLEANUP_SESSION_OUTPUTS]);
        const fallbackWarns = warnSpy.mock.calls.filter((call) => JSON.stringify(call).includes('not atomic'));
        expect(fallbackWarns).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('forceDeleteSession (orphaned: persisted only)', () => {
    it('deletes the row and enqueues exactly one cleanup job, waking the queue once after the delete', async () => {
      await seedSession('o-ok', { inMemory: false });
      const events = recordDeleteAndWake();

      expect(await settle(createService({ withDb: true }).forceDeleteSession('o-ok'))).toBe(true);

      expect(await sessionRepository.findById('o-ok')).toBeNull();
      expect(await jobTypes()).toEqual([JOB_TYPES.CLEANUP_SESSION_OUTPUTS]);
      expect(events).toEqual(['delete-resolved', 'wake']);
    });

    it('rolls the cleanup job back when the row delete fails', async () => {
      await seedSession('o-fail', { inMemory: false });
      spyOn(sessionRepository, 'delete').mockRejectedValue(new Error('injected delete failure'));

      await expect(createService({ withDb: true }).forceDeleteSession('o-fail')).rejects.toThrow('injected delete failure');

      expect(await sessionRepository.findById('o-fail')).not.toBeNull();
      expect(await jobTypes()).toEqual([]);
    });

    it('without an injected database falls back to the two separate writes and warns once', async () => {
      await seedSession('o-no-db', { inMemory: false });
      const warnSpy = spyOn(rootLogger, 'warn');
      try {
        await createService({ withDb: false }).forceDeleteSession('o-no-db');

        expect(await sessionRepository.findById('o-no-db')).toBeNull();
        expect(await jobTypes()).toEqual([JOB_TYPES.CLEANUP_SESSION_OUTPUTS]);
        const fallbackWarns = warnSpy.mock.calls.filter((call) => JSON.stringify(call).includes('not atomic'));
        expect(fallbackWarns).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
