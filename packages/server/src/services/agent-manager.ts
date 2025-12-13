import { v4 as uuidv4 } from 'uuid';
import type {
  AgentDefinition,
  CreateAgentRequest,
  UpdateAgentRequest,
} from '@agent-console/shared';
import { persistenceService } from './persistence-service.js';
import { claudeCodeAgent, CLAUDE_CODE_AGENT_ID } from './agents/claude-code.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('agent-manager');

// Re-export for backward compatibility
export { CLAUDE_CODE_AGENT_ID } from './agents/claude-code.js';

export class AgentManager {
  private agents: Map<string, AgentDefinition> = new Map();

  constructor() {
    this.initialize();
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

    const agent: AgentDefinition = {
      id,
      name: request.name,
      command: request.command,
      description: request.description,
      icon: request.icon,
      isBuiltIn: false,
      registeredAt: now,
      activityPatterns: request.activityPatterns,
      continueArgs: request.continueArgs,
    };

    this.agents.set(id, agent);
    this.persistAgents();

    logger.info({ agentId: id, agentName: agent.name }, 'Agent registered');
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

    const updated: AgentDefinition = {
      ...existing,
      name: request.name ?? existing.name,
      command: request.command ?? existing.command,
      description: request.description ?? existing.description,
      icon: request.icon ?? existing.icon,
      activityPatterns: request.activityPatterns ?? existing.activityPatterns,
      continueArgs: request.continueArgs ?? existing.continueArgs,
    };

    this.agents.set(id, updated);
    this.persistAgents();

    logger.info({ agentId: id, agentName: updated.name }, 'Agent updated');
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
