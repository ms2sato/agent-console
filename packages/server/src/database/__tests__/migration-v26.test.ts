/**
 * Migration v26 tests — workers.deliver_initial_prompt_on_activation column
 * addition.
 *
 * v26 adds a nullable `deliver_initial_prompt_on_activation INTEGER` (0/1)
 * column to `workers`, persisting the eligibility marker
 * (`InternalEmbeddedAgentWorker.deliverInitialPromptOnActivation`) so it
 * survives a server restart (Issue #1074). Null/0 for non-embedded-agent
 * workers and for legacy embedded-agent rows predating v26 (treated as
 * "not eligible" by application code).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'kysely';
import { initializeDatabase, closeDatabase, migrateToV26 } from '../connection.js';
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

describe('migration v26 (workers.deliver_initial_prompt_on_activation)', () => {
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

  it('advances the schema version to 26', async () => {
    const db = await initializeDatabase(':memory:');
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(27);
  });

  it('adds the deliver_initial_prompt_on_activation column to workers, nullable with no default', async () => {
    const db = await initializeDatabase(':memory:');

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(workers)`.execute(db);
    const column = columns.rows.find((c) => c.name === 'deliver_initial_prompt_on_activation');
    expect(column).toBeDefined();
    expect(column!.type.toUpperCase()).toBe('INTEGER');
    expect(column!.notnull).toBe(0);
    expect(column!.dflt_value).toBeNull();
  });

  it('round-trips a value of 1 (eligible)', async () => {
    const db = await initializeDatabase(':memory:');
    await seedSession(db, 'sess-1');

    await db
      .insertInto('workers')
      .values({
        id: 'worker-eligible',
        session_id: 'sess-1',
        type: 'embedded-agent',
        name: 'Embedded Agent',
        pid: null,
        agent_id: null,
        base_commit: null,
        embedded_agent_id: 'def-1',
        deliver_initial_prompt_on_activation: 1,
      })
      .execute();

    const row = await db
      .selectFrom('workers')
      .where('id', '=', 'worker-eligible')
      .select('deliver_initial_prompt_on_activation')
      .executeTakeFirstOrThrow();

    expect(row.deliver_initial_prompt_on_activation).toBe(1);
  });

  it('round-trips a null value (legacy row / non-embedded-agent worker)', async () => {
    const db = await initializeDatabase(':memory:');
    await seedSession(db, 'sess-1');

    await db
      .insertInto('workers')
      .values({
        id: 'worker-legacy',
        session_id: 'sess-1',
        type: 'agent',
        name: 'Agent',
        pid: null,
        agent_id: 'claude-code',
        base_commit: null,
        embedded_agent_id: null,
        deliver_initial_prompt_on_activation: null,
      })
      .execute();

    const row = await db
      .selectFrom('workers')
      .where('id', '=', 'worker-legacy')
      .select('deliver_initial_prompt_on_activation')
      .executeTakeFirstOrThrow();

    expect(row.deliver_initial_prompt_on_activation).toBeNull();
  });

  it('is idempotent when re-applied (duplicate column is ignored)', async () => {
    const db = await initializeDatabase(':memory:');

    await expect(migrateToV26(db)).resolves.toBeUndefined();
    await expect(migrateToV26(db)).resolves.toBeUndefined();

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(workers)`.execute(db);
    expect(columns.rows.find((c) => c.name === 'deliver_initial_prompt_on_activation')).toBeDefined();
  });
});
