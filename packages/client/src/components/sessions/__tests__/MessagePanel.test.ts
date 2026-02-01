import { describe, it, expect } from 'bun:test';
import { getAgentWorkers, getInitialTargetWorkerId, canSend } from '../MessagePanel';
import type { Worker } from '@agent-console/shared';

// Helper to create test worker objects with required fields
function agentWorker(id: string, name: string): Worker {
  return { id, type: 'agent', name, agentId: 'claude-code', createdAt: '2024-01-01', activated: true };
}

function terminalWorker(id: string, name: string): Worker {
  return { id, type: 'terminal', name, createdAt: '2024-01-01', activated: true };
}

function gitDiffWorker(id: string, name: string): Worker {
  return { id, type: 'git-diff', name, createdAt: '2024-01-01', baseCommit: 'abc123' };
}

describe('MessagePanel logic', () => {
  describe('getAgentWorkers', () => {
    it('should filter out terminal workers', () => {
      const w1 = agentWorker('w1', 'Agent 1');
      const w3 = agentWorker('w3', 'Agent 2');
      const workers: Worker[] = [w1, terminalWorker('w2', 'Shell 1'), w3];
      const result = getAgentWorkers(workers);
      expect(result).toEqual([w1, w3]);
    });

    it('should filter out git-diff workers', () => {
      const w1 = agentWorker('w1', 'Agent 1');
      const w3 = agentWorker('w3', 'Agent 2');
      const workers: Worker[] = [w1, gitDiffWorker('w2', 'Diff'), w3];
      const result = getAgentWorkers(workers);
      expect(result).toEqual([w1, w3]);
    });

    it('should return empty array when no agent workers exist', () => {
      const workers: Worker[] = [terminalWorker('w1', 'Shell 1'), gitDiffWorker('w2', 'Diff')];
      const result = getAgentWorkers(workers);
      expect(result).toEqual([]);
    });

    it('should return all workers when all are agents', () => {
      const workers: Worker[] = [agentWorker('w1', 'Agent 1'), agentWorker('w2', 'Agent 2')];
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
      const agentWorkers: Worker[] = [agentWorker('agent1', 'Agent 1'), agentWorker('agent2', 'Agent 2')];
      const result = getInitialTargetWorkerId('agent2', agentWorkers);
      expect(result).toBe('agent2');
    });

    it('should return first agent when active worker is non-agent (terminal)', () => {
      const agentWorkers: Worker[] = [agentWorker('agent1', 'Agent 1'), agentWorker('agent2', 'Agent 2')];
      const result = getInitialTargetWorkerId('terminal1', agentWorkers);
      expect(result).toBe('agent1');
    });

    it('should return first agent when active worker is non-agent (git-diff)', () => {
      const agentWorkers: Worker[] = [agentWorker('agent1', 'Agent 1'), agentWorker('agent2', 'Agent 2')];
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
      const agentWorkers: Worker[] = [agentWorker('agent1', 'Agent 1'), agentWorker('agent2', 'Agent 2')];
      const result = getInitialTargetWorkerId(null, agentWorkers);
      expect(result).toBe('agent1');
    });

    it('should fall back to first agent when activeWorkerId does not match any agent', () => {
      const agentWorkers: Worker[] = [agentWorker('agent1', 'Agent 1')];
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
