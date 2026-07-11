import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Kysely, sql } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import { SqliteEmbeddedAgentRepository } from '../sqlite-embedded-agent-repository.js';
import type { Database } from '../../database/schema.js';
import type { EmbeddedAgentDefinition } from '@agent-console/shared';

const NOW_ISO8601 = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

function buildDefinition(
  overrides: Partial<EmbeddedAgentDefinition> = {}
): EmbeddedAgentDefinition {
  return {
    id: 'def-1',
    name: 'Ollama qwen3',
    provider: {
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3:32b',
    },
    createdBy: 'user-1',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('SqliteEmbeddedAgentRepository', () => {
  let bunDb: BunDatabase;
  let db: Kysely<Database>;
  let repository: SqliteEmbeddedAgentRepository;

  beforeEach(async () => {
    bunDb = new BunDatabase(':memory:');
    bunDb.exec('PRAGMA foreign_keys = ON;');

    db = new Kysely<Database>({
      dialect: new BunSqliteDialect({ database: bunDb }),
    });

    await db.schema
      .createTable('embedded_agents')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('description', 'text')
      .addColumn('provider_base_url', 'text', (col) => col.notNull())
      .addColumn('provider_model', 'text', (col) => col.notNull())
      .addColumn('provider_api_key_ref', 'text')
      .addColumn('system_prompt', 'text')
      .addColumn('max_tool_iterations', 'integer')
      .addColumn('created_by', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(NOW_ISO8601))
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(NOW_ISO8601))
      .execute();

    repository = new SqliteEmbeddedAgentRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
    bunDb.close();
  });

  describe('findAll', () => {
    it('returns an empty array when none exist', async () => {
      expect(await repository.findAll()).toEqual([]);
    });

    it('returns all saved definitions', async () => {
      await repository.save(buildDefinition({ id: 'a' }));
      await repository.save(buildDefinition({ id: 'b' }));

      const all = await repository.findAll();
      expect(all.map((d) => d.id).sort()).toEqual(['a', 'b']);
    });
  });

  describe('save / findById round-trip', () => {
    it('round-trips a full definition including optional fields', async () => {
      const def = buildDefinition({
        id: 'full',
        description: 'A local model',
        provider: {
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
          apiKeyRef: 'openai-key',
        },
        systemPrompt: 'You are helpful',
        maxToolIterations: 42,
      });

      await repository.save(def);
      const found = await repository.findById('full');

      expect(found).toEqual(def);
    });

    it('round-trips a minimal definition with null optional fields', async () => {
      const def = buildDefinition({ id: 'minimal' });

      await repository.save(def);
      const found = await repository.findById('minimal');

      expect(found?.description).toBeUndefined();
      expect(found?.provider.apiKeyRef).toBeUndefined();
      expect(found?.systemPrompt).toBeUndefined();
      expect(found?.maxToolIterations).toBeUndefined();
    });

    it('returns null for an unknown id', async () => {
      expect(await repository.findById('nope')).toBeNull();
    });
  });

  describe('upsert', () => {
    it('updates mutable fields on conflict', async () => {
      await repository.save(buildDefinition({ id: 'x', name: 'Original' }));
      await repository.save(
        buildDefinition({ id: 'x', name: 'Updated', updatedAt: '2024-06-01T00:00:00.000Z' })
      );

      const found = await repository.findById('x');
      expect(found?.name).toBe('Updated');
      // Only one row
      expect(await repository.findAll()).toHaveLength(1);
    });

    it('does not clobber created_at or created_by on conflict', async () => {
      await repository.save(
        buildDefinition({
          id: 'x',
          createdBy: 'original-creator',
          createdAt: '2024-01-01T00:00:00.000Z',
        })
      );

      // Attempt to overwrite created_by/created_at via a second save
      await repository.save(
        buildDefinition({
          id: 'x',
          name: 'Renamed',
          createdBy: 'imposter',
          createdAt: '2099-12-31T00:00:00.000Z',
          updatedAt: '2024-06-01T00:00:00.000Z',
        })
      );

      const row = await db
        .selectFrom('embedded_agents')
        .where('id', '=', 'x')
        .select(['created_at', 'created_by', 'updated_at', 'name'])
        .executeTakeFirst();

      expect(row?.created_by).toBe('original-creator');
      expect(row?.created_at).toBe('2024-01-01T00:00:00.000Z');
      expect(row?.updated_at).toBe('2024-06-01T00:00:00.000Z');
      expect(row?.name).toBe('Renamed');
    });
  });

  describe('delete', () => {
    it('removes a definition by id', async () => {
      await repository.save(buildDefinition({ id: 'a' }));
      await repository.save(buildDefinition({ id: 'b' }));

      await repository.delete('a');

      const all = await repository.findAll();
      expect(all.map((d) => d.id)).toEqual(['b']);
    });

    it('is idempotent for a non-existent id', async () => {
      await repository.save(buildDefinition({ id: 'keep' }));

      await repository.delete('nope');

      expect(await repository.findById('keep')).not.toBeNull();
    });
  });
});
