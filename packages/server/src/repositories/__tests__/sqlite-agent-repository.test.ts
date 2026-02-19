import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Kysely, sql } from 'kysely';
import { BunSqliteDialect } from 'kysely-bun-sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import { SqliteAgentRepository } from '../sqlite-agent-repository.js';
import type { Database } from '../../database/schema.js';
import type { AgentDefinition, AgentActivityPatterns } from '@agent-console/shared';

const NOW_ISO8601 = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

describe('SqliteAgentRepository', () => {
  let bunDb: BunDatabase;
  let db: Kysely<Database>;
  let repository: SqliteAgentRepository;

  beforeEach(async () => {
    // Create in-memory database
    bunDb = new BunDatabase(':memory:');
    bunDb.exec('PRAGMA foreign_keys = ON;');

    db = new Kysely<Database>({
      dialect: new BunSqliteDialect({ database: bunDb }),
    });

    // Create agents table (v2 schema)
    await db.schema
      .createTable('agents')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('command_template', 'text', (col) => col.notNull())
      .addColumn('continue_template', 'text')
      .addColumn('headless_template', 'text')
      .addColumn('description', 'text')
      .addColumn('is_built_in', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(NOW_ISO8601))
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(NOW_ISO8601))
      .addColumn('activity_patterns', 'text')
      .execute();

    repository = new SqliteAgentRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
    bunDb.close();
  });

  // ========== Helper Functions ==========

  function createAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
    return {
      id: overrides.id ?? 'test-agent-id',
      name: overrides.name ?? 'Test Agent',
      commandTemplate: overrides.commandTemplate ?? 'agent start --prompt={{prompt}}',
      continueTemplate: overrides.continueTemplate,
      headlessTemplate: overrides.headlessTemplate,
      description: overrides.description,
      isBuiltIn: overrides.isBuiltIn ?? false,
      createdAt: overrides.createdAt ?? new Date().toISOString(),
      activityPatterns: overrides.activityPatterns,
      capabilities: overrides.capabilities ?? {
        supportsContinue: false,
        supportsHeadlessMode: false,
        supportsActivityDetection: false,
      },
    };
  }

  // ========== Test Suites ==========

  describe('findAll', () => {
    it('should return empty array when no agents exist', async () => {
      const agents = await repository.findAll();
      expect(agents).toEqual([]);
    });

    it('should return all agents', async () => {
      const agent1 = createAgent({ id: 'agent-1' });
      const agent2 = createAgent({ id: 'agent-2' });

      await repository.save(agent1);
      await repository.save(agent2);

      const agents = await repository.findAll();

      expect(agents.length).toBe(2);
      expect(agents.map((a) => a.id).sort()).toEqual(['agent-1', 'agent-2']);
    });

    it('should correctly restore capabilities from templates', async () => {
      const agent = createAgent({
        id: 'capable-agent',
        commandTemplate: 'agent --prompt={{prompt}}',
        continueTemplate: 'agent --continue',
        headlessTemplate: 'agent --headless --prompt={{prompt}}',
      });

      await repository.save(agent);

      const agents = await repository.findAll();
      expect(agents.length).toBe(1);

      const retrieved = agents[0];
      expect(retrieved.capabilities.supportsContinue).toBe(true);
      expect(retrieved.capabilities.supportsHeadlessMode).toBe(true);
    });
  });

  describe('findById', () => {
    it('should return agent if exists', async () => {
      const agent = createAgent({ id: 'find-me', name: 'Find Me Agent' });
      await repository.save(agent);

      const found = await repository.findById('find-me');

      expect(found).not.toBeNull();
      expect(found?.id).toBe('find-me');
      expect(found?.name).toBe('Find Me Agent');
    });

    it('should return null if agent not found', async () => {
      const agent = createAgent({ id: 'existing' });
      await repository.save(agent);

      const found = await repository.findById('non-existent');

      expect(found).toBeNull();
    });

    it('should return null when no agents exist', async () => {
      const found = await repository.findById('any-id');
      expect(found).toBeNull();
    });
  });

  describe('save', () => {
    it('should insert new agent', async () => {
      const agent = createAgent({ id: 'new-agent', name: 'New Agent' });

      await repository.save(agent);

      const found = await repository.findById('new-agent');
      expect(found).not.toBeNull();
      expect(found?.name).toBe('New Agent');
    });

    it('should update existing agent', async () => {
      const agent = createAgent({ id: 'update-agent', name: 'Original' });
      await repository.save(agent);

      const updated = createAgent({ id: 'update-agent', name: 'Updated' });
      await repository.save(updated);

      const found = await repository.findById('update-agent');
      expect(found?.name).toBe('Updated');

      // Verify only one agent exists
      const all = await repository.findAll();
      expect(all.length).toBe(1);
    });

    it('should preserve created_at and update updated_at on update', async () => {
      const originalCreatedAt = '2024-01-01T00:00:00.000Z';
      const agent = createAgent({
        id: 'timestamp-test',
        name: 'Original',
        createdAt: originalCreatedAt,
      });
      await repository.save(agent);

      // Get the original timestamps from database directly
      const originalRow = await db
        .selectFrom('agents')
        .where('id', '=', 'timestamp-test')
        .select(['created_at', 'updated_at'])
        .executeTakeFirst();

      expect(originalRow?.created_at).toBe(originalCreatedAt);
      const originalUpdatedAt = originalRow?.updated_at;

      // Wait a bit to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Update with a different createdAt (simulating real-world scenario)
      const updated = createAgent({
        id: 'timestamp-test',
        name: 'Updated',
        createdAt: '2024-06-01T00:00:00.000Z', // Different createdAt
      });
      await repository.save(updated);

      // Get timestamps after update
      const updatedRow = await db
        .selectFrom('agents')
        .where('id', '=', 'timestamp-test')
        .select(['created_at', 'updated_at'])
        .executeTakeFirst();

      // created_at should NOT change
      expect(updatedRow?.created_at).toBe(originalCreatedAt);

      // updated_at should change
      expect(updatedRow?.updated_at).not.toBe(originalUpdatedAt);
    });

    it('should save built-in agents', async () => {
      const builtInAgent = createAgent({ id: 'built-in', isBuiltIn: true });

      await repository.save(builtInAgent);

      // Built-in agent should be saved to DB
      const found = await repository.findById('built-in');
      expect(found).not.toBeNull();
      expect(found?.isBuiltIn).toBe(true);

      const all = await repository.findAll();
      expect(all.length).toBe(1);
    });

    it('should preserve all optional fields', async () => {
      const createdAt = '2024-01-15T10:30:00.000Z';
      const agent = createAgent({
        id: 'full-agent',
        name: 'Full Agent',
        commandTemplate: 'agent start --prompt={{prompt}}',
        continueTemplate: 'agent continue',
        headlessTemplate: 'agent headless --prompt={{prompt}}',
        description: 'A test agent with all fields',
        createdAt,
      });

      await repository.save(agent);

      const found = await repository.findById('full-agent');
      expect(found?.id).toBe('full-agent');
      expect(found?.name).toBe('Full Agent');
      expect(found?.commandTemplate).toBe('agent start --prompt={{prompt}}');
      expect(found?.continueTemplate).toBe('agent continue');
      expect(found?.headlessTemplate).toBe('agent headless --prompt={{prompt}}');
      expect(found?.description).toBe('A test agent with all fields');
      expect(found?.createdAt).toBe(createdAt);
    });

    it('should serialize and deserialize activity patterns', async () => {
      const activityPatterns: AgentActivityPatterns = {
        askingPatterns: ['do you want to proceed\\?', 'confirm\\?'],
      };

      const agent = createAgent({
        id: 'patterns-agent',
        activityPatterns,
      });

      await repository.save(agent);

      const found = await repository.findById('patterns-agent');
      expect(found?.activityPatterns).toEqual(activityPatterns);
    });

    it('should handle undefined optional fields', async () => {
      const agent = createAgent({
        id: 'minimal-agent',
        continueTemplate: undefined,
        headlessTemplate: undefined,
        description: undefined,
        activityPatterns: undefined,
      });

      await repository.save(agent);

      const found = await repository.findById('minimal-agent');
      expect(found?.continueTemplate).toBeUndefined();
      expect(found?.headlessTemplate).toBeUndefined();
      expect(found?.description).toBeUndefined();
      expect(found?.activityPatterns).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('should remove agent by id', async () => {
      const agents = [
        createAgent({ id: 'agent-1' }),
        createAgent({ id: 'agent-2' }),
        createAgent({ id: 'agent-3' }),
      ];

      for (const agent of agents) {
        await repository.save(agent);
      }

      await repository.delete('agent-2');

      const all = await repository.findAll();
      expect(all.length).toBe(2);
      expect(all.map((a) => a.id).sort()).toEqual(['agent-1', 'agent-3']);
    });

    it('should be idempotent for non-existent agent', async () => {
      await repository.save(createAgent({ id: 'existing' }));

      // Should not throw for non-existent agent
      await repository.delete('non-existent');

      // Existing agent should still be there
      const found = await repository.findById('existing');
      expect(found).not.toBeNull();
    });

    it('should throw error for built-in agents', async () => {
      // First save a non-built-in agent
      const customAgent = createAgent({ id: 'custom', isBuiltIn: false });
      await repository.save(customAgent);

      // Then manually insert a built-in agent for testing the delete logic
      const now = new Date().toISOString();
      await db
        .insertInto('agents')
        .values({
          id: 'built-in',
          name: 'Built-in Agent',
          command_template: 'built-in-command',
          continue_template: null,
          headless_template: null,
          description: null,
          is_built_in: 1,
          created_at: now,
          updated_at: now,
          activity_patterns: null,
        })
        .execute();

      // Attempt to delete built-in agent should throw
      await expect(repository.delete('built-in')).rejects.toThrow('Cannot delete built-in agent');

      // Built-in agent should still exist (check directly in DB)
      const row = await db
        .selectFrom('agents')
        .where('id', '=', 'built-in')
        .selectAll()
        .executeTakeFirst();
      expect(row).not.toBeUndefined();
    });

    it('should not affect other agents', async () => {
      const agent1 = createAgent({ id: 'agent-1', name: 'Agent One' });
      const agent2 = createAgent({ id: 'agent-2', name: 'Agent Two' });

      await repository.save(agent1);
      await repository.save(agent2);

      await repository.delete('agent-1');

      const remaining = await repository.findById('agent-2');
      expect(remaining).not.toBeNull();
      expect(remaining?.name).toBe('Agent Two');
    });
  });

  describe('edge cases', () => {
    it('should handle unicode in name and description', async () => {
      const agent = createAgent({
        id: 'unicode-agent',
        name: 'Agent with unicode: Hello World',
        description: 'Description with special chars: @#$%',
      });

      await repository.save(agent);

      const found = await repository.findById('unicode-agent');
      expect(found?.name).toBe('Agent with unicode: Hello World');
      expect(found?.description).toBe('Description with special chars: @#$%');
    });

    it('should handle long command templates', async () => {
      const longTemplate = 'command '.repeat(1000) + '--prompt={{prompt}}';
      const agent = createAgent({
        id: 'long-template',
        commandTemplate: longTemplate,
      });

      await repository.save(agent);

      const found = await repository.findById('long-template');
      expect(found?.commandTemplate).toBe(longTemplate);
    });

    it('should handle complex activity patterns', async () => {
      const complexPatterns: AgentActivityPatterns = {
        askingPatterns: [
          'proceed\\?',
          'confirm\\?',
          'continue\\?',
          'pattern1',
          'pattern2',
        ],
      };

      const agent = createAgent({
        id: 'complex-patterns',
        activityPatterns: complexPatterns,
      });

      await repository.save(agent);

      const found = await repository.findById('complex-patterns');
      expect(found?.activityPatterns?.askingPatterns?.length).toBe(5);
    });
  });
});
