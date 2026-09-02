/**
 * Migration v38 tests -- `workers.context_window_tokens` column (Issue
 * #1554, Phase 2 of #1521, embedded-agent worker-persisted context-window
 * override).
 *
 * A DIFFERENT fact from `embedded_agents.context_window_tokens` (the
 * definition-level default, migration v34/v36): this column is a
 * per-WORKER override, meaningful only when that same worker's `model`
 * column (v37) is also set (agent-surface.md Ruling 4).
 *
 * Like v37's `model` / `reasoning_effort`, this column is genuinely
 * absent-by-default: NULL means "no override" -- there is no meaningful
 * non-NULL default to backfill existing rows to.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'kysely';
import { initializeDatabase, closeDatabase, migrateToV38 } from '../connection.js';
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
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
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

describe('migration v38 (workers.context_window_tokens column)', () => {
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

  it('adds context_window_tokens as a nullable INTEGER column with no default (fresh DB via full migration chain)', async () => {
    const db = await initializeDatabase(':memory:');

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(workers)`.execute(db);
    const byName = new Map(columns.rows.map((c) => [c.name, c]));

    const contextWindowTokens = byName.get('context_window_tokens');
    expect(contextWindowTokens).toBeDefined();
    expect(contextWindowTokens!.type.toUpperCase()).toBe('INTEGER');
    expect(contextWindowTokens!.notnull).toBe(0);
    expect(contextWindowTokens!.dflt_value).toBeNull();
  });

  it('backfills a legacy worker row (inserted without the column) to NULL', async () => {
    const db = await initializeDatabase(':memory:');
    await seedSession(db, 'session-1');

    await sql`
      INSERT INTO workers (id, session_id, type, name, created_at, updated_at, embedded_agent_id)
      VALUES ('worker-legacy', 'session-1', 'embedded-agent', 'Embedded Agent', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'def-1')
    `.execute(db);

    const row = await db
      .selectFrom('workers')
      .where('id', '=', 'worker-legacy')
      .select(['context_window_tokens'])
      .executeTakeFirstOrThrow();

    expect(row.context_window_tokens).toBeNull();
  });

  it('round-trips an explicit override value', async () => {
    const db = await initializeDatabase(':memory:');
    await seedSession(db, 'session-1');

    await db
      .insertInto('workers')
      .values({
        id: 'worker-override',
        session_id: 'session-1',
        type: 'embedded-agent',
        name: 'Embedded Agent',
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
        pid: null,
        agent_id: null,
        base_commit: null,
        embedded_agent_id: 'def-1',
        deliver_initial_prompt_on_activation: 0,
        model: 'gpt-5-codex',
        context_window_tokens: 200_000,
      })
      .execute();

    const row = await db
      .selectFrom('workers')
      .where('id', '=', 'worker-override')
      .select(['model', 'context_window_tokens'])
      .executeTakeFirstOrThrow();

    expect(row.model).toBe('gpt-5-codex');
    expect(row.context_window_tokens).toBe(200_000);
  });

  it('is idempotent when re-applied (duplicate column is ignored)', async () => {
    const db = await initializeDatabase(':memory:');

    await expect(migrateToV38(db)).resolves.toBeUndefined();
    await expect(migrateToV38(db)).resolves.toBeUndefined();

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(workers)`.execute(db);
    expect(columns.rows.filter((c) => c.name === 'context_window_tokens')).toHaveLength(1);
  });
});
