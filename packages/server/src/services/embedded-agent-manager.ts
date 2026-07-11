import {
  type EmbeddedAgentDefinition,
  type CreateEmbeddedAgentRequest,
  type UpdateEmbeddedAgentRequest,
} from '@agent-console/shared';
import { createLogger } from '../lib/logger.js';
import { initializeDatabase } from '../database/connection.js';
import type { EmbeddedAgentRepository } from '../repositories/embedded-agent-repository.js';
import { SqliteEmbeddedAgentRepository } from '../repositories/sqlite-embedded-agent-repository.js';

const logger = createLogger('embedded-agent-manager');

export interface EmbeddedAgentLifecycleCallbacks {
  onEmbeddedAgentCreated: (def: EmbeddedAgentDefinition) => void;
  onEmbeddedAgentUpdated: (def: EmbeddedAgentDefinition) => void;
  onEmbeddedAgentDeleted: (id: string) => void;
}

/**
 * In-memory registry of embedded-agent definitions backed by a SQLite
 * repository. Modeled on AgentManager, but with no built-in/default definition:
 * the registry starts empty and every definition is user-created.
 */
export class EmbeddedAgentManager {
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
   * Initialize the manager by loading all definitions from the repository.
   * Unlike AgentManager there is no built-in definition to seed.
   */
  private async initialize(): Promise<void> {
    const defs = await this.repository.findAll();
    for (const def of defs) {
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

  /**
   * Create a new embedded-agent definition.
   * `createdBy` is set from the authenticated user parameter, never from the
   * request body.
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
      provider: request.provider,
      systemPrompt: request.systemPrompt,
      maxToolIterations: request.maxToolIterations,
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
   * - null = clear (for description / systemPrompt / maxToolIterations)
   * - `provider` replaces the whole provider object when present
   *
   * Preserves id / createdBy / createdAt, bumps updatedAt.
   */
  async updateEmbeddedAgent(
    id: string,
    request: UpdateEmbeddedAgentRequest
  ): Promise<EmbeddedAgentDefinition | null> {
    const existing = this.embeddedAgents.get(id);
    if (!existing) {
      return null;
    }

    const updated: EmbeddedAgentDefinition = {
      id: existing.id,
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
   * @returns true if a definition was removed, false if the id did not exist.
   */
  async deleteEmbeddedAgent(id: string): Promise<boolean> {
    const existing = this.embeddedAgents.get(id);
    if (!existing) {
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
