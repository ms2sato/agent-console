import { v4 as uuidv4 } from 'uuid';
import type {
  AgentDefinition,
  CreateAgentRequest,
  UpdateAgentRequest,
} from '@agents-web-console/shared';
import { persistenceService, type PersistedAgent } from './persistence-service.js';

// Built-in agent ID
export const CLAUDE_CODE_AGENT_ID = 'claude-code-builtin';

// Claude Code specific asking patterns (extracted from activity-detector.ts)
const CLAUDE_CODE_ASKING_PATTERNS: string[] = [
  // Selection menu footer (most reliable - appears on all permission prompts)
  'Enter to select.*Tab.*navigate.*Esc to cancel',

  // Permission prompts - Claude Code style
  'Do you want to.*\\?',              // "Do you want to create/edit/run..." prompts
  '\\[y\\].*\\[n\\]',                 // Yes/No selection
  '\\[a\\].*always',                  // Always allow option
  'Allow.*\\?',                       // "Allow X?" prompts

  // AskUserQuestion patterns
  '\\[A\\].*\\[B\\]',                 // A/B selection
  '\\[1\\].*\\[2\\]',                 // Numbered selection

  // Selection box with prompt
  '╰─+╯\\s*>\\s*$',                   // Box bottom + prompt
];

// Claude Code built-in agent definition
const CLAUDE_CODE_BUILTIN_AGENT: AgentDefinition = {
  id: CLAUDE_CODE_AGENT_ID,
  name: 'Claude Code',
  command: 'claude',
  description: 'Anthropic Claude Code - Interactive AI coding assistant',
  icon: 'terminal',
  isBuiltIn: true,
  registeredAt: new Date(0).toISOString(), // Epoch time for built-in
  activityPatterns: {
    askingPatterns: CLAUDE_CODE_ASKING_PATTERNS,
  },
};

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
    this.agents.set(CLAUDE_CODE_AGENT_ID, CLAUDE_CODE_BUILTIN_AGENT);

    // Load custom agents from persistence
    const persistedAgents = persistenceService.loadAgents();
    for (const persisted of persistedAgents) {
      // Skip if it's the built-in agent (already loaded)
      if (persisted.isBuiltIn) {
        continue;
      }
      this.agents.set(persisted.id, this.toAgentDefinition(persisted));
    }

    console.log(`AgentManager initialized with ${this.agents.size} agents`);
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
    };

    this.agents.set(id, agent);
    this.persistAgents();

    console.log(`Agent registered: ${agent.name} (${id})`);
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
      console.warn(`Cannot modify built-in agent: ${id}`);
      return null;
    }

    const updated: AgentDefinition = {
      ...existing,
      name: request.name ?? existing.name,
      command: request.command ?? existing.command,
      description: request.description ?? existing.description,
      icon: request.icon ?? existing.icon,
      activityPatterns: request.activityPatterns ?? existing.activityPatterns,
    };

    this.agents.set(id, updated);
    this.persistAgents();

    console.log(`Agent updated: ${updated.name} (${id})`);
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
      console.warn(`Cannot delete built-in agent: ${id}`);
      return false;
    }

    this.agents.delete(id);
    this.persistAgents();

    console.log(`Agent unregistered: ${agent.name} (${id})`);
    return true;
  }

  /**
   * Persist all custom agents to storage
   */
  private persistAgents(): void {
    const customAgents: PersistedAgent[] = [];

    for (const agent of this.agents.values()) {
      // Don't persist built-in agents
      if (agent.isBuiltIn) {
        continue;
      }
      customAgents.push(this.toPersistedAgent(agent));
    }

    persistenceService.saveAgents(customAgents);
  }

  /**
   * Convert PersistedAgent to AgentDefinition
   */
  private toAgentDefinition(persisted: PersistedAgent): AgentDefinition {
    return {
      id: persisted.id,
      name: persisted.name,
      command: persisted.command,
      description: persisted.description,
      icon: persisted.icon,
      isBuiltIn: persisted.isBuiltIn,
      registeredAt: persisted.registeredAt,
      activityPatterns: persisted.activityPatterns,
    };
  }

  /**
   * Convert AgentDefinition to PersistedAgent
   */
  private toPersistedAgent(agent: AgentDefinition): PersistedAgent {
    return {
      id: agent.id,
      name: agent.name,
      command: agent.command,
      description: agent.description,
      icon: agent.icon,
      isBuiltIn: agent.isBuiltIn,
      registeredAt: agent.registeredAt,
      activityPatterns: agent.activityPatterns,
    };
  }
}

// Singleton instance
export const agentManager = new AgentManager();
