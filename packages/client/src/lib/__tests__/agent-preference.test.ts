import { describe, it, expect, beforeEach } from 'bun:test';
import { getLastSelectedAgentId, saveLastSelectedAgentId } from '../agent-preference';

const STORAGE_KEY = 'agent-console:last-selected-agent';

describe('agent-preference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('getLastSelectedAgentId', () => {
    it('should return undefined when no value is stored', () => {
      expect(getLastSelectedAgentId()).toBeUndefined();
    });

    it('should return the stored agent ID', () => {
      localStorage.setItem(STORAGE_KEY, 'claude-code');
      expect(getLastSelectedAgentId()).toBe('claude-code');
    });
  });

  describe('saveLastSelectedAgentId', () => {
    it('should persist the agent ID to localStorage', () => {
      saveLastSelectedAgentId('custom-agent');
      expect(localStorage.getItem(STORAGE_KEY)).toBe('custom-agent');
    });

    it('should overwrite the previously saved agent ID', () => {
      saveLastSelectedAgentId('agent-1');
      saveLastSelectedAgentId('agent-2');
      expect(getLastSelectedAgentId()).toBe('agent-2');
    });
  });
});
