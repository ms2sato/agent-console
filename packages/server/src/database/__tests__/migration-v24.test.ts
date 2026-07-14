/**
 * Migration v24 tests — sessions.initial_prompt_delivered column addition.
 *
 * v24 adds a nullable `initial_prompt_delivered INTEGER` (0/1) column to
 * `sessions`, tracking whether `initial_prompt` has already been delivered as
 * the session's initial embedded-agent worker's first user message.
 * Null = legacy row predating v24 (application code treats it as
 * "not delivered").
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'kysely';
import { initializeDatabase, closeDatabase, migrateToV24 } from '../connection.js';
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

describe('migration v24 (sessions.initial_prompt_delivered)', () => {
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

  it('advances the schema version to 24', async () => {
    const db = await initializeDatabase(':memory:');
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(26);
  });

  it('adds the initial_prompt_delivered column to sessions, nullable with no default', async () => {
    const db = await initializeDatabase(':memory:');

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(sessions)`.execute(db);
    const column = columns.rows.find((c) => c.name === 'initial_prompt_delivered');
    expect(column).toBeDefined();
    expect(column!.type.toUpperCase()).toBe('INTEGER');
    expect(column!.notnull).toBe(0);
  });

  it('round-trips a 0/1 integer value', async () => {
    const db = await initializeDatabase(':memory:');

    await db
      .insertInto('sessions')
      .values({
        id: 'session-1',
        type: 'quick',
        location_path: '/path',
        server_pid: null,
        initial_prompt: 'do something',
        initial_prompt_delivered: 1,
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

    const row = await db
      .selectFrom('sessions')
      .where('id', '=', 'session-1')
      .select('initial_prompt_delivered')
      .executeTakeFirstOrThrow();

    expect(row.initial_prompt_delivered).toBe(1);
  });

  it('round-trips a 0 integer value', async () => {
    const db = await initializeDatabase(':memory:');

    await db
      .insertInto('sessions')
      .values({
        id: 'session-0',
        type: 'quick',
        location_path: '/path',
        server_pid: null,
        initial_prompt: 'do something',
        initial_prompt_delivered: 0,
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

    const row = await db
      .selectFrom('sessions')
      .where('id', '=', 'session-0')
      .select('initial_prompt_delivered')
      .executeTakeFirstOrThrow();

    expect(row.initial_prompt_delivered).toBe(0);
  });

  it('defaults to null when the column is not specified', async () => {
    const db = await initializeDatabase(':memory:');

    await db
      .insertInto('sessions')
      .values({
        id: 'session-null',
        type: 'quick',
        location_path: '/path',
        server_pid: null,
        initial_prompt: 'do something',
        // initial_prompt_delivered omitted -- should default to null
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

    const row = await db
      .selectFrom('sessions')
      .where('id', '=', 'session-null')
      .select('initial_prompt_delivered')
      .executeTakeFirstOrThrow();

    expect(row.initial_prompt_delivered).toBeNull();
  });

  it('is idempotent when re-applied (duplicate column is ignored)', async () => {
    const db = await initializeDatabase(':memory:');

    await expect(migrateToV24(db)).resolves.toBeUndefined();

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(sessions)`.execute(db);
    expect(columns.rows.find((c) => c.name === 'initial_prompt_delivered')).toBeDefined();
  });
});
