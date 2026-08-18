/**
 * Migration v32 tests — embedded_agents.engine value rename
 * 'native-loop' -> 'openai-api' (#1364).
 *
 * Strategy mirrors migration-v29.test.ts (the other table-rebuild migration
 * on this same table): a v31-shaped `embedded_agents` table (already
 * carrying the `engine`/`is_built_in` columns with the OLD default) is
 * seeded directly against a raw Bun SQLite instance, then the production
 * `migrateToV32` is invoked directly. This exercises the real migration code
 * with no risk of drift between a test-local copy and the production
 * implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql, Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import type { Database } from '../schema.js';
import { initializeDatabase, closeDatabase, migrateToV32 } from '../connection.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';

const TEST_CONFIG_DIR = '/test/config';

interface SeedEmbeddedAgent {
  id: string;
  name: string;
  engine: 'native-loop' | 'claude-sdk';
  provider_base_url: string | null;
  provider_model: string;
  created_by: string;
}

/**
 * Build a v31-shaped database seeded with the caller's rows: the
 * `embedded_agents` table as it existed through v29-v31 (neither v30 nor
 * v31 touched this table's columns), i.e. already carrying `engine` with the
 * OLD `DEFAULT 'native-loop'` and `is_built_in`.
 */
function seedV31Database(rows: SeedEmbeddedAgent[]): Kysely<Database> {
  const bunDb = new BunDatabase(':memory:');
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: bunDb }),
  });

  bunDb.exec(`
    CREATE TABLE embedded_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      engine TEXT NOT NULL DEFAULT 'native-loop',
      provider_base_url TEXT,
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
      is_built_in INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    PRAGMA user_version = 31;
  `);

  const insert = bunDb.prepare(
    `INSERT INTO embedded_agents (id, name, engine, provider_base_url, provider_model, created_by,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
  );
  for (const row of rows) {
    insert.run(row.id, row.name, row.engine, row.provider_base_url, row.provider_model, row.created_by);
  }

  return db;
}

describe('migration v32 (embedded_agents.engine native-loop -> openai-api)', () => {
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

  it('advances the schema version to 32 via the real production migration path', async () => {
    const db = await initializeDatabase(':memory:');
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(32);
  });

  it("rewrites existing 'native-loop' rows to 'openai-api', and passes a 'claude-sdk' control row through byte-unchanged", async () => {
    const db = seedV31Database([
      {
        id: 'def-1',
        name: 'Ollama qwen3',
        engine: 'native-loop',
        provider_base_url: 'http://localhost:11434/v1',
        provider_model: 'qwen3:32b',
        created_by: 'user-1',
      },
      {
        id: 'def-sdk',
        name: 'Claude',
        engine: 'claude-sdk',
        provider_base_url: null,
        provider_model: 'claude-sonnet-5',
        created_by: 'system',
      },
    ]);

    const beforeSdkRow = await db
      .selectFrom('embedded_agents')
      .where('id', '=', 'def-sdk')
      .selectAll()
      .executeTakeFirstOrThrow();

    await migrateToV32(db);

    const nativeLoopRow = await db
      .selectFrom('embedded_agents')
      .where('id', '=', 'def-1')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(nativeLoopRow.engine).toBe('openai-api');
    expect(nativeLoopRow.provider_base_url).toBe('http://localhost:11434/v1');
    expect(nativeLoopRow.provider_model).toBe('qwen3:32b');

    const sdkRow = await db
      .selectFrom('embedded_agents')
      .where('id', '=', 'def-sdk')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(sdkRow).toEqual(beforeSdkRow);

    await db.destroy();
  });

  it('inserts a row omitting engine and gets the NEW default (openai-api), not the stale native-loop default', async () => {
    const db = seedV31Database([]);
    await migrateToV32(db);

    // Deliberately omit `engine` from the column list -- this is the
    // assertion that would fail if R1 had been implemented as a bare
    // `UPDATE embedded_agents SET engine = 'openai-api' WHERE engine =
    // 'native-loop'` instead of a table rebuild: the column DEFAULT would
    // still read 'native-loop' and this insert would resurrect it.
    await sql`
      INSERT INTO embedded_agents (
        id, name, provider_base_url, provider_model, created_by
      ) VALUES (
        'def-default', 'Default Engine Def', 'http://localhost:11434/v1', 'qwen3:32b', 'user-1'
      )
    `.execute(db);

    const row = await db
      .selectFrom('embedded_agents')
      .where('id', '=', 'def-default')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.engine).toBe('openai-api');

    await db.destroy();
  });

  it('migration is idempotent: running twice has no additional effect', async () => {
    const db = seedV31Database([
      {
        id: 'def-1',
        name: 'Ollama qwen3',
        engine: 'native-loop',
        provider_base_url: 'http://localhost:11434/v1',
        provider_model: 'qwen3:32b',
        created_by: 'user-1',
      },
    ]);

    await migrateToV32(db);
    await migrateToV32(db);

    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(32);

    const rows = await db.selectFrom('embedded_agents').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].engine).toBe('openai-api');

    await db.destroy();
  });

  it('preserves all other columns during the rebuild', async () => {
    const db = seedV31Database([
      {
        id: 'def-full',
        name: 'Full Def',
        engine: 'native-loop',
        provider_base_url: 'http://localhost:11434/v1',
        provider_model: 'qwen3:32b',
        created_by: 'user-1',
      },
    ]);
    // Set the remaining columns via a raw update, since the seed helper only
    // covers the minimal required set.
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
        handoff_auto = 1,
        is_built_in = 0
      WHERE id = 'def-full'
    `.execute(db);

    await migrateToV32(db);

    const row = await db
      .selectFrom('embedded_agents')
      .where('id', '=', 'def-full')
      .selectAll()
      .executeTakeFirstOrThrow();

    expect(row.engine).toBe('openai-api');
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
    expect(row.is_built_in).toBe(0);
    expect(row.created_by).toBe('user-1');

    await db.destroy();
  });
});
