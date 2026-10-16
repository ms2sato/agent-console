/**
 * Migration v51 tests -- `todos.resolved_by_worker_id` (agent-recorded
 * resolutions, docs/design/human-todo-list.md section 3).
 *
 * One additive nullable column, no CHECK: the "set only with status done"
 * invariant is enforced in the repository, not the schema.
 */

import { describe, it, expect } from 'bun:test';
import { sql, Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import type { Database } from '../schema.js';
import { initializeDatabase, migrateToV50, migrateToV51, LATEST_SCHEMA_VERSION } from '../connection.js';
import type { PragmaTableInfoRow } from './helpers/ddl-pin.js';

const NOW = '2026-10-16T00:00:00.000Z';

async function v50Db(): Promise<Kysely<Database>> {
  const bunDb = new BunDatabase(':memory:');
  const db = new Kysely<Database>({ dialect: new BunSqliteDialect({ database: bunDb }) });
  await migrateToV50(db);
  return db;
}

async function insertV50Row(db: Kysely<Database>, id: string): Promise<void> {
  await sql`
    INSERT INTO todos (id, kind, scope, title, body, session_id, created_user_id, created_at, updated_at)
    VALUES (${id}, 'action', 'session', 't', 'b', 'session-1', 'user-1', ${NOW}, ${NOW})
  `.execute(db);
}

describe('migration v51 (todos.resolved_by_worker_id)', () => {
  it('adds a nullable TEXT column without a default, after the v50 columns', async () => {
    const db = await v50Db();
    await migrateToV51(db);

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
      'resolved_by_worker_id',
    ]);
    expect(columns.find((c) => c.name === 'resolved_by_worker_id')).toMatchObject({
      type: 'TEXT',
      notnull: 0,
      dflt_value: null,
    });

    await db.destroy();
  });

  it('existing rows read back with a null worker', async () => {
    const db = await v50Db();
    await insertV50Row(db, 'todo-existing');

    await migrateToV51(db);

    const row = await db.selectFrom('todos').selectAll().executeTakeFirstOrThrow();
    expect(row.id).toBe('todo-existing');
    expect(row.resolved_by_worker_id).toBeNull();

    await db.destroy();
  });

  it('sets user_version to 51 and is idempotent (rows and column survive a second run)', async () => {
    const db = await v50Db();
    await insertV50Row(db, 'todo-existing');
    await migrateToV51(db);

    await expect(migrateToV51(db)).resolves.toBeUndefined();

    expect(await db.selectFrom('todos').selectAll().execute()).toHaveLength(1);
    const columns = (await sql.raw<PragmaTableInfoRow>('PRAGMA table_info(todos)').execute(db)).rows;
    expect(columns.filter((c) => c.name === 'resolved_by_worker_id')).toHaveLength(1);
    const version = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(version.rows[0]?.user_version).toBe(51);

    await db.destroy();
  });

  it('a fresh database lands on the latest version with the column present', async () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(51);
    const db = await initializeDatabase(':memory:');

    const columns = (await sql.raw<PragmaTableInfoRow>('PRAGMA table_info(todos)').execute(db)).rows;
    expect(columns.map((c) => c.name)).toContain('resolved_by_worker_id');
    const version = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(version.rows[0]?.user_version).toBe(LATEST_SCHEMA_VERSION);
  });
});
