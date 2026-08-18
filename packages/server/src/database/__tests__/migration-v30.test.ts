/**
 * Migration v30 tests — workers.sdk_session_id column addition (SDK Engine
 * Phase 1, consulted with the Architect 2026-08-17).
 *
 * v30 adds a nullable `sdk_session_id TEXT` column to `workers`, persisting
 * `InternalEmbeddedAgentWorker.sdkSessionId` (SDK Engine Phase 1) so it
 * survives a server restart. Null for non-embedded-agent workers and for
 * native-loop engine embedded-agent workers. See
 * docs/design/embedded-agent-sdk-engine.md §4 "Process lifetime" row.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'kysely';
import { initializeDatabase, closeDatabase, migrateToV30 } from '../connection.js';
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

describe('migration v30 (workers.sdk_session_id)', () => {
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

  it('advances the schema version to 30', async () => {
    const db = await initializeDatabase(':memory:');
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(30);
  });

  it('adds the sdk_session_id column to workers, nullable with no default', async () => {
    const db = await initializeDatabase(':memory:');

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(workers)`.execute(db);
    const column = columns.rows.find((c) => c.name === 'sdk_session_id');
    expect(column).toBeDefined();
    expect(column!.type.toUpperCase()).toBe('TEXT');
    expect(column!.notnull).toBe(0);
    expect(column!.dflt_value).toBeNull();
  });

  it('round-trips a non-null sdk_session_id value', async () => {
    const db = await initializeDatabase(':memory:');
    await seedSession(db, 'sess-1');

    await db
      .insertInto('workers')
      .values({
        id: 'worker-sdk',
        session_id: 'sess-1',
        type: 'embedded-agent',
        name: 'Embedded Agent',
        pid: null,
        agent_id: null,
        base_commit: null,
        embedded_agent_id: 'def-1',
        deliver_initial_prompt_on_activation: null,
        sdk_session_id: 'sdk-sess-abc',
      })
      .execute();

    const row = await db
      .selectFrom('workers')
      .where('id', '=', 'worker-sdk')
      .select('sdk_session_id')
      .executeTakeFirstOrThrow();

    expect(row.sdk_session_id).toBe('sdk-sess-abc');
  });

  it('round-trips a null sdk_session_id value (native-loop engine / non-embedded-agent worker)', async () => {
    const db = await initializeDatabase(':memory:');
    await seedSession(db, 'sess-1');

    await db
      .insertInto('workers')
      .values({
        id: 'worker-native-loop',
        session_id: 'sess-1',
        type: 'embedded-agent',
        name: 'Embedded Agent',
        pid: null,
        agent_id: null,
        base_commit: null,
        embedded_agent_id: 'def-1',
        deliver_initial_prompt_on_activation: null,
        sdk_session_id: null,
      })
      .execute();

    const row = await db
      .selectFrom('workers')
      .where('id', '=', 'worker-native-loop')
      .select('sdk_session_id')
      .executeTakeFirstOrThrow();

    expect(row.sdk_session_id).toBeNull();
  });

  it('is idempotent when re-applied (duplicate column is ignored)', async () => {
    const db = await initializeDatabase(':memory:');

    await expect(migrateToV30(db)).resolves.toBeUndefined();
    await expect(migrateToV30(db)).resolves.toBeUndefined();

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(workers)`.execute(db);
    expect(columns.rows.find((c) => c.name === 'sdk_session_id')).toBeDefined();
  });
});
