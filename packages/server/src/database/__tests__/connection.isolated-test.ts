/**
 * Database Connection Integration Tests
 *
 * This test file is named `.isolated-test.ts` instead of `.test.ts` intentionally.
 * It must be run SEPARATELY from other tests because:
 *
 * 1. Other tests (e.g., api.test.ts) use `mock.module` to mock the database connection
 * 2. Bun's mock.module is process-wide and cannot be undone
 * 3. When run together, these tests would use the mock instead of the real implementation
 *
 * To run these tests:
 *   bun test src/database/__tests__/connection.isolated-test.ts
 *
 * These tests verify the actual database initialization, migrations, and CRUD operations
 * using real SQLite database files in temporary directories.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as path from 'path';
import * as os from 'os';
import { sql } from 'kysely';
import { v4 as uuid } from 'uuid';
import {
  initializeDatabase,
  closeDatabase,
  getDatabase,
  databaseExists,
} from '../connection.js';

/**
 * Create a unique temporary directory using Bun native APIs.
 * This avoids interference with memfs mocks used in other tests.
 */
function createTempDir(): string {
  const tmpBase = os.tmpdir();
  const uniqueDir = path.join(tmpBase, `agent-console-db-test-${uuid()}`);
  // Use Bun's native shell to create directory
  Bun.spawnSync(['mkdir', '-p', uniqueDir]);
  return uniqueDir;
}

/**
 * Remove a directory recursively using Bun native APIs.
 */
function removeTempDir(dirPath: string): void {
  Bun.spawnSync(['rm', '-rf', dirPath]);
}

describe('database/connection', () => {
  let testDir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    // Close any existing database connection from previous tests
    // This is critical for test isolation when tests run in parallel
    await closeDatabase();

    // Create a unique test directory for each test using Bun native APIs
    // to avoid interference with memfs mocks in other tests
    testDir = createTempDir();
    originalEnv = process.env.AGENT_CONSOLE_HOME;
    process.env.AGENT_CONSOLE_HOME = testDir;
  });

  afterEach(async () => {
    await closeDatabase();
    process.env.AGENT_CONSOLE_HOME = originalEnv;
    // Clean up test directory using Bun native APIs
    removeTempDir(testDir);
  });

  describe('initializeDatabase', () => {
    test('creates database file and runs migrations', async () => {
      expect(await databaseExists()).toBe(false);

      const db = await initializeDatabase();
      expect(db).toBeDefined();
      expect(await databaseExists()).toBe(true);

      // Verify schema version is set (v2 includes repositories and agents tables)
      const result = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
      expect(result.rows[0]?.user_version).toBe(2);
    });

    test('creates sessions and workers tables', async () => {
      const db = await initializeDatabase();

      // Verify sessions table exists with correct columns
      const sessionColumns = await sql<{ name: string }>`
        PRAGMA table_info(sessions)
      `.execute(db);
      const sessionColumnNames = sessionColumns.rows.map((r) => r.name);
      expect(sessionColumnNames).toContain('id');
      expect(sessionColumnNames).toContain('type');
      expect(sessionColumnNames).toContain('location_path');
      expect(sessionColumnNames).toContain('server_pid');
      expect(sessionColumnNames).toContain('created_at');
      expect(sessionColumnNames).toContain('initial_prompt');
      expect(sessionColumnNames).toContain('title');
      expect(sessionColumnNames).toContain('repository_id');
      expect(sessionColumnNames).toContain('worktree_id');

      // Verify workers table exists with correct columns
      const workerColumns = await sql<{ name: string }>`
        PRAGMA table_info(workers)
      `.execute(db);
      const workerColumnNames = workerColumns.rows.map((r) => r.name);
      expect(workerColumnNames).toContain('id');
      expect(workerColumnNames).toContain('session_id');
      expect(workerColumnNames).toContain('type');
      expect(workerColumnNames).toContain('name');
      expect(workerColumnNames).toContain('created_at');
      expect(workerColumnNames).toContain('pid');
      expect(workerColumnNames).toContain('agent_id');
      expect(workerColumnNames).toContain('base_commit');
    });

    test('creates index on workers.session_id', async () => {
      const db = await initializeDatabase();

      const indexes = await sql<{ name: string }>`
        PRAGMA index_list(workers)
      `.execute(db);
      const indexNames = indexes.rows.map((r) => r.name);
      expect(indexNames).toContain('idx_workers_session_id');
    });

    test('is idempotent (can be called multiple times)', async () => {
      const db1 = await initializeDatabase();
      const db2 = await initializeDatabase();

      expect(db1).toBe(db2);
    });

    test('handles concurrent calls safely (mutex)', async () => {
      // Close any existing database first
      await closeDatabase();

      // Call initializeDatabase concurrently
      const [db1, db2, db3] = await Promise.all([
        initializeDatabase(),
        initializeDatabase(),
        initializeDatabase(),
      ]);

      // All should return the same instance
      expect(db1).toBe(db2);
      expect(db2).toBe(db3);

      // Verify database is functional
      const result = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db1);
      expect(result.rows[0]?.user_version).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getDatabase', () => {
    test('throws error when not initialized', () => {
      expect(() => getDatabase()).toThrow(
        'Database not initialized. Call initializeDatabase() first.'
      );
    });

    test('returns database after initialization', async () => {
      await initializeDatabase();
      const db = getDatabase();
      expect(db).toBeDefined();
    });
  });

  describe('closeDatabase', () => {
    test('closes the database connection', async () => {
      await initializeDatabase();
      await closeDatabase();

      // After closing, getDatabase should throw
      expect(() => getDatabase()).toThrow(
        'Database not initialized. Call initializeDatabase() first.'
      );
    });

    test('is idempotent (can be called when not initialized)', async () => {
      // Should not throw
      await closeDatabase();
    });
  });

  describe('databaseExists', () => {
    test('returns false when database does not exist', async () => {
      expect(await databaseExists()).toBe(false);
    });

    test('returns true after database is initialized', async () => {
      await initializeDatabase();
      expect(await databaseExists()).toBe(true);
    });
  });

  describe('CRUD operations', () => {
    test('can insert and query sessions', async () => {
      const db = await initializeDatabase();

      // Insert a session
      await db
        .insertInto('sessions')
        .values({
          id: 'test-session-1',
          type: 'quick',
          location_path: '/tmp/test',
          server_pid: 12345,
          created_at: new Date().toISOString(),
          initial_prompt: 'test prompt',
          title: 'Test Session',
          repository_id: null,
          worktree_id: null,
        })
        .execute();

      // Query the session
      const session = await db
        .selectFrom('sessions')
        .selectAll()
        .where('id', '=', 'test-session-1')
        .executeTakeFirst();

      expect(session).toBeDefined();
      expect(session?.type).toBe('quick');
      expect(session?.location_path).toBe('/tmp/test');
      expect(session?.title).toBe('Test Session');
    });

    test('can insert and query workers with foreign key', async () => {
      const db = await initializeDatabase();

      // Insert a session first
      const sessionId = 'test-session-2';
      await db
        .insertInto('sessions')
        .values({
          id: sessionId,
          type: 'worktree',
          location_path: '/tmp/test2',
          server_pid: 12345,
          created_at: new Date().toISOString(),
          initial_prompt: null,
          title: null,
          repository_id: 'repo-1',
          worktree_id: 'wt-1',
        })
        .execute();

      // Insert a worker
      await db
        .insertInto('workers')
        .values({
          id: 'worker-1',
          session_id: sessionId,
          type: 'agent',
          name: 'Claude',
          created_at: new Date().toISOString(),
          pid: 54321,
          agent_id: 'claude-code-builtin',
          base_commit: null,
        })
        .execute();

      // Query the worker
      const worker = await db
        .selectFrom('workers')
        .selectAll()
        .where('id', '=', 'worker-1')
        .executeTakeFirst();

      expect(worker).toBeDefined();
      expect(worker?.session_id).toBe(sessionId);
      expect(worker?.type).toBe('agent');
      expect(worker?.agent_id).toBe('claude-code-builtin');
    });

    test('cascade deletes workers when session is deleted', async () => {
      const db = await initializeDatabase();

      // Insert a session
      const sessionId = 'test-session-3';
      await db
        .insertInto('sessions')
        .values({
          id: sessionId,
          type: 'quick',
          location_path: '/tmp/test3',
          server_pid: 12345,
          created_at: new Date().toISOString(),
          initial_prompt: null,
          title: null,
          repository_id: null,
          worktree_id: null,
        })
        .execute();

      // Insert a worker
      await db
        .insertInto('workers')
        .values({
          id: 'worker-2',
          session_id: sessionId,
          type: 'terminal',
          name: 'Terminal',
          created_at: new Date().toISOString(),
          pid: null,
          agent_id: null,
          base_commit: null,
        })
        .execute();

      // Delete the session
      await db.deleteFrom('sessions').where('id', '=', sessionId).execute();

      // Verify worker is also deleted
      const worker = await db
        .selectFrom('workers')
        .selectAll()
        .where('id', '=', 'worker-2')
        .executeTakeFirst();

      expect(worker).toBeUndefined();
    });
  });
});
