/**
 * Migration v53 tests -- every foreign-key column leads an index.
 *
 * SQLite does not index the child side of a foreign key, so a parent DELETE
 * with CASCADE / SET NULL / RESTRICT scans the child table. v53 adds the eight
 * indexes that were missing. Each case pins the index's TABLE and COLUMN, not
 * just its name.
 */

import { describe, it, expect } from 'bun:test';
import { sql, Kysely } from 'kysely';
import type { Database } from '../schema.js';
import {
  initializeDatabase,
  migrateToV53,
  LATEST_SCHEMA_VERSION,
} from '../connection.js';

const EXPECTED_INDEXES = [
  { name: 'idx_mcp_server_path_permissions_decided_by', table: 'mcp_server_path_permissions', column: 'decided_by' },
  { name: 'idx_mcp_server_permissions_decided_by', table: 'mcp_server_permissions', column: 'decided_by' },
  { name: 'idx_repositories_shared_account_user_id', table: 'repositories', column: 'shared_account_user_id' },
  { name: 'idx_repositories_default_agent_id', table: 'repositories', column: 'default_agent_id' },
  { name: 'idx_sessions_created_by', table: 'sessions', column: 'created_by' },
  { name: 'idx_shared_accounts_created_by', table: 'shared_accounts', column: 'created_by' },
  { name: 'idx_todos_assignee_user_id', table: 'todos', column: 'assignee_user_id' },
  { name: 'idx_todos_created_user_id', table: 'todos', column: 'created_user_id' },
];

// The v50-v52 chain alone does not build the older tables v53 indexes, so a v52
// database is a fully migrated one with the eight v53 indexes dropped and
// user_version rewound -- exactly the state a v52 installation is in.
async function v52Db(): Promise<Kysely<Database>> {
  const db = await initializeDatabase(':memory:');
  for (const { name } of EXPECTED_INDEXES) {
    await sql.raw(`DROP INDEX ${name}`).execute(db);
  }
  await sql`PRAGMA user_version = 52`.execute(db);
  return db;
}

async function userVersion(db: Kysely<Database>): Promise<number | undefined> {
  const version = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
  return version.rows[0]?.user_version;
}

async function userIndexNames(db: Kysely<Database>): Promise<string[]> {
  const rows = (
    await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name`.execute(db)
  ).rows;
  return rows.map((r) => r.name);
}

describe('migration v53 (foreign-key column indexes)', () => {
  it('a fresh database lands on the latest schema version', async () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(53);
    const db = await initializeDatabase(':memory:');
    try {
      expect(await userVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      await db.destroy();
    }
  });

  describe('each approved index', () => {
    it.each(EXPECTED_INDEXES)('$name is a single-column index on $table($column)', async ({ name, table, column }) => {
      const db = await initializeDatabase(':memory:');
      try {
        const info = (await sql.raw<{ name: string }>(`PRAGMA index_info(${name})`).execute(db)).rows;
        expect(info.map((r) => r.name)).toEqual([column]);

        const master = (
          await sql<{ tbl_name: string }>`SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ${name}`.execute(db)
        ).rows;
        expect(master.map((r) => r.tbl_name)).toEqual([table]);

        const listed = (await sql.raw<{ name: string }>(`PRAGMA index_list(${table})`).execute(db)).rows;
        expect(listed.map((r) => r.name)).toContain(name);
      } finally {
        await db.destroy();
      }
    });
  });

  it('is idempotent: a second run does not throw and user_version stays 53', async () => {
    const db = await initializeDatabase(':memory:');
    try {
      await expect(migrateToV53(db)).resolves.toBeUndefined();
      expect(await userVersion(db)).toBe(53);
    } finally {
      await db.destroy();
    }
  });

  it('v52 -> v53 adds exactly the eight indexes and changes no existing idx_ index', async () => {
    const db = await v52Db();
    try {
      const before = await userIndexNames(db);
      const definitionsBefore = (
        await sql<{ name: string; sql: string }>`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name`.execute(db)
      ).rows;
      expect(await userVersion(db)).toBe(52);

      await migrateToV53(db);

      const after = await userIndexNames(db);
      const added = after.filter((n) => !before.includes(n));
      const removed = before.filter((n) => !after.includes(n));
      expect(added.sort()).toEqual(EXPECTED_INDEXES.map((i) => i.name).sort());
      expect(removed).toEqual([]);

      const definitionsAfter = (
        await sql<{ name: string; sql: string }>`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name`.execute(db)
      ).rows.filter((r) => before.includes(r.name));
      expect(definitionsAfter).toEqual(definitionsBefore);
      expect(await userVersion(db)).toBe(53);
    } finally {
      await db.destroy();
    }
  });
});
