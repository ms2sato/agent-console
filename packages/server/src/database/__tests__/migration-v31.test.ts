/**
 * Migration v31 tests — `user_notification_cursor` table (Notification
 * Center Phase 1, Issue #1353).
 *
 * v31 creates the `user_notification_cursor` table: `user_id` (TEXT PK, FK
 * users.id ON DELETE CASCADE), `last_seen_at` (TEXT NOT NULL). One row per
 * user; `last_seen_at` is a monotonic high-water mark for the bell badge --
 * NOT per-item read state (N2). See docs/design/notification-center.md §5.
 *
 * PRAGMA foreign_keys is always ON for this connection (see
 * `connection.ts`'s `doInitializeDatabase`, and `migration-v28.test.ts`'s
 * identical note for the `artifacts` table), so FK enforcement is asserted
 * directly rather than skipped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'kysely';
import { initializeDatabase, closeDatabase, migrateToV31 } from '../connection.js';
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
      created_at: '2026-08-18T00:00:00.000Z',
      updated_at: '2026-08-18T00:00:00.000Z',
    })
    .execute();
}

async function seedCursor(
  db: Awaited<ReturnType<typeof initializeDatabase>>,
  overrides: { user_id: string; last_seen_at: string }
): Promise<void> {
  await db
    .insertInto('user_notification_cursor')
    .values({
      user_id: overrides.user_id,
      last_seen_at: overrides.last_seen_at,
    })
    .execute();
}

describe('migration v31 (user_notification_cursor table)', () => {
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

  it('advances the schema version to 31', async () => {
    const db = await initializeDatabase(':memory:');
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(31);
  });

  it('creates the user_notification_cursor table with the expected column shapes', async () => {
    const db = await initializeDatabase(':memory:');

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(user_notification_cursor)`.execute(db);
    const byName = new Map(columns.rows.map((c) => [c.name, c]));

    const userId = byName.get('user_id');
    expect(userId).toBeDefined();
    expect(userId!.type.toUpperCase()).toBe('TEXT');
    expect(userId!.pk).toBe(1);

    const lastSeenAt = byName.get('last_seen_at');
    expect(lastSeenAt).toBeDefined();
    expect(lastSeenAt!.type.toUpperCase()).toBe('TEXT');
    expect(lastSeenAt!.notnull).toBe(1);
  });

  it('round-trips an insert/select of a cursor row', async () => {
    const db = await initializeDatabase(':memory:');
    await seedUser(db, 'user-1');
    await seedCursor(db, { user_id: 'user-1', last_seen_at: '2026-08-18T00:00:00.000Z' });

    const row = await db
      .selectFrom('user_notification_cursor')
      .where('user_id', '=', 'user-1')
      .selectAll()
      .executeTakeFirstOrThrow();

    expect(row.user_id).toBe('user-1');
    expect(row.last_seen_at).toBe('2026-08-18T00:00:00.000Z');
  });

  it('is idempotent when re-applied (duplicate table is ignored)', async () => {
    const db = await initializeDatabase(':memory:');

    await expect(migrateToV31(db)).resolves.toBeUndefined();
    await expect(migrateToV31(db)).resolves.toBeUndefined();

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(user_notification_cursor)`.execute(db);
    expect(columns.rows.some((c) => c.name === 'user_id')).toBe(true);
  });

  it('declares a real FK constraint on user_id referencing users(id) ON DELETE CASCADE', async () => {
    const db = await initializeDatabase(':memory:');

    const fks = await sql<PragmaForeignKeyListRow>`PRAGMA foreign_key_list(user_notification_cursor)`.execute(db);
    expect(fks.rows).toHaveLength(1);
    expect(fks.rows[0]?.table).toBe('users');
    expect(fks.rows[0]?.from).toBe('user_id');
    expect(fks.rows[0]?.to).toBe('id');
    expect(fks.rows[0]?.on_delete.toUpperCase()).toBe('CASCADE');
  });

  it('rejects inserting a cursor row whose user_id has no matching users row', async () => {
    const db = await initializeDatabase(':memory:');

    await expect(
      seedCursor(db, { user_id: 'orphan-user', last_seen_at: '2026-08-18T00:00:00.000Z' })
    ).rejects.toThrow();
  });

  it('cascade-deletes the cursor row when its owning user is deleted', async () => {
    const db = await initializeDatabase(':memory:');
    await seedUser(db, 'user-1');
    await seedCursor(db, { user_id: 'user-1', last_seen_at: '2026-08-18T00:00:00.000Z' });

    await db.deleteFrom('users').where('id', '=', 'user-1').execute();

    const row = await db
      .selectFrom('user_notification_cursor')
      .where('user_id', '=', 'user-1')
      .selectAll()
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });
});
