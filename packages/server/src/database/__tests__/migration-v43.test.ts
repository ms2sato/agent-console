/**
 * Migration v43 tests — restores the two ISO8601 CHECK constraints and the
 * ISO8601 DEFAULT on sessions.created_at/updated_at that migration v19's
 * hand-written table rebuild silently dropped.
 *
 * Strategy mirrors migration-v19.test.ts / migration-v36.test.ts (the other
 * table-rebuild migrations): a v42-shaped `sessions` (plus its minimal FK
 * dependents) is seeded directly against a raw Bun SQLite instance, then the
 * production `migrateToV43` is invoked directly. This exercises the real
 * migration code with no risk of drift between a test-local copy and the
 * production implementation.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { sql, Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import * as fsPromises from 'fs/promises';
import type { Database } from '../schema.js';
import { initializeDatabase, closeDatabase, migrateToV43 } from '../connection.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { expectRebuiltTableDdl, type PragmaTableInfoRow } from './helpers/ddl-pin.js';

const TEST_CONFIG_DIR = '/test/config';

const NON_ISO8601_TIMESTAMP = '2024-01-01 00:00:00';

/**
 * Build a v42-shaped database: `sessions` as it existed after v41 (no
 * migration between v19 and v43 touched sessions.created_at/updated_at),
 * i.e. the CURRENT DEFECTIVE shape (no CHECK, `datetime('now')` DEFAULT),
 * plus minimal shapes of its three real FK dependents
 * (`workers`, `inbound_event_notifications`, `repository_orchestrator_sessions`)
 * and its one outbound FK target (`users`).
 *
 * Also seeds exactly ONE synthetic non-auto index on `sessions`
 * (`idx_sessions_test_synthetic`). Production `sessions` currently has zero
 * non-auto indexes; this index exists purely so the tests below can exercise
 * migrateToV43's defensively-kept snapshot/restore mechanism (mirroring
 * migrateToV42's own rationale for keeping that mechanism despite having
 * nothing to restore today).
 */
function seedV42Database(): Kysely<Database> {
  const bunDb = new BunDatabase(':memory:');
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: bunDb }),
  });

  bunDb.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      os_uid INTEGER,
      username TEXT NOT NULL,
      home_dir TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      data_scope TEXT,
      data_scope_slug TEXT,
      recovery_state TEXT NOT NULL DEFAULT 'healthy',
      orphaned_at INTEGER,
      orphaned_reason TEXT,
      initiated_by TEXT,
      initial_prompt_delivered INTEGER
    );

    -- Synthetic: see this function's doc comment above. Production sessions
    -- currently has zero non-auto indexes; this exists purely to exercise
    -- migrateToV43's defensively-kept snapshot/restore mechanism.
    CREATE INDEX idx_sessions_test_synthetic ON sessions(repository_id);

    CREATE TABLE workers (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      name TEXT NOT NULL
    );

    CREATE TABLE inbound_event_notifications (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      worker_id TEXT NOT NULL,
      handler_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      notified_at TEXT
    );

    CREATE TABLE repository_orchestrator_sessions (
      repository_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (repository_id, session_id)
    );

    PRAGMA user_version = 42;
  `);

  return db;
}

interface SessionOverrides {
  id: string;
  type?: 'quick' | 'worktree';
  location_path?: string;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * Insert a session row with an explicit, ISO8601-conforming created_at/
 * updated_at unless the caller overrides them. This mirrors real
 * application behavior: `mappers.ts`'s `toSessionRow` always writes an
 * explicit `new Date().toISOString()` value rather than omitting the
 * column and falling back to the v42 table's raw SQL DEFAULT (which is the
 * non-conforming `datetime('now')` this migration exists to fix). Seeding
 * via the raw DEFAULT here would make every seeded row trip v43's own
 * pre-flight check, which is not what most of these tests are about.
 */
async function insertSession(db: Kysely<Database>, overrides: SessionOverrides): Promise<void> {
  await db
    .insertInto('sessions')
    .values({
      id: overrides.id,
      type: overrides.type ?? 'quick',
      location_path: overrides.location_path ?? `/test/${overrides.id}`,
      server_pid: null,
      created_at: overrides.created_at ?? '2024-01-01T00:00:00.000Z',
      updated_at: overrides.updated_at ?? '2024-01-01T00:00:00.000Z',
      initial_prompt: null,
      initial_prompt_delivered: null,
      title: null,
      repository_id: null,
      worktree_id: null,
      paused_at: null,
      parent_session_id: null,
      parent_worker_id: null,
      created_by: overrides.created_by ?? null,
      initiated_by: null,
      data_scope: null,
      data_scope_slug: null,
      orphaned_at: null,
      orphaned_reason: null,
    })
    .execute();
}

describe('migration v43 (sessions ISO8601 CHECK restoration)', () => {
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

  // Polarity (Task 4 #1, #4): reverting the CREATE TABLE to v19's
  // defective shape (no CHECK, `datetime('now')`) fails this test's
  // dflt_value assertions; dropping the `sessions_updated_at_iso8601`
  // constraint alone fails this test's `mustContain` assertion.
  it('rebuilds sessions with the corrected DEFAULT and the two ISO8601 CHECK constraints', async () => {
    const db = seedV42Database();
    await migrateToV43(db);

    const expectedColumns: PragmaTableInfoRow[] = [
      { cid: 0, name: 'id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
      { cid: 1, name: 'type', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 2, name: 'location_path', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 3, name: 'server_pid', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
      {
        cid: 4,
        name: 'created_at',
        type: 'TEXT',
        notnull: 1,
        dflt_value: "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        pk: 0,
      },
      {
        cid: 5,
        name: 'updated_at',
        type: 'TEXT',
        notnull: 1,
        dflt_value: "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        pk: 0,
      },
      { cid: 6, name: 'initial_prompt', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 7, name: 'title', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 8, name: 'repository_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 9, name: 'worktree_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 10, name: 'paused_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 11, name: 'parent_session_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 12, name: 'parent_worker_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 13, name: 'created_by', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 14, name: 'data_scope', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 15, name: 'data_scope_slug', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 16, name: 'recovery_state', type: 'TEXT', notnull: 1, dflt_value: "'healthy'", pk: 0 },
      { cid: 17, name: 'orphaned_at', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 18, name: 'orphaned_reason', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 19, name: 'initiated_by', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 20, name: 'initial_prompt_delivered', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
    ];

    await expectRebuiltTableDdl(db, 'sessions', {
      expectedColumns,
      mustContain: ['sessions_created_at_iso8601', 'sessions_updated_at_iso8601', 'GLOB'],
      mustNotContain: ["datetime('now')"],
    });

    await db.destroy();
  });

  // Polarity (Task 4 #1, #4): reverting the CREATE TABLE to v19's
  // defective shape, or dropping either CONSTRAINT clause alone,
  // fails this test's corresponding post-migration `rejects.toThrow()`
  // assertion (both columns are exercised independently).
  it('rejects a non-ISO8601 created_at/updated_at pre-migration but not post-migration', async () => {
    const db = seedV42Database();

    // Before migration: the v42 shape has no CHECK, so a malformed timestamp
    // is accepted without error.
    await expect(
      insertSession(db, {
        id: 'sess-pre',
        created_at: NON_ISO8601_TIMESTAMP,
        updated_at: NON_ISO8601_TIMESTAMP,
      })
    ).resolves.toBeUndefined();

    // Remove the malformed row before migrating: v43's own pre-flight check
    // (exercised separately below) would otherwise abort this migration on
    // exactly the row this test just proved is acceptable pre-migration.
    // This test is about the CHECK constraint's before/after behavior, not
    // the pre-flight abort.
    await db.deleteFrom('sessions').where('id', '=', 'sess-pre').execute();

    await migrateToV43(db);

    // After migration: the same shape must be rejected by the new CHECK
    // constraint on both columns.
    await expect(
      insertSession(db, {
        id: 'sess-post-created',
        created_at: NON_ISO8601_TIMESTAMP,
        updated_at: '2024-01-01T00:00:00.000Z',
      })
    ).rejects.toThrow();

    await expect(
      insertSession(db, {
        id: 'sess-post-updated',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: NON_ISO8601_TIMESTAMP,
      })
    ).rejects.toThrow();

    await db.destroy();
  });

  it('restores the ISO8601 DEFAULT for created_at/updated_at when omitted', async () => {
    const db = seedV42Database();
    await migrateToV43(db);

    await db
      .insertInto('sessions')
      .values({
        id: 'sess-default',
        type: 'quick',
        location_path: '/test/sess-default',
        server_pid: null,
        initial_prompt: null,
        initial_prompt_delivered: null,
        title: null,
        repository_id: null,
        worktree_id: null,
        paused_at: null,
        parent_session_id: null,
        parent_worker_id: null,
        created_by: null,
        initiated_by: null,
        data_scope: null,
        data_scope_slug: null,
        orphaned_at: null,
        orphaned_reason: null,
      })
      .execute();

    const row = await db
      .selectFrom('sessions')
      .where('id', '=', 'sess-default')
      .select(['created_at', 'updated_at'])
      .executeTakeFirstOrThrow();

    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(row.created_at).toContain('T');
    expect(row.created_at.endsWith('Z')).toBe(true);

    await db.destroy();
  });

  // Polarity (Task 4 #5): removing the `backupDatabaseFile(...)` call
  // fails this test's backup-file-exists assertion.
  it('aborts the migration when pre-existing rows carry non-ISO8601 timestamps, leaving the schema untouched', async () => {
    const db = seedV42Database();
    await insertSession(db, {
      id: 'sess-bad',
      created_at: NON_ISO8601_TIMESTAMP,
      updated_at: '2024-01-01T00:00:00.000Z',
    });

    const dbPath = `${TEST_CONFIG_DIR}/agentconsole.db`;
    setupMemfs({
      [dbPath]: 'irrelevant',
    });

    // Derive the expected backup-filename version from the seeded db's own
    // PRAGMA user_version rather than hardcoding it: this way, if
    // migrateToV43's `backupDatabaseFile(dbPath, <fromVersion>, 43)` call
    // ever drifts from the fixture's actual pre-migration version (e.g. a
    // rebase onto a branch where v42 exists and the dispatcher runs
    // v41 -> v42 -> v43, so the real pre-v43 version is 42), this test fails
    // loudly on the mismatch instead of silently passing against a filename
    // nobody actually produces.
    const preMigrationVersionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    const fromVersion = preMigrationVersionRes.rows[0]?.user_version;

    await expect(migrateToV43(db, dbPath)).rejects.toThrow(/1 sessions row\(s\)/);

    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(fromVersion);

    const tblRes = await sql<{ sql: string }>`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'
    `.execute(db);
    expect(tblRes.rows[0]?.sql ?? '').not.toContain('iso8601');

    // The pre-flight backup still happened, since it runs BEFORE the
    // pre-flight data check (same ordering rationale as v19: a backup exists
    // even on abort).
    const dirEntries = await fsPromises.readdir(TEST_CONFIG_DIR);
    const backups = dirEntries.filter((name) => name.startsWith(`agentconsole.db.bak.v${fromVersion}-to-v43.`));
    expect(backups).toHaveLength(1);

    await db.destroy();
  });

  describe('FK hazard: workers, inbound_event_notifications, repository_orchestrator_sessions', () => {
    it('preserves FK declarations, passes foreign_key_check, and CASCADEs on session delete', async () => {
      const db = seedV42Database();
      await insertSession(db, { id: 'sess-fk' });
      await migrateToV43(db);

      for (const table of ['workers', 'inbound_event_notifications', 'repository_orchestrator_sessions'] as const) {
        const fkRows = await sql.raw<{
          id: number;
          seq: number;
          table: string;
          from: string;
          to: string;
        }>(`PRAGMA foreign_key_list(${table})`).execute(db);
        const sessionFk = fkRows.rows.find((row) => row.from === 'session_id');
        expect(sessionFk, `${table}.session_id FK`).toBeDefined();
        expect(sessionFk!.table).toBe('sessions');
      }

      await db
        .insertInto('workers')
        .values({ id: 'worker-fk', session_id: 'sess-fk', type: 'terminal', name: 'w' })
        .execute();
      await db
        .insertInto('inbound_event_notifications')
        .values({
          id: 'notif-fk',
          job_id: 'job-1',
          session_id: 'sess-fk',
          worker_id: 'worker-fk',
          handler_id: 'handler-1',
          event_type: 'ci:completed',
          event_summary: 'summary',
          status: 'pending',
          created_at: '2024-01-01T00:00:00.000Z',
          notified_at: null,
        })
        .execute();
      await db
        .insertInto('repository_orchestrator_sessions')
        .values({ repository_id: 'repo-fk', session_id: 'sess-fk' })
        .execute();

      const fkCheck = await sql`PRAGMA foreign_key_check`.execute(db);
      expect(fkCheck.rows).toHaveLength(0);

      await db.deleteFrom('sessions').where('id', '=', 'sess-fk').execute();

      expect(await db.selectFrom('workers').selectAll().execute()).toEqual([]);
      expect(await db.selectFrom('inbound_event_notifications').selectAll().execute()).toEqual([]);
      expect(await db.selectFrom('repository_orchestrator_sessions').selectAll().execute()).toEqual([]);

      await db.destroy();
    });

    it('sets sessions.created_by to NULL (not CASCADE) when the referenced user is deleted', async () => {
      const db = seedV42Database();
      await db
        .insertInto('users')
        .values({
          id: 'user-fk',
          os_uid: null,
          username: 'alice',
          home_dir: '/home/alice',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        .execute();
      await insertSession(db, { id: 'sess-owner', created_by: 'user-fk' });
      await migrateToV43(db);

      await db.deleteFrom('users').where('id', '=', 'user-fk').execute();

      const row = await db
        .selectFrom('sessions')
        .where('id', '=', 'sess-owner')
        .select(['id', 'created_by'])
        .executeTakeFirstOrThrow();
      expect(row.created_by).toBeNull();

      await db.destroy();
    });
  });

  // Polarity (Task 4 #2): commenting out the index/trigger restore
  // loop fails this test (received length 0, expected 1) and no other
  // test in this file.
  it('preserves the synthetic non-auto index through the table rebuild', async () => {
    const db = seedV42Database();

    const beforeRows = await sql<{ sql: string | null }>`
      SELECT sql FROM sqlite_master
      WHERE tbl_name = 'sessions' AND type = 'index' AND name = 'idx_sessions_test_synthetic'
    `.execute(db);
    expect(beforeRows.rows).toHaveLength(1);

    await migrateToV43(db);

    const afterRows = await sql<{ sql: string | null }>`
      SELECT sql FROM sqlite_master
      WHERE tbl_name = 'sessions' AND type = 'index' AND name = 'idx_sessions_test_synthetic'
    `.execute(db);
    expect(afterRows.rows).toHaveLength(1);
    expect(afterRows.rows[0]?.sql).toBe(beforeRows.rows[0]?.sql);

    await db.destroy();
  });

  it('preserves every column of every row byte-for-byte through the rebuild', async () => {
    const db = seedV42Database();
    await db
      .insertInto('users')
      .values({
        id: 'user-carry',
        os_uid: 1001,
        username: 'alice',
        home_dir: '/home/alice',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      })
      .execute();

    const rowsBefore = [
      {
        id: 'sess-carry-1',
        type: 'worktree' as const,
        location_path: '/tmp/repo1',
        server_pid: 4242,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
        initial_prompt: 'do the thing',
        initial_prompt_delivered: 1,
        title: 'My Session',
        repository_id: 'repo-1',
        worktree_id: 'feature-x',
        paused_at: '2024-01-03T00:00:00.000Z',
        parent_session_id: 'parent-1',
        parent_worker_id: 'parent-worker-1',
        created_by: 'user-carry',
        initiated_by: 'user-carry',
        data_scope: 'repository' as const,
        data_scope_slug: 'repo-1',
        recovery_state: 'healthy' as const,
        orphaned_at: null,
        orphaned_reason: null,
      },
      {
        id: 'sess-carry-2',
        type: 'quick' as const,
        location_path: '/tmp/quick',
        server_pid: null,
        created_at: '2024-02-01T00:00:00.000Z',
        updated_at: '2024-02-02T00:00:00.000Z',
        initial_prompt: null,
        initial_prompt_delivered: null,
        title: null,
        repository_id: null,
        worktree_id: null,
        paused_at: null,
        parent_session_id: null,
        parent_worker_id: null,
        created_by: null,
        initiated_by: null,
        data_scope: null,
        data_scope_slug: null,
        recovery_state: 'orphaned' as const,
        orphaned_at: 1700000000000,
        orphaned_reason: 'migration_unresolved_repository',
      },
      {
        id: 'sess-carry-3',
        type: 'quick' as const,
        location_path: '/tmp/quick3',
        server_pid: null,
        created_at: '2024-03-01T00:00:00.000Z',
        updated_at: '2024-03-02T00:00:00.000Z',
        initial_prompt: null,
        initial_prompt_delivered: 0,
        title: 'Third',
        repository_id: null,
        worktree_id: null,
        paused_at: null,
        parent_session_id: null,
        parent_worker_id: null,
        created_by: null,
        initiated_by: null,
        data_scope: 'quick' as const,
        data_scope_slug: null,
        recovery_state: 'healthy' as const,
        orphaned_at: null,
        orphaned_reason: null,
      },
    ];

    for (const row of rowsBefore) {
      await db.insertInto('sessions').values(row).execute();
    }

    await migrateToV43(db);

    const rowsAfter = await db.selectFrom('sessions').selectAll().orderBy('id').execute();
    expect(rowsAfter).toEqual(rowsBefore);

    await db.destroy();
  });

  it('is idempotent: running twice has no additional effect', async () => {
    const db = seedV42Database();
    await insertSession(db, { id: 'sess-idempotent' });

    await migrateToV43(db);
    await expect(migrateToV43(db)).resolves.toBeUndefined();

    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(43);

    const rows = await db.selectFrom('sessions').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('sess-idempotent');

    await db.destroy();
  });

  it('lands the fresh in-memory dispatcher on schema version 43', async () => {
    const db = await initializeDatabase(':memory:');
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(43);
  });

  // Polarity (Task 4 #5): removing the `backupDatabaseFile(...)` call in
  // migrateToV43 fails both tests in this block (no backup file is written,
  // and the copy-failure abort test's `rejects.toThrow('disk full')`
  // assertion has nothing to reject against since copyFile is never called).
  //
  // Task 4 #3 note (moving the pre-flight data check outside the
  // transaction): tried and reverted. All 13 tests in this file still pass
  // unmodified -- bun:sqlite's single-connection synchronous execution model
  // gives no way, within this test suite, to insert a row between the
  // pre-flight query and the transaction start. This mutation is not
  // observable by the tests in this file; a genuine regression here would
  // only be caught in production by a directly concurrent writer landing
  // between the two statements, which the AC itself said may be an
  // acceptable "hard to observe" outcome.
  describe('pre-flight database backup', () => {
    it('takes a backup before migrating and proceeds with migration', async () => {
      const dbPath = `${TEST_CONFIG_DIR}/agentconsole.db`;
      const fakeDbBytes = 'SQLITE format 3 -pretend-db-content';
      setupMemfs({
        [dbPath]: fakeDbBytes,
      });

      const db = seedV42Database();
      await insertSession(db, { id: 'sess-backup' });

      // Derive the expected backup-filename version from the seeded db's
      // own PRAGMA user_version rather than hardcoding it -- see the
      // matching comment in the pre-flight-abort test above for why.
      const preMigrationVersionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
      const fromVersion = preMigrationVersionRes.rows[0]?.user_version;

      await migrateToV43(db, dbPath);

      const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
      expect(versionRes.rows[0]?.user_version).toBe(43);

      const dirEntries = await fsPromises.readdir(TEST_CONFIG_DIR);
      const backups = dirEntries.filter((name) => name.startsWith(`agentconsole.db.bak.v${fromVersion}-to-v43.`));
      expect(backups).toHaveLength(1);

      const backupName = backups[0];
      expect(backupName).toMatch(
        new RegExp(`^agentconsole\\.db\\.bak\\.v${fromVersion}-to-v43\\.\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z$`)
      );

      const backupContent = await fsPromises.readFile(`${TEST_CONFIG_DIR}/${backupName}`, 'utf-8');
      expect(backupContent).toBe(fakeDbBytes);

      await db.destroy();
    });

    it('aborts the migration when the backup copy fails', async () => {
      const dbPath = `${TEST_CONFIG_DIR}/agentconsole.db`;
      setupMemfs({
        [dbPath]: 'irrelevant',
      });

      const db = seedV42Database();
      await insertSession(db, { id: 'sess-copyfail' });

      const copySpy = spyOn(fsPromises, 'copyFile').mockImplementation(() => {
        return Promise.reject(new Error('disk full'));
      });

      try {
        await expect(migrateToV43(db, dbPath)).rejects.toThrow('disk full');

        const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
        expect(versionRes.rows[0]?.user_version).toBe(42);

        const tblRes = await sql<{ sql: string }>`
          SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'
        `.execute(db);
        expect(tblRes.rows[0]?.sql ?? '').not.toContain('iso8601');
      } finally {
        copySpy.mockRestore();
      }

      await db.destroy();
    });

    it('skips the backup for in-memory databases', async () => {
      const db = seedV42Database();
      await insertSession(db, { id: 'sess-mem' });

      const copySpy = spyOn(fsPromises, 'copyFile');

      try {
        await migrateToV43(db, ':memory:');
        expect(copySpy).not.toHaveBeenCalled();

        const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
        expect(versionRes.rows[0]?.user_version).toBe(43);
      } finally {
        copySpy.mockRestore();
      }

      await db.destroy();
    });
  });
});
