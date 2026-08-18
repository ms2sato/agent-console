import {
  type EmbeddedAgentDefinition,
  type CreateEmbeddedAgentRequest,
  type UpdateEmbeddedAgentRequest,
  type AgentDirectoryEntry,
  type AgentSurface,
} from '@agent-console/shared';
import { createLogger } from '../lib/logger.js';
import { initializeDatabase } from '../database/connection.js';
import type { EmbeddedAgentRepository } from '../repositories/embedded-agent-repository.js';
import { SqliteEmbeddedAgentRepository } from '../repositories/sqlite-embedded-agent-repository.js';
import { claudeSdkAgent, CLAUDE_SDK_AGENT_ID } from './embedded-agents/claude-sdk-builtin.js';

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

  /**
   * Create an EmbeddedAgentManager instance with async initialization.
   * This is the preferred way to create an EmbeddedAgentManager.
   */
  static async create(repository?: EmbeddedAgentRepository): Promise<EmbeddedAgentManager> {
    const repo = repository ?? new SqliteEmbeddedAgentRepository(await initializeDatabase());
    const manager = new EmbeddedAgentManager(repo);
    await manager.initialize();
    return manager;
  }

  /**
   * Private constructor - use EmbeddedAgentManager.create() for async initialization.
   */
  private constructor(repository: EmbeddedAgentRepository) {
    this.repository = repository;
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
   * request body. User-facing creation via this route always produces a
   * `openai-api` engine definition (hardcoded here, not read from the
   * request) -- the `claude-sdk` engine is registered as a builtin only
   * (Phase 1), never user-created. See
   * docs/design/embedded-agent-sdk-engine.md §3.1/§1 ("SDK-hosted subprocess
   * ... registered as a builtin only").
   */
  async createEmbeddedAgent(
    request: CreateEmbeddedAgentRequest,
    createdBy: string
  ): Promise<EmbeddedAgentDefinition> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

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
      handoff: request.handoff,
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
   * `engine` is never accepted from the request (only `openai-api`
   * definitions can be user-created; see `createEmbeddedAgent`), so an
   * update can never change a definition's engine.
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

    // Defensive engine-narrowing guard: in Phase 1 every non-built-in
    // definition is `openai-api` by construction (createEmbeddedAgent
    // hardcodes it; the only `claude-sdk` definition is the builtin already
    // rejected above), so this branch is unreachable at runtime today. It
    // exists so TypeScript narrows `existing.provider` to the openai-api
    // shape below (matching `request.provider`'s type) and so a future
    // engine addition fails loudly here instead of silently constructing an
    // inconsistent definition.
    if (existing.engine !== 'openai-api') {
      logger.warn(
        { embeddedAgentId: id, engine: existing.engine },
        'Cannot modify non-openai-api embedded agent via update'
      );
      return null;
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
      enabledTools:
        request.enabledTools === null ? undefined : (request.enabledTools ?? existing.enabledTools),
      instructions:
        request.instructions === null ? undefined : (request.instructions ?? existing.instructions),
      contextWindowTokens:
        request.contextWindowTokens === null
          ? undefined
          : (request.contextWindowTokens ?? existing.contextWindowTokens),
      handoff: request.handoff === null ? undefined : (request.handoff ?? existing.handoff),
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

    // Callback fires after successful delete - clients will receive state update
    // only after database write is confirmed
    this.lifecycleCallbacks?.onEmbeddedAgentDeleted(id);

    return true;
  }
}
