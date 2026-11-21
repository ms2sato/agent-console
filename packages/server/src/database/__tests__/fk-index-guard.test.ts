/**
 * Foreign-key index guard.
 *
 * Rule: a foreign key with N columns is covered when the first N columns of some
 * full index are exactly the key's columns, in any order (a single column is seqno
 * 0 of an index returned by PRAGMA index_list; primary-key and UNIQUE autoindexes
 * count). Order inside the prefix does not matter because the parent-side lookup is
 * an equality on every key column: measured on Bun's SQLite, a child key (a, b) with
 * only an index on (b, a) plans `SEARCH c USING COVERING INDEX c_ba (b=? AND a=?)`,
 * and with no index `SCAN c`. SQLite does not index the child side of a foreign key
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
  /** Groups the columns of one (possibly composite) foreign key. */
  id: number;
  seq: number;
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

    const fullIndexColumns: string[][] = [];
    for (const index of indexes) {
      if (index.partial === 1) continue;
      const info = (await sql.raw<{ seqno: number; name: string }>(`PRAGMA index_info("${index.name}")`).execute(db)).rows;
      fullIndexColumns.push([...info].sort((a, b) => a.seqno - b.seqno).map((r) => r.name));
    }

    // A foreign key with N columns is covered when the first N columns of one full index are exactly the
    // key's columns, in any order: the lookup is an equality on each, and the planner uses an index
    // whose prefix is that set (see the header). Checking the columns one by one would demand a second
    // index just for the later column; accepting the columns anywhere in the index would count an index
    // whose prefix does not hold them all.
    const byKey = new Map<number, ForeignKeyRow[]>();
    for (const fk of fks) byKey.set(fk.id, [...(byKey.get(fk.id) ?? []), fk]);
    for (const columns of byKey.values()) {
      enumerated += 1;
      const wanted = new Set(columns.map((c) => c.from));
      const covered = fullIndexColumns.some((index) => {
        const prefix = index.slice(0, wanted.size);
        // Every key column once: a prefix such as (a, a) has the right length and only key columns, yet lacks b.
        return prefix.length === wanted.size && new Set(prefix).size === wanted.size && prefix.every((column) => wanted.has(column));
      });
      if (!covered) missing.push(`${table}.${columns.map((c) => c.from).join(',')} -> ${columns[0]!.table}`);
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

    // Key (a, b). One test per state so a failure names the state.
    const COMPOSITE_STATES: Array<{ name: string; indexes: string[]; covered: boolean }> = [
      { name: 'no index', indexes: [], covered: false },
      { name: 'an index on (a) only', indexes: ['(a)'], covered: false },
      { name: 'an index on (a, id): the first column, then an unrelated one', indexes: ['(a, id)'], covered: false },
      { name: 'an index on (b, id, a): both columns, not as the prefix', indexes: ['(b, id, a)'], covered: false },
      { name: 'an index on (a, a): the right length, but b is missing from the prefix', indexes: ['(a, a)'], covered: false },
      { name: 'an index on (b, a): the reversed prefix', indexes: ['(b, a)'], covered: true },
      { name: 'an index on (a, b, id): the key in order, then more', indexes: ['(a, b, id)'], covered: true },
    ];
    for (const state of COMPOSITE_STATES) {
      it(`a composite foreign key (a, b) with ${state.name} is ${state.covered ? 'covered' : 'uncovered'}`, async () => {
        const db = await createDatabaseForTest(':memory:');
        try {
          await sql.raw('CREATE TABLE guard_pair (a TEXT, b TEXT, PRIMARY KEY (a, b))').execute(db);
          await sql
            .raw('CREATE TABLE guard_pair_child (id TEXT PRIMARY KEY, a TEXT, b TEXT, FOREIGN KEY (a, b) REFERENCES guard_pair(a, b))')
            .execute(db);
          for (const [i, columns] of state.indexes.entries()) {
            await sql.raw(`CREATE INDEX idx_gpc_${i} ON guard_pair_child ${columns}`).execute(db);
          }
          const missing = (await auditForeignKeyIndexes(db)).missing.filter((m) => m.startsWith('guard_pair_child'));
          expect(missing).toEqual(state.covered ? [] : ['guard_pair_child.a,b -> guard_pair']);
        } finally {
          await db.destroy();
        }
      });
    }

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
