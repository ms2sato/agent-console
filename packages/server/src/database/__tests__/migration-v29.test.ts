/**
 * Migration v29 tests — embedded_agents.engine/is_built_in table rebuild
 * (SDK Engine Phase 1, consulted with the Architect 2026-08-17).
 *
 * Strategy mirrors migration-v19.test.ts (the other table-rebuild
 * migration): a v28-shaped `embedded_agents` table is seeded directly
 * against a raw Bun SQLite instance, then the production `migrateToV29` is
 * invoked directly. This exercises the real migration code with no risk of
 * drift between a test-local copy and the production implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql, Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import type { Database } from '../schema.js';
import { initializeDatabase, closeDatabase, migrateToV29 } from '../connection.js';
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

interface SeedEmbeddedAgent {
  id: string;
  name: string;
  provider_base_url: string;
  provider_model: string;
  created_by: string;
}

/**
 * Build a v28-shaped database seeded with the caller's rows: the
 * `embedded_agents` table as it existed through v27 (v28 itself only added
 * the unrelated `artifacts` table), with NO `engine`/`is_built_in` columns
 * and `provider_base_url NOT NULL`.
 */
function seedV28Database(rows: SeedEmbeddedAgent[]): Kysely<Database> {
  const bunDb = new BunDatabase(':memory:');
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: bunDb }),
  });

  bunDb.exec(`
    CREATE TABLE embedded_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      provider_base_url TEXT NOT NULL,
      provider_model TEXT NOT NULL,
      provider_api_key_ref TEXT,
      system_prompt TEXT,
      max_tool_iterations INTEGER,
      enabled_tools TEXT,
      instructions TEXT,
      context_window_tokens INTEGER,
      handoff_soft_ratio REAL,
      handoff_hard_ratio REAL,
      handoff_auto INTEGER,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    PRAGMA user_version = 28;
  `);

  const insert = bunDb.prepare(
    `INSERT INTO embedded_agents (id, name, provider_base_url, provider_model, created_by,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
  );
  for (const row of rows) {
    insert.run(row.id, row.name, row.provider_base_url, row.provider_model, row.created_by);
  }

  return db;
}

describe('migration v29 (embedded_agents.engine/is_built_in)', () => {
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

  it('advances the schema version to (at least) 29 via the real production migration path', async () => {
    const db = await initializeDatabase(':memory:');
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBeGreaterThanOrEqual(29);
  });

  it('backfills pre-existing rows to engine=native-loop, is_built_in=0', async () => {
    const db = seedV28Database([
      {
        id: 'def-1',
        name: 'Ollama qwen3',
        provider_base_url: 'http://localhost:11434/v1',
        provider_model: 'qwen3:32b',
        created_by: 'user-1',
      },
    ]);

    await migrateToV29(db);

    const row = await db
      .selectFrom('embedded_agents')
      .where('id', '=', 'def-1')
      .selectAll()
      .executeTakeFirstOrThrow();

    expect(row.engine).toBe('native-loop');
    expect(row.is_built_in).toBe(0);
    expect(row.provider_base_url).toBe('http://localhost:11434/v1');
    expect(row.provider_model).toBe('qwen3:32b');

    await db.destroy();
  });

  it('makes provider_base_url nullable afterward', async () => {
    const db = seedV28Database([]);
    await migrateToV29(db);

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(embedded_agents)`.execute(db);
    const column = columns.rows.find((c) => c.name === 'provider_base_url');
    expect(column).toBeDefined();
    expect(column!.notnull).toBe(0);

    // A claude-sdk-shaped row (null provider_base_url) must now be insertable.
    await db
      .insertInto('embedded_agents')
      .values({
        id: 'def-sdk',
        name: 'Claude',
        description: null,
        engine: 'claude-sdk',
        provider_base_url: null,
        provider_model: 'claude-sonnet-5',
        provider_api_key_ref: null,
        system_prompt: null,
        max_tool_iterations: null,
        enabled_tools: null,
        instructions: null,
        context_window_tokens: null,
        handoff_soft_ratio: null,
        handoff_hard_ratio: null,
        handoff_auto: null,
        is_built_in: 1,
        created_by: 'system',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      })
      .execute();

    const row = await db
      .selectFrom('embedded_agents')
      .where('id', '=', 'def-sdk')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.provider_base_url).toBeNull();
    expect(row.engine).toBe('claude-sdk');

    await db.destroy();
  });

  it('keeps provider_model NOT NULL', async () => {
    const db = seedV28Database([]);
    await migrateToV29(db);

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(embedded_agents)`.execute(db);
    const column = columns.rows.find((c) => c.name === 'provider_model');
    expect(column).toBeDefined();
    expect(column!.notnull).toBe(1);

    await db.destroy();
  });

  it('preserves all pre-existing columns and row data during the rebuild', async () => {
    const db = seedV28Database([
      {
        id: 'def-full',
        name: 'Full Def',
        provider_base_url: 'http://localhost:11434/v1',
        provider_model: 'qwen3:32b',
        created_by: 'user-1',
      },
    ]);
    // Set the remaining v22-v27 columns via a raw update, since the seed
    // helper only covers the minimal required set.
    await sql`
      UPDATE embedded_agents SET
        description = 'A local model',
        provider_api_key_ref = 'ref-1',
        system_prompt = 'You are helpful',
        max_tool_iterations = 30,
        enabled_tools = '["Read"]',
        instructions = '["docs/note.md"]',
        context_window_tokens = 128000,
        handoff_soft_ratio = 0.75,
        handoff_hard_ratio = 0.9,
        handoff_auto = 1
      WHERE id = 'def-full'
    `.execute(db);

    await migrateToV29(db);

    const row = await db
      .selectFrom('embedded_agents')
      .where('id', '=', 'def-full')
      .selectAll()
      .executeTakeFirstOrThrow();

    expect(row.description).toBe('A local model');
    expect(row.provider_api_key_ref).toBe('ref-1');
    expect(row.system_prompt).toBe('You are helpful');
    expect(row.max_tool_iterations).toBe(30);
    expect(row.enabled_tools).toBe('["Read"]');
    expect(row.instructions).toBe('["docs/note.md"]');
    expect(row.context_window_tokens).toBe(128000);
    expect(row.handoff_soft_ratio).toBe(0.75);
    expect(row.handoff_hard_ratio).toBe(0.9);
    expect(row.handoff_auto).toBe(1);
    expect(row.created_by).toBe('user-1');

    await db.destroy();
  });

  it('migration is idempotent: running twice has no effect', async () => {
    const db = seedV28Database([
      {
        id: 'def-1',
        name: 'Ollama qwen3',
        provider_base_url: 'http://localhost:11434/v1',
        provider_model: 'qwen3:32b',
        created_by: 'user-1',
      },
    ]);

    await migrateToV29(db);
    await migrateToV29(db);

    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(29);

    const rows = await db.selectFrom('embedded_agents').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].engine).toBe('native-loop');
    expect(rows[0].is_built_in).toBe(0);

    await db.destroy();
  });
});
