import {
  type AgentDefinition,
  type CreateAgentRequest,
  type UpdateAgentRequest,
  computeCapabilities,
} from '@agent-console/shared';
import { claudeCodeAgent, CLAUDE_CODE_AGENT_ID } from './agents/claude-code.js';
import { createLogger } from '../lib/logger.js';
import { initializeDatabase } from '../database/connection.js';
import type { AgentRepository } from '../repositories/agent-repository.js';
import { SqliteAgentRepository } from '../repositories/sqlite-agent-repository.js';

const logger = createLogger('agent-manager');

// Re-export for backward compatibility
export { CLAUDE_CODE_AGENT_ID } from './agents/claude-code.js';

export interface AgentLifecycleCallbacks {
  onAgentCreated: (agent: AgentDefinition) => void;
  onAgentUpdated: (agent: AgentDefinition) => void;
  onAgentDeleted: (agentId: string) => void;
}

export class AgentManager {
  private agents: Map<string, AgentDefinition> = new Map();
  private lifecycleCallbacks: AgentLifecycleCallbacks | null = null;
  private repository: AgentRepository;

  /**
   * Create an AgentManager instance with async initialization.
   * This is the preferred way to create an AgentManager.
   */
  static async create(repository?: AgentRepository): Promise<AgentManager> {
    const repo = repository ?? new SqliteAgentRepository(await initializeDatabase());
    const manager = new AgentManager(repo);
    await manager.initialize();
    return manager;
  }

  /**
   * Private constructor - use AgentManager.create() for async initialization.
   */
  private constructor(repository: AgentRepository) {
    this.repository = repository;
  }

  /**
   * Set callbacks for agent lifecycle events (for WebSocket broadcasting)
   */
  setLifecycleCallbacks(callbacks: AgentLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
  }

  /**
   * Initialize agent manager - load from persistence and ensure built-in agents exist
   */
  private async initialize(): Promise<void> {
    // Always register built-in agent first
    this.agents.set(CLAUDE_CODE_AGENT_ID, claudeCodeAgent);

    // Upsert built-in agent to DB on every startup (ensures DB always has latest definition)
    await this.repository.save(claudeCodeAgent);

    // Load custom agents from persistence
    const customAgents = await this.repository.findAll();
    for (const agent of customAgents) {
      // Skip if it's the built-in agent (already loaded)
      if (agent.isBuiltIn) {
        continue;
      }
      this.agents.set(agent.id, agent);
    }

    logger.info({ count: this.agents.size }, 'AgentManager initialized');
  }

  /**
   * Get all registered agents, with presets resolved against their base agents.
   */
  getAllAgents(): AgentDefinition[] {
    return Array.from(this.agents.values()).map((agent) => this.resolvePreset(agent));
  }

  /**
   * Get agent by ID, with preset resolved against its base agent.
   */
  getAgent(id: string): AgentDefinition | undefined {
    const agent = this.agents.get(id);
    if (!agent) return undefined;
    return this.resolvePreset(agent);
  }

  /**
   * Find agents by name (exact, case-sensitive match).
   * Returns matching agents array to distinguish 0/1/multiple matches.
   */
  getAgentsByName(name: string): AgentDefinition[] {
    return this.getAllAgents().filter((agent) => agent.name === name);
  }

  /**
   * Get the default agent (Claude Code)
   */
  getDefaultAgent(): AgentDefinition {
    return this.agents.get(CLAUDE_CODE_AGENT_ID)!;
  }

  /**
   * Register a new custom agent
   */
  async registerAgent(request: CreateAgentRequest): Promise<AgentDefinition> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const agentBase = {
      id,
      name: request.name,
      commandTemplate: request.commandTemplate,
      continueTemplate: request.continueTemplate,
      headlessTemplate: request.headlessTemplate,
      description: request.description,
      isBuiltIn: false,
      createdAt: now,
      activityPatterns: request.activityPatterns,
      baseAgentId: request.baseAgentId,
    };

    const agent: AgentDefinition = {
      ...agentBase,
      capabilities: computeCapabilities(agentBase),
    };

    // Write to repository FIRST - if this fails, in-memory state remains unchanged
    await this.repository.save(agent);

    // Update in-memory map only after successful persistence
    this.agents.set(id, agent);

    logger.info({ agentId: id, agentName: agent.name }, 'Agent registered');

    // Callback fires after successful save - clients will receive state update
    // only after database write is confirmed
    this.lifecycleCallbacks?.onAgentCreated(agent);

    return agent;
  }

  /**
   * Update an existing agent
   */
  async updateAgent(id: string, request: UpdateAgentRequest): Promise<AgentDefinition | null> {
    const existing = this.agents.get(id);
    if (!existing) {
      return null;
    }

    // Built-in agents cannot be modified (except possibly activityPatterns in future)
    if (existing.isBuiltIn) {
      logger.warn({ agentId: id }, 'Cannot modify built-in agent');
      return null;
    }

    const agentBase = {
      ...existing,
      name: request.name ?? existing.name,
      commandTemplate: request.commandTemplate ?? existing.commandTemplate,
      // Allow clearing optional templates by setting to null
      continueTemplate:
        request.continueTemplate === null
          ? undefined
          : (request.continueTemplate ?? existing.continueTemplate),
      headlessTemplate:
        request.headlessTemplate === null
          ? undefined
          : (request.headlessTemplate ?? existing.headlessTemplate),
      description: request.description ?? existing.description,
      // Allow clearing activityPatterns by setting to null (PATCH semantics: null = clear, undefined = no change)
      activityPatterns:
        request.activityPatterns === null
          ? undefined
          : (request.activityPatterns ?? existing.activityPatterns),
      stripScrollbackClear:
        request.stripScrollbackClear === null
          ? undefined
          : (request.stripScrollbackClear ?? existing.stripScrollbackClear),
      baseAgentId:
        request.baseAgentId === null
          ? undefined
          : (request.baseAgentId ?? existing.baseAgentId),
    };

    // Remove the capabilities from agentBase before recomputing
    const { capabilities: _, ...agentBaseWithoutCapabilities } = agentBase;

    const updated: AgentDefinition = {
      ...agentBaseWithoutCapabilities,
      capabilities: computeCapabilities(agentBaseWithoutCapabilities),
    };

    // Write to repository FIRST - if this fails, in-memory state remains unchanged
    await this.repository.save(updated);

    // Update in-memory map only after successful persistence
    this.agents.set(id, updated);

    logger.info({ agentId: id, agentName: updated.name }, 'Agent updated');

    // Callback fires after successful save - clients will receive state update
    // only after database write is confirmed
    this.lifecycleCallbacks?.onAgentUpdated(updated);

    return updated;
  }

  /**
   * Unregister (delete) an agent
   */
  async unregisterAgent(id: string): Promise<boolean> {
    const agent = this.agents.get(id);
    if (!agent) {
      return false;
    }

    // Built-in agents cannot be deleted
    if (agent.isBuiltIn) {
      logger.warn({ agentId: id }, 'Cannot delete built-in agent');
      return false;
    }

    // Delete from repository FIRST - if this fails, in-memory state remains unchanged
    await this.repository.delete(id);

    // Update in-memory map only after successful persistence
    this.agents.delete(id);

    logger.info({ agentId: id, agentName: agent.name }, 'Agent unregistered');

    // Callback fires after successful delete - clients will receive state update
    // only after database write is confirmed
    this.lifecycleCallbacks?.onAgentDeleted(id);

    return true;
  }

  /**
   * Resolve a preset agent by merging it with its base agent.
   * If the agent has a baseAgentId, inherit unset fields from the base.
   * If the base agent no longer exists, the preset becomes standalone.
   */
  private resolvePreset(agent: AgentDefinition): AgentDefinition {
    if (!agent.baseAgentId) return agent;

    const base = this.agents.get(agent.baseAgentId);
    if (!base) return agent; // Base deleted, preset becomes standalone

    const merged = {
      // Preset identity
      id: agent.id,
      name: agent.name,
      description: agent.description ?? base.description,
      isBuiltIn: agent.isBuiltIn,
      createdAt: agent.createdAt,
      baseAgentId: agent.baseAgentId,
      // Templates: use preset override if set, otherwise inherit from base
      commandTemplate: agent.commandTemplate,
      continueTemplate: agent.continueTemplate ?? base.continueTemplate,
      headlessTemplate: agent.headlessTemplate ?? base.headlessTemplate,
      // Activity detection: inherit from base if not overridden
      activityPatterns: agent.activityPatterns ?? base.activityPatterns,
      // Terminal processing: inherit from base if not overridden
      stripScrollbackClear: agent.stripScrollbackClear ?? base.stripScrollbackClear,
    };

    return {
      ...merged,
      capabilities: computeCapabilities(merged),
    };
  }
}
