import {
  type EmbeddedAgentDefinition,
  type CreateEmbeddedAgentRequest,
  type UpdateEmbeddedAgentRequest,
  type AgentDirectoryEntry,
  type AgentSurface,
  type CleanupDefinitionMemoryPayload,
  EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES,
} from '@agent-console/shared';
import { createLogger } from '../lib/logger.js';
import { initializeDatabase } from '../database/connection.js';
import { ValidationError } from '../lib/errors.js';
import type { EmbeddedAgentRepository } from '../repositories/embedded-agent-repository.js';
import { SqliteEmbeddedAgentRepository } from '../repositories/sqlite-embedded-agent-repository.js';
import { claudeSdkAgent, CLAUDE_SDK_AGENT_ID } from './embedded-agents/claude-sdk-builtin.js';
import { JOB_TYPES, type JobQueue } from '../jobs/index.js';

const logger = createLogger('embedded-agent-manager');

// Re-export for backward compatibility, mirroring agent-manager.ts's
// CLAUDE_CODE_AGENT_ID re-export.
export { CLAUDE_SDK_AGENT_ID } from './embedded-agents/claude-sdk-builtin.js';

export interface EmbeddedAgentLifecycleCallbacks {
  onEmbeddedAgentCreated: (def: EmbeddedAgentDefinition) => void;
  onEmbeddedAgentUpdated: (def: EmbeddedAgentDefinition) => void;
  onEmbeddedAgentDeleted: (id: string) => void;
}

/**
 * In-memory registry of embedded-agent definitions backed by a SQLite
 * repository. Modeled on AgentManager, including its built-in-definition
 * pattern (SDK Engine Phase 1): the `claude-sdk` engine's `claudeSdkAgent`
 * is registered on every startup, mirroring `AgentManager`'s `claudeCodeAgent`.
 * Every OTHER definition is still user-created via the REST route, which
 * always produces `engine: 'openai-api'` (see `createEmbeddedAgent` below).
 */
export class EmbeddedAgentManager implements AgentSurface<'embedded'> {
  readonly kind = 'embedded' as const;

  private embeddedAgents: Map<string, EmbeddedAgentDefinition> = new Map();
  private lifecycleCallbacks: EmbeddedAgentLifecycleCallbacks | null = null;
  private repository: EmbeddedAgentRepository;
  private jobQueue: JobQueue | null = null;

  /**
   * Create an EmbeddedAgentManager instance with async initialization.
   * This is the preferred way to create an EmbeddedAgentManager.
   */
  static async create(
    repository?: EmbeddedAgentRepository,
    options?: { jobQueue?: JobQueue | null }
  ): Promise<EmbeddedAgentManager> {
    const repo = repository ?? new SqliteEmbeddedAgentRepository(await initializeDatabase());
    const manager = new EmbeddedAgentManager(repo, options?.jobQueue ?? null);
    await manager.initialize();
    return manager;
  }

  /**
   * Private constructor - use EmbeddedAgentManager.create() for async initialization.
   */
  private constructor(repository: EmbeddedAgentRepository, jobQueue: JobQueue | null = null) {
    this.repository = repository;
    this.jobQueue = jobQueue;
  }

  /**
   * Set callbacks for lifecycle events (for WebSocket broadcasting).
   */
  setLifecycleCallbacks(callbacks: EmbeddedAgentLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
  }

  /**
   * Initialize the manager: register the built-in `claude-sdk` definition
   * first (mirrors `AgentManager.initialize()`), then load custom
   * definitions from the repository, skipping any built-in row already
   * loaded above (same `if (isBuiltIn) continue` guard as `AgentManager`).
   */
  private async initialize(): Promise<void> {
    // Always register the built-in definition first.
    this.embeddedAgents.set(CLAUDE_SDK_AGENT_ID, claudeSdkAgent);

    // Upsert the built-in definition to the DB on every startup (ensures the
    // DB always has the latest definition), mirroring
    // AgentManager.initialize()'s claudeCodeAgent upsert.
    await this.repository.save(claudeSdkAgent);

    // Load custom (and any persisted built-in) definitions from persistence.
    const defs = await this.repository.findAll();
    for (const def of defs) {
      // Skip if it's the built-in definition (already loaded above).
      if (def.isBuiltIn) {
        continue;
      }
      this.embeddedAgents.set(def.id, def);
    }

    logger.info({ count: this.embeddedAgents.size }, 'EmbeddedAgentManager initialized');
  }

  /**
   * Get all registered embedded-agent definitions.
   */
  getAllEmbeddedAgents(): EmbeddedAgentDefinition[] {
    return Array.from(this.embeddedAgents.values());
  }

  /**
   * Get an embedded-agent definition by ID.
   */
  getEmbeddedAgent(id: string): EmbeddedAgentDefinition | undefined {
    return this.embeddedAgents.get(id);
  }

  // ---------- AgentSurface<'embedded'> ----------

  list(): Extract<AgentDirectoryEntry, { kind: 'embedded' }>[] {
    return this.getAllEmbeddedAgents().map((agent) => ({ kind: 'embedded' as const, agent }));
  }

  get(id: string): Extract<AgentDirectoryEntry, { kind: 'embedded' }> | undefined {
    const agent = this.getEmbeddedAgent(id);
    return agent ? { kind: 'embedded', agent } : undefined;
  }

  findByName(name: string): Extract<AgentDirectoryEntry, { kind: 'embedded' }>[] {
    return this.getAllEmbeddedAgents()
      .filter((a) => a.name === name)
      .map((agent) => ({ kind: 'embedded' as const, agent }));
  }

  /**
   * Create a new embedded-agent definition.
   * `createdBy` is set from the authenticated user parameter, never from the
   * request body.
   *
   * Discriminated on `request.engine` (epic #1636 Phase 5 decision 3, Issue
   * #1779; `CreateEmbeddedAgentRequestSchema` is engine-discriminated):
   * - `openai-api`: user-facing creation, unchanged behavior from before
   *   this PR (every field the request already carried).
   * - `claude-sdk`: MINIMAL create -- `{ name, provider: { model } }` only.
   *   No `enabledTools` is representable on this arm at the type level, so
   *   no capability check is needed here (the `'Task'`-in-`enabledTools`
   *   check below is openai-api-arm-only for the same reason). See
   *   docs/design/embedded-agent-sdk-engine.md §3.1/§1 for why the
   *   SDK-hosted subprocess was previously builtin-only.
   */
  async createEmbeddedAgent(
    request: CreateEmbeddedAgentRequest,
    createdBy: string
  ): Promise<EmbeddedAgentDefinition> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    if (request.engine === 'claude-sdk') {
      const def: EmbeddedAgentDefinition = {
        id,
        name: request.name,
        engine: 'claude-sdk',
        provider: request.provider,
        isBuiltIn: false,
        createdBy,
        createdAt: now,
        updatedAt: now,
      };

      await this.repository.save(def);
      this.embeddedAgents.set(id, def);

      logger.info({ embeddedAgentId: id, name: def.name, engine: def.engine }, 'Embedded agent created');

      this.lifecycleCallbacks?.onEmbeddedAgentCreated(def);

      return def;
    }

    // 'Task' inside enabledTools is a shared picklist value, representable
    // on the openai-api arm at the type level -- so the incapability is
    // enforced here, loudly, rather than left as a representable-but-ignored
    // value.
    const taskCapability = EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES['openai-api'].task;
    if (!taskCapability.capable && request.enabledTools?.includes('Task')) {
      throw new ValidationError(taskCapability.reason);
    }

    const def: EmbeddedAgentDefinition = {
      id,
      name: request.name,
      description: request.description,
      engine: 'openai-api',
      provider: request.provider,
      systemPrompt: request.systemPrompt,
      maxToolIterations: request.maxToolIterations,
      enabledTools: request.enabledTools,
      instructions: request.instructions,
      contextWindowTokens: request.contextWindowTokens,
      compaction: request.compaction,
      isBuiltIn: false,
      createdBy,
      createdAt: now,
      updatedAt: now,
    };

    // Write to repository FIRST - if this fails, in-memory state remains unchanged
    await this.repository.save(def);

    // Update in-memory map only after successful persistence
    this.embeddedAgents.set(id, def);

    logger.info({ embeddedAgentId: id, name: def.name }, 'Embedded agent created');

    // Callback fires after successful save - clients will receive state update
    // only after database write is confirmed
    this.lifecycleCallbacks?.onEmbeddedAgentCreated(def);

    return def;
  }

  /**
   * Update an existing embedded-agent definition.
   *
   * PATCH semantics matching UpdateEmbeddedAgentRequestSchema:
   * - undefined = no change
   * - null = clear (for description / systemPrompt / maxToolIterations / enabledTools / instructions)
   * - `provider` replaces the whole provider object when present
   *
   * Preserves id / engine / isBuiltIn / createdBy / createdAt, bumps updatedAt.
   * `engine` is never accepted from the request, so an update can never
   * change a definition's engine.
   *
   * Branches on `existing.engine` (epic #1636 Phase 5 decision 3, Issue
   * #1779). Before this PR every non-built-in definition was `openai-api`
   * by construction (`createEmbeddedAgent` hardcoded it), so the
   * `claude-sdk` branch was unreachable at runtime -- it exists NOW, and is
   * REACHED, whenever `createEmbeddedAgent` produced a non-builtin
   * `claude-sdk` definition (this PR's `engine: 'claude-sdk'` create arm).
   */
  async updateEmbeddedAgent(
    id: string,
    request: UpdateEmbeddedAgentRequest
  ): Promise<EmbeddedAgentDefinition | null> {
    const existing = this.embeddedAgents.get(id);
    if (!existing) {
      return null;
    }

    // Built-in definitions cannot be modified, mirroring
    // AgentManager.updateAgent's identical guard.
    if (existing.isBuiltIn) {
      logger.warn({ embeddedAgentId: id }, 'Cannot modify built-in embedded agent');
      return null;
    }

    if (existing.engine === 'claude-sdk') {
      // `UpdateEmbeddedAgentRequestSchema.provider` is a union of both
      // engines' provider shapes (it has to be -- a PATCH carries no
      // `engine` discriminant), so a schema-valid payload can still be
      // shaped for the WRONG engine relative to this existing definition.
      // The schema alone cannot catch that (it has no view of
      // `existing.engine`); reject it here, structurally, via presence of
      // `baseUrl` -- the field only the openai-api shape carries.
      if (request.provider !== undefined && 'baseUrl' in request.provider) {
        throw new ValidationError('provider shape does not match this definition engine (claude-sdk)');
      }

      const enabledTools =
        request.enabledTools === null ? undefined : (request.enabledTools ?? existing.enabledTools);

      const updated: EmbeddedAgentDefinition = {
        id: existing.id,
        engine: 'claude-sdk',
        isBuiltIn: existing.isBuiltIn,
        name: request.name ?? existing.name,
        description:
          request.description === null ? undefined : (request.description ?? existing.description),
        provider: request.provider ?? existing.provider,
        systemPrompt:
          request.systemPrompt === null ? undefined : (request.systemPrompt ?? existing.systemPrompt),
        maxToolIterations:
          request.maxToolIterations === null
            ? undefined
            : (request.maxToolIterations ?? existing.maxToolIterations),
        enabledTools,
        instructions:
          request.instructions === null ? undefined : (request.instructions ?? existing.instructions),
        contextWindowTokens:
          request.contextWindowTokens === null
            ? undefined
            : (request.contextWindowTokens ?? existing.contextWindowTokens),
        compaction: request.compaction === null ? undefined : (request.compaction ?? existing.compaction),
        createdBy: existing.createdBy,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      };

      await this.repository.save(updated);
      this.embeddedAgents.set(id, updated);

      logger.info(
        { embeddedAgentId: id, name: updated.name, engine: updated.engine },
        'Embedded agent updated'
      );

      this.lifecycleCallbacks?.onEmbeddedAgentUpdated(updated);

      return updated;
    }

    // 'openai-api' branch. 'Task' is incapable on this engine -- reject
    // loudly rather than silently accepting a representable-but-ignored
    // value (it is representable here because it is a shared picklist value
    // on enabledTools).
    const taskCapability = EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES['openai-api'].task;
    const resolvedEnabledTools =
      request.enabledTools === null ? undefined : (request.enabledTools ?? existing.enabledTools);
    if (!taskCapability.capable && resolvedEnabledTools?.includes('Task')) {
      throw new ValidationError(taskCapability.reason);
    }

    // Same structural mismatch guard as the claude-sdk branch above, in the
    // opposite direction: a schema-valid claude-sdk-shaped `{ model }`
    // payload (no `baseUrl`) must not be accepted as-is here, since
    // openai-api's own `EmbeddedAgentDefinition.provider` requires `baseUrl`.
    if (request.provider !== undefined && !('baseUrl' in request.provider)) {
      throw new ValidationError('provider shape does not match this definition engine (openai-api)');
    }

    const updated: EmbeddedAgentDefinition = {
      id: existing.id,
      engine: 'openai-api',
      isBuiltIn: existing.isBuiltIn,
      name: request.name ?? existing.name,
      // null = clear, undefined = keep
      description:
        request.description === null ? undefined : (request.description ?? existing.description),
      // provider is a whole-object replacement when present
      provider: request.provider ?? existing.provider,
      systemPrompt:
        request.systemPrompt === null ? undefined : (request.systemPrompt ?? existing.systemPrompt),
      maxToolIterations:
        request.maxToolIterations === null
          ? undefined
          : (request.maxToolIterations ?? existing.maxToolIterations),
      enabledTools: resolvedEnabledTools,
      instructions:
        request.instructions === null ? undefined : (request.instructions ?? existing.instructions),
      contextWindowTokens:
        request.contextWindowTokens === null
          ? undefined
          : (request.contextWindowTokens ?? existing.contextWindowTokens),
      compaction: request.compaction === null ? undefined : (request.compaction ?? existing.compaction),
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    // Write to repository FIRST - if this fails, in-memory state remains unchanged
    await this.repository.save(updated);

    // Update in-memory map only after successful persistence
    this.embeddedAgents.set(id, updated);

    logger.info({ embeddedAgentId: id, name: updated.name }, 'Embedded agent updated');

    // Callback fires after successful save - clients will receive state update
    // only after database write is confirmed
    this.lifecycleCallbacks?.onEmbeddedAgentUpdated(updated);

    return updated;
  }

  /**
   * Delete an embedded-agent definition.
   * @returns true if a definition was removed, false if the id did not
   * exist OR if it is built-in (mirrors AgentManager.unregisterAgent's
   * identical `false`-on-built-in contract).
   */
  async deleteEmbeddedAgent(id: string): Promise<boolean> {
    const existing = this.embeddedAgents.get(id);
    if (!existing) {
      return false;
    }

    // Built-in definitions cannot be deleted, mirroring
    // AgentManager.unregisterAgent's identical guard.
    if (existing.isBuiltIn) {
      logger.warn({ embeddedAgentId: id }, 'Cannot delete built-in embedded agent');
      return false;
    }

    // Delete from repository FIRST - if this fails, in-memory state remains unchanged
    await this.repository.delete(id);

    // Update in-memory map only after successful persistence
    this.embeddedAgents.delete(id);

    logger.info({ embeddedAgentId: id, name: existing.name }, 'Embedded agent deleted');

    // Enqueue memory-directory cleanup AFTER the row and the in-memory entry
    // are both gone -- the row's absence is what makes the directory
    // unreachable through the ordinary create/activate path, so removal
    // must follow it, the same ordering discipline
    // `RepositoryManager.cleanupRepositoryData` uses for repository data.
    // Enqueued here, from the manager, never from the WS lifecycle callback
    // below (that callback is a broadcast site, not a place to trigger
    // side effects). Built-in definitions never reach this point (guarded
    // above). No job queue (e.g. unit tests constructing the manager
    // without one) means no enqueue and no throw -- deletion still
    // succeeds.
    if (this.jobQueue) {
      const payload: CleanupDefinitionMemoryPayload = { definitionId: id };
      await this.jobQueue.enqueue(JOB_TYPES.CLEANUP_DEFINITION_MEMORY, payload);
    }

    // Callback fires after successful delete - clients will receive state update
    // only after database write is confirmed
    this.lifecycleCallbacks?.onEmbeddedAgentDeleted(id);

    return true;
  }
}
