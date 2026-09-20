/**
 * Migration v44 tests — `embedded_agents.mcp_servers` /
 * `embedded_agents.subagents` columns (epic #1636 Phase 5 PR-1, decision 3;
 * Issue #1779).
 *
 * Simple additive `ALTER TABLE ... ADD COLUMN` migration, same shape as
 * migration v37's `workers.model` / `workers.reasoning_effort` columns --
 * both are genuinely absent-by-default: NULL means "nothing declared",
 * there is no meaningful non-NULL default to backfill existing rows to.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'kysely';
import { initializeDatabase, closeDatabase, migrateToV44 } from '../connection.js';
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

describe('migration v44 (embedded_agents.mcp_servers / embedded_agents.subagents columns)', () => {
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

  it('adds mcp_servers and subagents as nullable TEXT columns with no default', async () => {
    const db = await initializeDatabase(':memory:');

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(embedded_agents)`.execute(db);
    const byName = new Map(columns.rows.map((c) => [c.name, c]));

    const mcpServers = byName.get('mcp_servers');
    expect(mcpServers).toBeDefined();
    expect(mcpServers!.type.toUpperCase()).toBe('TEXT');
    expect(mcpServers!.notnull).toBe(0);
    expect(mcpServers!.dflt_value).toBeNull();

    const subagents = byName.get('subagents');
    expect(subagents).toBeDefined();
    expect(subagents!.type.toUpperCase()).toBe('TEXT');
    expect(subagents!.notnull).toBe(0);
    expect(subagents!.dflt_value).toBeNull();
  });

  it('bumps user_version to 44', async () => {
    const db = await initializeDatabase(':memory:');
    const result = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(result.rows[0]?.user_version).toBe(44);
  });

  it('backfills a legacy embedded_agents row (inserted without the columns) to NULL', async () => {
    const db = await initializeDatabase(':memory:');

    await sql`
      INSERT INTO embedded_agents (id, name, engine, provider_model, is_built_in, created_by)
      VALUES ('def-legacy', 'Legacy', 'openai-api', 'qwen3:32b', 0, 'user-1')
    `.execute(db);

    const row = await db
      .selectFrom('embedded_agents')
      .where('id', '=', 'def-legacy')
      .select(['mcp_servers', 'subagents'])
      .executeTakeFirstOrThrow();

    expect(row.mcp_servers).toBeNull();
    expect(row.subagents).toBeNull();
  });

  it('round-trips explicit JSON values', async () => {
    const db = await initializeDatabase(':memory:');

    await db
      .insertInto('embedded_agents')
      .values({
        id: 'def-sdk',
        name: 'Claude',
        engine: 'claude-sdk',
        provider_base_url: null,
        provider_model: 'claude-sonnet-5',
        provider_api_key_ref: null,
        provider_supports_images: null,
        system_prompt: null,
        max_tool_iterations: null,
        enabled_tools: null,
        instructions: null,
        context_window_tokens: null,
        compaction_threshold: null,
        mcp_servers: JSON.stringify({ docs: { type: 'stdio', command: 'docs-mcp' } }),
        subagents: JSON.stringify({ reviewer: { description: 'Reviews code', prompt: 'Review it' } }),
        is_built_in: 0,
        created_by: 'user-1',
      })
      .execute();

    const row = await db
      .selectFrom('embedded_agents')
      .where('id', '=', 'def-sdk')
      .select(['mcp_servers', 'subagents'])
      .executeTakeFirstOrThrow();

    expect(JSON.parse(row.mcp_servers!)).toEqual({ docs: { type: 'stdio', command: 'docs-mcp' } });
    expect(JSON.parse(row.subagents!)).toEqual({
      reviewer: { description: 'Reviews code', prompt: 'Review it' },
    });
  });

  it('is idempotent when re-applied (duplicate columns are ignored)', async () => {
    const db = await initializeDatabase(':memory:');

    await expect(migrateToV44(db)).resolves.toBeUndefined();
    await expect(migrateToV44(db)).resolves.toBeUndefined();

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(embedded_agents)`.execute(db);
    expect(columns.rows.filter((c) => c.name === 'mcp_servers')).toHaveLength(1);
    expect(columns.rows.filter((c) => c.name === 'subagents')).toHaveLength(1);
  });

  it('is a no-op re-run when already at v44 (user_version unchanged)', async () => {
    const db = await initializeDatabase(':memory:');

    const before = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(before.rows[0]?.user_version).toBe(44);

    await migrateToV44(db);

    const after = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(after.rows[0]?.user_version).toBe(44);
  });
});
