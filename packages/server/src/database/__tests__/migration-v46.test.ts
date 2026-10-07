/**
 * Migration v46 tests — `users.disable_claude_ai_connectors` column
 * (the per-user claude.ai connectors toggle).
 *
 * The load-bearing property is the DEFAULT, not the column's existence:
 * `NOT NULL DEFAULT 0` is what makes every user row that predates this
 * migration read as connectors-ON (the toggle is OFF by default). A
 * migration that landed the toggle ON for existing users would silently
 * disable claude.ai connectors for every account already using them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'kysely';
import { initializeDatabase, closeDatabase, migrateToV46 } from '../connection.js';
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

describe('migration v46 (users.disable_claude_ai_connectors column)', () => {
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

  it('adds disable_claude_ai_connectors as INTEGER NOT NULL DEFAULT 0', async () => {
    const db = await initializeDatabase(':memory:');

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(users)`.execute(db);
    const column = columns.rows.find((c) => c.name === 'disable_claude_ai_connectors');

    expect(column).toBeDefined();
    expect(column!.type.toUpperCase()).toBe('INTEGER');
    expect(column!.notnull).toBe(1);
    expect(column!.dflt_value).toBe('0');
  });

  it('backfills a legacy user row (inserted without the column) to OFF (connectors ON)', async () => {
    // This is the migration's whole purpose. The insert deliberately omits
    // `disable_claude_ai_connectors`, exactly as every pre-v46 insert path did.
    const db = await initializeDatabase(':memory:');

    await sql`
      INSERT INTO users (id, os_uid, username, home_dir, created_at, updated_at)
      VALUES ('user-legacy', 1000, 'legacy-user', '/home/legacy-user', '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z')
    `.execute(db);

    const row = await db
      .selectFrom('users')
      .where('id', '=', 'user-legacy')
      .select(['disable_claude_ai_connectors'])
      .executeTakeFirstOrThrow();

    expect(row.disable_claude_ai_connectors).toBe(0);
  });

  it('round-trips an explicit ON value', async () => {
    const db = await initializeDatabase(':memory:');

    await db
      .insertInto('users')
      .values({
        id: 'user-on',
        os_uid: 1001,
        username: 'on-user',
        home_dir: '/home/on-user',
        created_at: '2026-09-25T00:00:00.000Z',
        updated_at: '2026-09-25T00:00:00.000Z',
        disable_claude_ai_connectors: 1,
      })
      .execute();

    const row = await db
      .selectFrom('users')
      .where('id', '=', 'user-on')
      .select(['disable_claude_ai_connectors'])
      .executeTakeFirstOrThrow();

    // A deliberate ON must survive: it is the one value the DEFAULT would
    // silently overwrite if the column were ever re-added rather than kept.
    expect(row.disable_claude_ai_connectors).toBe(1);
  });

  it('is idempotent when re-applied (duplicate column is ignored)', async () => {
    const db = await initializeDatabase(':memory:');

    await expect(migrateToV46(db)).resolves.toBeUndefined();
    await expect(migrateToV46(db)).resolves.toBeUndefined();

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(users)`.execute(db);
    expect(columns.rows.filter((c) => c.name === 'disable_claude_ai_connectors')).toHaveLength(1);
  });

  it('lands the fresh in-memory dispatcher on schema version 46', async () => {
    const db = await initializeDatabase(':memory:');
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(46);
  });
});
