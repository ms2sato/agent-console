/**
 * Migration v36 tests — `embedded_agents`: the three retired Context Handoff
 * columns are replaced by a single `compaction_threshold` (Issue #1401).
 *
 * Strategy mirrors `migration-v32.test.ts` (the other table-rebuild migration
 * on this same table): a v35-shaped `embedded_agents` table is seeded
 * directly against a raw Bun SQLite instance, then the production
 * `migrateToV36` is invoked directly. This exercises the real migration code
 * with no risk of drift between a test-local copy and the production
 * implementation -- and it is the only way to test a DROP-shaped migration at
 * all, since after the full chain the dropped columns no longer exist to seed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql, Kysely } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import type { Database } from '../schema.js';
import { initializeDatabase, closeDatabase, migrateToV36 } from '../connection.js';
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
  engine: 'openai-api' | 'claude-sdk';
  provider_base_url: string | null;
  provider_model: string;
  context_window_tokens: number | null;
  handoff_soft_ratio: number | null;
  handoff_hard_ratio: number | null;
  handoff_auto: number | null;
}

/**
 * Build a v35-shaped database: `embedded_agents` as it existed from v32
 * through v35 (v33/v34/v35 touched other tables), i.e. still carrying the
 * three `handoff_*` columns.
 */
function seedV35Database(rows: SeedEmbeddedAgent[]): Kysely<Database> {
  const bunDb = new BunDatabase(':memory:');
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: bunDb }),
  });

  bunDb.exec(`
    CREATE TABLE embedded_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      engine TEXT NOT NULL DEFAULT 'openai-api',
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

    PRAGMA user_version = 35;
  `);

  const insert = bunDb.prepare(
    `INSERT INTO embedded_agents (id, name, description, engine, provider_base_url, provider_model,
       provider_api_key_ref, system_prompt, max_tool_iterations, enabled_tools, instructions,
       context_window_tokens, handoff_soft_ratio, handoff_hard_ratio, handoff_auto,
       is_built_in, created_by, created_at, updated_at)
     VALUES (?, ?, 'A local model', ?, ?, ?, 'ref-1', 'You are helpful', 30, '["Read"]',
       '["docs/note.md"]', ?, ?, ?, ?, 0, 'user-1',
       '2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z')`
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.name,
      row.engine,
      row.provider_base_url,
      row.provider_model,
      row.context_window_tokens,
      row.handoff_soft_ratio,
      row.handoff_hard_ratio,
      row.handoff_auto
    );
  }

  return db;
}

const CONFIGURED_ROW: SeedEmbeddedAgent = {
  id: 'def-configured',
  name: 'Ollama qwen3',
  engine: 'openai-api',
  provider_base_url: 'http://localhost:11434/v1',
  provider_model: 'qwen3:32b',
  context_window_tokens: 128000,
  handoff_soft_ratio: 0.75,
  handoff_hard_ratio: 0.9,
  handoff_auto: 1,
};

describe('migration v36 (embedded_agents handoff_* -> compaction_threshold)', () => {
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

  it('advances the schema version to 36 via the real production migration path', async () => {
    // KEEP THIS despite its resemblance to the terminal-version assertions
    // #1405 removed from every other migration-vNN test. Those asserted the
    // CHAIN's final version, which `migration.test.ts` owns; this asserts
    // what v36 ITSELF sets (`PRAGMA user_version = 36`), which is v36's own
    // effect and nobody else's. The two coincide only while v36 is the last
    // migration -- when v37 lands this will read like a stale duplicate and
    // it will still be correct, so do not sweep it away by pattern.
    const db = await initializeDatabase(':memory:');
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(36);
  });

  it('drops the three handoff_* columns and adds compaction_threshold as a nullable REAL', async () => {
    const db = seedV35Database([]);
    await migrateToV36(db);

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(embedded_agents)`.execute(db);
    const byName = new Map(columns.rows.map((c) => [c.name, c]));

    expect(byName.has('handoff_soft_ratio')).toBe(false);
    expect(byName.has('handoff_hard_ratio')).toBe(false);
    expect(byName.has('handoff_auto')).toBe(false);

    const threshold = byName.get('compaction_threshold');
    expect(threshold).toBeDefined();
    expect(threshold!.type.toUpperCase()).toBe('REAL');
    expect(threshold!.notnull).toBe(0);
    expect(threshold!.dflt_value).toBeNull();

    await db.destroy();
  });

  it('lands every existing definition on compaction_threshold NULL, carrying no handoff value across', async () => {
    // Deliberate: the soft/hard pair were the two ends of a banner
    // escalation, not a compaction trigger point. Mapping either onto the new
    // column would invent a threshold the operator never chose -- so a row
    // that had 0.75/0.9 configured must come out unconfigured, falling to
    // DEFAULT_COMPACTION_THRESHOLD downstream.
    const db = seedV35Database([CONFIGURED_ROW]);
    await migrateToV36(db);

    const row = await db
      .selectFrom('embedded_agents')
      .where('id', '=', 'def-configured')
      .select(['compaction_threshold'])
      .executeTakeFirstOrThrow();

    expect(row.compaction_threshold).toBeNull();

    await db.destroy();
  });

  it('preserves every other column of every row through the table rebuild', async () => {
    // The rebuild copies 16 columns by name; a typo in that list would drop
    // real configuration silently, which is the failure mode a DROP-shaped
    // migration is most prone to.
    const db = seedV35Database([
      CONFIGURED_ROW,
      {
        ...CONFIGURED_ROW,
        id: 'def-sdk',
        name: 'Claude',
        engine: 'claude-sdk',
        provider_base_url: null,
        provider_model: 'claude-sonnet-5',
      },
    ]);
    await migrateToV36(db);

    const rows = await db.selectFrom('embedded_agents').selectAll().orderBy('id').execute();
    expect(rows).toHaveLength(2);

    const [openaiRow, sdkRow] = rows;
    expect(openaiRow.id).toBe('def-configured');
    expect(openaiRow.name).toBe('Ollama qwen3');
    expect(openaiRow.description).toBe('A local model');
    expect(openaiRow.engine).toBe('openai-api');
    expect(openaiRow.provider_base_url).toBe('http://localhost:11434/v1');
    expect(openaiRow.provider_model).toBe('qwen3:32b');
    expect(openaiRow.provider_api_key_ref).toBe('ref-1');
    expect(openaiRow.system_prompt).toBe('You are helpful');
    expect(openaiRow.max_tool_iterations).toBe(30);
    expect(openaiRow.enabled_tools).toBe('["Read"]');
    expect(openaiRow.instructions).toBe('["docs/note.md"]');
    expect(openaiRow.context_window_tokens).toBe(128000);
    expect(openaiRow.is_built_in).toBe(0);
    expect(openaiRow.created_by).toBe('user-1');
    expect(openaiRow.created_at).toBe('2024-01-01T00:00:00.000Z');
    expect(openaiRow.updated_at).toBe('2024-01-02T00:00:00.000Z');

    // The claude-sdk control row: a null provider_base_url must survive the
    // rebuild, since the recreated table must not reintroduce a NOT NULL that
    // migration v29 removed.
    expect(sdkRow.id).toBe('def-sdk');
    expect(sdkRow.engine).toBe('claude-sdk');
    expect(sdkRow.provider_base_url).toBeNull();
    expect(sdkRow.provider_model).toBe('claude-sonnet-5');

    await db.destroy();
  });

  it('is a no-op when re-applied (already at v36)', async () => {
    const db = seedV35Database([CONFIGURED_ROW]);
    await migrateToV36(db);
    await expect(migrateToV36(db)).resolves.toBeUndefined();

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(embedded_agents)`.execute(db);
    expect(columns.rows.filter((c) => c.name === 'compaction_threshold')).toHaveLength(1);
    const rows = await db.selectFrom('embedded_agents').selectAll().execute();
    expect(rows).toHaveLength(1);

    await db.destroy();
  });
});
