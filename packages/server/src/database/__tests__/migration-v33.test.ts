/**
 * Migration v33 tests — `bookmarks` table.
 *
 * v33 creates the `bookmarks` table: `id` (TEXT PK), `user_id` (TEXT NOT
 * NULL, FK users.id), `source_session_id` (TEXT, nullable -- provenance
 * only, never used for lookup or cascade), `url` (TEXT NOT NULL), `title`
 * (TEXT, nullable), `created_at` (TEXT NOT NULL). Mirrors
 * `migration-v28.test.ts` (artifacts table).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'kysely';
import { initializeDatabase, closeDatabase, migrateToV33 } from '../connection.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';

const TEST_CONFIG_DIR = '/test/config';

interface PragmaTableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface PragmaForeignKeyListRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

/**
 * `bookmarks.user_id` carries a real FK constraint (`REFERENCES users.id`),
 * so every seeded bookmark needs a matching `users` row first -- otherwise
 * the insert below violates the constraint (`PRAGMA foreign_keys = ON` is
 * always set, see `connection.ts`'s `doInitializeDatabase`).
 */
async function seedUser(
  db: Awaited<ReturnType<typeof initializeDatabase>>,
  id: string
): Promise<void> {
  await db
    .insertInto('users')
    .values({
      id,
      os_uid: null,
      username: id,
      home_dir: `/home/${id}`,
      created_at: '2026-08-20T00:00:00.000Z',
      updated_at: '2026-08-20T00:00:00.000Z',
    })
    .execute();
}

async function seedBookmark(
  db: Awaited<ReturnType<typeof initializeDatabase>>,
  overrides: { id: string; source_session_id?: string | null; title?: string | null }
): Promise<void> {
  await db
    .insertInto('bookmarks')
    .values({
      id: overrides.id,
      user_id: 'user-1',
      source_session_id: overrides.source_session_id ?? null,
      url: 'https://example.com',
      title: overrides.title ?? null,
      created_at: '2026-08-20T00:00:00.000Z',
    })
    .execute();
}

describe('migration v33 (bookmarks table)', () => {
  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
  });

  afterEach(async () => {
    await closeDatabase();
    cleanupMemfs();
  });

  it('advances the schema version to 33', async () => {
    const db = await initializeDatabase(':memory:');
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(33);
  });

  it('creates the bookmarks table with the expected column shapes', async () => {
    const db = await initializeDatabase(':memory:');

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(bookmarks)`.execute(db);
    const byName = new Map(columns.rows.map((c) => [c.name, c]));

    const id = byName.get('id');
    expect(id).toBeDefined();
    expect(id!.type.toUpperCase()).toBe('TEXT');
    expect(id!.pk).toBe(1);

    const userId = byName.get('user_id');
    expect(userId).toBeDefined();
    expect(userId!.type.toUpperCase()).toBe('TEXT');
    expect(userId!.notnull).toBe(1);

    const sourceSessionId = byName.get('source_session_id');
    expect(sourceSessionId).toBeDefined();
    expect(sourceSessionId!.type.toUpperCase()).toBe('TEXT');
    expect(sourceSessionId!.notnull).toBe(0);

    const url = byName.get('url');
    expect(url).toBeDefined();
    expect(url!.type.toUpperCase()).toBe('TEXT');
    expect(url!.notnull).toBe(1);

    const title = byName.get('title');
    expect(title).toBeDefined();
    expect(title!.type.toUpperCase()).toBe('TEXT');
    expect(title!.notnull).toBe(0);

    const createdAt = byName.get('created_at');
    expect(createdAt).toBeDefined();
    expect(createdAt!.type.toUpperCase()).toBe('TEXT');
    expect(createdAt!.notnull).toBe(1);
  });

  it('round-trips a non-null source_session_id and title', async () => {
    const db = await initializeDatabase(':memory:');
    await seedUser(db, 'user-1');
    await seedBookmark(db, { id: 'bookmark-with-source', source_session_id: 'session-1', title: 'My bookmark' });

    const row = await db
      .selectFrom('bookmarks')
      .where('id', '=', 'bookmark-with-source')
      .selectAll()
      .executeTakeFirstOrThrow();

    expect(row.user_id).toBe('user-1');
    expect(row.url).toBe('https://example.com');
    expect(row.source_session_id).toBe('session-1');
    expect(row.title).toBe('My bookmark');
  });

  it('round-trips a null source_session_id and null title (provenance-unavailable / no-title case)', async () => {
    const db = await initializeDatabase(':memory:');
    await seedUser(db, 'user-1');
    await seedBookmark(db, { id: 'bookmark-no-source' });

    const row = await db
      .selectFrom('bookmarks')
      .where('id', '=', 'bookmark-no-source')
      .select(['source_session_id', 'title'])
      .executeTakeFirstOrThrow();

    expect(row.source_session_id).toBeNull();
    expect(row.title).toBeNull();
  });

  it('is idempotent when re-applied (duplicate table/index are ignored)', async () => {
    const db = await initializeDatabase(':memory:');

    await expect(migrateToV33(db)).resolves.toBeUndefined();
    await expect(migrateToV33(db)).resolves.toBeUndefined();

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(bookmarks)`.execute(db);
    expect(columns.rows.some((c) => c.name === 'id')).toBe(true);
  });

  it('declares a real FK constraint on user_id referencing users(id) ON DELETE CASCADE', async () => {
    const db = await initializeDatabase(':memory:');

    const fks = await sql<PragmaForeignKeyListRow>`PRAGMA foreign_key_list(bookmarks)`.execute(db);
    expect(fks.rows).toHaveLength(1);
    expect(fks.rows[0]?.table).toBe('users');
    expect(fks.rows[0]?.from).toBe('user_id');
    expect(fks.rows[0]?.to).toBe('id');
    expect(fks.rows[0]?.on_delete.toUpperCase()).toBe('CASCADE');
  });

  it('rejects inserting a bookmark whose user_id has no matching users row', async () => {
    const db = await initializeDatabase(':memory:');

    await expect(seedBookmark(db, { id: 'bookmark-orphan-user' })).rejects.toThrow();
  });

  it('cascade-deletes bookmark rows when their owning user is deleted', async () => {
    const db = await initializeDatabase(':memory:');
    await seedUser(db, 'user-1');
    await seedBookmark(db, { id: 'bookmark-cascade-target' });

    await db.deleteFrom('users').where('id', '=', 'user-1').execute();

    const row = await db
      .selectFrom('bookmarks')
      .where('id', '=', 'bookmark-cascade-target')
      .selectAll()
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it('has an index on user_id', async () => {
    const db = await initializeDatabase(':memory:');

    const indexes = await sql<{ name: string }>`PRAGMA index_list(bookmarks)`.execute(db);
    expect(indexes.rows.some((idx) => idx.name === 'idx_bookmarks_user_id')).toBe(true);
  });
});
