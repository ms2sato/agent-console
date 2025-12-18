import { v4 as uuidv4 } from 'uuid';
import {
  type AgentDefinition,
  type CreateAgentRequest,
  type UpdateAgentRequest,
  computeCapabilities,
} from '@agent-console/shared';
import { persistenceService } from './persistence-service.js';
import { claudeCodeAgent, CLAUDE_CODE_AGENT_ID } from './agents/claude-code.js';
import { createLogger } from '../lib/logger.js';

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

  constructor() {
    this.initialize();
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
  private initialize(): void {
    // Always register built-in agent first
    this.agents.set(CLAUDE_CODE_AGENT_ID, claudeCodeAgent);

    // Load custom agents from persistence
    const customAgents = persistenceService.loadAgents();
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
   * Get all registered agents
   */
  getAllAgents(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get agent by ID
   */
  getAgent(id: string): AgentDefinition | undefined {
    return this.agents.get(id);
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
  registerAgent(request: CreateAgentRequest): AgentDefinition {
    const id = uuidv4();
    const now = new Date().toISOString();

    const agentBase = {
      id,
      name: request.name,
      commandTemplate: request.commandTemplate,
      continueTemplate: request.continueTemplate,
      headlessTemplate: request.headlessTemplate,
      description: request.description,
      isBuiltIn: false,
      registeredAt: now,
      activityPatterns: request.activityPatterns,
    };

    const agent: AgentDefinition = {
      ...agentBase,
      capabilities: computeCapabilities(agentBase),
    };

    this.agents.set(id, agent);
    this.persistAgents();

    logger.info({ agentId: id, agentName: agent.name }, 'Agent registered');

    // Notify lifecycle callbacks
    this.lifecycleCallbacks?.onAgentCreated(agent);

    return agent;
  }

  /**
   * Update an existing agent
   */
  updateAgent(id: string, request: UpdateAgentRequest): AgentDefinition | null {
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
    };

    // Remove the capabilities from agentBase before recomputing
    const { capabilities: _, ...agentBaseWithoutCapabilities } = agentBase;

    const updated: AgentDefinition = {
      ...agentBaseWithoutCapabilities,
      capabilities: computeCapabilities(agentBaseWithoutCapabilities),
    };

    this.agents.set(id, updated);
    this.persistAgents();

    logger.info({ agentId: id, agentName: updated.name }, 'Agent updated');

    // Notify lifecycle callbacks
    this.lifecycleCallbacks?.onAgentUpdated(updated);

    return updated;
  }

  /**
   * Unregister (delete) an agent
   */
  unregisterAgent(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent) {
      return false;
    }

    // Built-in agents cannot be deleted
    if (agent.isBuiltIn) {
      logger.warn({ agentId: id }, 'Cannot delete built-in agent');
      return false;
    }

    this.agents.delete(id);
    this.persistAgents();

    logger.info({ agentId: id, agentName: agent.name }, 'Agent unregistered');

    // Notify lifecycle callbacks
    this.lifecycleCallbacks?.onAgentDeleted(id);

    return true;
  }

  /**
   * Persist all custom agents to storage
   */
  private persistAgents(): void {
    const customAgents: AgentDefinition[] = [];

    for (const agent of this.agents.values()) {
      // Don't persist built-in agents
      if (agent.isBuiltIn) {
        continue;
      }
      customAgents.push(agent);
    }

    persistenceService.saveAgents(customAgents);
  }
}

// Singleton instance
export const agentManager = new AgentManager();
