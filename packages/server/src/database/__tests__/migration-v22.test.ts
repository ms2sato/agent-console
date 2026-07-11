/**
 * Migration v22 tests — embedded-agent support.
 *
 * v22 adds the nullable `embedded_agent_id` column to the workers table and
 * creates the `embedded_agents` registry table. The workers `pid` column is
 * reused for the agent subprocess pid, so no new pid column is added.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'kysely';
import { initializeDatabase, closeDatabase, migrateToV22 } from '../connection.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';

const TEST_CONFIG_DIR = '/test/config';

async function seedSession(db: Awaited<ReturnType<typeof initializeDatabase>>, id: string): Promise<void> {
  await db
    .insertInto('sessions')
    .values({
      id,
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

async function columnNames(
  db: Awaited<ReturnType<typeof initializeDatabase>>,
  table: string
): Promise<string[]> {
  const info = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.execute(db);
  return info.rows.map((r) => r.name);
}

describe('migration v22 (embedded-agent support)', () => {
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

  it('advances the schema version to 22', async () => {
    const db = await initializeDatabase(':memory:');
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(22);
  });

  it('adds the embedded_agent_id column to workers, null for existing rows', async () => {
    const db = await initializeDatabase(':memory:');
    await seedSession(db, 'sess-1');

    // A pre-existing worker row (initializeDatabase already ran v22, so the
    // column exists; insert an agent worker with a null embedded_agent_id).
    await db
      .insertInto('workers')
      .values({
        id: 'worker-agent',
        session_id: 'sess-1',
        type: 'agent',
        name: 'Agent',
        pid: null,
        agent_id: 'claude-code',
        base_commit: null,
        embedded_agent_id: null,
      })
      .execute();

    const cols = await columnNames(db, 'workers');
    expect(cols).toContain('embedded_agent_id');

    const row = await db
      .selectFrom('workers')
      .where('id', '=', 'worker-agent')
      .select('embedded_agent_id')
      .executeTakeFirstOrThrow();
    expect(row.embedded_agent_id).toBeNull();
  });

  it('creates the embedded_agents table with the expected columns', async () => {
    const db = await initializeDatabase(':memory:');
    const cols = await columnNames(db, 'embedded_agents');
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'name',
        'description',
        'provider_base_url',
        'provider_model',
        'provider_api_key_ref',
        'system_prompt',
        'max_tool_iterations',
        'created_by',
        'created_at',
        'updated_at',
      ])
    );
  });

  it('is idempotent when re-applied against a v22 database', async () => {
    const db = await initializeDatabase(':memory:');
    // Re-running the migration must not throw (duplicate column / table guards).
    await expect(migrateToV22(db)).resolves.toBeUndefined();

    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(22);
  });
});
