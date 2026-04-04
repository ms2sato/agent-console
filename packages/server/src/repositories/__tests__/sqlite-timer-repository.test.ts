import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Kysely } from 'kysely';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteTimerRepository } from '../sqlite-timer-repository.js';
import type { TimerRecord } from '../timer-repository.js';

describe('SqliteTimerRepository', () => {
  let db: Kysely<Database>;
  let repository: SqliteTimerRepository;

  beforeEach(async () => {
    db = await createDatabaseForTest();
    repository = new SqliteTimerRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  function createRecord(overrides?: Partial<TimerRecord>): TimerRecord {
    return {
      id: crypto.randomUUID(),
      sessionId: 'session-1',
      workerId: 'worker-1',
      intervalSeconds: 60,
      action: 'check status',
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  describe('save and findAll', () => {
    it('should save a record and retrieve it with findAll', async () => {
      const record = createRecord();

      await repository.save(record);

      const results = await repository.findAll();
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(record.id);
      expect(results[0].sessionId).toBe(record.sessionId);
      expect(results[0].workerId).toBe(record.workerId);
      expect(results[0].intervalSeconds).toBe(record.intervalSeconds);
      expect(results[0].action).toBe(record.action);
      expect(results[0].createdAt).toBe(record.createdAt);
    });

    it('should save multiple records and retrieve all', async () => {
      const record1 = createRecord({ id: 'timer-1' });
      const record2 = createRecord({ id: 'timer-2', sessionId: 'session-2' });

      await repository.save(record1);
      await repository.save(record2);

      const results = await repository.findAll();
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.id).sort()).toEqual(['timer-1', 'timer-2']);
    });
  });

  describe('delete', () => {
    it('should delete a record by id', async () => {
      const record = createRecord();
      await repository.save(record);

      await repository.delete(record.id);

      const results = await repository.findAll();
      expect(results).toHaveLength(0);
    });

    it('should not throw when deleting non-existent id', async () => {
      await repository.delete('non-existent');
      // No error thrown
    });
  });

  describe('deleteBySessionId', () => {
    it('should delete all timers for a session and return count', async () => {
      const record1 = createRecord({ id: 'timer-1', sessionId: 'session-1' });
      const record2 = createRecord({ id: 'timer-2', sessionId: 'session-1' });
      const record3 = createRecord({ id: 'timer-3', sessionId: 'session-2' });

      await repository.save(record1);
      await repository.save(record2);
      await repository.save(record3);

      const deletedCount = await repository.deleteBySessionId('session-1');
      expect(deletedCount).toBe(2);

      const remaining = await repository.findAll();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].sessionId).toBe('session-2');
    });

    it('should return 0 when no timers match the session', async () => {
      const count = await repository.deleteBySessionId('non-existent-session');
      expect(count).toBe(0);
    });
  });

  describe('findAll', () => {
    it('should return empty array on fresh database', async () => {
      const results = await repository.findAll();
      expect(results).toEqual([]);
    });
  });
});
