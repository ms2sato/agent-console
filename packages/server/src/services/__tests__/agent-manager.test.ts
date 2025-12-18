import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import type { AgentDefinition } from '@agent-console/shared';
import { setupTestConfigDir, cleanupTestConfigDir } from '../../__tests__/utils/mock-fs-helper.js';

describe('AgentManager', () => {
  const TEST_CONFIG_DIR = '/test/config';
  let importCounter = 0;

  beforeEach(() => {
    setupTestConfigDir(TEST_CONFIG_DIR);
  });

  afterEach(() => {
    cleanupTestConfigDir();
  });

  // Helper to get fresh module instances
  async function getAgentManager() {
    const module = await import(`../agent-manager.js?v=${++importCounter}`);
    return {
      AgentManager: module.AgentManager,
      CLAUDE_CODE_AGENT_ID: module.CLAUDE_CODE_AGENT_ID,
    };
  }

  // Helper to pre-populate agents file
  function setupAgents(agents: AgentDefinition[]) {
    fs.writeFileSync(
      `${TEST_CONFIG_DIR}/agents.json`,
      JSON.stringify(agents)
    );
  }

  describe('initialization', () => {
    it('should initialize with built-in Claude Code agent', async () => {
      const { AgentManager } = await getAgentManager();
      const manager = new AgentManager();

      const agents = manager.getAllAgents();
      expect(agents.length).toBeGreaterThanOrEqual(1);

      const claudeCode = agents.find((a: AgentDefinition) => a.name === 'Claude Code');
      expect(claudeCode).toBeDefined();
      expect(claudeCode?.isBuiltIn).toBe(true);
    });

    it('should load custom agents from persistence', async () => {
      setupAgents([
        {
          id: 'custom-agent',
          name: 'Custom Agent',
          commandTemplate: 'custom-cmd {{prompt}}',
          isBuiltIn: false,
          registeredAt: '2024-01-01T00:00:00.000Z',
          capabilities: {
            supportsContinue: false,
            supportsHeadlessMode: false,
            supportsActivityDetection: false,
          },
        },
      ]);

      const { AgentManager } = await getAgentManager();
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
      const { AgentManager } = await getAgentManager();
      const manager = new AgentManager();

      const agents = manager.getAllAgents();
      expect(agents).toBeInstanceOf(Array);
      expect(agents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getAgent', () => {
    it('should return agent by id', async () => {
      const { AgentManager, CLAUDE_CODE_AGENT_ID } = await getAgentManager();
      const manager = new AgentManager();

      const agent = manager.getAgent(CLAUDE_CODE_AGENT_ID);
      expect(agent).toBeDefined();
      expect(agent?.name).toBe('Claude Code');
    });

    it('should return undefined for non-existent agent', async () => {
      const { AgentManager } = await getAgentManager();
      const manager = new AgentManager();

      const agent = manager.getAgent('non-existent');
      expect(agent).toBeUndefined();
    });
  });

  describe('getDefaultAgent', () => {
    it('should return Claude Code agent', async () => {
      const { AgentManager } = await getAgentManager();
      const manager = new AgentManager();

      const agent = manager.getDefaultAgent();
      expect(agent.name).toBe('Claude Code');
      expect(agent.isBuiltIn).toBe(true);
    });
  });

  describe('registerAgent', () => {
    it('should register a new custom agent', async () => {
      const { AgentManager } = await getAgentManager();
      const manager = new AgentManager();

      const agent = manager.registerAgent({
        name: 'My Agent',
        commandTemplate: 'my-agent-cmd {{prompt}}',
        description: 'Test agent',
      });

      expect(agent.id).toBeDefined();
      expect(agent.name).toBe('My Agent');
      expect(agent.commandTemplate).toBe('my-agent-cmd {{prompt}}');
      expect(agent.isBuiltIn).toBe(false);
      expect(agent.registeredAt).toBeDefined();

      // Should be retrievable
      expect(manager.getAgent(agent.id)).toBeDefined();

      // Should be persisted
      const savedData = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/agents.json`, 'utf-8'));
      expect(savedData.length).toBeGreaterThan(0);
    });

    it('should register agent with activity patterns', async () => {
      const { AgentManager } = await getAgentManager();
      const manager = new AgentManager();

      const agent = manager.registerAgent({
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
      const { AgentManager } = await getAgentManager();
      const manager = new AgentManager();

      const agent = manager.registerAgent({
        name: 'Agent with Continue',
        commandTemplate: 'cmd {{prompt}}',
        continueTemplate: 'cmd --resume',
      });

      expect(agent.continueTemplate).toBe('cmd --resume');
      expect(agent.capabilities.supportsContinue).toBe(true);
    });

    it('should register agent with headless template', async () => {
      const { AgentManager } = await getAgentManager();
      const manager = new AgentManager();

      const agent = manager.registerAgent({
        name: 'Agent with Headless',
        commandTemplate: 'cmd {{prompt}}',
        headlessTemplate: 'cmd -p {{prompt}}',
      });

      expect(agent.headlessTemplate).toBe('cmd -p {{prompt}}');
      expect(agent.capabilities.supportsHeadlessMode).toBe(true);
    });

    it('should handle agent name with special characters', async () => {
      const { AgentManager } = await getAgentManager();
      const manager = new AgentManager();

      const agent = manager.registerAgent({
        name: 'Agent 日本語 🤖',
        commandTemplate: 'my-cmd {{prompt}}',
      });

      expect(agent.name).toBe('Agent 日本語 🤖');
      expect(manager.getAgent(agent.id)?.name).toBe('Agent 日本語 🤖');
    });

    it('should handle agent with empty description', async () => {
      const { AgentManager } = await getAgentManager();
      const manager = new AgentManager();

      const agent = manager.registerAgent({
        name: 'Agent',
        commandTemplate: 'cmd {{prompt}}',
        description: '',
      });

      expect(agent.description).toBe('');
    });

    it('should compute capabilities correctly', async () => {
      const { AgentManager } = await getAgentManager();
      const manager = new AgentManager();

      // Agent with no optional templates
      const basicAgent = manager.registerAgent({
        name: 'Basic Agent',
        commandTemplate: 'cmd {{prompt}}',
      });
      expect(basicAgent.capabilities.supportsContinue).toBe(false);
      expect(basicAgent.capabilities.supportsHeadlessMode).toBe(false);
      expect(basicAgent.capabilities.supportsActivityDetection).toBe(false);

      // Agent with all features
      const fullAgent = manager.registerAgent({
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
      const { AgentManager } = await getAgentManager();
      const manager = new AgentManager();

      // First register a custom agent
      const created = manager.registerAgent({
        name: 'Original Name',
        commandTemplate: 'original-cmd {{prompt}}',
      });

      // Then update it
      const updated = manager.updateAgent(created.id, {
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
      const { AgentManager } = await getAgentManager();
      const manager = new AgentManager();

      const result = manager.updateAgent('non-existent', { name: 'Test' });
      expect(result).toBeNull();
    });

    it('should not update built-in agent', async () => {
      const { AgentManager, CLAUDE_CODE_AGENT_ID } = await getAgentManager();
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
      const { AgentManager } = await getAgentManager();
      const manager = new AgentManager();

      const created = manager.registerAgent({
        name: 'Original',
        commandTemplate: 'cmd {{prompt}}',
        description: 'Original description',
      });

      // Update only name
      const updated = manager.updateAgent(created.id, {
        name: 'New Name',
      });

      expect(updated?.name).toBe('New Name');
      expect(updated?.commandTemplate).toBe('cmd {{prompt}}'); // Unchanged
      expect(updated?.description).toBe('Original description'); // Unchanged
    });

    it('should update capabilities when templates change', async () => {
      const { AgentManager } = await getAgentManager();
      const manager = new AgentManager();

      const created = manager.registerAgent({
        name: 'Agent',
        commandTemplate: 'cmd {{prompt}}',
      });

      expect(created.capabilities.supportsContinue).toBe(false);

      // Add continue template
      const updated = manager.updateAgent(created.id, {
        continueTemplate: 'cmd --continue',
      });

      expect(updated?.capabilities.supportsContinue).toBe(true);
    });

    it('should clear optional templates when set to null', async () => {
      const { AgentManager } = await getAgentManager();
      const manager = new AgentManager();

      const created = manager.registerAgent({
        name: 'Agent',
        commandTemplate: 'cmd {{prompt}}',
        continueTemplate: 'cmd --continue',
        headlessTemplate: 'cmd -p {{prompt}}',
      });

      expect(created.capabilities.supportsContinue).toBe(true);
      expect(created.capabilities.supportsHeadlessMode).toBe(true);

      // Clear templates by setting to null
      const updated = manager.updateAgent(created.id, {
        continueTemplate: null,
        headlessTemplate: null,
      });

      expect(updated?.continueTemplate).toBeUndefined();
      expect(updated?.headlessTemplate).toBeUndefined();
      expect(updated?.capabilities.supportsContinue).toBe(false);
      expect(updated?.capabilities.supportsHeadlessMode).toBe(false);
    });

    it('should clear activityPatterns when set to null', async () => {
      const { AgentManager } = await getAgentManager();
      const manager = new AgentManager();

      const created = manager.registerAgent({
        name: 'Agent with Patterns',
        commandTemplate: 'cmd {{prompt}}',
        activityPatterns: {
          askingPatterns: ['pattern1', 'pattern2'],
        },
      });

      expect(created.activityPatterns?.askingPatterns).toEqual(['pattern1', 'pattern2']);
      expect(created.capabilities.supportsActivityDetection).toBe(true);

      // Clear activityPatterns by setting to null
      const updated = manager.updateAgent(created.id, {
        activityPatterns: null,
      });

      expect(updated?.activityPatterns).toBeUndefined();
      expect(updated?.capabilities.supportsActivityDetection).toBe(false);
    });

    it('should preserve activityPatterns when not specified in update (undefined)', async () => {
      const { AgentManager } = await getAgentManager();
      const manager = new AgentManager();

      const created = manager.registerAgent({
        name: 'Agent with Patterns',
        commandTemplate: 'cmd {{prompt}}',
        activityPatterns: {
          askingPatterns: ['pattern1'],
        },
      });

      // Update only name, activityPatterns not specified (undefined)
      const updated = manager.updateAgent(created.id, {
        name: 'Renamed Agent',
      });

      // activityPatterns should be preserved
      expect(updated?.activityPatterns?.askingPatterns).toEqual(['pattern1']);
      expect(updated?.capabilities.supportsActivityDetection).toBe(true);
    });
  });

  describe('unregisterAgent', () => {
    it('should unregister a custom agent', async () => {
      const { AgentManager } = await getAgentManager();
      const manager = new AgentManager();

      const created = manager.registerAgent({
        name: 'To Delete',
        commandTemplate: 'cmd {{prompt}}',
      });

      const result = manager.unregisterAgent(created.id);

      expect(result).toBe(true);
      expect(manager.getAgent(created.id)).toBeUndefined();
    });

    it('should return false for non-existent agent', async () => {
      const { AgentManager } = await getAgentManager();
      const manager = new AgentManager();

      const result = manager.unregisterAgent('non-existent');
      expect(result).toBe(false);
    });

    it('should not unregister built-in agent', async () => {
      const { AgentManager, CLAUDE_CODE_AGENT_ID } = await getAgentManager();
      const manager = new AgentManager();

      const result = manager.unregisterAgent(CLAUDE_CODE_AGENT_ID);

      expect(result).toBe(false);

      // Should still exist
      const agent = manager.getAgent(CLAUDE_CODE_AGENT_ID);
      expect(agent).toBeDefined();
    });
  });
});
