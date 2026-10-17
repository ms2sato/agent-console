/**
 * Foreign-key index guard.
 *
 * Rule: every column that carries a REFERENCES clause leads some index (it is
 * seqno 0 of an index returned by PRAGMA index_list; primary-key and UNIQUE
 * autoindexes count). SQLite does not index the child side of a foreign key
 * itself, so a parent DELETE with CASCADE / SET NULL / RESTRICT would scan the
 * whole child table.
 *
 * Scope: only declared foreign keys are enumerable. Soft references (an `*_id`
 * column without a REFERENCES clause) are out of scope by design.
 *
 * Polarity: deleting any one of the migrateToV53 CREATE INDEX lines makes this
 * file fail naming that table.column.
 */

import { describe, it, expect } from 'bun:test';
import { sql } from 'kysely';
import { createDatabaseForTest } from '../connection.js';

interface ForeignKeyRow {
  table: string;
  from: string;
}

const MIN_EXPECTED_FOREIGN_KEYS = 16;

describe('foreign-key columns lead an index', () => {
  it('every declared foreign-key column is the first column of some index', async () => {
    const db = await createDatabaseForTest(':memory:');
    try {
      const tables = (
        await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`.execute(db)
      ).rows;

      const missing: string[] = [];
      let enumerated = 0;

      for (const { name: table } of tables) {
        const fks = (await sql.raw<ForeignKeyRow>(`PRAGMA foreign_key_list("${table}")`).execute(db)).rows;
        const indexes = (await sql.raw<{ name: string }>(`PRAGMA index_list("${table}")`).execute(db)).rows;

        const leadingColumns = new Set<string>();
        for (const index of indexes) {
          const info = (await sql.raw<{ seqno: number; name: string }>(`PRAGMA index_info("${index.name}")`).execute(db)).rows;
          const first = info.find((r) => r.seqno === 0);
          if (first) leadingColumns.add(first.name);
        }

        for (const fk of fks) {
          enumerated += 1;
          if (!leadingColumns.has(fk.from)) missing.push(`${table}.${fk.from} -> ${fk.table}`);
        }
      }

      expect(enumerated).toBeGreaterThanOrEqual(MIN_EXPECTED_FOREIGN_KEYS);
      expect(missing).toEqual([]);
    } finally {
      await db.destroy();
    }
  });
});
