/**
 * Migration v54 tests -- `repositories.pause_command` / `repositories.resume_command`
 * (per-repository session pause / resume hook commands).
 *
 * Two additive nullable TEXT columns with no default: existing rows read back
 * NULL ("no hook configured").
 */

import { describe, it, expect } from 'bun:test';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../schema.js';
import { initializeDatabase, migrateToV54, LATEST_SCHEMA_VERSION } from '../connection.js';
import type { PragmaTableInfoRow } from './helpers/ddl-pin.js';

const NOW = '2026-10-18T00:00:00.000Z';

/** A database at the v53 shape: a fully migrated one with the two v54 columns removed. */
async function v53Db(): Promise<Kysely<Database>> {
  const db = await initializeDatabase(':memory:');
  await sql`ALTER TABLE repositories DROP COLUMN pause_command`.execute(db);
  await sql`ALTER TABLE repositories DROP COLUMN resume_command`.execute(db);
  await sql`PRAGMA user_version = 53`.execute(db);
  return db;
}

async function columnNames(db: Kysely<Database>): Promise<string[]> {
  const columns = (await sql.raw<PragmaTableInfoRow>('PRAGMA table_info(repositories)').execute(db)).rows;
  return columns.map((c) => c.name);
}

async function userVersion(db: Kysely<Database>): Promise<number | undefined> {
  const version = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
  return version.rows[0]?.user_version;
}

describe('migration v54 (repositories.pause_command / resume_command)', () => {
  it('the v53 fixture really lacks both columns', async () => {
    const db = await v53Db();
    const names = await columnNames(db);
    expect(names).not.toContain('pause_command');
    expect(names).not.toContain('resume_command');
    expect(await userVersion(db)).toBe(53);
    await db.destroy();
  });

  it('adds exactly the two columns as nullable TEXT without a default', async () => {
    const db = await v53Db();
    const before = await columnNames(db);

    await migrateToV54(db);

    const columns = (await sql.raw<PragmaTableInfoRow>('PRAGMA table_info(repositories)').execute(db)).rows;
    expect(columns.map((c) => c.name).filter((n) => !before.includes(n))).toEqual([
      'pause_command',
      'resume_command',
    ]);
    expect(columns.length).toBe(before.length + 2);
    for (const name of ['pause_command', 'resume_command']) {
      expect(columns.find((c) => c.name === name)).toMatchObject({
        type: 'TEXT',
        notnull: 0,
        dflt_value: null,
      });
    }

    await db.destroy();
  });

  it('existing rows read back with null commands', async () => {
    const db = await v53Db();
    await sql`
      INSERT INTO repositories (id, name, path, created_at, updated_at)
      VALUES ('repo-existing', 'existing', '/tmp/existing', ${NOW}, ${NOW})
    `.execute(db);

    await migrateToV54(db);

    const row = await db.selectFrom('repositories').selectAll().executeTakeFirstOrThrow();
    expect(row.id).toBe('repo-existing');
    expect(row.pause_command).toBeNull();
    expect(row.resume_command).toBeNull();

    await db.destroy();
  });

  it('sets user_version to 54 and is idempotent (rows and columns survive a second run)', async () => {
    const db = await v53Db();
    await sql`
      INSERT INTO repositories (id, name, path, created_at, updated_at)
      VALUES ('repo-existing', 'existing', '/tmp/existing', ${NOW}, ${NOW})
    `.execute(db);
    await migrateToV54(db);

    await expect(migrateToV54(db)).resolves.toBeUndefined();

    expect(await db.selectFrom('repositories').selectAll().execute()).toHaveLength(1);
    const names = await columnNames(db);
    expect(names.filter((n) => n === 'pause_command')).toHaveLength(1);
    expect(names.filter((n) => n === 'resume_command')).toHaveLength(1);
    expect(await userVersion(db)).toBe(54);

    await db.destroy();
  });

  it('completes when only one of the two columns already exists', async () => {
    const db = await v53Db();
    await sql`ALTER TABLE repositories ADD COLUMN pause_command TEXT`.execute(db);

    await migrateToV54(db);

    const names = await columnNames(db);
    expect(names).toContain('pause_command');
    expect(names).toContain('resume_command');
    expect(await userVersion(db)).toBe(54);

    await db.destroy();
  });

  it('a fresh database lands on version 54 with both columns present', async () => {
    expect(LATEST_SCHEMA_VERSION).toBe(54);
    const db = await initializeDatabase(':memory:');
    try {
      const names = await columnNames(db);
      expect(names).toContain('pause_command');
      expect(names).toContain('resume_command');
      expect(await userVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      await db.destroy();
    }
  });
});
