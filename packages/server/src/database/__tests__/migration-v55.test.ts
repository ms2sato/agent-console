/**
 * Migration v55 tests -- `deferred_worker_notifications` (notifications held for
 * a worker of a paused session until resume, docs/design/session-pause-resume.md).
 */

import { describe, it, expect } from 'bun:test';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../schema.js';
import { ISO8601_GLOB_PATTERN } from '../schema-helpers.js';
import { initializeDatabase, migrateToV55, LATEST_SCHEMA_VERSION } from '../connection.js';
import type { PragmaTableInfoRow } from './helpers/ddl-pin.js';

const TABLE = 'deferred_worker_notifications';

/** A database at the v54 shape: a fully migrated one with the v55 table removed. */
async function v54Db(): Promise<Kysely<Database>> {
  const db = await initializeDatabase(':memory:');
  await sql.raw(`DROP TABLE ${TABLE}`).execute(db);
  await sql`PRAGMA user_version = 54`.execute(db);
  return db;
}

async function userVersion(db: Kysely<Database>): Promise<number | undefined> {
  const version = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
  return version.rows[0]?.user_version;
}

async function indexNames(db: Kysely<Database>): Promise<string[]> {
  const rows = (
    await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ${TABLE} AND name LIKE 'idx_dwn_%' ORDER BY name`.execute(db)
  ).rows;
  return rows.map((r) => r.name);
}

describe('migration v55 (deferred_worker_notifications)', () => {
  it('the v54 fixture really lacks the table', async () => {
    const db = await v54Db();
    try {
      const tables = (await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${TABLE}`.execute(db)).rows;
      expect(tables).toHaveLength(0);
      expect(await userVersion(db)).toBe(54);
    } finally {
      await db.destroy();
    }
  });

  it('creates exactly the approved columns (no source column) and the three indexes', async () => {
    const db = await v54Db();
    try {
      await migrateToV55(db);

      const columns = (await sql.raw<PragmaTableInfoRow>(`PRAGMA table_info(${TABLE})`).execute(db)).rows;
      expect(columns.map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
        ['id', 'TEXT', 0, 1],
        ['session_id', 'TEXT', 1, 0],
        ['worker_id', 'TEXT', 1, 0],
        ['kind', 'TEXT', 1, 0],
        ['source_id', 'TEXT', 0, 0],
        ['params_json', 'TEXT', 1, 0],
        ['reply_to_session_id', 'TEXT', 0, 0],
        ['created_at', 'TEXT', 1, 0],
      ]);
      expect(await indexNames(db)).toEqual(['idx_dwn_reply_to', 'idx_dwn_session_created', 'idx_dwn_worker']);
    } finally {
      await db.destroy();
    }
  });

  it('declares the three named CHECKs, with the created_at literal rendered from ISO8601_GLOB_PATTERN', async () => {
    const db = await v54Db();
    try {
      await migrateToV55(db);
      const ddl = (await sql<{ sql: string }>`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${TABLE}`.execute(db)).rows[0]!.sql;
      expect(ddl).toContain('dwn_kind_check');
      expect(ddl).toContain('dwn_params_check');
      expect(ddl).toContain(`dwn_created_at_check CHECK (created_at GLOB '${ISO8601_GLOB_PATTERN}')`);
      expect(ddl).toContain('REFERENCES sessions(id) ON DELETE CASCADE');
      expect(ddl).toContain('REFERENCES workers(id) ON DELETE CASCADE');
      expect(ddl).toContain('REFERENCES sessions(id) ON DELETE SET NULL');
    } finally {
      await db.destroy();
    }
  });

  it('sets user_version to 55 and is idempotent', async () => {
    const db = await v54Db();
    try {
      await migrateToV55(db);
      await expect(migrateToV55(db)).resolves.toBeUndefined();
      expect(await userVersion(db)).toBe(55);
      expect(await indexNames(db)).toHaveLength(3);
    } finally {
      await db.destroy();
    }
  });

  it('a fresh database lands on the latest version with the table present', async () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(55);
    const db = await initializeDatabase(':memory:');
    try {
      const tables = (await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${TABLE}`.execute(db)).rows;
      expect(tables).toHaveLength(1);
      expect(await userVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      await db.destroy();
    }
  });
});
