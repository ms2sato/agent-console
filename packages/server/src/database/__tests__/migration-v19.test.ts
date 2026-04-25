/**
 * Migration v19 tests — sessions.created_by FK constraint addition.
 *
 * Strategy:
 *   - `adds FK constraint to created_by` test exercises the real production path
 *     via `initializeDatabase(':memory:')`.
 *   - FK behavior tests construct a v18-shaped schema directly against a raw
 *     Bun SQLite instance, seed it with users and sessions, then re-apply the same
 *     DDL that the production `migrateToV19` performs (kept in `runV19Migration`
 *     here). Table-recreation pattern is required because SQLite doesn't support
 *     ALTER TABLE ADD CONSTRAINT.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql, Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import type { Database } from '../schema.js';
import { initializeDatabase, closeDatabase } from '../connection.js';
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
 * Creates users, sessions, and repositories tables with v18 schema (no FK constraint on created_by).
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

    CREATE TABLE repositories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      setup_command TEXT,
      env_vars TEXT,
      description TEXT,
      cleanup_command TEXT,
      default_agent_id TEXT
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

/**
 * Apply the v19 migration body (table recreation with FK constraint) against a caller-
 * owned DB. Kept in sync with `migrateToV19` in connection.ts.
 */
async function runV19Migration(db: Kysely<Database>): Promise<void> {
  // Idempotency guard mirrors `migrateToV19`.
  const versionResult = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
  const currentVersion = versionResult.rows[0]?.user_version ?? 0;
  if (currentVersion >= 19) {
    return;
  }

  // FK toggling cannot happen inside a transaction.
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  try {
    const objectsResult = await sql<{
      type: string;
      name: string;
      sql: string | null;
    }>`
      SELECT type, name, sql
      FROM sqlite_master
      WHERE tbl_name = 'sessions'
        AND type IN ('index', 'trigger')
        AND name NOT LIKE 'sqlite_autoindex%'
    `.execute(db);
    const objectsToRestore = objectsResult.rows.filter((row) => row.sql !== null);

    await db.transaction().execute(async (trx) => {
      await sql`
        CREATE TABLE sessions_new (
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
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          data_scope TEXT,
          data_scope_slug TEXT,
          recovery_state TEXT NOT NULL DEFAULT 'healthy',
          orphaned_at INTEGER,
          orphaned_reason TEXT
        )
      `.execute(trx);

      await sql`
        INSERT INTO sessions_new (
          id, type, location_path, server_pid, created_at, updated_at,
          initial_prompt, title, repository_id, worktree_id, paused_at,
          parent_session_id, parent_worker_id, created_by, data_scope,
          data_scope_slug, recovery_state, orphaned_at, orphaned_reason
        )
        SELECT
          id, type, location_path, server_pid, created_at, updated_at,
          initial_prompt, title, repository_id, worktree_id, paused_at,
          parent_session_id, parent_worker_id, created_by, data_scope,
          data_scope_slug, recovery_state, orphaned_at, orphaned_reason
        FROM sessions
      `.execute(trx);

      await sql`DROP TABLE sessions`.execute(trx);
      await sql`ALTER TABLE sessions_new RENAME TO sessions`.execute(trx);

      for (const obj of objectsToRestore) {
        await sql.raw(obj.sql as string).execute(trx);
      }

      await sql`PRAGMA user_version = 19`.execute(trx);
    });

    const fkCheck = await sql<{ table: string; rowid: number; parent: string; fkid: number }>`
      PRAGMA foreign_key_check
    `.execute(db);
    if (fkCheck.rows.length > 0) {
      throw new Error(
        `Foreign key check failed after v19 migration: ${JSON.stringify(fkCheck.rows)}`
      );
    }
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
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

    await runV19Migration(db);

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

    await runV19Migration(db);

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

    await runV19Migration(db);

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

    // Verify all non-automatic indexes/triggers are preserved
    expect(afterObjects.rows).toHaveLength(beforeObjects.rows.length);

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
    await runV19Migration(db);
    await runV19Migration(db);

    // Verify schema version is correct
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(19);

    // Verify data is still intact
    const sessions = await db.selectFrom('sessions').selectAll().execute();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('sess-1');
    expect(sessions[0].created_by).toBe('user-1');

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

    await runV19Migration(db);

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
});