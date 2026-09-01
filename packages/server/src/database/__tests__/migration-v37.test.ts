/**
 * Migration v37 tests — `workers.model` / `workers.reasoning_effort`
 * columns (Issue #1541, worker-persisted model/reasoning-effort override).
 *
 * Unlike migration v35's `auto_compaction` (NOT NULL DEFAULT 1, a
 * meaningful boolean default), these columns are genuinely
 * absent-by-default: NULL means "no override, live-read the agent
 * definition's template default" -- there is no meaningful non-NULL
 * default to backfill existing rows to.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'kysely';
import { initializeDatabase, closeDatabase, migrateToV37 } from '../connection.js';
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

describe('migration v37 (workers.model / workers.reasoning_effort columns)', () => {
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

  it('adds model and reasoning_effort as nullable TEXT columns with no default', async () => {
    const db = await initializeDatabase(':memory:');

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(workers)`.execute(db);
    const byName = new Map(columns.rows.map((c) => [c.name, c]));

    const model = byName.get('model');
    expect(model).toBeDefined();
    expect(model!.type.toUpperCase()).toBe('TEXT');
    expect(model!.notnull).toBe(0);
    expect(model!.dflt_value).toBeNull();

    const reasoningEffort = byName.get('reasoning_effort');
    expect(reasoningEffort).toBeDefined();
    expect(reasoningEffort!.type.toUpperCase()).toBe('TEXT');
    expect(reasoningEffort!.notnull).toBe(0);
    expect(reasoningEffort!.dflt_value).toBeNull();
  });

  it('backfills a legacy worker row (inserted without the columns) to NULL', async () => {
    const db = await initializeDatabase(':memory:');
    await seedSession(db, 'session-1');

    await sql`
      INSERT INTO workers (id, session_id, type, name, created_at, updated_at, agent_id)
      VALUES ('worker-legacy', 'session-1', 'agent', 'Agent', '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z', 'claude-code-builtin')
    `.execute(db);

    const row = await db
      .selectFrom('workers')
      .where('id', '=', 'worker-legacy')
      .select(['model', 'reasoning_effort'])
      .executeTakeFirstOrThrow();

    expect(row.model).toBeNull();
    expect(row.reasoning_effort).toBeNull();
  });

  it('round-trips explicit override values', async () => {
    const db = await initializeDatabase(':memory:');
    await seedSession(db, 'session-1');

    await db
      .insertInto('workers')
      .values({
        id: 'worker-override',
        session_id: 'session-1',
        type: 'agent',
        name: 'Agent',
        created_at: '2026-08-28T00:00:00.000Z',
        updated_at: '2026-08-28T00:00:00.000Z',
        pid: null,
        agent_id: 'claude-code-builtin',
        base_commit: null,
        embedded_agent_id: null,
        deliver_initial_prompt_on_activation: 0,
        model: 'claude-opus-4-6',
        reasoning_effort: 'high',
      })
      .execute();

    const row = await db
      .selectFrom('workers')
      .where('id', '=', 'worker-override')
      .select(['model', 'reasoning_effort'])
      .executeTakeFirstOrThrow();

    expect(row.model).toBe('claude-opus-4-6');
    expect(row.reasoning_effort).toBe('high');
  });

  it('is idempotent when re-applied (duplicate columns are ignored)', async () => {
    const db = await initializeDatabase(':memory:');

    await expect(migrateToV37(db)).resolves.toBeUndefined();
    await expect(migrateToV37(db)).resolves.toBeUndefined();

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(workers)`.execute(db);
    expect(columns.rows.filter((c) => c.name === 'model')).toHaveLength(1);
    expect(columns.rows.filter((c) => c.name === 'reasoning_effort')).toHaveLength(1);
  });
});
