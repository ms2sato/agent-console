/**
 * Migration v35 tests — `workers.auto_compaction` column (Issue #1401,
 * Compaction's per-worker automatic-firing toggle).
 *
 * The load-bearing property is the DEFAULT, not the column's existence:
 * `NOT NULL DEFAULT 1` is what makes every worker row that predates this
 * migration read as ON. The whole point of the compaction swap is to end the
 * state where a worker has no context management, so a migration that landed
 * the toggle OFF for existing workers would recreate exactly that state on
 * every machine that already has workers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'kysely';
import { initializeDatabase, closeDatabase, migrateToV35 } from '../connection.js';
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

async function seedSession(
  db: Awaited<ReturnType<typeof initializeDatabase>>,
  id: string
): Promise<void> {
  await db
    .insertInto('sessions')
    .values({
      id,
      type: 'quick',
      location_path: '/tmp/work',
      server_pid: null,
      created_at: '2026-08-28T00:00:00.000Z',
      updated_at: '2026-08-28T00:00:00.000Z',
      initial_prompt: null,
      title: null,
      repository_id: null,
      worktree_id: null,
      paused_at: null,
      parent_session_id: null,
      parent_worker_id: null,
      created_by: null,
      initiated_by: null,
      data_scope: 'quick',
      data_scope_slug: null,
      recovery_state: 'healthy',
      orphaned_at: null,
      orphaned_reason: null,
    })
    .execute();
}

describe('migration v35 (workers.auto_compaction column)', () => {
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

  it('advances the schema version past v35 to the latest', async () => {
    const db = await initializeDatabase(':memory:');
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(36);
  });

  it('adds auto_compaction as INTEGER NOT NULL DEFAULT 1', async () => {
    const db = await initializeDatabase(':memory:');

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(workers)`.execute(db);
    const column = columns.rows.find((c) => c.name === 'auto_compaction');

    expect(column).toBeDefined();
    expect(column!.type.toUpperCase()).toBe('INTEGER');
    expect(column!.notnull).toBe(1);
    expect(column!.dflt_value).toBe('1');
  });

  it('backfills a legacy worker row (inserted without the column) to ON', async () => {
    // This is the migration's whole purpose. The insert deliberately omits
    // `auto_compaction`, exactly as every pre-v35 insert path did.
    const db = await initializeDatabase(':memory:');
    await seedSession(db, 'session-1');

    await sql`
      INSERT INTO workers (id, session_id, type, name, created_at, updated_at, embedded_agent_id)
      VALUES ('worker-legacy', 'session-1', 'embedded-agent', 'Embedded', '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z', 'def-1')
    `.execute(db);

    const row = await db
      .selectFrom('workers')
      .where('id', '=', 'worker-legacy')
      .select(['auto_compaction'])
      .executeTakeFirstOrThrow();

    expect(row.auto_compaction).toBe(1);
  });

  it('round-trips an explicit OFF value', async () => {
    const db = await initializeDatabase(':memory:');
    await seedSession(db, 'session-1');

    await db
      .insertInto('workers')
      .values({
        id: 'worker-off',
        session_id: 'session-1',
        type: 'embedded-agent',
        name: 'Embedded',
        created_at: '2026-08-28T00:00:00.000Z',
        updated_at: '2026-08-28T00:00:00.000Z',
        pid: null,
        agent_id: null,
        base_commit: null,
        embedded_agent_id: 'def-1',
        deliver_initial_prompt_on_activation: 0,
        sdk_session_id: null,
        auto_compaction: 0,
      })
      .execute();

    const row = await db
      .selectFrom('workers')
      .where('id', '=', 'worker-off')
      .select(['auto_compaction'])
      .executeTakeFirstOrThrow();

    // A deliberate OFF must survive: it is the one value the DEFAULT would
    // silently overwrite if the column were ever re-added rather than kept.
    expect(row.auto_compaction).toBe(0);
  });

  it('is idempotent when re-applied (duplicate column is ignored)', async () => {
    const db = await initializeDatabase(':memory:');

    await expect(migrateToV35(db)).resolves.toBeUndefined();
    await expect(migrateToV35(db)).resolves.toBeUndefined();

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(workers)`.execute(db);
    expect(columns.rows.filter((c) => c.name === 'auto_compaction')).toHaveLength(1);
  });
});
