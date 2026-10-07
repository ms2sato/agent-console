/**
 * Migration v47 tests -- creates the `shared_accounts` table and
 * `repositories.shared_account_user_id` column (shared-accounts design,
 * Release 1: storage only, not yet consulted by session creation or
 * access control -- see `migrateToV47`'s doc comment in `connection.ts`).
 *
 * A NEW table plus an `ALTER TABLE ... ADD COLUMN`, no rebuild, no backup
 * file -- same shape as `migration-v44.test.ts` / `migration-v45.test.ts`.
 * A minimal v45-shaped `repositories`/`users` pair is seeded directly
 * against a raw Bun SQLite instance, then the production `migrateToV47` is
 * invoked directly against it -- exercising the real migration code with no
 * risk of drift between a test-local copy and the production
 * implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql, Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import type { Database } from '../schema.js';
import { initializeDatabase, closeDatabase, migrateToV47 } from '../connection.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { expectRebuiltTableDdl, type PragmaTableInfoRow } from './helpers/ddl-pin.js';

const TEST_CONFIG_DIR = '/test/config';

/**
 * Build a v45-shaped database: a minimal `repositories`/`users` pair (both
 * are FK targets this migration's own DDL needs -- `repositories` gains the
 * new column, `users` is what both FKs in `shared_accounts` reference),
 * with no `shared_accounts` table yet and no `shared_account_user_id`
 * column.
 */
function seedV45Database(): Kysely<Database> {
  const bunDb = new BunDatabase(':memory:');
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: bunDb }),
  });

  bunDb.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE repositories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      os_uid INTEGER,
      username TEXT NOT NULL,
      home_dir TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT
    );

    PRAGMA user_version = 45;
  `);

  return db;
}

async function insertUser(db: Kysely<Database>, id: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto('users')
    .values({ id, os_uid: null, username: id, home_dir: `/home/${id}`, created_at: now, updated_at: now })
    .execute();
}

async function insertRepository(db: Kysely<Database>, id: string): Promise<void> {
  await db.insertInto('repositories').values({ id, name: id, path: `/tmp/${id}` }).execute();
}

describe('migration v47 (shared_accounts table + repositories.shared_account_user_id)', () => {
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

  it('creates shared_accounts with the expected column shape and DDL', async () => {
    const db = seedV45Database();
    await migrateToV47(db);

    const expectedColumns: PragmaTableInfoRow[] = [
      { cid: 0, name: 'user_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
      { cid: 1, name: 'created_by', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      {
        cid: 2,
        name: 'created_at',
        type: 'TEXT',
        notnull: 1,
        dflt_value: "strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        pk: 0,
      },
    ];

    await expectRebuiltTableDdl(db, 'shared_accounts', {
      expectedColumns,
      mustContain: [
        'REFERENCES users(id) ON DELETE CASCADE',
        'REFERENCES users(id) ON DELETE SET NULL',
      ],
      mustNotContain: [],
    });

    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(47);

    await db.destroy();
  });

  it('adds a nullable shared_account_user_id column to repositories', async () => {
    const db = seedV45Database();
    await migrateToV47(db);

    const columnsResult = await sql.raw<PragmaTableInfoRow>('PRAGMA table_info(repositories)').execute(db);
    const column = columnsResult.rows.find((c) => c.name === 'shared_account_user_id');
    expect(column).toBeDefined();
    expect(column!.notnull).toBe(0);
    expect(column!.dflt_value).toBeNull();

    const ddlResult = await sql<{ sql: string | null }>`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'repositories'
    `.execute(db);
    expect(ddlResult.rows[0]?.sql ?? '').toContain('REFERENCES shared_accounts(user_id) ON DELETE RESTRICT');

    await db.destroy();
  });

  it('a legacy (pre-existing) repository row reads shared_account_user_id as null -- no backfill', async () => {
    const db = seedV45Database();
    await insertRepository(db, 'repo-legacy');

    await migrateToV47(db);

    const row = await db
      .selectFrom('repositories')
      .where('id', '=', 'repo-legacy')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.shared_account_user_id).toBeNull();

    await db.destroy();
  });

  it('is idempotent: running twice has no additional effect', async () => {
    const db = seedV45Database();
    await migrateToV47(db);
    await insertUser(db, 'user-1');
    await db.insertInto('shared_accounts').values({ user_id: 'user-1', created_by: null }).execute();

    await expect(migrateToV47(db)).resolves.toBeUndefined();

    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(47);

    const rows = await db.selectFrom('shared_accounts').selectAll().execute();
    expect(rows).toHaveLength(1);

    await db.destroy();
  });

  it('ON DELETE RESTRICT: rejects deleting a shared_accounts row referenced by a bound repository', async () => {
    const db = seedV45Database();
    await migrateToV47(db);
    await insertUser(db, 'user-1');
    await insertRepository(db, 'repo-1');
    await db.insertInto('shared_accounts').values({ user_id: 'user-1', created_by: null }).execute();
    await db
      .updateTable('repositories')
      .set({ shared_account_user_id: 'user-1' })
      .where('id', '=', 'repo-1')
      .execute();

    await expect(
      db.deleteFrom('shared_accounts').where('user_id', '=', 'user-1').execute(),
    ).rejects.toThrow();

    // The row must survive the rejected delete.
    const rows = await db.selectFrom('shared_accounts').selectAll().execute();
    expect(rows).toHaveLength(1);

    await db.destroy();
  });

  it('ON DELETE CASCADE: deleting the backing users row removes the shared_accounts row', async () => {
    const db = seedV45Database();
    await migrateToV47(db);
    await insertUser(db, 'user-cascade');
    await db.insertInto('shared_accounts').values({ user_id: 'user-cascade', created_by: null }).execute();

    await db.deleteFrom('users').where('id', '=', 'user-cascade').execute();

    const rows = await db.selectFrom('shared_accounts').selectAll().execute();
    expect(rows).toEqual([]);

    await db.destroy();
  });

  it('ON DELETE SET NULL: deleting the created_by user leaves the shared_accounts row with created_by = null', async () => {
    const db = seedV45Database();
    await migrateToV47(db);
    await insertUser(db, 'user-shared');
    await insertUser(db, 'user-admin');
    await db.insertInto('shared_accounts').values({ user_id: 'user-shared', created_by: 'user-admin' }).execute();

    await db.deleteFrom('users').where('id', '=', 'user-admin').execute();

    const row = await db
      .selectFrom('shared_accounts')
      .where('user_id', '=', 'user-shared')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.created_by).toBeNull();

    await db.destroy();
  });

  it('lands the fresh in-memory dispatcher on schema version 47', async () => {
    const db = await initializeDatabase(':memory:');
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(47);
  });
});
