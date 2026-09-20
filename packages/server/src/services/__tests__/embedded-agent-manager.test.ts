import { describe, it, expect, beforeEach } from 'bun:test';
import { JOB_TYPES, type EmbeddedAgentDefinition } from '@agent-console/shared';
import type { EmbeddedAgentRepository } from '../../repositories/embedded-agent-repository.js';
import type { JobQueue } from '../../jobs/index.js';
import {
  EmbeddedAgentManager,
  type EmbeddedAgentLifecycleCallbacks,
} from '../embedded-agent-manager.js';
import { claudeSdkAgent, CLAUDE_SDK_AGENT_ID } from '../embedded-agents/claude-sdk-builtin.js';

/**
 * In-memory mock implementation of EmbeddedAgentRepository for testing.
 * `failSave` toggles a save-time failure so tests can assert the manager
 * writes to the repository BEFORE mutating its in-memory map / firing callbacks.
 */
class InMemoryEmbeddedAgentRepository implements EmbeddedAgentRepository {
  private defs = new Map<string, EmbeddedAgentDefinition>();
  failSave = false;
  /** Throws from `delete()` when set, to test the pre-enqueue failure path. */
  failDelete = false;
  /** Fires after a successful `delete()`, so tests can assert call ordering
   *  against the manager's own job-queue enqueue. */
  onDelete?: (id: string) => void;

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
    if (this.failDelete) {
      throw new Error('delete failed');
    }
    this.defs.delete(id);
    this.onDelete?.(id);
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

/**
 * Fake `JobQueue` capturing every `enqueue` call's `(type, payload)`, plus
 * an optional `order` array so tests can interleave enqueue calls with
 * other recorded events (repository writes, lifecycle callbacks) to assert
 * relative ordering.
 */
function createFakeJobQueue(order?: string[]) {
  const calls: Array<{ type: string; payload: unknown }> = [];
  const jobQueue = {
    enqueue: async (type: string, payload: unknown) => {
      order?.push('enqueue');
      calls.push({ type, payload });
      return 'job-id';
    },
  } as unknown as JobQueue;
  return { jobQueue, calls };
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
    it('registers only the built-in claude-sdk definition when the repository has no custom definitions', async () => {
      const manager = await getManager();
      expect(manager.getAllEmbeddedAgents()).toEqual([claudeSdkAgent]);
    });

    it('loads existing definitions from the repository alongside the built-in', async () => {
      const now = '2024-01-01T00:00:00.000Z';
      await repository.save({
        id: 'preloaded',
        name: 'Preloaded',
        engine: 'openai-api',
        provider: VALID_PROVIDER,
        isBuiltIn: false,
        createdBy: 'user-1',
        createdAt: now,
        updatedAt: now,
      });

      const manager = await getManager();
      expect(manager.getAllEmbeddedAgents()).toHaveLength(2);
      expect(manager.getEmbeddedAgent('preloaded')?.name).toBe('Preloaded');
      expect(manager.getEmbeddedAgent(CLAUDE_SDK_AGENT_ID)).toEqual(claudeSdkAgent);
    });

    it('upserts the built-in definition to the repository on every startup', async () => {
      await getManager();
      expect(repository.getAllSaved()).toEqual([claudeSdkAgent]);
    });

    it('is present in findAll() / getAllEmbeddedAgents() even when the repository already persisted it from a prior startup (upsert idempotency)', async () => {
      await getManager(); // first startup: upserts claudeSdkAgent

      const manager = await getManager(); // second startup: repository.findAll() now also returns it
      expect(manager.getAllEmbeddedAgents()).toEqual([claudeSdkAgent]);
      expect(repository.getAllSaved()).toEqual([claudeSdkAgent]);
    });

    // Mutation measurement (epic 1636 Phase 2, upgrade-path pin): temporarily
    // added an `if (await repository.findById(CLAUDE_SDK_AGENT_ID)) return;`
    // guard before the `save(claudeSdkAgent)` call in
    // `EmbeddedAgentManager.initialize()` (simulating "only save on the very
    // first startup"). This test failed as expected (the seeded row's
    // `enabledTools: undefined` was never overwritten). Reverted after
    // observing the failure.
    it('upgrades a pre-existing persisted row missing enabledTools (an install that predates the Write/Edit opt-in) to the current definition on next startup', async () => {
      // Simulate a DB row persisted by a prior server version, before this
      // builtin carried an `enabledTools` field at all.
      const staleRow: EmbeddedAgentDefinition = {
        ...claudeSdkAgent,
        enabledTools: undefined,
      };
      await repository.save(staleRow);

      await getManager(); // initialize() re-upserts claudeSdkAgent unconditionally

      const persisted = await repository.findById(CLAUDE_SDK_AGENT_ID);
      expect(persisted?.enabledTools).toEqual(['Read', 'Glob', 'Grep', 'TodoWrite', 'Write', 'Edit']);
    });
  });

  describe('createEmbeddedAgent', () => {
    it('sets server-side createdBy, a uuid id, and matching timestamps', async () => {
      const manager = await getManager();

      const def = await manager.createEmbeddedAgent(
        { engine: 'openai-api', name: 'Ollama', provider: VALID_PROVIDER },
        'creator-user-id'
      );

      expect(def.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(def.createdBy).toBe('creator-user-id');
      expect(def.createdAt).toBe(def.updatedAt);
      expect(def.name).toBe('Ollama');
      expect(def.provider).toEqual(VALID_PROVIDER);

      // Retrievable from the in-memory map and persisted in the repository
      // (alongside the built-in, upserted at startup).
      expect(manager.getEmbeddedAgent(def.id)).toEqual(def);
      expect(repository.getAllSaved()).toHaveLength(2);
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
        { engine: 'openai-api', name: 'Ollama', provider: VALID_PROVIDER, enabledTools: ['Read', 'Glob'] },
        'creator-user-id'
      );

      expect(def.enabledTools).toEqual(['Read', 'Glob']);
    });

    it('leaves enabledTools undefined when absent from the request', async () => {
      const manager = await getManager();

      const def = await manager.createEmbeddedAgent(
        { engine: 'openai-api', name: 'Ollama', provider: VALID_PROVIDER },
        'creator-user-id'
      );

      expect(def.enabledTools).toBeUndefined();
    });

    it('sets instructions from the request', async () => {
      const manager = await getManager();

      const def = await manager.createEmbeddedAgent(
        { engine: 'openai-api', name: 'Ollama', provider: VALID_PROVIDER, instructions: ['docs/local-note.md'] },
        'creator-user-id'
      );

      expect(def.instructions).toEqual(['docs/local-note.md']);
    });

    it('leaves instructions undefined when absent from the request', async () => {
      const manager = await getManager();

      const def = await manager.createEmbeddedAgent(
        { engine: 'openai-api', name: 'Ollama', provider: VALID_PROVIDER },
        'creator-user-id'
      );

      expect(def.instructions).toBeUndefined();
    });

    it('sets contextWindowTokens and compaction from the request', async () => {
      const manager = await getManager();

      const def = await manager.createEmbeddedAgent(
        {
          engine: 'openai-api',
          name: 'Ollama',
          provider: VALID_PROVIDER,
          contextWindowTokens: 128000,
          compaction: { threshold: 0.75 },
        },
        'creator-user-id'
      );

      expect(def.contextWindowTokens).toBe(128000);
      expect(def.compaction).toEqual({ threshold: 0.75 });
    });

    it('leaves contextWindowTokens/compaction undefined when absent from the request', async () => {
      const manager = await getManager();

      const def = await manager.createEmbeddedAgent(
        { engine: 'openai-api', name: 'Ollama', provider: VALID_PROVIDER },
        'creator-user-id'
      );

      expect(def.contextWindowTokens).toBeUndefined();
      expect(def.compaction).toBeUndefined();
    });

    it('fires onEmbeddedAgentCreated after a successful save', async () => {
      const { created, callbacks } = createCallbackRecorder();
      const manager = await getManager();
      manager.setLifecycleCallbacks(callbacks);

      const def = await manager.createEmbeddedAgent(
        { engine: 'openai-api', name: 'Cb', provider: VALID_PROVIDER },
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
        manager.createEmbeddedAgent({ engine: 'openai-api', name: 'Fail', provider: VALID_PROVIDER }, 'user-1')
      ).rejects.toThrow('save failed');

      expect(manager.getAllEmbeddedAgents()).toEqual([claudeSdkAgent]);
      expect(created).toHaveLength(0);
    });

    describe('claude-sdk engine (epic #1636 Phase 5 PR-1, decision 3, Issue #1779)', () => {
      it('creates a minimal claude-sdk definition: id, name, provider.model, no other fields', async () => {
        const manager = await getManager();

        const def = await manager.createEmbeddedAgent(
          { engine: 'claude-sdk', name: 'Claude', provider: { model: 'claude-sonnet-5' } },
          'creator-user-id'
        );

        expect(def.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(def.engine).toBe('claude-sdk');
        expect(def.name).toBe('Claude');
        expect(def.provider).toEqual({ model: 'claude-sonnet-5' });
        expect(def.isBuiltIn).toBe(false);
        expect(def.createdBy).toBe('creator-user-id');
        expect(def.createdAt).toBe(def.updatedAt);
        if (def.engine === 'claude-sdk') {
          expect(def.mcpServers).toBeUndefined();
          expect(def.subagents).toBeUndefined();
        }
        expect(def.enabledTools).toBeUndefined();
        expect(def.systemPrompt).toBeUndefined();

        expect(manager.getEmbeddedAgent(def.id)).toEqual(def);
      });

      it('fires onEmbeddedAgentCreated for a claude-sdk create', async () => {
        const { created, callbacks } = createCallbackRecorder();
        const manager = await getManager();
        manager.setLifecycleCallbacks(callbacks);

        const def = await manager.createEmbeddedAgent(
          { engine: 'claude-sdk', name: 'Claude', provider: { model: 'claude-sonnet-5' } },
          'user-1'
        );

        expect(created).toHaveLength(1);
        expect(created[0]).toEqual(def);
      });
    });

    describe("'Task' in enabledTools on an openai-api create (incapable engine)", () => {
      it('rejects with a ValidationError naming the capability row reason', async () => {
        const manager = await getManager();

        await expect(
          manager.createEmbeddedAgent(
            { engine: 'openai-api', name: 'X', provider: VALID_PROVIDER, enabledTools: ['Read', 'Task'] },
            'user-1'
          )
        ).rejects.toThrow('openai-api has no subagent runtime');
      });

      it('does not persist or mutate the map when rejected', async () => {
        const manager = await getManager();

        await expect(
          manager.createEmbeddedAgent(
            { engine: 'openai-api', name: 'X', provider: VALID_PROVIDER, enabledTools: ['Task'] },
            'user-1'
          )
        ).rejects.toThrow();

        expect(manager.getAllEmbeddedAgents()).toEqual([claudeSdkAgent]);
        expect(repository.getAllSaved()).toHaveLength(1);
      });
    });
  });

  describe('updateEmbeddedAgent', () => {
    async function seed(manager: EmbeddedAgentManager) {
      return manager.createEmbeddedAgent(
        {
          engine: 'openai-api',
          name: 'Original',
          description: 'orig desc',
          provider: VALID_PROVIDER,
          systemPrompt: 'orig prompt',
          maxToolIterations: 10,
          enabledTools: ['Read'],
          instructions: ['docs/local-note.md'],
          contextWindowTokens: 32000,
          compaction: { threshold: 0.7 },
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
      expect(updated?.contextWindowTokens).toBe(32000);
      expect(updated?.compaction).toEqual({ threshold: 0.7 });
      expect(updated?.provider).toEqual(VALID_PROVIDER);
      expect(updated?.createdBy).toBe('owner-id');
      expect(updated?.createdAt).toBe(created.createdAt);
    });

    it('clears description/systemPrompt/maxToolIterations/enabledTools/instructions/contextWindowTokens/compaction on null', async () => {
      const manager = await getManager();
      const created = await seed(manager);

      const updated = await manager.updateEmbeddedAgent(created.id, {
        description: null,
        systemPrompt: null,
        maxToolIterations: null,
        enabledTools: null,
        instructions: null,
        contextWindowTokens: null,
        compaction: null,
      });

      expect(updated?.description).toBeUndefined();
      expect(updated?.systemPrompt).toBeUndefined();
      expect(updated?.maxToolIterations).toBeUndefined();
      expect(updated?.enabledTools).toBeUndefined();
      expect(updated?.instructions).toBeUndefined();
      expect(updated?.contextWindowTokens).toBeUndefined();
      expect(updated?.compaction).toBeUndefined();
    });

    it('replaces the whole compaction object when compaction is present (no per-subfield merge)', async () => {
      const manager = await getManager();
      const created = await seed(manager);

      const updated = await manager.updateEmbeddedAgent(created.id, {
        compaction: {},
      });

      // Whole-object replace: the original threshold is NOT carried over by
      // an empty replacement object. With one sub-field left this is the only
      // shape that can still distinguish replace from merge -- a merge would
      // leave 0.7 in place.
      expect(updated?.compaction).toEqual({});
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

    it('returns null and does not modify the built-in claude-sdk definition', async () => {
      const manager = await getManager();

      const result = await manager.updateEmbeddedAgent(CLAUDE_SDK_AGENT_ID, { name: 'Renamed' });

      expect(result).toBeNull();
      expect(manager.getEmbeddedAgent(CLAUDE_SDK_AGENT_ID)).toEqual(claudeSdkAgent);
    });

    describe('claude-sdk engine (epic #1636 Phase 5 PR-1, decision 3, Issue #1779) -- now REACHED, not unreachable', () => {
      async function seedSdk(manager: EmbeddedAgentManager) {
        return manager.createEmbeddedAgent(
          { engine: 'claude-sdk', name: 'Claude', provider: { model: 'claude-sonnet-5' } },
          'owner-id'
        );
      }

      it('patches name/provider.model on a non-builtin claude-sdk definition', async () => {
        const manager = await getManager();
        const created = await seedSdk(manager);

        const updated = await manager.updateEmbeddedAgent(created.id, {
          name: 'Renamed Claude',
          provider: { baseUrl: 'http://localhost:11434/v1', model: 'claude-opus-5' },
        });

        expect(updated).not.toBeNull();
        expect(updated?.engine).toBe('claude-sdk');
        expect(updated?.name).toBe('Renamed Claude');
        expect(updated?.provider).toEqual({ model: 'claude-opus-5' });
      });

      it("narrows a patched provider to '{ model }' only, never leaking baseUrl/apiKeyRef onto a claude-sdk definition (defense in depth: UpdateEmbeddedAgentRequestSchema.provider is openai-api-shaped)", async () => {
        const manager = await getManager();
        const created = await seedSdk(manager);

        const updated = await manager.updateEmbeddedAgent(created.id, {
          provider: {
            baseUrl: 'http://localhost:11434/v1',
            model: 'claude-opus-5',
            apiKeyRef: 'should-never-leak',
          },
        });

        expect(updated?.engine).toBe('claude-sdk');
        expect(updated?.provider).toEqual({ model: 'claude-opus-5' });
        expect('baseUrl' in (updated?.provider ?? {})).toBe(false);
        expect('apiKeyRef' in (updated?.provider ?? {})).toBe(false);
      });

      it('mcpServers absent from the request leaves it unchanged (regression: identical to before this PR)', async () => {
        const manager = await getManager();
        const created = await seedSdk(manager);

        const updated = await manager.updateEmbeddedAgent(created.id, { name: 'Renamed' });

        expect(updated?.engine).toBe('claude-sdk');
        if (updated?.engine === 'claude-sdk') {
          expect(updated.mcpServers).toBeUndefined();
        }
      });

      it('accepts a whole-object mcpServers replacement', async () => {
        const manager = await getManager();
        const created = await seedSdk(manager);
        const mcpServers = { docs: { type: 'stdio' as const, command: 'docs-mcp' } };

        const updated = await manager.updateEmbeddedAgent(created.id, { mcpServers });

        expect(updated?.engine).toBe('claude-sdk');
        if (updated?.engine === 'claude-sdk') {
          expect(updated.mcpServers).toEqual(mcpServers);
        }
      });

      it('clears mcpServers on null', async () => {
        const manager = await getManager();
        const created = await seedSdk(manager);
        await manager.updateEmbeddedAgent(created.id, {
          mcpServers: { docs: { type: 'stdio', command: 'docs-mcp' } },
        });

        const updated = await manager.updateEmbeddedAgent(created.id, { mcpServers: null });

        expect(updated?.engine).toBe('claude-sdk');
        if (updated?.engine === 'claude-sdk') {
          expect(updated.mcpServers).toBeUndefined();
        }
      });

      it("rejects a declared mcpServers entry named 'agent-console' (reserved), naming the offending key", async () => {
        const manager = await getManager();
        const created = await seedSdk(manager);

        await expect(
          manager.updateEmbeddedAgent(created.id, {
            mcpServers: { 'agent-console': { type: 'stdio', command: 'evil' } },
          })
        ).rejects.toThrow('mcpServers cannot declare the reserved name "agent-console"');
      });

      it("rejects a declared mcpServers entry named 'console' (reserved), naming the offending key", async () => {
        const manager = await getManager();
        const created = await seedSdk(manager);

        await expect(
          manager.updateEmbeddedAgent(created.id, {
            mcpServers: { console: { type: 'stdio', command: 'evil' } },
          })
        ).rejects.toThrow('mcpServers cannot declare the reserved name "console"');
      });

      it('does not persist or mutate the map when the reserved-name check rejects', async () => {
        const manager = await getManager();
        const created = await seedSdk(manager);

        await expect(
          manager.updateEmbeddedAgent(created.id, {
            mcpServers: { console: { type: 'stdio', command: 'evil' } },
          })
        ).rejects.toThrow();

        const stillOriginal = manager.getEmbeddedAgent(created.id);
        expect(stillOriginal?.engine).toBe('claude-sdk');
        if (stillOriginal?.engine === 'claude-sdk') {
          expect(stillOriginal.mcpServers).toBeUndefined();
        }
      });

      it('accepts subagents when enabledTools includes Task in the same request', async () => {
        const manager = await getManager();
        const created = await seedSdk(manager);
        const subagents = { reviewer: { description: 'Reviews code', prompt: 'Review it.' } };

        const updated = await manager.updateEmbeddedAgent(created.id, {
          enabledTools: ['Task'],
          subagents,
        });

        expect(updated?.engine).toBe('claude-sdk');
        if (updated?.engine === 'claude-sdk') {
          expect(updated.subagents).toEqual(subagents);
          expect(updated.enabledTools).toEqual(['Task']);
        }
      });

      it('accepts subagents when Task was already enabled by a prior update (resolved against existing enabledTools)', async () => {
        const manager = await getManager();
        const created = await seedSdk(manager);
        await manager.updateEmbeddedAgent(created.id, { enabledTools: ['Task'] });

        const subagents = { reviewer: { description: 'Reviews code', prompt: 'Review it.' } };
        const updated = await manager.updateEmbeddedAgent(created.id, { subagents });

        expect(updated?.engine).toBe('claude-sdk');
        if (updated?.engine === 'claude-sdk') {
          expect(updated.subagents).toEqual(subagents);
        }
      });

      it('rejects subagents when the resolved enabledTools lacks Task (a silent no-op is forbidden)', async () => {
        const manager = await getManager();
        const created = await seedSdk(manager);

        await expect(
          manager.updateEmbeddedAgent(created.id, {
            subagents: { reviewer: { description: 'Reviews code', prompt: 'Review it.' } },
          })
        ).rejects.toThrow('subagents requires "Task" to be included in enabledTools');
      });

      it('rejects subagents when enabledTools is explicitly set without Task in the same request', async () => {
        const manager = await getManager();
        const created = await seedSdk(manager);

        await expect(
          manager.updateEmbeddedAgent(created.id, {
            enabledTools: ['Read'],
            subagents: { reviewer: { description: 'Reviews code', prompt: 'Review it.' } },
          })
        ).rejects.toThrow('subagents requires "Task" to be included in enabledTools');
      });

      it('rejects subagents when a prior Task enablement is cleared in the same request (enabledTools: null)', async () => {
        const manager = await getManager();
        const created = await seedSdk(manager);
        await manager.updateEmbeddedAgent(created.id, { enabledTools: ['Task'] });

        await expect(
          manager.updateEmbeddedAgent(created.id, {
            enabledTools: null,
            subagents: { reviewer: { description: 'Reviews code', prompt: 'Review it.' } },
          })
        ).rejects.toThrow('subagents requires "Task" to be included in enabledTools');
      });

      it('does not mutate the map when the subagents-without-Task check rejects', async () => {
        const manager = await getManager();
        const created = await seedSdk(manager);

        await expect(
          manager.updateEmbeddedAgent(created.id, {
            subagents: { reviewer: { description: 'Reviews code', prompt: 'Review it.' } },
          })
        ).rejects.toThrow();

        const stillOriginal = manager.getEmbeddedAgent(created.id);
        expect(stillOriginal?.engine).toBe('claude-sdk');
        if (stillOriginal?.engine === 'claude-sdk') {
          expect(stillOriginal.subagents).toBeUndefined();
        }
      });

      it('clears subagents on null (no Task requirement re-checked on clear)', async () => {
        const manager = await getManager();
        const created = await seedSdk(manager);
        await manager.updateEmbeddedAgent(created.id, {
          enabledTools: ['Task'],
          subagents: { reviewer: { description: 'Reviews code', prompt: 'Review it.' } },
        });

        const updated = await manager.updateEmbeddedAgent(created.id, { subagents: null });

        expect(updated?.engine).toBe('claude-sdk');
        if (updated?.engine === 'claude-sdk') {
          expect(updated.subagents).toBeUndefined();
        }
      });
    });

    describe('mcpServers/subagents/Task on an openai-api update (incapable engine)', () => {
      it('rejects mcpServers with a ValidationError naming the capability row reason', async () => {
        const manager = await getManager();
        const created = await seed(manager);

        await expect(
          manager.updateEmbeddedAgent(created.id, {
            mcpServers: { docs: { type: 'stdio', command: 'docs-mcp' } },
          })
        ).rejects.toThrow(
          'openai-api reaches MCP only through the console dial-back; no declared external servers on this engine'
        );
      });

      it('rejects mcpServers: null too (present at all, including explicit clear)', async () => {
        const manager = await getManager();
        const created = await seed(manager);

        await expect(manager.updateEmbeddedAgent(created.id, { mcpServers: null })).rejects.toThrow(
          'openai-api reaches MCP only through the console dial-back; no declared external servers on this engine'
        );
      });

      it('rejects subagents with a ValidationError naming the task capability row reason', async () => {
        const manager = await getManager();
        const created = await seed(manager);

        await expect(
          manager.updateEmbeddedAgent(created.id, {
            subagents: { reviewer: { description: 'Reviews code', prompt: 'Review it.' } },
          })
        ).rejects.toThrow('openai-api has no subagent runtime');
      });

      it("rejects 'Task' inside enabledTools with a ValidationError naming the task capability row reason", async () => {
        const manager = await getManager();
        const created = await seed(manager);

        await expect(
          manager.updateEmbeddedAgent(created.id, { enabledTools: ['Read', 'Task'] })
        ).rejects.toThrow('openai-api has no subagent runtime');
      });

      it('does not mutate the map when any of the above rejects', async () => {
        const manager = await getManager();
        const created = await seed(manager);

        await expect(
          manager.updateEmbeddedAgent(created.id, { enabledTools: ['Task'] })
        ).rejects.toThrow();

        expect(manager.getEmbeddedAgent(created.id)?.enabledTools).toEqual(['Read']);
      });

      it('existing openai-api update with no new fields is entirely unchanged (regression)', async () => {
        const manager = await getManager();
        const created = await seed(manager);

        const updated = await manager.updateEmbeddedAgent(created.id, { name: 'Renamed' });

        expect(updated).not.toBeNull();
        expect(updated?.engine).toBe('openai-api');
        expect(updated?.name).toBe('Renamed');
        expect(updated?.enabledTools).toEqual(['Read']);
      });
    });
  });

  describe('deleteEmbeddedAgent', () => {
    it('removes the definition from the map and the repository', async () => {
      const manager = await getManager();
      const created = await manager.createEmbeddedAgent(
        { engine: 'openai-api', name: 'ToDelete', provider: VALID_PROVIDER },
        'user-1'
      );

      const result = await manager.deleteEmbeddedAgent(created.id);

      expect(result).toBe(true);
      expect(manager.getEmbeddedAgent(created.id)).toBeUndefined();
      // The built-in survives deletion of the custom definition.
      expect(repository.getAllSaved()).toEqual([claudeSdkAgent]);
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
        { engine: 'openai-api', name: 'ToDelete', provider: VALID_PROVIDER },
        'user-1'
      );
      manager.setLifecycleCallbacks(callbacks);

      await manager.deleteEmbeddedAgent(created.id);

      expect(deleted).toEqual([created.id]);
    });

    it('returns false and does not delete the built-in claude-sdk definition', async () => {
      const manager = await getManager();

      const result = await manager.deleteEmbeddedAgent(CLAUDE_SDK_AGENT_ID);

      expect(result).toBe(false);
      expect(manager.getEmbeddedAgent(CLAUDE_SDK_AGENT_ID)).toEqual(claudeSdkAgent);
    });
  });

  describe('deleteEmbeddedAgent with a job queue (Issue #1709)', () => {
    it('enqueues exactly one cleanup:definition-memory job, after repository.delete and before the lifecycle callback', async () => {
      // Mutation measured: enqueuing BEFORE `this.repository.delete(id)`
      // (instead of after) fails the `order` assertion below --
      // 'enqueue' would appear before 'repository.delete'.
      const order: string[] = [];
      repository.onDelete = () => order.push('repository.delete');
      const { jobQueue, calls } = createFakeJobQueue(order);

      const manager = await EmbeddedAgentManager.create(repository, { jobQueue });
      const created = await manager.createEmbeddedAgent(
        { engine: 'openai-api', name: 'ToDelete', provider: VALID_PROVIDER },
        'user-1'
      );
      const { deleted, callbacks } = createCallbackRecorder();
      manager.setLifecycleCallbacks({
        ...callbacks,
        onEmbeddedAgentDeleted: (id) => {
          order.push('callback');
          callbacks.onEmbeddedAgentDeleted(id);
        },
      });

      const result = await manager.deleteEmbeddedAgent(created.id);

      expect(result).toBe(true);
      expect(calls).toEqual([
        { type: JOB_TYPES.CLEANUP_DEFINITION_MEMORY, payload: { definitionId: created.id } },
      ]);
      expect(order).toEqual(['repository.delete', 'enqueue', 'callback']);
      expect(deleted).toEqual([created.id]);
    });

    it('does not enqueue and leaves the map unchanged when repository.delete throws', async () => {
      // Mutation measured: moving the enqueue call BEFORE
      // `this.repository.delete(id)` fails this test -- `calls` would be
      // non-empty even though the delete rejected.
      const { jobQueue, calls } = createFakeJobQueue();
      const manager = await EmbeddedAgentManager.create(repository, { jobQueue });
      const created = await manager.createEmbeddedAgent(
        { engine: 'openai-api', name: 'ToDelete', provider: VALID_PROVIDER },
        'user-1'
      );
      repository.failDelete = true;

      await expect(manager.deleteEmbeddedAgent(created.id)).rejects.toThrow('delete failed');

      expect(calls).toEqual([]);
      expect(manager.getEmbeddedAgent(created.id)).toEqual(created);
    });

    it('does not enqueue for a built-in id', async () => {
      // Mutation measured: moving the enqueue call above the
      // `existing.isBuiltIn` guard fails this test -- `calls` would contain
      // an entry for CLAUDE_SDK_AGENT_ID even though built-ins are never
      // deletable.
      const { jobQueue, calls } = createFakeJobQueue();
      const manager = await EmbeddedAgentManager.create(repository, { jobQueue });

      const result = await manager.deleteEmbeddedAgent(CLAUDE_SDK_AGENT_ID);

      expect(result).toBe(false);
      expect(calls).toEqual([]);
    });

    it('deletes without throwing and still fires the lifecycle callback when created with jobQueue: null, or with no options at all', async () => {
      // Mutation measured: removing the `if (this.jobQueue)` guard (calling
      // `this.jobQueue.enqueue(...)` unconditionally) fails this test with
      // a TypeError ("Cannot read properties of null") for both factories.
      const factories: Array<() => Promise<EmbeddedAgentManager>> = [
        () => EmbeddedAgentManager.create(repository, { jobQueue: null }),
        () => EmbeddedAgentManager.create(repository),
      ];
      for (const createManager of factories) {
        const manager = await createManager();
        const created = await manager.createEmbeddedAgent(
          { engine: 'openai-api', name: 'ToDelete', provider: VALID_PROVIDER },
          'user-1'
        );
        const { deleted, callbacks } = createCallbackRecorder();
        manager.setLifecycleCallbacks(callbacks);

        await expect(manager.deleteEmbeddedAgent(created.id)).resolves.toBe(true);
        expect(deleted).toEqual([created.id]);
      }
    });
  });

  describe('AgentSurface<"embedded"> conformance', () => {
    it('exposes kind "embedded"', async () => {
      const manager = await getManager();
      expect(manager.kind).toBe('embedded');
    });

    it('list() wraps getAllEmbeddedAgents() entries with kind "embedded"', async () => {
      const manager = await getManager();
      const created = await manager.createEmbeddedAgent({ engine: 'openai-api', name: 'Listed', provider: VALID_PROVIDER }, 'user-1');

      // The built-in claude-sdk definition is always present alongside the
      // newly-created custom one.
      const entries = manager.list();
      expect(entries).toHaveLength(2);
      expect(entries).toContainEqual({ kind: 'embedded', agent: created });
      expect(entries).toContainEqual({ kind: 'embedded', agent: claudeSdkAgent });
    });

    it('get(id) wraps getEmbeddedAgent(id) with kind "embedded", or returns undefined', async () => {
      const manager = await getManager();
      const created = await manager.createEmbeddedAgent(
        { engine: 'openai-api', name: 'Findable', provider: VALID_PROVIDER },
        'user-1',
      );

      expect(manager.get(created.id)).toEqual({ kind: 'embedded', agent: created });
      expect(manager.get('non-existent')).toBeUndefined();
    });

    it('findByName(name) wraps a name filter over getAllEmbeddedAgents() with kind "embedded"', async () => {
      const manager = await getManager();
      const created = await manager.createEmbeddedAgent(
        { engine: 'openai-api', name: 'Shared Name', provider: VALID_PROVIDER },
        'user-1',
      );
      await manager.createEmbeddedAgent({ engine: 'openai-api', name: 'Other Name', provider: VALID_PROVIDER }, 'user-1');

      const entries = manager.findByName('Shared Name');
      expect(entries).toEqual([{ kind: 'embedded', agent: created }]);

      expect(manager.findByName('No Such Name')).toEqual([]);
    });
  });
});
