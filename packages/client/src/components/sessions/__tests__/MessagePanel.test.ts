import { describe, it, expect } from 'bun:test';

/**
 * Tests for MessagePanel logic.
 * These test the core business rules without rendering the full component.
 */

// Extracted logic from components/sessions/MessagePanel.tsx
type WorkerType = 'agent' | 'terminal' | 'git-diff';

interface WorkerInfo {
  id: string;
  type: WorkerType;
  name: string;
}

/**
 * Filter workers to only include agent workers (valid message targets).
 */
function getAgentWorkers(workers: WorkerInfo[]): WorkerInfo[] {
  return workers.filter(w => w.type === 'agent');
}

/**
 * Determine the initial target worker for message sending.
 * Prefers the active worker if it's an agent, otherwise falls back to first agent worker.
 */
function getInitialTargetWorkerId(
  activeWorkerId: string | null,
  agentWorkers: WorkerInfo[]
): string {
  if (activeWorkerId && agentWorkers.some(w => w.id === activeWorkerId)) {
    return activeWorkerId;
  }
  return agentWorkers[0]?.id ?? '';
}

/**
 * Determine if the send action should be enabled.
 */
function canSend(targetWorkerId: string, content: string, sending: boolean): boolean {
  return !sending && content.trim().length > 0 && targetWorkerId.length > 0;
}

describe('MessagePanel logic', () => {
  describe('getAgentWorkers', () => {
    it('should filter out terminal workers', () => {
      const workers: WorkerInfo[] = [
        { id: 'w1', type: 'agent', name: 'Agent 1' },
        { id: 'w2', type: 'terminal', name: 'Shell 1' },
        { id: 'w3', type: 'agent', name: 'Agent 2' },
      ];
      const result = getAgentWorkers(workers);
      expect(result).toEqual([
        { id: 'w1', type: 'agent', name: 'Agent 1' },
        { id: 'w3', type: 'agent', name: 'Agent 2' },
      ]);
    });

    it('should filter out git-diff workers', () => {
      const workers: WorkerInfo[] = [
        { id: 'w1', type: 'agent', name: 'Agent 1' },
        { id: 'w2', type: 'git-diff', name: 'Diff' },
        { id: 'w3', type: 'agent', name: 'Agent 2' },
      ];
      const result = getAgentWorkers(workers);
      expect(result).toEqual([
        { id: 'w1', type: 'agent', name: 'Agent 1' },
        { id: 'w3', type: 'agent', name: 'Agent 2' },
      ]);
    });

    it('should return empty array when no agent workers exist', () => {
      const workers: WorkerInfo[] = [
        { id: 'w1', type: 'terminal', name: 'Shell 1' },
        { id: 'w2', type: 'git-diff', name: 'Diff' },
      ];
      const result = getAgentWorkers(workers);
      expect(result).toEqual([]);
    });

    it('should return all workers when all are agents', () => {
      const workers: WorkerInfo[] = [
        { id: 'w1', type: 'agent', name: 'Agent 1' },
        { id: 'w2', type: 'agent', name: 'Agent 2' },
      ];
      const result = getAgentWorkers(workers);
      expect(result).toEqual(workers);
    });

    it('should handle empty worker list', () => {
      const result = getAgentWorkers([]);
      expect(result).toEqual([]);
    });
  });

  describe('getInitialTargetWorkerId', () => {
    it('should return activeWorkerId when it is an agent worker', () => {
      const agentWorkers: WorkerInfo[] = [
        { id: 'agent1', type: 'agent', name: 'Agent 1' },
        { id: 'agent2', type: 'agent', name: 'Agent 2' },
      ];
      const result = getInitialTargetWorkerId('agent2', agentWorkers);
      expect(result).toBe('agent2');
    });

    it('should return first agent when active worker is non-agent (terminal)', () => {
      const agentWorkers: WorkerInfo[] = [
        { id: 'agent1', type: 'agent', name: 'Agent 1' },
        { id: 'agent2', type: 'agent', name: 'Agent 2' },
      ];
      const result = getInitialTargetWorkerId('terminal1', agentWorkers);
      expect(result).toBe('agent1');
    });

    it('should return first agent when active worker is non-agent (git-diff)', () => {
      const agentWorkers: WorkerInfo[] = [
        { id: 'agent1', type: 'agent', name: 'Agent 1' },
        { id: 'agent2', type: 'agent', name: 'Agent 2' },
      ];
      const result = getInitialTargetWorkerId('git-diff1', agentWorkers);
      expect(result).toBe('agent1');
    });

    it('should return empty string when no agent workers exist', () => {
      const result = getInitialTargetWorkerId('terminal1', []);
      expect(result).toBe('');
    });

    it('should return empty string when activeWorkerId is null and no agents exist', () => {
      const result = getInitialTargetWorkerId(null, []);
      expect(result).toBe('');
    });

    it('should return first agent when activeWorkerId is null', () => {
      const agentWorkers: WorkerInfo[] = [
        { id: 'agent1', type: 'agent', name: 'Agent 1' },
        { id: 'agent2', type: 'agent', name: 'Agent 2' },
      ];
      const result = getInitialTargetWorkerId(null, agentWorkers);
      expect(result).toBe('agent1');
    });

    it('should fall back to first agent when activeWorkerId does not match any agent', () => {
      const agentWorkers: WorkerInfo[] = [
        { id: 'agent1', type: 'agent', name: 'Agent 1' },
      ];
      const result = getInitialTargetWorkerId('unknown', agentWorkers);
      expect(result).toBe('agent1');
    });
  });

  describe('canSend', () => {
    it('should return true when all conditions are met', () => {
      expect(canSend('worker1', 'Hello', false)).toBe(true);
    });

    it('should return false when content is empty', () => {
      expect(canSend('worker1', '', false)).toBe(false);
    });

    it('should return false when content is only whitespace', () => {
      expect(canSend('worker1', '   ', false)).toBe(false);
    });

    it('should return false when targetWorkerId is empty', () => {
      expect(canSend('', 'Hello', false)).toBe(false);
    });

    it('should return false when sending is true', () => {
      expect(canSend('worker1', 'Hello', true)).toBe(false);
    });

    it('should return false when both content is empty and sending is true', () => {
      expect(canSend('worker1', '', true)).toBe(false);
    });

    it('should return false when targetWorkerId is empty and content is valid', () => {
      expect(canSend('', 'Hello', false)).toBe(false);
    });

    it('should return true when content has leading/trailing whitespace but is not empty', () => {
      expect(canSend('worker1', '  Hello  ', false)).toBe(true);
    });

    it('should return false when all conditions fail', () => {
      expect(canSend('', '', true)).toBe(false);
    });
  });
});
