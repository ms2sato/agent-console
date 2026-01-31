import { describe, it, expect } from 'bun:test';

/**
 * Tests for session page tab behavior logic.
 * These test the core business rules without rendering the full component.
 */

// Extracted logic from components/sessions/SessionPage.tsx
type WorkerType = 'agent' | 'terminal' | 'git-diff';

/**
 * Determines if a tab can be closed based on worker type.
 * Agent and git-diff tabs are fixed and cannot be closed.
 */
function canCloseTab(workerType: WorkerType): boolean {
  return workerType === 'terminal';
}

/**
 * Determines which worker types should be auto-created when session starts.
 * Both agent and git-diff workers are created automatically.
 */
function getAutoCreateWorkerTypes(): WorkerType[] {
  return ['agent', 'git-diff'];
}

interface AgentDef {
  id: string;
  name: string;
  isBuiltIn: boolean;
}

/**
 * Generate menu items for the add worker dropdown.
 * Always includes "Shell" plus one entry per registered agent.
 */
function getAddWorkerMenuItems(agents: AgentDef[]): Array<{ label: string; type: 'terminal' | 'agent'; agentId?: string }> {
  const items: Array<{ label: string; type: 'terminal' | 'agent'; agentId?: string }> = [
    { label: 'Shell', type: 'terminal' },
  ];
  for (const agent of agents) {
    items.push({ label: `Agent: ${agent.name}`, type: 'agent', agentId: agent.id });
  }
  return items;
}

describe('Session page tab behavior', () => {
  describe('canCloseTab', () => {
    it('should return false for agent tabs', () => {
      expect(canCloseTab('agent')).toBe(false);
    });

    it('should return false for git-diff tabs', () => {
      expect(canCloseTab('git-diff')).toBe(false);
    });

    it('should return true for terminal tabs', () => {
      expect(canCloseTab('terminal')).toBe(true);
    });

    it('should return false for dynamically-added agent tabs', () => {
      // Verify that the rule applies to all agent tabs, not just auto-created ones
      expect(canCloseTab('agent')).toBe(false);
    });
  });

  describe('getAutoCreateWorkerTypes', () => {
    it('should include agent worker', () => {
      const types = getAutoCreateWorkerTypes();
      expect(types).toContain('agent');
    });

    it('should include git-diff worker', () => {
      const types = getAutoCreateWorkerTypes();
      expect(types).toContain('git-diff');
    });

    it('should not include terminal worker', () => {
      const types = getAutoCreateWorkerTypes();
      expect(types).not.toContain('terminal');
    });

    it('should have exactly 2 worker types', () => {
      const types = getAutoCreateWorkerTypes();
      expect(types.length).toBe(2);
    });
  });

  describe('getAddWorkerMenuItems', () => {
    it('should include Shell item when no agents exist', () => {
      const items = getAddWorkerMenuItems([]);
      expect(items).toEqual([
        { label: 'Shell', type: 'terminal' },
      ]);
    });

    it('should include Shell and agent when one built-in agent exists', () => {
      const agents: AgentDef[] = [
        { id: 'claude', name: 'Claude Code', isBuiltIn: true },
      ];
      const items = getAddWorkerMenuItems(agents);
      expect(items).toEqual([
        { label: 'Shell', type: 'terminal' },
        { label: 'Agent: Claude Code', type: 'agent', agentId: 'claude' },
      ]);
    });

    it('should include Shell and all agents when multiple agents exist', () => {
      const agents: AgentDef[] = [
        { id: 'claude', name: 'Claude Code', isBuiltIn: true },
        { id: 'custom1', name: 'Custom Agent 1', isBuiltIn: false },
        { id: 'custom2', name: 'Custom Agent 2', isBuiltIn: false },
      ];
      const items = getAddWorkerMenuItems(agents);
      expect(items).toEqual([
        { label: 'Shell', type: 'terminal' },
        { label: 'Agent: Claude Code', type: 'agent', agentId: 'claude' },
        { label: 'Agent: Custom Agent 1', type: 'agent', agentId: 'custom1' },
        { label: 'Agent: Custom Agent 2', type: 'agent', agentId: 'custom2' },
      ]);
    });

    it('should always include Shell as the first item', () => {
      const agents: AgentDef[] = [
        { id: 'agent1', name: 'Agent 1', isBuiltIn: true },
        { id: 'agent2', name: 'Agent 2', isBuiltIn: false },
      ];
      const items = getAddWorkerMenuItems(agents);
      expect(items[0]).toEqual({ label: 'Shell', type: 'terminal' });
    });

    it('should preserve agent order', () => {
      const agents: AgentDef[] = [
        { id: 'z-agent', name: 'Z Agent', isBuiltIn: false },
        { id: 'a-agent', name: 'A Agent', isBuiltIn: false },
      ];
      const items = getAddWorkerMenuItems(agents);
      expect(items[1].label).toBe('Agent: Z Agent');
      expect(items[2].label).toBe('Agent: A Agent');
    });

    it('should include agentId for agent items', () => {
      const agents: AgentDef[] = [
        { id: 'test-agent', name: 'Test Agent', isBuiltIn: false },
      ];
      const items = getAddWorkerMenuItems(agents);
      expect(items[1]).toEqual({
        label: 'Agent: Test Agent',
        type: 'agent',
        agentId: 'test-agent',
      });
    });

    it('should not include agentId for Shell item', () => {
      const items = getAddWorkerMenuItems([]);
      expect(items[0]).toEqual({ label: 'Shell', type: 'terminal' });
      expect(items[0]).not.toHaveProperty('agentId');
    });
  });
});
