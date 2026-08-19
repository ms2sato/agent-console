import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Kysely, sql } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import { SqliteEmbeddedAgentRepository } from '../sqlite-embedded-agent-repository.js';
import type { Database } from '../../database/schema.js';
import type { EmbeddedAgentDefinition } from '@agent-console/shared';

const NOW_ISO8601 = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

function buildDefinition(
  overrides: Partial<Extract<EmbeddedAgentDefinition, { engine: 'openai-api' }>> = {}
): EmbeddedAgentDefinition {
  return {
    id: 'def-1',
    name: 'Ollama qwen3',
    engine: 'openai-api',
    provider: {
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3:32b',
    },
    isBuiltIn: false,
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
      .addColumn('engine', 'text', (col) => col.notNull().defaultTo('openai-api'))
      .addColumn('provider_base_url', 'text')
      .addColumn('provider_model', 'text', (col) => col.notNull())
      .addColumn('provider_api_key_ref', 'text')
      .addColumn('system_prompt', 'text')
      .addColumn('max_tool_iterations', 'integer')
      .addColumn('enabled_tools', 'text')
      .addColumn('instructions', 'text')
      .addColumn('context_window_tokens', 'integer')
      .addColumn('handoff_soft_ratio', 'real')
      .addColumn('handoff_hard_ratio', 'real')
      .addColumn('handoff_auto', 'integer')
      .addColumn('is_built_in', 'integer', (col) => col.notNull().defaultTo(0))
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

  describe('data integrity handling', () => {
    // `engine` is typed as a literal union ('openai-api' | 'claude-sdk') by
    // the Kysely schema; a corrupted row's actual value is deliberately
    // outside that union (this is what `toEmbeddedAgentDefinition`'s
    // default-arm consistency guard exists to catch), so the insert needs a
    // single, documented, narrowly-scoped cast to bypass the compile-time
    // guarantee that real corrupted data would not honor either.
    const BOGUS_ENGINE = 'bogus-engine' as 'openai-api' | 'claude-sdk';

    it('skips a row with an unknown engine value in findAll, returning healthy definitions', async () => {
      await repository.save(buildDefinition({ id: 'healthy' }));

      // Insert a corrupted row directly (unknown `engine` value -- the
      // `toEmbeddedAgentDefinition` mapper's default-arm consistency guard).
      await db
        .insertInto('embedded_agents')
        .values({
          id: 'corrupted-unknown-engine',
          name: 'Corrupted',
          engine: BOGUS_ENGINE,
          provider_base_url: 'http://localhost:11434/v1',
          provider_model: 'm',
          is_built_in: 0,
          created_by: 'user-1',
        })
        .execute();

      const all = await repository.findAll();

      expect(all.map((d) => d.id)).toEqual(['healthy']);
    });

    it('skips an openai-api row with a null provider_base_url in findAll, returning healthy definitions', async () => {
      await repository.save(buildDefinition({ id: 'healthy' }));

      // Insert a corrupted row directly (openai-api engine requires a
      // non-null provider_base_url).
      await db
        .insertInto('embedded_agents')
        .values({
          id: 'corrupted-null-base-url',
          name: 'Corrupted',
          engine: 'openai-api',
          provider_base_url: null,
          provider_model: 'm',
          is_built_in: 0,
          created_by: 'user-1',
        })
        .execute();

      const all = await repository.findAll();

      expect(all.map((d) => d.id)).toEqual(['healthy']);
    });

    it('lets a DataIntegrityError propagate uncaught from findById, which has no containment wrapper', async () => {
      // findById has no per-row try/catch (unlike findAll's containment
      // loop) -- a single corrupted row looked up directly still surfaces
      // the mapper's DataIntegrityError uncaught, same as before this fix.
      await db
        .insertInto('embedded_agents')
        .values({
          id: 'corrupted-only',
          name: 'Corrupted',
          engine: BOGUS_ENGINE,
          provider_base_url: 'http://localhost:11434/v1',
          provider_model: 'm',
          is_built_in: 0,
          created_by: 'user-1',
        })
        .execute();

      await expect(repository.findById('corrupted-only')).rejects.toThrow(
        "Data integrity error: embedded-agent 'corrupted-only' has invalid engine (unexpected value: bogus-engine)"
      );
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
      expect(found?.engine).toBe('openai-api');
      if (found?.engine === 'openai-api') {
        expect(found.provider.apiKeyRef).toBeUndefined();
      }
      expect(found?.systemPrompt).toBeUndefined();
      expect(found?.maxToolIterations).toBeUndefined();
    });

    it('returns null for an unknown id', async () => {
      expect(await repository.findById('nope')).toBeNull();
    });

    it('round-trips enabledTools: undefined as a NULL column and back to undefined', async () => {
      const def = buildDefinition({ id: 'no-enabled-tools' });

      await repository.save(def);
      const found = await repository.findById('no-enabled-tools');

      expect(found?.enabledTools).toBeUndefined();
    });

    it('round-trips enabledTools: [] as an explicit empty array', async () => {
      const def = buildDefinition({ id: 'empty-enabled-tools', enabledTools: [] });

      await repository.save(def);
      const found = await repository.findById('empty-enabled-tools');

      expect(found?.enabledTools).toEqual([]);
    });

    it('round-trips a non-empty enabledTools array exactly', async () => {
      const def = buildDefinition({ id: 'some-enabled-tools', enabledTools: ['Read', 'Glob'] });

      await repository.save(def);
      const found = await repository.findById('some-enabled-tools');

      expect(found?.enabledTools).toEqual(['Read', 'Glob']);
    });

    it('round-trips instructions: undefined as a NULL column and back to undefined', async () => {
      const def = buildDefinition({ id: 'no-instructions' });

      await repository.save(def);
      const found = await repository.findById('no-instructions');

      expect(found?.instructions).toBeUndefined();
    });

    it('round-trips instructions: [] as an explicit empty array', async () => {
      const def = buildDefinition({ id: 'empty-instructions', instructions: [] });

      await repository.save(def);
      const found = await repository.findById('empty-instructions');

      expect(found?.instructions).toEqual([]);
    });

    it('round-trips a non-empty instructions array exactly', async () => {
      const def = buildDefinition({
        id: 'some-instructions',
        instructions: ['docs/local-note.md', 'CONTRIBUTING.md'],
      });

      await repository.save(def);
      const found = await repository.findById('some-instructions');

      expect(found?.instructions).toEqual(['docs/local-note.md', 'CONTRIBUTING.md']);
    });

    it('round-trips contextWindowTokens and handoff (Context Handoff Phase A)', async () => {
      const def = buildDefinition({
        id: 'handoff-configured',
        contextWindowTokens: 128000,
        handoff: { softRatio: 0.75, hardRatio: 0.9, auto: true },
      });

      await repository.save(def);
      const found = await repository.findById('handoff-configured');

      expect(found?.contextWindowTokens).toBe(128000);
      expect(found?.handoff).toEqual({ softRatio: 0.75, hardRatio: 0.9, auto: true });
    });

    it('round-trips contextWindowTokens/handoff: undefined as NULL columns and back to undefined', async () => {
      const def = buildDefinition({ id: 'handoff-unconfigured' });

      await repository.save(def);
      const found = await repository.findById('handoff-unconfigured');

      expect(found?.contextWindowTokens).toBeUndefined();
      expect(found?.handoff).toBeUndefined();
    });

    it('round-trips engine and isBuiltIn (SDK Engine Phase 1)', async () => {
      const def = buildDefinition({ id: 'engine-fields', isBuiltIn: true });

      await repository.save(def);
      const found = await repository.findById('engine-fields');

      expect(found?.engine).toBe('openai-api');
      expect(found?.isBuiltIn).toBe(true);
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

    it('updates enabled_tools on conflict (regression guard: onConflict lists columns explicitly)', async () => {
      await repository.save(buildDefinition({ id: 'x', enabledTools: ['Read'] }));
      await repository.save(
        buildDefinition({
          id: 'x',
          enabledTools: ['Read', 'Glob', 'Grep'],
          updatedAt: '2024-06-01T00:00:00.000Z',
        })
      );

      const found = await repository.findById('x');
      expect(found?.enabledTools).toEqual(['Read', 'Glob', 'Grep']);
    });

    it('updates instructions on conflict (regression guard: onConflict lists columns explicitly)', async () => {
      await repository.save(buildDefinition({ id: 'x', instructions: ['a.md'] }));
      await repository.save(
        buildDefinition({
          id: 'x',
          instructions: ['a.md', 'b.md'],
          updatedAt: '2024-06-01T00:00:00.000Z',
        })
      );

      const found = await repository.findById('x');
      expect(found?.instructions).toEqual(['a.md', 'b.md']);
    });

    it('updates contextWindowTokens/handoff on conflict (regression guard: onConflict lists columns explicitly)', async () => {
      await repository.save(buildDefinition({ id: 'x', contextWindowTokens: 32000 }));
      await repository.save(
        buildDefinition({
          id: 'x',
          contextWindowTokens: 128000,
          handoff: { softRatio: 0.8, hardRatio: 0.95, auto: true },
          updatedAt: '2024-06-01T00:00:00.000Z',
        })
      );

      const found = await repository.findById('x');
      expect(found?.contextWindowTokens).toBe(128000);
      expect(found?.handoff).toEqual({ softRatio: 0.8, hardRatio: 0.95, auto: true });
    });

    it('updates is_built_in on conflict (regression guard: onConflict lists columns explicitly)', async () => {
      await repository.save(buildDefinition({ id: 'x', isBuiltIn: false }));
      await repository.save(
        buildDefinition({ id: 'x', isBuiltIn: true, updatedAt: '2024-06-01T00:00:00.000Z' })
      );

      const found = await repository.findById('x');
      expect(found?.isBuiltIn).toBe(true);
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
