/**
 * Migration v25 tests — embedded_agents.instructions column addition.
 *
 * v25 adds a nullable `instructions TEXT` column to `embedded_agents`, holding
 * a JSON-serialized array of opt-in instruction-file paths
 * (EmbeddedAgentDefinition.instructions). Null = none configured.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'kysely';
import { initializeDatabase, closeDatabase, migrateToV25 } from '../connection.js';
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

describe('migration v25 (embedded_agents.instructions)', () => {
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

  it('advances the schema version to 25', async () => {
    const db = await initializeDatabase(':memory:');
    const versionRes = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db);
    expect(versionRes.rows[0]?.user_version).toBe(26);
  });

  it('adds the instructions column to embedded_agents, nullable with no default', async () => {
    const db = await initializeDatabase(':memory:');

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(embedded_agents)`.execute(db);
    const column = columns.rows.find((c) => c.name === 'instructions');
    expect(column).toBeDefined();
    expect(column!.type.toUpperCase()).toBe('TEXT');
    expect(column!.notnull).toBe(0);
  });

  it('round-trips a JSON-array string value', async () => {
    const db = await initializeDatabase(':memory:');

    await db
      .insertInto('embedded_agents')
      .values({
        id: 'agent-1',
        name: 'Ollama',
        description: null,
        provider_base_url: 'http://localhost:11434/v1',
        provider_model: 'qwen3:32b',
        provider_api_key_ref: null,
        system_prompt: null,
        max_tool_iterations: null,
        enabled_tools: null,
        instructions: JSON.stringify(['docs/local-note.md', 'CONTRIBUTING.md']),
        created_by: 'user-1',
      })
      .execute();

    const row = await db
      .selectFrom('embedded_agents')
      .where('id', '=', 'agent-1')
      .select('instructions')
      .executeTakeFirstOrThrow();

    expect(row.instructions).toBe(JSON.stringify(['docs/local-note.md', 'CONTRIBUTING.md']));
  });

  it('round-trips a null value', async () => {
    const db = await initializeDatabase(':memory:');

    await db
      .insertInto('embedded_agents')
      .values({
        id: 'agent-null',
        name: 'Ollama',
        description: null,
        provider_base_url: 'http://localhost:11434/v1',
        provider_model: 'qwen3:32b',
        provider_api_key_ref: null,
        system_prompt: null,
        max_tool_iterations: null,
        enabled_tools: null,
        instructions: null,
        created_by: 'user-1',
      })
      .execute();

    const row = await db
      .selectFrom('embedded_agents')
      .where('id', '=', 'agent-null')
      .select('instructions')
      .executeTakeFirstOrThrow();

    expect(row.instructions).toBeNull();
  });

  it('is idempotent when re-applied (duplicate column is ignored)', async () => {
    const db = await initializeDatabase(':memory:');

    await expect(migrateToV25(db)).resolves.toBeUndefined();

    const columns = await sql<PragmaTableInfoRow>`PRAGMA table_info(embedded_agents)`.execute(db);
    expect(columns.rows.find((c) => c.name === 'instructions')).toBeDefined();
  });
});
