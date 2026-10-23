/**
 * Tests for addDatetime and ISO8601_GLOB_PATTERN.
 *
 * Runs against a real in-memory SQLite database (no memfs needed) so the
 * CHECK constraint is evaluated by SQLite itself.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql, Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import { addDatetime, ISO8601_GLOB_PATTERN } from '../schema-helpers.js';

describe('schema-helpers', () => {
  let bunDb: BunDatabase;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: Kysely<any>;

  beforeEach(async () => {
    bunDb = new BunDatabase(':memory:');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db = new Kysely<any>({ dialect: new BunSqliteDialect({ database: bunDb }) });
    await addDatetime(
      db.schema.createTable('probe').addColumn('id', 'text', (c) => c.primaryKey()),
      'probe',
      'at'
    ).execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function insertAt(id: string, at: string | null): Promise<void> {
    await sql`INSERT INTO probe (id, at) VALUES (${id}, ${at})`.execute(db);
  }

  // Polarity (measured 2026-10-23): with the old pattern '????-??-??T??:??:??*Z',
  // "uses digit classes in every numeric position" (the constant pin) and
  // "rejects a non-digit substitution in a numeric position" FAIL; "rejects a value
  // without the trailing Z", "accepts Date.prototype.toISOString output" and
  // "accepts NULL" pass in both worlds (they guard addDatetime's shape, not this fix).
  describe('ISO8601_GLOB_PATTERN', () => {
    it('uses digit classes in every numeric position', () => {
      expect(ISO8601_GLOB_PATTERN).toBe(
        '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
      );
    });
  });

  describe('addDatetime CHECK constraint', () => {
    it('rejects a non-digit substitution in a numeric position', async () => {
      await expect(insertAt('a', '2024-XX-01T00:00:00Z')).rejects.toThrow(
        /CHECK constraint failed|probe_at_iso8601/
      );
    });

    it('rejects a value without the trailing Z', async () => {
      await expect(insertAt('a', '2024-01-01T00:00:00')).rejects.toThrow(
        /CHECK constraint failed|probe_at_iso8601/
      );
    });

    it('accepts Date.prototype.toISOString output', async () => {
      const now = new Date().toISOString();
      await insertAt('a', now);
      const row = await sql<{ at: string }>`SELECT at FROM probe WHERE id = 'a'`.execute(db);
      expect(row.rows[0].at).toBe(now);
    });

    it('accepts NULL', async () => {
      await insertAt('a', null);
      const row = await sql<{ at: string | null }>`SELECT at FROM probe WHERE id = 'a'`.execute(db);
      expect(row.rows[0].at).toBeNull();
    });
  });
});
