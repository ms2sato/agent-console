/**
 * Migration v34 tests — `bookmarks.origin` column (Issue #1390, agent
 * registration over MCP).
 *
 * v34 adds `origin TEXT NOT NULL DEFAULT 'user'` to the `bookmarks` table
 * created in v33. Mirrors `migration-v33.test.ts`'s structure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'kysely';
import { initializeDatabase, closeDatabase, migrateToV34 } from '../connection.js';
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

/**
 * `bookmarks.user_id` carries a real FK constraint, so every seeded
 * bookmark needs a matching `users` row first (mirrors
 * `migration-v33.test.ts`'s `seedUser`).
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
      created_at: '2026-08-28T00:00:00.000Z',
      updated_at: '2026-08-28T00:00:00.000Z',
    })
    .execute();
}

describe('migration v34 (bookmarks.origin column)', () => {
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

  it("adds the origin column as TEXT NOT NULL DEFAULT 'user'", async () => {
    const db = await initializeDatabase(':memory:');

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(bookmarks)`.execute(db);
    const origin = columns.rows.find((c) => c.name === 'origin');

    expect(origin).toBeDefined();
    expect(origin!.type.toUpperCase()).toBe('TEXT');
    expect(origin!.notnull).toBe(1);
    // SQLite stores TEXT defaults with surrounding quotes in dflt_value.
    expect(origin!.dflt_value).toBe("'user'");
  });

  it("round-trips a bookmark inserted with an explicit origin: 'agent'", async () => {
    const db = await initializeDatabase(':memory:');
    await seedUser(db, 'user-1');

    await db
      .insertInto('bookmarks')
      .values({
        id: 'bookmark-agent',
        user_id: 'user-1',
        source_session_id: 'session-1',
        url: 'https://example.com',
        title: 'Agent bookmark',
        created_at: '2026-08-28T00:00:00.000Z',
        origin: 'agent',
      })
      .execute();

    const row = await db
      .selectFrom('bookmarks')
      .where('id', '=', 'bookmark-agent')
      .selectAll()
      .executeTakeFirstOrThrow();

    expect(row.origin).toBe('agent');
  });

  it(
    "backfills origin to 'user' via the column default when a row is inserted without specifying it " +
      '(simulating a pre-migration/legacy insert path)',
    async () => {
      const db = await initializeDatabase(':memory:');
      await seedUser(db, 'user-1');

      // Insert with a raw SQL statement that omits `origin` entirely,
      // simulating an insert made before this migration existed.
      await sql`
        INSERT INTO bookmarks (id, user_id, source_session_id, url, title, created_at)
        VALUES ('bookmark-legacy', 'user-1', NULL, 'https://example.com/legacy', NULL, '2026-08-28T00:00:00.000Z')
      `.execute(db);

      const row = await db
        .selectFrom('bookmarks')
        .where('id', '=', 'bookmark-legacy')
        .selectAll()
        .executeTakeFirstOrThrow();

      expect(row.origin).toBe('user');
    }
  );

  it('is idempotent when re-applied (duplicate column is ignored)', async () => {
    const db = await initializeDatabase(':memory:');

    await expect(migrateToV34(db)).resolves.toBeUndefined();
    await expect(migrateToV34(db)).resolves.toBeUndefined();

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(bookmarks)`.execute(db);
    expect(columns.rows.some((c) => c.name === 'origin')).toBe(true);
  });
});
