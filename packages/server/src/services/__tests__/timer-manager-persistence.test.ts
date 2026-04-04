import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { Kysely } from 'kysely';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteTimerRepository } from '../../repositories/sqlite-timer-repository.js';
import { TimerManager } from '../timer-manager.js';

describe('TimerManager with persistence', () => {
  let db: Kysely<Database>;
  let repository: SqliteTimerRepository;
  let manager: TimerManager;
  let onTick: ReturnType<typeof mock>;

  beforeEach(async () => {
    db = await createDatabaseForTest();
    repository = new SqliteTimerRepository(db);
    onTick = mock(() => {});
    manager = new TimerManager(onTick, repository);
  });

  afterEach(async () => {
    manager.disposeAll();
    await db.destroy();
  });

  /** Let fire-and-forget persistence promises settle. */
  const flush = () => new Promise((r) => setTimeout(r, 10));

  describe('create persists to database', () => {
    it('should persist timer to database on create', async () => {
      const timer = manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 60,
        action: 'check status',
      });

      await flush();

      const records = await repository.findAll();
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe(timer.id);
      expect(records[0].sessionId).toBe('session-1');
      expect(records[0].workerId).toBe('worker-1');
      expect(records[0].intervalSeconds).toBe(60);
      expect(records[0].action).toBe('check status');
      expect(records[0].createdAt).toBe(timer.createdAt);
    });
  });

  describe('delete removes from database', () => {
    it('should remove timer from database on delete', async () => {
      const timer = manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 60,
        action: 'check status',
      });

      await flush();

      manager.deleteTimer(timer.id);

      await flush();

      const records = await repository.findAll();
      expect(records).toHaveLength(0);
    });

    it('should remove all session timers from database on deleteTimersBySession', async () => {
      manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 60,
        action: 'action 1',
      });
      manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-2',
        intervalSeconds: 120,
        action: 'action 2',
      });

      await flush();

      manager.deleteTimersBySession('session-1');

      await flush();

      const records = await repository.findAll();
      expect(records).toHaveLength(0);
    });
  });

  describe('restoreTimers', () => {
    it('should recreate timers from database', async () => {
      const timer = manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 60,
        action: 'check status',
      });

      await flush();

      // Dispose manager1 without clearing DB
      manager.disposeAll();

      // Create a new manager with the same repository
      const onTick2 = mock(() => {});
      const manager2 = new TimerManager(onTick2, repository);

      try {
        const restoredCount = await manager2.restoreTimers();
        expect(restoredCount).toBe(1);

        const timers = manager2.listTimers();
        expect(timers).toHaveLength(1);
        expect(timers[0].id).toBe(timer.id);
        expect(timers[0].sessionId).toBe('session-1');
        expect(timers[0].workerId).toBe('worker-1');
        expect(timers[0].intervalSeconds).toBe(60);
        expect(timers[0].action).toBe('check status');
        expect(timers[0].fireCount).toBe(0);
      } finally {
        manager2.disposeAll();
      }
    });

    it('should return count of restored timers', async () => {
      manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-1',
        intervalSeconds: 60,
        action: 'action 1',
      });
      manager.createTimer({
        sessionId: 'session-1',
        workerId: 'worker-2',
        intervalSeconds: 120,
        action: 'action 2',
      });

      await flush();

      manager.disposeAll();

      const onTick2 = mock(() => {});
      const manager2 = new TimerManager(onTick2, repository);

      try {
        const restoredCount = await manager2.restoreTimers();
        expect(restoredCount).toBe(2);
      } finally {
        manager2.disposeAll();
      }
    });

    it('should return 0 with empty database', async () => {
      const onTick2 = mock(() => {});
      const manager2 = new TimerManager(onTick2, repository);

      try {
        const restoredCount = await manager2.restoreTimers();
        expect(restoredCount).toBe(0);
      } finally {
        manager2.disposeAll();
      }
    });
  });

  describe('graceful fallback', () => {
    it('should work without repository', () => {
      const noRepoManager = new TimerManager(onTick);

      try {
        const timer = noRepoManager.createTimer({
          sessionId: 'session-1',
          workerId: 'worker-1',
          intervalSeconds: 60,
          action: 'volatile action',
        });

        const timers = noRepoManager.listTimers();
        expect(timers).toHaveLength(1);
        expect(timers[0].id).toBe(timer.id);

        const deleted = noRepoManager.deleteTimer(timer.id);
        expect(deleted).toBe(true);

        expect(noRepoManager.listTimers()).toHaveLength(0);
      } finally {
        noRepoManager.disposeAll();
      }
    });

    it('should return 0 from restoreTimers without repository', async () => {
      const noRepoManager = new TimerManager(onTick);

      try {
        const count = await noRepoManager.restoreTimers();
        expect(count).toBe(0);
      } finally {
        noRepoManager.disposeAll();
      }
    });
  });
});
