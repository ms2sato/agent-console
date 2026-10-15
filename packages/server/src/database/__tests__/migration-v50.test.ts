/**
 * Migration v50 tests -- the `todos` table (human TODO list,
 * docs/design/human-todo-list.md section 3).
 *
 * The table carries exactly seven CHECK constraints. Each is pinned by one
 * INSERT that violates ONLY that constraint, asserting the failure names it.
 */

import { describe, it, expect } from 'bun:test';
import { sql, Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import type { Database } from '../schema.js';
import { initializeDatabase, migrateToV50, LATEST_SCHEMA_VERSION } from '../connection.js';
import type { PragmaTableInfoRow } from './helpers/ddl-pin.js';

const NOW = '2026-10-15T00:00:00.000Z';

type TodoInsert = Record<string, string | null>;

/** A row that satisfies every constraint: a session-scoped action created by a human. */
function validRow(overrides: TodoInsert = {}): TodoInsert {
  return {
    id: 'todo-1',
    kind: 'action',
    scope: 'session',
    title: 'Do the thing',
    body: 'details',
    session_id: 'session-1',
    created_worker_id: null,
    created_user_id: 'user-1',
    assignee_user_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

async function typedInsert(db: Kysely<Database>, row: TodoInsert): Promise<void> {
  await db
    .insertInto('todos')
    .values(row as never)
    .execute();
}

async function freshDb(): Promise<Kysely<Database>> {
  const bunDb = new BunDatabase(':memory:');
  const db = new Kysely<Database>({ dialect: new BunSqliteDialect({ database: bunDb }) });
  await migrateToV50(db);
  return db;
}

describe('migration v50 (todos table)', () => {
  it('creates the table with the expected columns and the two indexes', async () => {
    const db = await freshDb();

    const columns = (await sql.raw<PragmaTableInfoRow>('PRAGMA table_info(todos)').execute(db)).rows;
    expect(columns.map((c) => c.name)).toEqual([
      'id',
      'kind',
      'scope',
      'title',
      'body',
      'session_id',
      'created_worker_id',
      'created_user_id',
      'assignee_user_id',
      'status',
      'resolution_text',
      'resolved_by_user_id',
      'resolved_at',
      'created_at',
      'updated_at',
    ]);
    const status = columns.find((c) => c.name === 'status');
    expect(status).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'open'" });

    const indexes = (
      await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'todos' AND name LIKE 'idx_%'`.execute(db)
    ).rows.map((r) => r.name);
    expect(indexes.sort()).toEqual(['idx_todos_session_status', 'idx_todos_status_assignee']);

    await db.destroy();
  });

  it('declares exactly the seven named CHECK constraints', async () => {
    const db = await freshDb();
    const ddl = (
      await sql<{ sql: string }>`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'todos'`.execute(db)
    ).rows[0]!.sql;

    const names = [...ddl.matchAll(/CONSTRAINT (\w+)\s+CHECK/g)].map((m) => m[1]);
    expect(names).toEqual([
      'todos_kind_check',
      'todos_scope_check',
      'todos_status_check',
      'todos_creator_check',
      'todos_agent_session_check',
      'todos_session_scope_check',
      'todos_question_scope_check',
    ]);
    expect(ddl).not.toContain('REFERENCES');

    await db.destroy();
  });

  it('accepts a valid row, defaulting status to open', async () => {
    const db = await freshDb();
    await typedInsert(db, validRow());

    const row = await db.selectFrom('todos').selectAll().executeTakeFirstOrThrow();
    expect(row.status).toBe('open');

    await db.destroy();
  });

  describe('each CHECK constraint is violated by exactly one insert', () => {
    const violations: Array<{ constraint: string; row: TodoInsert }> = [
      { constraint: 'todos_kind_check', row: validRow({ kind: 'reminder' }) },
      { constraint: 'todos_scope_check', row: validRow({ scope: 'team' }) },
      { constraint: 'todos_status_check', row: validRow({ status: 'expired' }) },
      {
        constraint: 'todos_creator_check',
        row: validRow({ created_worker_id: null, created_user_id: null }),
      },
      {
        constraint: 'todos_creator_check',
        row: validRow({ created_worker_id: 'worker-1', created_user_id: 'user-1' }),
      },
      {
        constraint: 'todos_agent_session_check',
        row: validRow({ created_worker_id: 'worker-1', created_user_id: null, scope: 'global', session_id: null }),
      },
      {
        constraint: 'todos_session_scope_check',
        row: validRow({ scope: 'session', session_id: null }),
      },
      {
        constraint: 'todos_question_scope_check',
        row: validRow({ kind: 'question', scope: 'global' }),
      },
    ];

    for (const { constraint, row } of violations) {
      it(`${constraint}: ${JSON.stringify(row)}`, async () => {
        const db = await freshDb();

        const error = await typedInsert(db, row).then(
          () => null,
          (e: unknown) => e as Error,
        );

        expect(error).not.toBeNull();
        expect(error!.message).toContain('CHECK constraint failed');
        expect(error!.message).toContain(constraint);

        await db.destroy();
      });
    }
  });

  it('allows the valid neighbours of each violation (global provenance, agent creator with session)', async () => {
    const db = await freshDb();
    await typedInsert(db, validRow({ id: 'a', scope: 'global', session_id: null }));
    await typedInsert(db, validRow({ id: 'b', scope: 'global', session_id: 'session-1' }));
    await typedInsert(
      db,
      validRow({ id: 'c', created_worker_id: 'worker-1', created_user_id: null, scope: 'global', session_id: 'session-1' }),
    );
    await typedInsert(db, validRow({ id: 'd', kind: 'question', scope: 'session' }));

    const count = await db.selectFrom('todos').select(sql<number>`count(*)`.as('n')).executeTakeFirstOrThrow();
    expect(count.n).toBe(4);

    await db.destroy();
  });

  it('sets user_version to 50 and is idempotent', async () => {
    const db = await freshDb();
    await typedInsert(db, validRow());

    await expect(migrateToV50(db)).resolves.toBeUndefined();

    const rows = await db.selectFrom('todos').selectAll().execute();
    expect(rows).toHaveLength(1);
    const version = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(version.rows[0]?.user_version).toBe(50);

    await db.destroy();
  });

  it('a fresh database lands on the latest version with the todos table present', async () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(50);
    const db = await initializeDatabase(':memory:');

    const columns = (await sql.raw<PragmaTableInfoRow>('PRAGMA table_info(todos)').execute(db)).rows;
    expect(columns.length).toBeGreaterThan(0);
    const version = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(version.rows[0]?.user_version).toBe(LATEST_SCHEMA_VERSION);
  });
});
