/**
 * Migration v23 tests — embedded_agents.enabled_tools column addition.
 *
 * v23 adds a nullable `enabled_tools TEXT` column to `embedded_agents`,
 * holding a JSON-serialized array of enabled builtin tool names (FF-1a
 * builtin-tools policy). Null = the default read-only set applies downstream
 * (subprocess-side), not a specific stored default.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'kysely';
import { initializeDatabase, closeDatabase, migrateToV23 } from '../connection.js';
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

describe('migration v23 (embedded_agents.enabled_tools)', () => {
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

  it('advances the schema version to 23', async () => {
    const db = await initializeDatabase(':memory:');
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(23);
  });

  it('adds the enabled_tools column to embedded_agents, nullable with no default', async () => {
    const db = await initializeDatabase(':memory:');

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(embedded_agents)`.execute(db);
    const enabledTools = columns.rows.find((c) => c.name === 'enabled_tools');
    expect(enabledTools).toBeDefined();
    expect(enabledTools!.type.toUpperCase()).toBe('TEXT');
    expect(enabledTools!.notnull).toBe(0);
  });

  it('round-trips a JSON-serialized enabled_tools value', async () => {
    const db = await initializeDatabase(':memory:');

    await db
      .insertInto('embedded_agents')
      .values({
        id: 'def-1',
        name: 'Ollama',
        description: null,
        provider_base_url: 'http://localhost:11434/v1',
        provider_model: 'qwen3:32b',
        provider_api_key_ref: null,
        system_prompt: null,
        max_tool_iterations: null,
        enabled_tools: '["Read","Glob"]',
        created_by: 'user-1',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      })
      .execute();

    const row = await db
      .selectFrom('embedded_agents')
      .where('id', '=', 'def-1')
      .select('enabled_tools')
      .executeTakeFirstOrThrow();

    expect(row.enabled_tools).toBe('["Read","Glob"]');
  });

  it('is idempotent when re-applied (duplicate column is ignored)', async () => {
    const db = await initializeDatabase(':memory:');

    await expect(migrateToV23(db)).resolves.toBeUndefined();

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(embedded_agents)`.execute(db);
    expect(columns.rows.find((c) => c.name === 'enabled_tools')).toBeDefined();
  });
});
