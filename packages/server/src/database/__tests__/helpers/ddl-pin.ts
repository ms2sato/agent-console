/**
 * Shared DDL-pin helper for migration tests.
 *
 * Generalizes the inline `PRAGMA table_info(...)` + `sqlite_master.sql`
 * pattern that migration tests (e.g. `migration-v19.test.ts`,
 * `migration-v29.test.ts`, `migration-v36.test.ts`) previously duplicated
 * per-test: assert a rebuilt table's column shape column-by-column, and
 * assert the table's raw CREATE TABLE text does/doesn't contain given
 * substrings (e.g. a CHECK constraint name, a DEFAULT expression).
 */

import { expect } from 'bun:test';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../schema.js';

export interface PragmaTableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export interface ExpectRebuiltTableDdlOptions {
  /** Expected `PRAGMA table_info(<table>)` rows, in any order. */
  expectedColumns: PragmaTableInfoRow[];
  /** Substrings that must appear in the table's raw `sqlite_master.sql` text. */
  mustContain: string[];
  /** Substrings that must NOT appear in the table's raw `sqlite_master.sql` text. */
  mustNotContain: string[];
}

/**
 * Assert a rebuilt table's column shape and raw DDL text match expectations.
 *
 * Column matching is by `name`: every expected column must exist in the
 * actual `PRAGMA table_info` output with identical `type`, `notnull`,
 * `dflt_value`, and `pk`, and the actual output must contain exactly the
 * same set of column names as `expectedColumns` (no extras, none missing).
 */
export async function expectRebuiltTableDdl(
  db: Kysely<Database>,
  table: string,
  options: ExpectRebuiltTableDdlOptions
): Promise<void> {
  const { expectedColumns, mustContain, mustNotContain } = options;

  const columnsResult = await sql.raw<PragmaTableInfoRow>(`PRAGMA table_info(${table})`).execute(db);
  const actualByName = new Map(columnsResult.rows.map((row) => [row.name, row]));

  expect(new Set(actualByName.keys())).toEqual(new Set(expectedColumns.map((c) => c.name)));

  for (const expected of expectedColumns) {
    const actual = actualByName.get(expected.name);
    expect(actual, `${table}.${expected.name} is missing from PRAGMA table_info`).toBeDefined();
    expect(actual!.type, `${table}.${expected.name}.type`).toBe(expected.type);
    expect(actual!.notnull, `${table}.${expected.name}.notnull`).toBe(expected.notnull);
    expect(actual!.dflt_value, `${table}.${expected.name}.dflt_value`).toBe(expected.dflt_value);
    expect(actual!.pk, `${table}.${expected.name}.pk`).toBe(expected.pk);
  }

  const ddlResult = await sql<{ sql: string | null }>`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}
  `.execute(db);
  const ddl = ddlResult.rows[0]?.sql ?? '';

  for (const needle of mustContain) {
    expect(ddl, `${table} DDL must contain "${needle}"`).toContain(needle);
  }
  for (const needle of mustNotContain) {
    expect(ddl, `${table} DDL must not contain "${needle}"`).not.toContain(needle);
  }
}
