/**
 * Migration v20 tests — sessions.initiated_by column addition.
 *
 * v20 adds a nullable `initiated_by TEXT` column to sessions. For shared
 * sessions this records the authenticated user who created the session
 * (distinct from `created_by`, which is the shared account's users.id).
 * For personal sessions the column stays NULL.
 *
 * See docs/design/shared-orchestrator-session.md §"Schema Notes" item 1.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'kysely';
import { initializeDatabase, closeDatabase, migrateToV20 } from '../connection.js';
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

describe('migration v20 (sessions.initiated_by)', () => {
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

  it('adds the initiated_by column to sessions', async () => {
    const db = await initializeDatabase(':memory:');

    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(20);

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(sessions)`.execute(db);
    const initiatedBy = columns.rows.find((c) => c.name === 'initiated_by');
    expect(initiatedBy).toBeDefined();
    expect(initiatedBy!.type.toUpperCase()).toBe('TEXT');
    // Nullable (no NOT NULL constraint)
    expect(initiatedBy!.notnull).toBe(0);
  });

  it('round-trips initiated_by values inserted into sessions', async () => {
    const db = await initializeDatabase(':memory:');

    // Seed a user (FK target for created_by).
    await db
      .insertInto('users')
      .values({
        id: 'user-creator',
        os_uid: null,
        username: 'creator',
        home_dir: '/home/creator',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      })
      .execute();
    await db
      .insertInto('users')
      .values({
        id: 'user-initiator',
        os_uid: null,
        username: 'initiator',
        home_dir: '/home/initiator',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      })
      .execute();

    await db
      .insertInto('sessions')
      .values({
        id: 'sess-shared-1',
        type: 'quick',
        location_path: '/tmp',
        server_pid: null,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
        initial_prompt: null,
        title: null,
        repository_id: null,
        worktree_id: null,
        paused_at: null,
        parent_session_id: null,
        parent_worker_id: null,
        created_by: 'user-creator',
        initiated_by: 'user-initiator',
        data_scope: 'quick',
        data_scope_slug: null,
        recovery_state: 'healthy',
        orphaned_at: null,
        orphaned_reason: null,
      })
      .execute();

    const row = await db
      .selectFrom('sessions')
      .where('id', '=', 'sess-shared-1')
      .selectAll()
      .executeTakeFirstOrThrow();

    expect(row.created_by).toBe('user-creator');
    expect(row.initiated_by).toBe('user-initiator');
  });

  it('is idempotent when re-applied (duplicate column is ignored)', async () => {
    const db = await initializeDatabase(':memory:');

    // The first call already happened during initializeDatabase. A second
    // direct invocation must not throw, mirroring the migration's
    // duplicate-column guard.
    await expect(migrateToV20(db)).resolves.toBeUndefined();

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(sessions)`.execute(db);
    expect(columns.rows.find((c) => c.name === 'initiated_by')).toBeDefined();
  });
});
