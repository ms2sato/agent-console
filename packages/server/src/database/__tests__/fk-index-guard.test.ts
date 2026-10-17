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
 * A PARTIAL index (CREATE INDEX ... WHERE ...) does not count: a foreign-key
 * lookup carries no such predicate, so SQLite cannot use it. Rows of
 * PRAGMA index_list with partial = 1 are excluded from the coverage set.
 * Polarity (measured): removing the `partial === 1` skip fails exactly one test,
 * `the audit itself > does not count a partial index as coverage`.
 *
 * Polarity (measured): deleting any one of the six migrateToV53 CREATE INDEX
 * lines that cover a declared foreign key fails this file, and the failure names
 * that table.column -> parent. The two todos indexes cover soft references, so
 * they are pinned by migration-v53.test.ts instead, not by this guard.
 */

import { describe, it, expect } from 'bun:test';
import { sql, type Kysely } from 'kysely';
import { createDatabaseForTest } from '../connection.js';
import type { Database } from '../schema.js';

interface ForeignKeyRow {
  table: string;
  from: string;
}

interface IndexListRow {
  name: string;
  partial: number;
}

const MIN_EXPECTED_FOREIGN_KEYS = 16;

/** Every declared foreign key, and the `table.column -> parent` of those with no full leading index. */
async function auditForeignKeyIndexes(db: Kysely<Database>): Promise<{ enumerated: number; missing: string[] }> {
  const tables = (
    await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`.execute(db)
  ).rows;

  const missing: string[] = [];
  let enumerated = 0;

  for (const { name: table } of tables) {
    const fks = (await sql.raw<ForeignKeyRow>(`PRAGMA foreign_key_list("${table}")`).execute(db)).rows;
    const indexes = (await sql.raw<IndexListRow>(`PRAGMA index_list("${table}")`).execute(db)).rows;

    const leadingColumns = new Set<string>();
    for (const index of indexes) {
      if (index.partial === 1) continue;
      const info = (await sql.raw<{ seqno: number; name: string }>(`PRAGMA index_info("${index.name}")`).execute(db)).rows;
      const first = info.find((r) => r.seqno === 0);
      if (first) leadingColumns.add(first.name);
    }

    for (const fk of fks) {
      enumerated += 1;
      if (!leadingColumns.has(fk.from)) missing.push(`${table}.${fk.from} -> ${fk.table}`);
    }
  }
  return { enumerated, missing };
}

describe('foreign-key columns lead an index', () => {
  it('every declared foreign-key column is the first column of some full index', async () => {
    const db = await createDatabaseForTest(':memory:');
    try {
      const { enumerated, missing } = await auditForeignKeyIndexes(db);
      expect(enumerated).toBeGreaterThanOrEqual(MIN_EXPECTED_FOREIGN_KEYS);
      expect(missing).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  describe('the audit itself', () => {
    async function scratchDb(createIndexSql: string | null): Promise<Kysely<Database>> {
      const db = await createDatabaseForTest(':memory:');
      await sql.raw('CREATE TABLE guard_parent (id TEXT PRIMARY KEY)').execute(db);
      await sql
        .raw('CREATE TABLE guard_child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES guard_parent(id), status TEXT)')
        .execute(db);
      if (createIndexSql) await sql.raw(createIndexSql).execute(db);
      return db;
    }

    it('flags a foreign key with no index', async () => {
      const db = await scratchDb(null);
      try {
        expect((await auditForeignKeyIndexes(db)).missing).toEqual(['guard_child.parent_id -> guard_parent']);
      } finally {
        await db.destroy();
      }
    });

    it('accepts a full index that leads with the column', async () => {
      const db = await scratchDb('CREATE INDEX idx_guard_child_parent ON guard_child (parent_id)');
      try {
        expect((await auditForeignKeyIndexes(db)).missing).toEqual([]);
      } finally {
        await db.destroy();
      }
    });

    it('does not count a partial index as coverage', async () => {
      const db = await scratchDb("CREATE INDEX idx_guard_child_parent ON guard_child (parent_id) WHERE status = 'active'");
      try {
        expect((await auditForeignKeyIndexes(db)).missing).toEqual(['guard_child.parent_id -> guard_parent']);
      } finally {
        await db.destroy();
      }
    });
  });
});
