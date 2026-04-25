/**
 * Migration v19 tests — sessions.created_by FK constraint addition.
 *
 * Strategy:
 *   - `adds FK constraint to created_by` test exercises the real production path
 *     via `initializeDatabase(':memory:')`.
 *   - FK behavior tests construct a v18-shaped schema directly against a raw
 *     Bun SQLite instance, seed it with users and sessions, then invoke the
 *     production `migrateToV19` directly. This ensures tests run against the
 *     real migration code with no risk of drift between a test-local copy and
 *     the production implementation.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { sql, Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import * as fsPromises from 'fs/promises';
import type { Database } from '../schema.js';
import {
  initializeDatabase,
  closeDatabase,
  migrateToV19,
  backupDatabaseFile,
} from '../connection.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';

const TEST_CONFIG_DIR = '/test/config';

interface SeedUser {
  id: string;
  os_uid: number | null;
  username: string;
  home_dir: string;
}

interface SeedSession {
  id: string;
  type: 'worktree' | 'quick';
  location_path: string;
  repository_id: string | null;
  worktree_id: string | null;
  created_by: string | null;
}

/**
 * Build a v18-shaped database seeded with the caller's rows.
 * Creates the users and sessions tables with v18 schema (no FK constraint on
 * created_by). Only the tables required by the v19 migration are created;
 * dependent tables not referenced by `migrateToV19` (e.g. `repositories`,
 * `worktrees`, `workers`) are intentionally omitted to keep the seed minimal.
 */
async function seedV18Database(options: {
  users: SeedUser[];
  sessions: SeedSession[];
}): Promise<Kysely<Database>> {
  const bunDb = new BunDatabase(':memory:');
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: bunDb }),
  });

  await sql`PRAGMA foreign_keys = ON`.execute(db);

  // Create v18 schema: users table and sessions table WITHOUT FK constraint on created_by
  bunDb.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      os_uid INTEGER,
      username TEXT NOT NULL,
      home_dir TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_users_os_uid ON users(os_uid) WHERE os_uid IS NOT NULL;

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      location_path TEXT NOT NULL,
      server_pid INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      initial_prompt TEXT,
      title TEXT,
      repository_id TEXT,
      worktree_id TEXT,
      paused_at TEXT,
      parent_session_id TEXT,
      parent_worker_id TEXT,
      created_by TEXT,
      data_scope TEXT,
      data_scope_slug TEXT,
      recovery_state TEXT NOT NULL DEFAULT 'healthy',
      orphaned_at INTEGER,
      orphaned_reason TEXT
    );

    PRAGMA user_version = 18;
  `);

  // Insert test data
  const insertUser = bunDb.prepare(
    `INSERT INTO users (id, os_uid, username, home_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
  );
  for (const user of options.users) {
    insertUser.run(user.id, user.os_uid, user.username, user.home_dir);
  }

  const insertSess = bunDb.prepare(
    `INSERT INTO sessions (id, type, location_path, repository_id, worktree_id, created_by,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
  );
  for (const sess of options.sessions) {
    insertSess.run(
      sess.id,
      sess.type,
      sess.location_path,
      sess.repository_id,
      sess.worktree_id,
      sess.created_by
    );
  }

  return db;
}

describe('migration v19 (sessions.created_by FK constraint)', () => {
  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
  });

  afterEach(async () => {
    await closeDatabase();
    cleanupMemfs();
  });

  it('adds FK constraint to created_by column', async () => {
    // Exercise the real production migration path end-to-end.
    const db = await initializeDatabase(':memory:');

    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(19);

    // Verify FK constraint exists by checking sqlite_master
    const fkInfo = await sql<{ sql: string }>`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'sessions'
    `.execute(db);

    const createTableSql = fkInfo.rows[0]?.sql ?? '';
    expect(createTableSql).toContain('REFERENCES users(id)');
    expect(createTableSql).toContain('ON DELETE SET NULL');
  });

  it('preserves dependent FK references on the workers table', async () => {
    // Regression: SQLite ≥ 3.25 rewrites FK declarations in dependent tables
    // when ALTER TABLE RENAME affects the referenced table. The original v19
    // migration used "RENAME sessions TO sessions_old" which silently rewrote
    // workers.session_id to point at sessions_old; after we then dropped
    // sessions_old, the workers FK was dangling and any DELETE on workers
    // raised "no such table: main.sessions_old" on SQLite ≥ 3.25 (e.g. CI).
    // The migration now uses the inverse pattern (create sessions_new, copy,
    // drop sessions, rename sessions_new to sessions) to keep dependent FK
    // references pointing at `sessions`.
    const db = await initializeDatabase(':memory:');

    const fkRows = await sql<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
    }>`PRAGMA foreign_key_list(workers)`.execute(db);

    const sessionFk = fkRows.rows.find((row) => row.from === 'session_id');
    expect(sessionFk).toBeDefined();
    expect(sessionFk!.table).toBe('sessions');

    // Sanity: a DELETE that engages the FK (workers references sessions)
    // must not throw. Pre-fix this raised "no such table: main.sessions_old".
    await db
      .deleteFrom('workers')
      .where('session_id', '=', 'no-such-session')
      .execute();
  });

  it('preserves existing session data during table recreation', async () => {
    const testUsers = [
      { id: 'user-1', os_uid: 1001, username: 'alice', home_dir: '/home/alice' },
      { id: 'user-2', os_uid: null, username: 'bob', home_dir: '/home/bob' },
    ];

    const testSessions = [
      {
        id: 'sess-1',
        type: 'worktree' as const,
        location_path: '/tmp/repo1',
        repository_id: null,
        worktree_id: null,
        created_by: 'user-1',
      },
      {
        id: 'sess-2',
        type: 'quick' as const,
        location_path: '/tmp/quick',
        repository_id: null,
        worktree_id: null,
        created_by: null, // pre-v14 session
      },
    ];

    const db = await seedV18Database({
      users: testUsers,
      sessions: testSessions,
    });

    await migrateToV19(db);

    // Verify all data preserved
    const sessions = await db
      .selectFrom('sessions')
      .selectAll()
      .orderBy('id')
      .execute();

    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe('sess-1');
    expect(sessions[0].created_by).toBe('user-1');
    expect(sessions[0].location_path).toBe('/tmp/repo1');

    expect(sessions[1].id).toBe('sess-2');
    expect(sessions[1].created_by).toBeNull(); // pre-v14 NULL preserved
    expect(sessions[1].location_path).toBe('/tmp/quick');

    await db.destroy();
  });

  it('enforces FK constraint: user deletion sets sessions.created_by to NULL', async () => {
    const testUsers = [
      { id: 'user-to-delete', os_uid: 1001, username: 'temp', home_dir: '/home/temp' },
    ];

    const testSessions = [
      {
        id: 'sess-orphan',
        type: 'worktree' as const,
        location_path: '/tmp/will-orphan',
        repository_id: null,
        worktree_id: null,
        created_by: 'user-to-delete',
      },
    ];

    const db = await seedV18Database({
      users: testUsers,
      sessions: testSessions,
    });

    await migrateToV19(db);

    // Verify session references user before deletion
    let session = await db
      .selectFrom('sessions')
      .select(['id', 'created_by'])
      .where('id', '=', 'sess-orphan')
      .executeTakeFirstOrThrow();
    expect(session.created_by).toBe('user-to-delete');

    // Delete the user
    await db
      .deleteFrom('users')
      .where('id', '=', 'user-to-delete')
      .execute();

    // Verify session.created_by was set to NULL by FK constraint
    session = await db
      .selectFrom('sessions')
      .select(['id', 'created_by'])
      .where('id', '=', 'sess-orphan')
      .executeTakeFirstOrThrow();
    expect(session.created_by).toBeNull();

    await db.destroy();
  });

  it('preserves existing indexes and triggers during table recreation', async () => {
    const db = await seedV18Database({
      users: [],
      sessions: [],
    });

    // Add a test index to sessions table
    await sql`CREATE INDEX test_sessions_type_idx ON sessions(type)`.execute(db);

    // Get all indexes/triggers before migration
    const beforeObjects = await sql<{
      type: string;
      name: string;
      sql: string | null;
    }>`
      SELECT type, name, sql
      FROM sqlite_master
      WHERE tbl_name = 'sessions' AND type IN ('index', 'trigger')
      AND name NOT LIKE 'sqlite_autoindex%'
    `.execute(db);

    await migrateToV19(db);

    // Get all indexes/triggers after migration
    const afterObjects = await sql<{
      type: string;
      name: string;
      sql: string | null;
    }>`
      SELECT type, name, sql
      FROM sqlite_master
      WHERE tbl_name = 'sessions' AND type IN ('index', 'trigger')
      AND name NOT LIKE 'sqlite_autoindex%'
    `.execute(db);

    // Verify all non-automatic indexes/triggers are preserved with identical
    // DDL. A simple length comparison would miss cases where an object was
    // recreated under the same name but with a different definition; matching
    // by name and asserting `sql` equality catches such drift.
    expect(afterObjects.rows).toHaveLength(beforeObjects.rows.length);

    const beforeByName = new Map(beforeObjects.rows.map((row) => [row.name, row]));
    for (const after of afterObjects.rows) {
      const before = beforeByName.get(after.name);
      expect(before).toBeDefined();
      expect(after.type).toBe(before!.type);
      expect(after.sql).toBe(before!.sql);
    }

    const afterNames = afterObjects.rows.map(r => r.name);
    expect(afterNames).toContain('test_sessions_type_idx');

    await db.destroy();
  });

  it('migration is idempotent: running twice has no effect', async () => {
    const testUsers = [
      { id: 'user-1', os_uid: 1001, username: 'alice', home_dir: '/home/alice' },
    ];

    const testSessions = [
      {
        id: 'sess-1',
        type: 'worktree' as const,
        location_path: '/tmp/repo1',
        repository_id: null,
        worktree_id: null,
        created_by: 'user-1',
      },
    ];

    const db = await seedV18Database({
      users: testUsers,
      sessions: testSessions,
    });

    // Run migration twice
    await migrateToV19(db);
    await migrateToV19(db);

    // Verify schema version is correct
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(19);

    // Verify data is still intact
    const sessions = await db.selectFrom('sessions').selectAll().execute();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('sess-1');
    expect(sessions[0].created_by).toBe('user-1');

    // Re-verify FK behavior is still active after the second (no-op) run.
    // The idempotency guard must not silently drop the FK constraint.
    await db
      .deleteFrom('users')
      .where('id', '=', 'user-1')
      .execute();
    const afterDelete = await db
      .selectFrom('sessions')
      .select(['id', 'created_by'])
      .where('id', '=', 'sess-1')
      .executeTakeFirstOrThrow();
    expect(afterDelete.created_by).toBeNull();

    await db.destroy();
  });

  it('handles sessions with NULL created_by (pre-v14 compatibility)', async () => {
    const testUsers = [
      { id: 'user-1', os_uid: 1001, username: 'alice', home_dir: '/home/alice' },
    ];

    const testSessions = [
      {
        id: 'sess-old',
        type: 'quick' as const,
        location_path: '/tmp/old',
        repository_id: null,
        worktree_id: null,
        created_by: null, // pre-v14 session
      },
      {
        id: 'sess-new',
        type: 'worktree' as const,
        location_path: '/tmp/new',
        repository_id: null,
        worktree_id: null,
        created_by: 'user-1', // post-v14 session
      },
    ];

    const db = await seedV18Database({
      users: testUsers,
      sessions: testSessions,
    });

    await migrateToV19(db);

    const sessions = await db
      .selectFrom('sessions')
      .selectAll()
      .orderBy('id')
      .execute();

    expect(sessions).toHaveLength(2);

    // Pre-v14 session keeps NULL created_by
    expect(sessions[0].id).toBe('sess-new');
    expect(sessions[0].created_by).toBe('user-1');

    expect(sessions[1].id).toBe('sess-old');
    expect(sessions[1].created_by).toBeNull();

    await db.destroy();
  });

  describe('pre-flight database backup', () => {
    /**
     * The migration-v19 backup logic copies the SQLite file via
     * `fs.promises.copyFile`. The test file already mocks `fs/promises` via
     * memfs, so:
     *   - Pre-seeding a memfs file at `dbPath` lets us assert `copyFile`
     *     was actually invoked and produced a sibling file with the same
     *     bytes.
     *   - The Kysely database used to drive the migration is independent
     *     of that memfs file (Bun's native SQLite cannot read memfs paths),
     *     which is fine: backup correctness and migration correctness are
     *     orthogonal here. The migration only needs `dbPath` to know
     *     *where* to write the backup, not to read SQL from it.
     */
    it('takes a backup before migrating and proceeds with migration', async () => {
      const dbPath = `${TEST_CONFIG_DIR}/agentconsole.db`;
      const fakeDbBytes = 'SQLITE format 3 -pretend-db-content';
      // memfs-backed source file. Migration backup will copy these bytes.
      setupMemfs({
        [dbPath]: fakeDbBytes,
      });

      const db = await seedV18Database({
        users: [{ id: 'u', os_uid: 1, username: 'a', home_dir: '/h' }],
        sessions: [
          {
            id: 's',
            type: 'worktree',
            location_path: '/tmp/x',
            repository_id: null,
            worktree_id: null,
            created_by: 'u',
          },
        ],
      });

      await migrateToV19(db, dbPath);

      // Migration progressed past version bump.
      const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
      expect(versionRes.rows[0]?.user_version).toBe(19);

      // Exactly one backup file was written next to the source.
      const dirEntries = await fsPromises.readdir(TEST_CONFIG_DIR);
      const backups = dirEntries.filter((name) =>
        name.startsWith('agentconsole.db.bak.v18-to-v19.')
      );
      expect(backups).toHaveLength(1);

      // Backup file name encodes the version transition AND a colon-free
      // timestamp suffix. We don't pin the exact timestamp (it is now()),
      // but we do pin the structural shape — `T??-??-??-???Z` — so a
      // future change that drops the colon-replacement step would fail
      // here rather than producing un-portable filenames.
      const backupName = backups[0];
      expect(backupName).toMatch(
        /^agentconsole\.db\.bak\.v18-to-v19\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/
      );

      // Backup content matches the source bytes.
      const backupContent = await fsPromises.readFile(`${TEST_CONFIG_DIR}/${backupName}`, 'utf-8');
      expect(backupContent).toBe(fakeDbBytes);

      await db.destroy();
    });

    it('aborts the migration when the backup copy fails', async () => {
      const dbPath = `${TEST_CONFIG_DIR}/agentconsole.db`;
      setupMemfs({
        [dbPath]: 'irrelevant',
      });

      const db = await seedV18Database({
        users: [],
        sessions: [
          {
            id: 's',
            type: 'quick',
            location_path: '/tmp/q',
            repository_id: null,
            worktree_id: null,
            created_by: null,
          },
        ],
      });

      // Force the backup copy to fail. The migration must surface the
      // error AND leave the schema untouched (user_version stays at 18,
      // sessions table keeps its v18 shape with no FK on created_by).
      const copySpy = spyOn(fsPromises, 'copyFile').mockImplementation(() => {
        return Promise.reject(new Error('disk full'));
      });

      try {
        await expect(migrateToV19(db, dbPath)).rejects.toThrow('disk full');

        const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
        expect(versionRes.rows[0]?.user_version).toBe(18);

        // Sanity-check that the FK was not silently introduced. v18's
        // sessions table has no FK clause referencing users.
        const tblRes = await sql<{ sql: string }>`
          SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'
        `.execute(db);
        expect(tblRes.rows[0]?.sql ?? '').not.toContain('REFERENCES users(id)');
      } finally {
        copySpy.mockRestore();
      }

      await db.destroy();
    });

    it('skips the backup for in-memory databases', async () => {
      const db = await seedV18Database({
        users: [],
        sessions: [],
      });

      // No source file exists, but the migration must still succeed
      // because `:memory:` opts out of backup entirely. A spy ensures
      // the copy was not even attempted.
      const copySpy = spyOn(fsPromises, 'copyFile');

      try {
        await migrateToV19(db, ':memory:');
        expect(copySpy).not.toHaveBeenCalled();

        const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
        expect(versionRes.rows[0]?.user_version).toBe(19);
      } finally {
        copySpy.mockRestore();
      }

      await db.destroy();
    });

    it('backupDatabaseFile returns null and performs no copy for in-memory databases', async () => {
      const copySpy = spyOn(fsPromises, 'copyFile');

      try {
        const result = await backupDatabaseFile(':memory:', 18, 19);
        expect(result).toBeNull();
        expect(copySpy).not.toHaveBeenCalled();
      } finally {
        copySpy.mockRestore();
      }
    });
  });
});
