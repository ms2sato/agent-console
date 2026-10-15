/**
 * Migration v49 tests -- adds the nullable `artifacts.updated_at` column (the
 * "Updated <time>" signal of an in-place artifact update; see `migrateToV49`'s
 * doc comment in `connection.ts` and docs/design/html-artifacts.md section 5.4).
 *
 * One `ALTER TABLE ... ADD COLUMN`, no rebuild, no default, no backfill -- the
 * same shape as `migration-v48.test.ts`. A v48-shaped `artifacts` table (the
 * six columns it has had since creation) is seeded directly against a raw Bun
 * SQLite instance, then the production `migrateToV49` is invoked against it.
 */

import { describe, it, expect } from 'bun:test';
import { sql, Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import type { Database } from '../schema.js';
import { initializeDatabase, migrateToV49, LATEST_SCHEMA_VERSION } from '../connection.js';
import type { PragmaTableInfoRow } from './helpers/ddl-pin.js';

function seedV48Database(): Kysely<Database> {
  const bunDb = new BunDatabase(':memory:');
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: bunDb }),
  });

  bunDb.exec(`
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      source_session_id TEXT
    );

    INSERT INTO artifacts (id, user_id, title, created_at, size_bytes, source_session_id)
    VALUES ('legacy-artifact', 'user-1', 'Legacy', '2026-01-01T00:00:00.000Z', 12, 'session-1');

    PRAGMA user_version = 48;
  `);

  return db;
}

describe('migration v49 (artifacts.updated_at)', () => {
  it('adds a nullable TEXT column with no default, after the existing columns', async () => {
    const db = seedV48Database();
    await migrateToV49(db);

    const columns = (await sql.raw<PragmaTableInfoRow>('PRAGMA table_info(artifacts)').execute(db)).rows;
    const updatedAt = columns.find((c) => c.name === 'updated_at');

    expect(updatedAt).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 });
    expect(columns.map((c) => c.name)).toEqual([
      'id',
      'user_id',
      'title',
      'created_at',
      'size_bytes',
      'source_session_id',
      'updated_at',
    ]);

    await db.destroy();
  });

  it('an existing row reads NULL -- no backfill', async () => {
    const db = seedV48Database();
    await migrateToV49(db);

    const row = await db.selectFrom('artifacts').where('id', '=', 'legacy-artifact').selectAll().executeTakeFirstOrThrow();

    expect(row.updated_at).toBeNull();
    expect(row.size_bytes).toBe(12);
    expect(row.title).toBe('Legacy');

    await db.destroy();
  });

  it('sets user_version to 49', async () => {
    const db = seedV48Database();
    await migrateToV49(db);

    const result = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(result.rows[0]?.user_version).toBe(49);

    await db.destroy();
  });

  it('is idempotent: running twice leaves the data and the version unchanged', async () => {
    const db = seedV48Database();
    await migrateToV49(db);
    await db.updateTable('artifacts').set({ updated_at: '2026-02-02T00:00:00.000Z' }).where('id', '=', 'legacy-artifact').execute();

    await expect(migrateToV49(db)).resolves.toBeUndefined();

    const row = await db.selectFrom('artifacts').selectAll().executeTakeFirstOrThrow();
    expect(row.updated_at).toBe('2026-02-02T00:00:00.000Z');
    const version = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(version.rows[0]?.user_version).toBe(49);

    await db.destroy();
  });

  it('a fresh database lands on the latest version with the column present and nullable', async () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(49);
    const db = await initializeDatabase(':memory:');

    const columns = (await sql.raw<PragmaTableInfoRow>('PRAGMA table_info(artifacts)').execute(db)).rows;
    expect(columns.find((c) => c.name === 'updated_at')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    const version = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(version.rows[0]?.user_version).toBe(LATEST_SCHEMA_VERSION);
  });
});
