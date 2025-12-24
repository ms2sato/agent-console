import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { AgentDefinition } from '@agent-console/shared';
import { setupTestConfigDir, cleanupTestConfigDir } from '../../__tests__/utils/mock-fs-helper.js';
import type { AgentRepository } from '../../repositories/agent-repository.js';

/**
 * In-memory mock implementation of AgentRepository for testing.
 */
class InMemoryAgentRepository implements AgentRepository {
  private agents = new Map<string, AgentDefinition>();

  async findAll(): Promise<AgentDefinition[]> {
    return Array.from(this.agents.values());
  }

  async findById(id: string): Promise<AgentDefinition | null> {
    return this.agents.get(id) ?? null;
  }

  async save(agent: AgentDefinition): Promise<void> {
    // Skip built-in agents
    if (agent.isBuiltIn) return;
    this.agents.set(agent.id, agent);
  }

  async delete(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) {
      return; // Idempotent
    }
    if (agent.isBuiltIn) {
      throw new Error('Cannot delete built-in agent');
    }
    this.agents.delete(id);
  }

  // Test helper to pre-populate data
  setAgents(agents: AgentDefinition[]): void {
    this.agents.clear();
    for (const agent of agents) {
      if (!agent.isBuiltIn) {
        this.agents.set(agent.id, agent);
      }
    }
  }

  // Test helper to get all saved agents
  getAllSaved(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }
}

describe('AgentManager', () => {
  const TEST_CONFIG_DIR = '/test/config';
  let importCounter = 0;
  let mockRepository: InMemoryAgentRepository;

  beforeEach(() => {
    setupTestConfigDir(TEST_CONFIG_DIR);
    mockRepository = new InMemoryAgentRepository();
  });

  afterEach(() => {
    cleanupTestConfigDir();
  });

  // Helper to get fresh AgentManager instance with the mock repository
  async function getAgentManager(preloadedAgents: AgentDefinition[] = []) {
    // Pre-populate the repository before creating the manager
    mockRepository.setAgents(preloadedAgents);
    const module = await import(`../agent-manager.js?v=${++importCounter}`);
    const manager = await module.AgentManager.create(mockRepository);
    return {
      manager,
      CLAUDE_CODE_AGENT_ID: module.CLAUDE_CODE_AGENT_ID,
    };
  }

  describe('initialization', () => {
    it('should initialize with built-in Claude Code agent', async () => {
      const { manager } = await getAgentManager();

      const agents = manager.getAllAgents();
      expect(agents.length).toBeGreaterThanOrEqual(1);

      const claudeCode = agents.find((a: AgentDefinition) => a.name === 'Claude Code');
      expect(claudeCode).toBeDefined();
      expect(claudeCode?.isBuiltIn).toBe(true);
    });

    it('should load custom agents from persistence', async () => {
      const preloadedAgents: AgentDefinition[] = [
        {
          id: 'custom-agent',
          name: 'Custom Agent',
          commandTemplate: 'custom-cmd {{prompt}}',
          isBuiltIn: false,
          createdAt: '2024-01-01T00:00:00.000Z',
          capabilities: {
            supportsContinue: false,
            supportsHeadlessMode: false,
            supportsActivityDetection: false,
          },
        },
      ];

      const { manager } = await getAgentManager(preloadedAgents);

      const agents = manager.getAllAgents();
      expect(agents.length).toBe(2); // Built-in + custom

      const custom = manager.getAgent('custom-agent');
      expect(custom).toBeDefined();
      expect(custom?.name).toBe('Custom Agent');
    });
  });

  describe('getAllAgents', () => {
    it('should return all registered agents', async () => {
      const { manager } = await getAgentManager();

      const agents = manager.getAllAgents();
      expect(agents).toBeInstanceOf(Array);
      expect(agents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getAgent', () => {
    it('should return agent by id', async () => {
      const { manager, CLAUDE_CODE_AGENT_ID } = await getAgentManager();

      const agent = manager.getAgent(CLAUDE_CODE_AGENT_ID);
      expect(agent).toBeDefined();
      expect(agent?.name).toBe('Claude Code');
    });

    it('should return undefined for non-existent agent', async () => {
      const { manager } = await getAgentManager();

      const agent = manager.getAgent('non-existent');
      expect(agent).toBeUndefined();
    });
  });

  describe('getDefaultAgent', () => {
    it('should return Claude Code agent', async () => {
      const { manager } = await getAgentManager();

      const agent = manager.getDefaultAgent();
      expect(agent.name).toBe('Claude Code');
      expect(agent.isBuiltIn).toBe(true);
    });
  });

  describe('registerAgent', () => {
    it('should register a new custom agent', async () => {
      const { manager } = await getAgentManager();

      const agent = await manager.registerAgent({
        name: 'My Agent',
        commandTemplate: 'my-agent-cmd {{prompt}}',
        description: 'Test agent',
      });

      expect(agent.id).toBeDefined();
      expect(agent.name).toBe('My Agent');
      expect(agent.commandTemplate).toBe('my-agent-cmd {{prompt}}');
      expect(agent.isBuiltIn).toBe(false);
      expect(agent.createdAt).toBeDefined();

      // Should be retrievable
      expect(manager.getAgent(agent.id)).toBeDefined();

      // Should be persisted in the mock repository
      const savedAgents = mockRepository.getAllSaved();
      expect(savedAgents.length).toBeGreaterThan(0);
    });

    it('should register agent with activity patterns', async () => {
      const { manager } = await getAgentManager();

      const agent = await manager.registerAgent({
        name: 'Agent with Patterns',
        commandTemplate: 'cmd {{prompt}}',
        activityPatterns: {
          askingPatterns: ['pattern1', 'pattern2'],
        },
      });

      expect(agent.activityPatterns?.askingPatterns).toContain('pattern1');
      expect(agent.capabilities.supportsActivityDetection).toBe(true);
    });

    it('should register agent with continue template', async () => {
      const { manager } = await getAgentManager();

      const agent = await manager.registerAgent({
        name: 'Agent with Continue',
        commandTemplate: 'cmd {{prompt}}',
        continueTemplate: 'cmd --resume',
      });

      expect(agent.continueTemplate).toBe('cmd --resume');
      expect(agent.capabilities.supportsContinue).toBe(true);
    });

    it('should register agent with headless template', async () => {
      const { manager } = await getAgentManager();

      const agent = await manager.registerAgent({
        name: 'Agent with Headless',
        commandTemplate: 'cmd {{prompt}}',
        headlessTemplate: 'cmd -p {{prompt}}',
      });

      expect(agent.headlessTemplate).toBe('cmd -p {{prompt}}');
      expect(agent.capabilities.supportsHeadlessMode).toBe(true);
    });

    it('should handle agent name with special characters', async () => {
      const { manager } = await getAgentManager();

      const agent = await manager.registerAgent({
        name: 'Agent 日本語 🤖',
        commandTemplate: 'my-cmd {{prompt}}',
      });

      expect(agent.name).toBe('Agent 日本語 🤖');
      expect(manager.getAgent(agent.id)?.name).toBe('Agent 日本語 🤖');
    });

    it('should handle agent with empty description', async () => {
      const { manager } = await getAgentManager();

      const agent = await manager.registerAgent({
        name: 'Agent',
        commandTemplate: 'cmd {{prompt}}',
        description: '',
      });

      expect(agent.description).toBe('');
    });

    it('should compute capabilities correctly', async () => {
      const { manager } = await getAgentManager();

      // Agent with no optional templates
      const basicAgent = await manager.registerAgent({
        name: 'Basic Agent',
        commandTemplate: 'cmd {{prompt}}',
      });
      expect(basicAgent.capabilities.supportsContinue).toBe(false);
      expect(basicAgent.capabilities.supportsHeadlessMode).toBe(false);
      expect(basicAgent.capabilities.supportsActivityDetection).toBe(false);

      // Agent with all features
      const fullAgent = await manager.registerAgent({
        name: 'Full Agent',
        commandTemplate: 'cmd {{prompt}}',
        continueTemplate: 'cmd --continue',
        headlessTemplate: 'cmd -p {{prompt}}',
        activityPatterns: { askingPatterns: ['pattern'] },
      });
      expect(fullAgent.capabilities.supportsContinue).toBe(true);
      expect(fullAgent.capabilities.supportsHeadlessMode).toBe(true);
      expect(fullAgent.capabilities.supportsActivityDetection).toBe(true);
    });
  });

  describe('updateAgent', () => {
    it('should update an existing custom agent', async () => {
      const { manager } = await getAgentManager();

      // First register a custom agent
      const created = await manager.registerAgent({
        name: 'Original Name',
        commandTemplate: 'original-cmd {{prompt}}',
      });

      // Then update it
      const updated = await manager.updateAgent(created.id, {
        name: 'Updated Name',
        commandTemplate: 'updated-cmd {{prompt}}',
      });

      expect(updated).not.toBeNull();
      expect(updated?.name).toBe('Updated Name');
      expect(updated?.commandTemplate).toBe('updated-cmd {{prompt}}');

      // Should persist the update
      const retrieved = manager.getAgent(created.id);
      expect(retrieved?.name).toBe('Updated Name');
    });

    it('should return null for non-existent agent', async () => {
      const { manager } = await getAgentManager();

      const result = await manager.updateAgent('non-existent', { name: 'Test' });
      expect(result).toBeNull();
    });

    it('should not update built-in agent', async () => {
      const { manager, CLAUDE_CODE_AGENT_ID } = await getAgentManager();

      const result = await manager.updateAgent(CLAUDE_CODE_AGENT_ID, {
        name: 'Modified Claude',
      });

      expect(result).toBeNull();

      // Should remain unchanged
      const agent = manager.getAgent(CLAUDE_CODE_AGENT_ID);
      expect(agent?.name).toBe('Claude Code');
    });

    it('should partially update agent', async () => {
      const { manager } = await getAgentManager();

      const created = await manager.registerAgent({
        name: 'Original',
        commandTemplate: 'cmd {{prompt}}',
        description: 'Original description',
      });

      // Update only name
      const updated = await manager.updateAgent(created.id, {
        name: 'New Name',
      });

      expect(updated?.name).toBe('New Name');
      expect(updated?.commandTemplate).toBe('cmd {{prompt}}'); // Unchanged
      expect(updated?.description).toBe('Original description'); // Unchanged
    });

    it('should update capabilities when templates change', async () => {
      const { manager } = await getAgentManager();

      const created = await manager.registerAgent({
        name: 'Agent',
        commandTemplate: 'cmd {{prompt}}',
      });

      expect(created.capabilities.supportsContinue).toBe(false);

      // Add continue template
      const updated = await manager.updateAgent(created.id, {
        continueTemplate: 'cmd --continue',
      });

      expect(updated?.capabilities.supportsContinue).toBe(true);
    });

    it('should clear optional templates when set to null', async () => {
      const { manager } = await getAgentManager();

      const created = await manager.registerAgent({
        name: 'Agent',
        commandTemplate: 'cmd {{prompt}}',
        continueTemplate: 'cmd --continue',
        headlessTemplate: 'cmd -p {{prompt}}',
      });

      expect(created.capabilities.supportsContinue).toBe(true);
      expect(created.capabilities.supportsHeadlessMode).toBe(true);

      // Clear templates by setting to null
      const updated = await manager.updateAgent(created.id, {
        continueTemplate: null,
        headlessTemplate: null,
      });

      expect(updated?.continueTemplate).toBeUndefined();
      expect(updated?.headlessTemplate).toBeUndefined();
      expect(updated?.capabilities.supportsContinue).toBe(false);
      expect(updated?.capabilities.supportsHeadlessMode).toBe(false);
    });

    it('should clear activityPatterns when set to null', async () => {
      const { manager } = await getAgentManager();

      const created = await manager.registerAgent({
        name: 'Agent with Patterns',
        commandTemplate: 'cmd {{prompt}}',
        activityPatterns: {
          askingPatterns: ['pattern1', 'pattern2'],
        },
      });

      expect(created.activityPatterns?.askingPatterns).toEqual(['pattern1', 'pattern2']);
      expect(created.capabilities.supportsActivityDetection).toBe(true);

      // Clear activityPatterns by setting to null
      const updated = await manager.updateAgent(created.id, {
        activityPatterns: null,
      });

      expect(updated?.activityPatterns).toBeUndefined();
      expect(updated?.capabilities.supportsActivityDetection).toBe(false);
    });

    it('should preserve activityPatterns when not specified in update (undefined)', async () => {
      const { manager } = await getAgentManager();

      const created = await manager.registerAgent({
        name: 'Agent with Patterns',
        commandTemplate: 'cmd {{prompt}}',
        activityPatterns: {
          askingPatterns: ['pattern1'],
        },
      });

      // Update only name, activityPatterns not specified (undefined)
      const updated = await manager.updateAgent(created.id, {
        name: 'Renamed Agent',
      });

      // activityPatterns should be preserved
      expect(updated?.activityPatterns?.askingPatterns).toEqual(['pattern1']);
      expect(updated?.capabilities.supportsActivityDetection).toBe(true);
    });
  });

  describe('unregisterAgent', () => {
    it('should unregister a custom agent', async () => {
      const { manager } = await getAgentManager();

      const created = await manager.registerAgent({
        name: 'To Delete',
        commandTemplate: 'cmd {{prompt}}',
      });

      const result = await manager.unregisterAgent(created.id);

      expect(result).toBe(true);
      expect(manager.getAgent(created.id)).toBeUndefined();
    });

    it('should return false for non-existent agent', async () => {
      const { manager } = await getAgentManager();

      const result = await manager.unregisterAgent('non-existent');
      expect(result).toBe(false);
    });

    it('should not unregister built-in agent', async () => {
      const { manager, CLAUDE_CODE_AGENT_ID } = await getAgentManager();

      const result = await manager.unregisterAgent(CLAUDE_CODE_AGENT_ID);

      expect(result).toBe(false);

      // Should still exist
      const agent = manager.getAgent(CLAUDE_CODE_AGENT_ID);
      expect(agent).toBeDefined();
    });
  });
});
