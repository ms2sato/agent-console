/**
 * Migration v44 tests -- creates the `mcp_server_permissions` table (epic
 * #1636 Phase 5 PR-2, docs/design/embedded-agent-sdk-engine.md §4.5's "the
 * approval record").
 *
 * A NEW table, no rebuild, no existing rows, no backup file -- same shape as
 * `migrateToV41`'s `repository_orchestrator_sessions` table. A minimal
 * v43-shaped `repositories`/`users` pair (the two FK targets) is seeded
 * directly against a raw Bun SQLite instance, then the production
 * `migrateToV44` is invoked directly against it -- exercising the real
 * migration code with no risk of drift between a test-local copy and the
 * production implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql, Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import type { Database } from '../schema.js';
import { initializeDatabase, closeDatabase, migrateToV44 } from '../connection.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { expectRebuiltTableDdl, type PragmaTableInfoRow } from './helpers/ddl-pin.js';

const TEST_CONFIG_DIR = '/test/config';

/**
 * Build a v43-shaped database: a minimal `repositories`/`users` pair (the
 * two tables `mcp_server_permissions` references), with no
 * `mcp_server_permissions` table yet.
 */
function seedV43Database(): Kysely<Database> {
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

    PRAGMA user_version = 43;
  `);

  return db;
}

async function insertRepository(db: Kysely<Database>, id: string): Promise<void> {
  await db.insertInto('repositories').values({ id, name: id, path: `/tmp/${id}` }).execute();
}

async function insertUser(db: Kysely<Database>, id: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto('users')
    .values({ id, os_uid: null, username: id, home_dir: `/home/${id}`, created_at: now, updated_at: now })
    .execute();
}

describe('migration v44 (mcp_server_permissions table creation)', () => {
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

  it('creates mcp_server_permissions with the expected column shape and DDL', async () => {
    const db = seedV43Database();
    await migrateToV44(db);

    const expectedColumns: PragmaTableInfoRow[] = [
      { cid: 0, name: 'id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
      { cid: 1, name: 'repository_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 2, name: 'server_name', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 3, name: 'config_hash', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 4, name: 'decision', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 5, name: 'decided_by', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      {
        cid: 6,
        name: 'created_at',
        type: 'TEXT',
        notnull: 1,
        dflt_value: "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        pk: 0,
      },
      {
        cid: 7,
        name: 'decided_at',
        type: 'TEXT',
        notnull: 1,
        dflt_value: "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        pk: 0,
      },
    ];

    await expectRebuiltTableDdl(db, 'mcp_server_permissions', {
      expectedColumns,
      mustContain: [
        'mcp_server_permissions_key',
        'mcp_server_permissions_decision_check',
        "decision IN ('allow', 'deny')",
        'mcp_server_permissions_created_at_iso8601',
        'mcp_server_permissions_decided_at_iso8601',
        'GLOB',
      ],
      mustNotContain: [],
    });

    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(44);

    await db.destroy();
  });

  it('creates the repository_id index', async () => {
    const db = seedV43Database();
    await migrateToV44(db);

    const indexRows = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mcp_server_permissions'
    `.execute(db);
    expect(indexRows.rows.map((r) => r.name)).toContain('idx_mcp_server_permissions_repository_id');

    await db.destroy();
  });

  it('rejects a second row with the same (repository_id, server_name, config_hash) key', async () => {
    const db = seedV43Database();
    await migrateToV44(db);
    await insertRepository(db, 'repo-1');
    await insertUser(db, 'user-1');

    await db
      .insertInto('mcp_server_permissions')
      .values({
        id: 'perm-1',
        repository_id: 'repo-1',
        server_name: 'chrome-devtools',
        config_hash: 'hash-1',
        decision: 'allow',
        decided_by: 'user-1',
        decided_at: '2026-01-01T00:00:00.000Z',
      })
      .execute();

    await expect(
      db
        .insertInto('mcp_server_permissions')
        .values({
          id: 'perm-2',
          repository_id: 'repo-1',
          server_name: 'chrome-devtools',
          config_hash: 'hash-1',
          decision: 'deny',
          decided_by: 'user-1',
          decided_at: '2026-01-02T00:00:00.000Z',
        })
        .execute()
    ).rejects.toThrow();

    await db.destroy();
  });

  it('rejects a decision value outside allow/deny', async () => {
    const db = seedV43Database();
    await migrateToV44(db);
    await insertRepository(db, 'repo-1');
    await insertUser(db, 'user-1');

    await expect(
      db
        .insertInto('mcp_server_permissions')
        .values({
          id: 'perm-bad',
          repository_id: 'repo-1',
          server_name: 'chrome-devtools',
          config_hash: 'hash-1',
          decision: 'maybe' as never,
          decided_by: 'user-1',
          decided_at: '2026-01-01T00:00:00.000Z',
        })
        .execute()
    ).rejects.toThrow();

    await db.destroy();
  });

  it('CASCADEs on repository delete', async () => {
    const db = seedV43Database();
    await migrateToV44(db);
    await insertRepository(db, 'repo-cascade');
    await insertUser(db, 'user-1');
    await db
      .insertInto('mcp_server_permissions')
      .values({
        id: 'perm-cascade',
        repository_id: 'repo-cascade',
        server_name: 'chrome-devtools',
        config_hash: 'hash-1',
        decision: 'allow',
        decided_by: 'user-1',
        decided_at: '2026-01-01T00:00:00.000Z',
      })
      .execute();

    await db.deleteFrom('repositories').where('id', '=', 'repo-cascade').execute();

    const rows = await db.selectFrom('mcp_server_permissions').selectAll().execute();
    expect(rows).toEqual([]);

    await db.destroy();
  });

  it('CASCADEs on decided_by user delete', async () => {
    const db = seedV43Database();
    await migrateToV44(db);
    await insertRepository(db, 'repo-1');
    await insertUser(db, 'user-cascade');
    await db
      .insertInto('mcp_server_permissions')
      .values({
        id: 'perm-user-cascade',
        repository_id: 'repo-1',
        server_name: 'chrome-devtools',
        config_hash: 'hash-1',
        decision: 'allow',
        decided_by: 'user-cascade',
        decided_at: '2026-01-01T00:00:00.000Z',
      })
      .execute();

    await db.deleteFrom('users').where('id', '=', 'user-cascade').execute();

    const rows = await db.selectFrom('mcp_server_permissions').selectAll().execute();
    expect(rows).toEqual([]);

    await db.destroy();
  });

  it('is idempotent: running twice has no additional effect', async () => {
    const db = seedV43Database();
    await migrateToV44(db);
    await insertRepository(db, 'repo-1');
    await insertUser(db, 'user-1');
    await db
      .insertInto('mcp_server_permissions')
      .values({
        id: 'perm-1',
        repository_id: 'repo-1',
        server_name: 'chrome-devtools',
        config_hash: 'hash-1',
        decision: 'allow',
        decided_by: 'user-1',
        decided_at: '2026-01-01T00:00:00.000Z',
      })
      .execute();

    await expect(migrateToV44(db)).resolves.toBeUndefined();

    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(44);

    const rows = await db.selectFrom('mcp_server_permissions').selectAll().execute();
    expect(rows).toHaveLength(1);

    await db.destroy();
  });

  it('lands the fresh in-memory dispatcher past schema version 44 (see migration-v46.test.ts for the v46 pin)', async () => {
    const db = await initializeDatabase(':memory:');
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(46);
  });
});
