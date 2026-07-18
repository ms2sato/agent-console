/**
 * Migration v27 tests — Context Handoff (Phase A) columns on `embedded_agents`.
 *
 * v27 adds four nullable columns to `embedded_agents`: `context_window_tokens`
 * (INTEGER), `handoff_soft_ratio` (REAL), `handoff_hard_ratio` (REAL), and
 * `handoff_auto` (INTEGER 0/1, matching the `deliver_initial_prompt_on_activation`
 * boolean convention). `handoff_auto` is persisted but NOT read by any Phase A
 * code path (Phase B concern). See
 * docs/design/embedded-agent-worker.md "Context Handoff (Phase A)".
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'kysely';
import { initializeDatabase, closeDatabase, migrateToV27 } from '../connection.js';
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

async function seedEmbeddedAgent(
  db: Awaited<ReturnType<typeof initializeDatabase>>,
  overrides: {
    id: string;
    context_window_tokens?: number | null;
    handoff_soft_ratio?: number | null;
    handoff_hard_ratio?: number | null;
    handoff_auto?: number | null;
  }
): Promise<void> {
  await db
    .insertInto('embedded_agents')
    .values({
      id: overrides.id,
      name: 'Ollama',
      description: null,
      provider_base_url: 'http://localhost:11434/v1',
      provider_model: 'qwen3:32b',
      provider_api_key_ref: null,
      system_prompt: null,
      max_tool_iterations: null,
      enabled_tools: null,
      instructions: null,
      context_window_tokens: overrides.context_window_tokens ?? null,
      handoff_soft_ratio: overrides.handoff_soft_ratio ?? null,
      handoff_hard_ratio: overrides.handoff_hard_ratio ?? null,
      handoff_auto: overrides.handoff_auto ?? null,
      created_by: 'user-1',
    })
    .execute();
}

describe('migration v27 (embedded_agents Context Handoff Phase A columns)', () => {
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

  it('advances the schema version to 27', async () => {
    const db = await initializeDatabase(':memory:');
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(27);
  });

  it('adds all four columns to embedded_agents, nullable with no default', async () => {
    const db = await initializeDatabase(':memory:');

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(embedded_agents)`.execute(db);
    const byName = new Map(columns.rows.map((c) => [c.name, c]));

    const contextWindowTokens = byName.get('context_window_tokens');
    expect(contextWindowTokens).toBeDefined();
    expect(contextWindowTokens!.type.toUpperCase()).toBe('INTEGER');
    expect(contextWindowTokens!.notnull).toBe(0);
    expect(contextWindowTokens!.dflt_value).toBeNull();

    const softRatio = byName.get('handoff_soft_ratio');
    expect(softRatio).toBeDefined();
    expect(softRatio!.type.toUpperCase()).toBe('REAL');
    expect(softRatio!.notnull).toBe(0);
    expect(softRatio!.dflt_value).toBeNull();

    const hardRatio = byName.get('handoff_hard_ratio');
    expect(hardRatio).toBeDefined();
    expect(hardRatio!.type.toUpperCase()).toBe('REAL');
    expect(hardRatio!.notnull).toBe(0);
    expect(hardRatio!.dflt_value).toBeNull();

    const auto = byName.get('handoff_auto');
    expect(auto).toBeDefined();
    expect(auto!.type.toUpperCase()).toBe('INTEGER');
    expect(auto!.notnull).toBe(0);
    expect(auto!.dflt_value).toBeNull();
  });

  it('round-trips non-null values for all four columns', async () => {
    const db = await initializeDatabase(':memory:');
    await seedEmbeddedAgent(db, {
      id: 'agent-configured',
      context_window_tokens: 128000,
      handoff_soft_ratio: 0.75,
      handoff_hard_ratio: 0.9,
      handoff_auto: 1,
    });

    const row = await db
      .selectFrom('embedded_agents')
      .where('id', '=', 'agent-configured')
      .select(['context_window_tokens', 'handoff_soft_ratio', 'handoff_hard_ratio', 'handoff_auto'])
      .executeTakeFirstOrThrow();

    expect(row.context_window_tokens).toBe(128000);
    expect(row.handoff_soft_ratio).toBe(0.75);
    expect(row.handoff_hard_ratio).toBe(0.9);
    expect(row.handoff_auto).toBe(1);
  });

  it('round-trips null values for all four columns (legacy row / unconfigured)', async () => {
    const db = await initializeDatabase(':memory:');
    await seedEmbeddedAgent(db, { id: 'agent-unconfigured' });

    const row = await db
      .selectFrom('embedded_agents')
      .where('id', '=', 'agent-unconfigured')
      .select(['context_window_tokens', 'handoff_soft_ratio', 'handoff_hard_ratio', 'handoff_auto'])
      .executeTakeFirstOrThrow();

    expect(row.context_window_tokens).toBeNull();
    expect(row.handoff_soft_ratio).toBeNull();
    expect(row.handoff_hard_ratio).toBeNull();
    expect(row.handoff_auto).toBeNull();
  });

  it('is idempotent when re-applied (duplicate columns are ignored)', async () => {
    const db = await initializeDatabase(':memory:');

    await expect(migrateToV27(db)).resolves.toBeUndefined();
    await expect(migrateToV27(db)).resolves.toBeUndefined();

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(embedded_agents)`.execute(db);
    const byName = new Set(columns.rows.map((c) => c.name));
    expect(byName.has('context_window_tokens')).toBe(true);
    expect(byName.has('handoff_soft_ratio')).toBe(true);
    expect(byName.has('handoff_hard_ratio')).toBe(true);
    expect(byName.has('handoff_auto')).toBe(true);
  });
});
