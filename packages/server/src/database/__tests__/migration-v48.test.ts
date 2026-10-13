/**
 * Migration v48 tests -- adds `timers.backoff_factor` and
 * `timers.max_interval_seconds` (the exponential-backoff mode of the periodic
 * timer; see `migrateToV48`'s doc comment in `connection.ts`).
 *
 * Two `ALTER TABLE ... ADD COLUMN` statements, no rebuild, no backup file --
 * the same shape as `migration-v37.test.ts` / `migration-v47.test.ts`. A
 * v47-shaped `timers` table (the six columns migration v16 created) is seeded
 * directly against a raw Bun SQLite instance, then the production
 * `migrateToV48` is invoked against it.
 */

import { describe, it, expect } from 'bun:test';
import { sql, Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import type { Database } from '../schema.js';
import { migrateToV48 } from '../connection.js';
import type { PragmaTableInfoRow } from './helpers/ddl-pin.js';

function seedV47Database(): Kysely<Database> {
  const bunDb = new BunDatabase(':memory:');
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: bunDb }),
  });

  bunDb.exec(`
    CREATE TABLE timers (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      interval_seconds INTEGER NOT NULL,
      action TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    INSERT INTO timers (id, session_id, worker_id, interval_seconds, action, created_at)
    VALUES ('legacy-timer', 'session-1', 'worker-1', 1800, 'poll', '2026-01-01T00:00:00.000Z');

    PRAGMA user_version = 47;
  `);

  return db;
}

describe('migration v48 (timers.backoff_factor + timers.max_interval_seconds)', () => {
  it('adds both columns with the owner-approved types, NOT NULL and defaults', async () => {
    const db = seedV47Database();
    await migrateToV48(db);

    const columns = (await sql.raw<PragmaTableInfoRow>('PRAGMA table_info(timers)').execute(db)).rows;
    const backoff = columns.find((c) => c.name === 'backoff_factor');
    const max = columns.find((c) => c.name === 'max_interval_seconds');

    expect(backoff).toMatchObject({ type: 'REAL', notnull: 1, dflt_value: '1', pk: 0 });
    expect(max).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '86400', pk: 0 });
    expect(columns.map((c) => c.name)).toEqual([
      'id',
      'session_id',
      'worker_id',
      'interval_seconds',
      'action',
      'created_at',
      'backoff_factor',
      'max_interval_seconds',
    ]);

    await db.destroy();
  });

  it('a legacy (pre-existing) row reads the fixed-interval defaults -- no backfill', async () => {
    const db = seedV47Database();
    await migrateToV48(db);

    const row = await db
      .selectFrom('timers')
      .where('id', '=', 'legacy-timer')
      .selectAll()
      .executeTakeFirstOrThrow();

    expect(row.backoff_factor).toBe(1);
    expect(row.max_interval_seconds).toBe(86400);
    expect(row.interval_seconds).toBe(1800);

    await db.destroy();
  });

  it('sets user_version to 48', async () => {
    const db = seedV47Database();
    await migrateToV48(db);

    const result = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(result.rows[0]?.user_version).toBe(48);

    await db.destroy();
  });

  it('is idempotent: running twice leaves the data and the version unchanged', async () => {
    const db = seedV47Database();
    await migrateToV48(db);
    await db
      .updateTable('timers')
      .set({ backoff_factor: 2, max_interval_seconds: 600 })
      .where('id', '=', 'legacy-timer')
      .execute();

    await expect(migrateToV48(db)).resolves.toBeUndefined();

    const row = await db.selectFrom('timers').selectAll().executeTakeFirstOrThrow();
    expect(row.backoff_factor).toBe(2);
    expect(row.max_interval_seconds).toBe(600);
    const version = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(version.rows[0]?.user_version).toBe(48);

    await db.destroy();
  });
});
