import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentDefinition } from '@agent-console/shared';

// Mock storage for agents
let mockCustomAgents: AgentDefinition[] = [];

// Mock persistence service
vi.mock('../persistence-service.js', () => ({
  persistenceService: {
    loadAgents: vi.fn(() => mockCustomAgents),
    saveAgents: vi.fn((agents: AgentDefinition[]) => {
      mockCustomAgents = agents;
    }),
  },
}));

describe('AgentManager', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCustomAgents = [];
  });

  describe('initialization', () => {
    it('should initialize with built-in Claude Code agent', async () => {
      const { AgentManager } = await import('../agent-manager.js');
      const manager = new AgentManager();

      const agents = manager.getAllAgents();
      expect(agents.length).toBeGreaterThanOrEqual(1);

      const claudeCode = agents.find(a => a.name === 'Claude Code');
      expect(claudeCode).toBeDefined();
      expect(claudeCode?.isBuiltIn).toBe(true);
    });

    it('should load custom agents from persistence', async () => {
      mockCustomAgents = [
        {
          id: 'custom-agent',
          name: 'Custom Agent',
          command: 'custom-cmd',
          isBuiltIn: false,
          registeredAt: '2024-01-01T00:00:00.000Z',
        },
      ];

      const { AgentManager } = await import('../agent-manager.js');
      const manager = new AgentManager();

      const agents = manager.getAllAgents();
      expect(agents.length).toBe(2); // Built-in + custom

      const custom = manager.getAgent('custom-agent');
      expect(custom).toBeDefined();
      expect(custom?.name).toBe('Custom Agent');
    });
  });

  describe('getAllAgents', () => {
    it('should return all registered agents', async () => {
      const { AgentManager } = await import('../agent-manager.js');
      const manager = new AgentManager();

      const agents = manager.getAllAgents();
      expect(agents).toBeInstanceOf(Array);
      expect(agents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getAgent', () => {
    it('should return agent by id', async () => {
      const { AgentManager, CLAUDE_CODE_AGENT_ID } = await import('../agent-manager.js');
      const manager = new AgentManager();

      const agent = manager.getAgent(CLAUDE_CODE_AGENT_ID);
      expect(agent).toBeDefined();
      expect(agent?.name).toBe('Claude Code');
    });

    it('should return undefined for non-existent agent', async () => {
      const { AgentManager } = await import('../agent-manager.js');
      const manager = new AgentManager();

      const agent = manager.getAgent('non-existent');
      expect(agent).toBeUndefined();
    });
  });

  describe('getDefaultAgent', () => {
    it('should return Claude Code agent', async () => {
      const { AgentManager } = await import('../agent-manager.js');
      const manager = new AgentManager();

      const agent = manager.getDefaultAgent();
      expect(agent.name).toBe('Claude Code');
      expect(agent.isBuiltIn).toBe(true);
    });
  });

  describe('registerAgent', () => {
    it('should register a new custom agent', async () => {
      const { persistenceService } = await import('../persistence-service.js');
      const { AgentManager } = await import('../agent-manager.js');
      const manager = new AgentManager();

      const agent = manager.registerAgent({
        name: 'My Agent',
        command: 'my-agent-cmd',
        description: 'Test agent',
      });

      expect(agent.id).toBeDefined();
      expect(agent.name).toBe('My Agent');
      expect(agent.command).toBe('my-agent-cmd');
      expect(agent.isBuiltIn).toBe(false);
      expect(agent.registeredAt).toBeDefined();

      // Should be retrievable
      expect(manager.getAgent(agent.id)).toBeDefined();

      // Should be persisted
      expect(vi.mocked(persistenceService.saveAgents)).toHaveBeenCalled();
    });

    it('should register agent with activity patterns', async () => {
      const { AgentManager } = await import('../agent-manager.js');
      const manager = new AgentManager();

      const agent = manager.registerAgent({
        name: 'Agent with Patterns',
        command: 'cmd',
        activityPatterns: {
          askingPatterns: ['pattern1', 'pattern2'],
        },
      });

      expect(agent.activityPatterns?.askingPatterns).toContain('pattern1');
    });

    it('should register agent with continue args', async () => {
      const { AgentManager } = await import('../agent-manager.js');
      const manager = new AgentManager();

      const agent = manager.registerAgent({
        name: 'Agent with Continue',
        command: 'cmd',
        continueArgs: ['--resume'],
      });

      expect(agent.continueArgs).toEqual(['--resume']);
    });

    it('should handle agent name with special characters', async () => {
      const { AgentManager } = await import('../agent-manager.js');
      const manager = new AgentManager();

      const agent = manager.registerAgent({
        name: 'Agent 日本語 🤖',
        command: 'my-cmd',
      });

      expect(agent.name).toBe('Agent 日本語 🤖');
      expect(manager.getAgent(agent.id)?.name).toBe('Agent 日本語 🤖');
    });

    it('should handle agent with empty description', async () => {
      const { AgentManager } = await import('../agent-manager.js');
      const manager = new AgentManager();

      const agent = manager.registerAgent({
        name: 'Agent',
        command: 'cmd',
        description: '',
      });

      expect(agent.description).toBe('');
    });
  });

  describe('updateAgent', () => {
    it('should update an existing custom agent', async () => {
      const { AgentManager } = await import('../agent-manager.js');
      const manager = new AgentManager();

      // First register a custom agent
      const created = manager.registerAgent({
        name: 'Original Name',
        command: 'original-cmd',
      });

      // Then update it
      const updated = manager.updateAgent(created.id, {
        name: 'Updated Name',
        command: 'updated-cmd',
      });

      expect(updated).not.toBeNull();
      expect(updated?.name).toBe('Updated Name');
      expect(updated?.command).toBe('updated-cmd');

      // Should persist the update
      const retrieved = manager.getAgent(created.id);
      expect(retrieved?.name).toBe('Updated Name');
    });

    it('should return null for non-existent agent', async () => {
      const { AgentManager } = await import('../agent-manager.js');
      const manager = new AgentManager();

      const result = manager.updateAgent('non-existent', { name: 'Test' });
      expect(result).toBeNull();
    });

    it('should not update built-in agent', async () => {
      const { AgentManager, CLAUDE_CODE_AGENT_ID } = await import('../agent-manager.js');
      const manager = new AgentManager();

      const result = manager.updateAgent(CLAUDE_CODE_AGENT_ID, {
        name: 'Modified Claude',
      });

      expect(result).toBeNull();

      // Should remain unchanged
      const agent = manager.getAgent(CLAUDE_CODE_AGENT_ID);
      expect(agent?.name).toBe('Claude Code');
    });

    it('should partially update agent', async () => {
      const { AgentManager } = await import('../agent-manager.js');
      const manager = new AgentManager();

      const created = manager.registerAgent({
        name: 'Original',
        command: 'cmd',
        description: 'Original description',
      });

      // Update only name
      const updated = manager.updateAgent(created.id, {
        name: 'New Name',
      });

      expect(updated?.name).toBe('New Name');
      expect(updated?.command).toBe('cmd'); // Unchanged
      expect(updated?.description).toBe('Original description'); // Unchanged
    });
  });

  describe('unregisterAgent', () => {
    it('should unregister a custom agent', async () => {
      const { persistenceService } = await import('../persistence-service.js');
      const { AgentManager } = await import('../agent-manager.js');
      const manager = new AgentManager();

      const created = manager.registerAgent({
        name: 'To Delete',
        command: 'cmd',
      });

      vi.mocked(persistenceService.saveAgents).mockClear();

      const result = manager.unregisterAgent(created.id);

      expect(result).toBe(true);
      expect(manager.getAgent(created.id)).toBeUndefined();
      expect(vi.mocked(persistenceService.saveAgents)).toHaveBeenCalled();
    });

    it('should return false for non-existent agent', async () => {
      const { AgentManager } = await import('../agent-manager.js');
      const manager = new AgentManager();

      const result = manager.unregisterAgent('non-existent');
      expect(result).toBe(false);
    });

    it('should not unregister built-in agent', async () => {
      const { AgentManager, CLAUDE_CODE_AGENT_ID } = await import('../agent-manager.js');
      const manager = new AgentManager();

      const result = manager.unregisterAgent(CLAUDE_CODE_AGENT_ID);

      expect(result).toBe(false);

      // Should still exist
      const agent = manager.getAgent(CLAUDE_CODE_AGENT_ID);
      expect(agent).toBeDefined();
    });
  });
});
