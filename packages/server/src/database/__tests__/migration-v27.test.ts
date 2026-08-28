/**
 * Migration v27 tests — `embedded_agents.context_window_tokens`.
 *
 * v27 originally added FOUR nullable columns: `context_window_tokens`
 * (INTEGER) plus `handoff_soft_ratio` / `handoff_hard_ratio` / `handoff_auto`
 * for the since-retired Context Handoff feature. **Migration v36 dropped
 * those three** and replaced them with `compaction_threshold` (Issue #1401),
 * so the surviving contribution of v27 to the current schema is
 * `context_window_tokens` alone.
 *
 * Every test in this file asserts the outcome of the FULL migration chain
 * (`initializeDatabase` runs all of them), which is what these tests always
 * did -- so the right adaptation to v36 is to narrow the subject, not to keep
 * asserting columns the chain now removes. The three retired columns get one
 * explicit absence assertion here, because "v27's columns are gone" is the
 * fact a future reader of this file most needs, and finding it asserted where
 * they were introduced is cheaper than inferring it from v36's own test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'kysely';
import { initializeDatabase, closeDatabase } from '../connection.js';
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
  overrides: { id: string; context_window_tokens?: number | null }
): Promise<void> {
  await db
    .insertInto('embedded_agents')
    .values({
      id: overrides.id,
      name: 'Ollama',
      description: null,
      engine: 'openai-api',
      provider_base_url: 'http://localhost:11434/v1',
      provider_model: 'qwen3:32b',
      provider_api_key_ref: null,
      system_prompt: null,
      max_tool_iterations: null,
      enabled_tools: null,
      instructions: null,
      context_window_tokens: overrides.context_window_tokens ?? null,
      compaction_threshold: null,
      is_built_in: 0,
      created_by: 'user-1',
    })
    .execute();
}

describe('migration v27 (embedded_agents.context_window_tokens)', () => {
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

  it('leaves context_window_tokens on embedded_agents, nullable with no default', async () => {
    const db = await initializeDatabase(':memory:');

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(embedded_agents)`.execute(db);
    const byName = new Map(columns.rows.map((c) => [c.name, c]));

    const contextWindowTokens = byName.get('context_window_tokens');
    expect(contextWindowTokens).toBeDefined();
    expect(contextWindowTokens!.type.toUpperCase()).toBe('INTEGER');
    expect(contextWindowTokens!.notnull).toBe(0);
    expect(contextWindowTokens!.dflt_value).toBeNull();
  });

  it("no longer carries v27's three handoff columns after the chain runs (v36 dropped them)", async () => {
    const db = await initializeDatabase(':memory:');

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(embedded_agents)`.execute(db);
    const byName = new Set(columns.rows.map((c) => c.name));

    expect(byName.has('handoff_soft_ratio')).toBe(false);
    expect(byName.has('handoff_hard_ratio')).toBe(false);
    expect(byName.has('handoff_auto')).toBe(false);
  });

  it('round-trips a non-null context_window_tokens', async () => {
    const db = await initializeDatabase(':memory:');
    await seedEmbeddedAgent(db, { id: 'agent-configured', context_window_tokens: 128000 });

    const row = await db
      .selectFrom('embedded_agents')
      .where('id', '=', 'agent-configured')
      .select(['context_window_tokens'])
      .executeTakeFirstOrThrow();

    expect(row.context_window_tokens).toBe(128000);
  });

  it('round-trips a null context_window_tokens (legacy row / unconfigured)', async () => {
    const db = await initializeDatabase(':memory:');
    await seedEmbeddedAgent(db, { id: 'agent-unconfigured' });

    const row = await db
      .selectFrom('embedded_agents')
      .where('id', '=', 'agent-unconfigured')
      .select(['context_window_tokens'])
      .executeTakeFirstOrThrow();

    expect(row.context_window_tokens).toBeNull();
  });
});
