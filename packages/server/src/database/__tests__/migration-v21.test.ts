/**
 * Migration v21 tests — git-diff workers' frozen base_commit hash is reset to
 * the DEFAULT_FORK_POINT_SPEC sentinel (Issue #800).
 *
 * Previously a git-diff worker froze a resolved merge-base hash in
 * `base_commit`. The new model persists a base *spec* that is re-resolved on
 * every diff so the base tracks the moving fork point. v21 rewrites every
 * git-diff worker's frozen hash to the sentinel; agent/terminal workers (whose
 * `base_commit` is NULL) are untouched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'kysely';
import { DEFAULT_FORK_POINT_SPEC } from '@agent-console/shared';
import { initializeDatabase, closeDatabase, migrateToV21 } from '../connection.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';

const TEST_CONFIG_DIR = '/test/config';

const FROZEN_HASH = '0123456789abcdef0123456789abcdef01234567'; // 40-char hash

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

describe('migration v21 (git-diff base_commit → default fork-point spec)', () => {
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

  it('advances the schema version to 21', async () => {
    const db = await initializeDatabase(':memory:');
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(21);
  });

  it('resets a git-diff worker with a frozen hash to the sentinel spec', async () => {
    const db = await initializeDatabase(':memory:');
    await seedSession(db, 'sess-1');

    // Simulate a pre-v21 git-diff worker that froze a merge-base hash.
    await db
      .insertInto('workers')
      .values({
        id: 'worker-diff',
        session_id: 'sess-1',
        type: 'git-diff',
        name: 'Diff',
        pid: null,
        agent_id: null,
        base_commit: FROZEN_HASH,
      })
      .execute();

    // Force base_commit back to the frozen hash (the migration ran once during
    // initializeDatabase; re-seed the pre-migration state then re-run).
    await db.updateTable('workers').set({ base_commit: FROZEN_HASH }).where('id', '=', 'worker-diff').execute();
    await migrateToV21(db);

    const row = await db
      .selectFrom('workers')
      .where('id', '=', 'worker-diff')
      .select('base_commit')
      .executeTakeFirstOrThrow();

    expect(row.base_commit).toBe(DEFAULT_FORK_POINT_SPEC);
  });

  it('leaves agent and terminal workers (base_commit NULL) untouched', async () => {
    const db = await initializeDatabase(':memory:');
    await seedSession(db, 'sess-1');

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
      })
      .execute();
    await db
      .insertInto('workers')
      .values({
        id: 'worker-term',
        session_id: 'sess-1',
        type: 'terminal',
        name: 'Terminal',
        pid: null,
        agent_id: null,
        base_commit: null,
      })
      .execute();

    await migrateToV21(db);

    const agent = await db
      .selectFrom('workers')
      .where('id', '=', 'worker-agent')
      .select('base_commit')
      .executeTakeFirstOrThrow();
    const term = await db
      .selectFrom('workers')
      .where('id', '=', 'worker-term')
      .select('base_commit')
      .executeTakeFirstOrThrow();

    expect(agent.base_commit).toBeNull();
    expect(term.base_commit).toBeNull();
  });

  it('is idempotent when re-applied (sentinel rows stay at the sentinel)', async () => {
    const db = await initializeDatabase(':memory:');
    await seedSession(db, 'sess-1');

    await db
      .insertInto('workers')
      .values({
        id: 'worker-diff',
        session_id: 'sess-1',
        type: 'git-diff',
        name: 'Diff',
        pid: null,
        agent_id: null,
        base_commit: DEFAULT_FORK_POINT_SPEC,
      })
      .execute();

    await expect(migrateToV21(db)).resolves.toBeUndefined();

    const row = await db
      .selectFrom('workers')
      .where('id', '=', 'worker-diff')
      .select('base_commit')
      .executeTakeFirstOrThrow();
    expect(row.base_commit).toBe(DEFAULT_FORK_POINT_SPEC);
  });
});
