import { describe, it, expect, beforeEach } from 'bun:test';
import type { EmbeddedAgentDefinition } from '@agent-console/shared';
import type { EmbeddedAgentRepository } from '../../repositories/embedded-agent-repository.js';
import {
  EmbeddedAgentManager,
  type EmbeddedAgentLifecycleCallbacks,
} from '../embedded-agent-manager.js';

/**
 * In-memory mock implementation of EmbeddedAgentRepository for testing.
 * `failSave` toggles a save-time failure so tests can assert the manager
 * writes to the repository BEFORE mutating its in-memory map / firing callbacks.
 */
class InMemoryEmbeddedAgentRepository implements EmbeddedAgentRepository {
  private defs = new Map<string, EmbeddedAgentDefinition>();
  failSave = false;

  async findAll(): Promise<EmbeddedAgentDefinition[]> {
    return Array.from(this.defs.values());
  }

  async findById(id: string): Promise<EmbeddedAgentDefinition | null> {
    return this.defs.get(id) ?? null;
  }

  async save(def: EmbeddedAgentDefinition): Promise<void> {
    if (this.failSave) {
      throw new Error('save failed');
    }
    this.defs.set(def.id, def);
  }

  async delete(id: string): Promise<void> {
    this.defs.delete(id);
  }

  // Test helper: current persisted state
  getAllSaved(): EmbeddedAgentDefinition[] {
    return Array.from(this.defs.values());
  }
}

/** Records callback invocations for assertion. */
function createCallbackRecorder() {
  const created: EmbeddedAgentDefinition[] = [];
  const updated: EmbeddedAgentDefinition[] = [];
  const deleted: string[] = [];
  const callbacks: EmbeddedAgentLifecycleCallbacks = {
    onEmbeddedAgentCreated: (def) => created.push(def),
    onEmbeddedAgentUpdated: (def) => updated.push(def),
    onEmbeddedAgentDeleted: (id) => deleted.push(id),
  };
  return { created, updated, deleted, callbacks };
}

const VALID_PROVIDER = {
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen3:32b',
};

describe('EmbeddedAgentManager', () => {
  let repository: InMemoryEmbeddedAgentRepository;

  beforeEach(() => {
    repository = new InMemoryEmbeddedAgentRepository();
  });

  async function getManager() {
    return EmbeddedAgentManager.create(repository);
  }

  describe('initialization', () => {
    it('starts empty when the repository has no definitions', async () => {
      const manager = await getManager();
      expect(manager.getAllEmbeddedAgents()).toEqual([]);
    });

    it('loads existing definitions from the repository', async () => {
      const now = '2024-01-01T00:00:00.000Z';
      await repository.save({
        id: 'preloaded',
        name: 'Preloaded',
        provider: VALID_PROVIDER,
        createdBy: 'user-1',
        createdAt: now,
        updatedAt: now,
      });

      const manager = await getManager();
      expect(manager.getAllEmbeddedAgents()).toHaveLength(1);
      expect(manager.getEmbeddedAgent('preloaded')?.name).toBe('Preloaded');
    });
  });

  describe('createEmbeddedAgent', () => {
    it('sets server-side createdBy, a uuid id, and matching timestamps', async () => {
      const manager = await getManager();

      const def = await manager.createEmbeddedAgent(
        { name: 'Ollama', provider: VALID_PROVIDER },
        'creator-user-id'
      );

      expect(def.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(def.createdBy).toBe('creator-user-id');
      expect(def.createdAt).toBe(def.updatedAt);
      expect(def.name).toBe('Ollama');
      expect(def.provider).toEqual(VALID_PROVIDER);

      // Retrievable from the in-memory map and persisted in the repository
      expect(manager.getEmbeddedAgent(def.id)).toEqual(def);
      expect(repository.getAllSaved()).toHaveLength(1);
    });

    it('ignores any createdBy carried on the request object (server-side only)', async () => {
      const manager = await getManager();

      const def = await manager.createEmbeddedAgent(
        // Extra createdBy would be stripped by the route schema; assert the
        // manager never reads it even if present.
        { name: 'X', provider: VALID_PROVIDER, createdBy: 'attacker' } as never,
        'real-user'
      );

      expect(def.createdBy).toBe('real-user');
    });

    it('sets enabledTools from the request', async () => {
      const manager = await getManager();

      const def = await manager.createEmbeddedAgent(
        { name: 'Ollama', provider: VALID_PROVIDER, enabledTools: ['Read', 'Glob'] },
        'creator-user-id'
      );

      expect(def.enabledTools).toEqual(['Read', 'Glob']);
    });

    it('leaves enabledTools undefined when absent from the request', async () => {
      const manager = await getManager();

      const def = await manager.createEmbeddedAgent(
        { name: 'Ollama', provider: VALID_PROVIDER },
        'creator-user-id'
      );

      expect(def.enabledTools).toBeUndefined();
    });

    it('sets instructions from the request', async () => {
      const manager = await getManager();

      const def = await manager.createEmbeddedAgent(
        { name: 'Ollama', provider: VALID_PROVIDER, instructions: ['docs/local-note.md'] },
        'creator-user-id'
      );

      expect(def.instructions).toEqual(['docs/local-note.md']);
    });

    it('leaves instructions undefined when absent from the request', async () => {
      const manager = await getManager();

      const def = await manager.createEmbeddedAgent(
        { name: 'Ollama', provider: VALID_PROVIDER },
        'creator-user-id'
      );

      expect(def.instructions).toBeUndefined();
    });

    it('fires onEmbeddedAgentCreated after a successful save', async () => {
      const { created, callbacks } = createCallbackRecorder();
      const manager = await getManager();
      manager.setLifecycleCallbacks(callbacks);

      const def = await manager.createEmbeddedAgent(
        { name: 'Cb', provider: VALID_PROVIDER },
        'user-1'
      );

      expect(created).toHaveLength(1);
      expect(created[0]).toEqual(def);
    });

    it('does not mutate the map or fire the callback when the repository save fails', async () => {
      const { created, callbacks } = createCallbackRecorder();
      const manager = await getManager();
      manager.setLifecycleCallbacks(callbacks);
      repository.failSave = true;

      await expect(
        manager.createEmbeddedAgent({ name: 'Fail', provider: VALID_PROVIDER }, 'user-1')
      ).rejects.toThrow('save failed');

      expect(manager.getAllEmbeddedAgents()).toEqual([]);
      expect(created).toHaveLength(0);
    });
  });

  describe('updateEmbeddedAgent', () => {
    async function seed(manager: EmbeddedAgentManager) {
      return manager.createEmbeddedAgent(
        {
          name: 'Original',
          description: 'orig desc',
          provider: VALID_PROVIDER,
          systemPrompt: 'orig prompt',
          maxToolIterations: 10,
          enabledTools: ['Read'],
          instructions: ['docs/local-note.md'],
        },
        'owner-id'
      );
    }

    it('keeps fields on undefined, preserving createdBy/createdAt', async () => {
      const manager = await getManager();
      const created = await seed(manager);

      const updated = await manager.updateEmbeddedAgent(created.id, { name: 'Renamed' });

      expect(updated).not.toBeNull();
      expect(updated?.name).toBe('Renamed');
      expect(updated?.description).toBe('orig desc');
      expect(updated?.systemPrompt).toBe('orig prompt');
      expect(updated?.maxToolIterations).toBe(10);
      expect(updated?.enabledTools).toEqual(['Read']);
      expect(updated?.instructions).toEqual(['docs/local-note.md']);
      expect(updated?.provider).toEqual(VALID_PROVIDER);
      expect(updated?.createdBy).toBe('owner-id');
      expect(updated?.createdAt).toBe(created.createdAt);
    });

    it('clears description/systemPrompt/maxToolIterations/enabledTools/instructions on null', async () => {
      const manager = await getManager();
      const created = await seed(manager);

      const updated = await manager.updateEmbeddedAgent(created.id, {
        description: null,
        systemPrompt: null,
        maxToolIterations: null,
        enabledTools: null,
        instructions: null,
      });

      expect(updated?.description).toBeUndefined();
      expect(updated?.systemPrompt).toBeUndefined();
      expect(updated?.maxToolIterations).toBeUndefined();
      expect(updated?.enabledTools).toBeUndefined();
      expect(updated?.instructions).toBeUndefined();
    });

    it('replaces enabledTools with the request value when present, including an explicit empty array', async () => {
      const manager = await getManager();
      const created = await seed(manager);

      const updated = await manager.updateEmbeddedAgent(created.id, { enabledTools: [] });

      expect(updated?.enabledTools).toEqual([]);
    });

    it('replaces instructions with the request value when present, including an explicit empty array', async () => {
      const manager = await getManager();
      const created = await seed(manager);

      const updated = await manager.updateEmbeddedAgent(created.id, { instructions: [] });

      expect(updated?.instructions).toEqual([]);
    });

    it('replaces the whole provider object when provider is present', async () => {
      const manager = await getManager();
      const created = await seed(manager);

      const newProvider = {
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        apiKeyRef: 'openai-key',
      };
      const updated = await manager.updateEmbeddedAgent(created.id, { provider: newProvider });

      expect(updated?.provider).toEqual(newProvider);
    });

    it('bumps updatedAt', async () => {
      const manager = await getManager();
      const created = await seed(manager);
      await new Promise((r) => setTimeout(r, 5));

      const updated = await manager.updateEmbeddedAgent(created.id, { name: 'New' });
      expect(updated?.updatedAt).not.toBe(created.updatedAt);
    });

    it('returns null for an unknown id', async () => {
      const manager = await getManager();
      const result = await manager.updateEmbeddedAgent('nope', { name: 'X' });
      expect(result).toBeNull();
    });

    it('fires onEmbeddedAgentUpdated with the updated definition', async () => {
      const { updated, callbacks } = createCallbackRecorder();
      const manager = await getManager();
      const created = await seed(manager);
      manager.setLifecycleCallbacks(callbacks);

      const result = await manager.updateEmbeddedAgent(created.id, { name: 'Renamed' });

      expect(updated).toHaveLength(1);
      expect(updated[0]).toEqual(result!);
    });

    it('does not mutate the map or fire the callback when the repository save fails', async () => {
      const { updated, callbacks } = createCallbackRecorder();
      const manager = await getManager();
      const created = await seed(manager);
      manager.setLifecycleCallbacks(callbacks);
      repository.failSave = true;

      await expect(
        manager.updateEmbeddedAgent(created.id, { name: 'Renamed' })
      ).rejects.toThrow('save failed');

      expect(manager.getEmbeddedAgent(created.id)?.name).toBe('Original');
      expect(updated).toHaveLength(0);
    });
  });

  describe('deleteEmbeddedAgent', () => {
    it('removes the definition from the map and the repository', async () => {
      const manager = await getManager();
      const created = await manager.createEmbeddedAgent(
        { name: 'ToDelete', provider: VALID_PROVIDER },
        'user-1'
      );

      const result = await manager.deleteEmbeddedAgent(created.id);

      expect(result).toBe(true);
      expect(manager.getEmbeddedAgent(created.id)).toBeUndefined();
      expect(repository.getAllSaved()).toHaveLength(0);
    });

    it('returns false for an unknown id', async () => {
      const manager = await getManager();
      const result = await manager.deleteEmbeddedAgent('nope');
      expect(result).toBe(false);
    });

    it('fires onEmbeddedAgentDeleted with the id', async () => {
      const { deleted, callbacks } = createCallbackRecorder();
      const manager = await getManager();
      const created = await manager.createEmbeddedAgent(
        { name: 'ToDelete', provider: VALID_PROVIDER },
        'user-1'
      );
      manager.setLifecycleCallbacks(callbacks);

      await manager.deleteEmbeddedAgent(created.id);

      expect(deleted).toEqual([created.id]);
    });
  });
});
