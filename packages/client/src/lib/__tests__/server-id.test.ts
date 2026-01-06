import { describe, it, expect, beforeEach } from 'bun:test';
import { setServerId, getServerId } from '../server-id';

describe('server-id', () => {
  beforeEach(() => {
    // Reset server ID between tests by setting to a known state
    // Note: This relies on the module's internal state being mutable
    // In a real scenario, we might want a resetServerId function for testing
  });

  describe('setServerId and getServerId', () => {
    it('should store and retrieve server ID', () => {
      setServerId('test-server-123');
      expect(getServerId()).toBe('test-server-123');
    });

    it('should overwrite previous server ID', () => {
      setServerId('server-1');
      setServerId('server-2');
      expect(getServerId()).toBe('server-2');
    });

    it('should handle empty string', () => {
      setServerId('');
      expect(getServerId()).toBe('');
    });
  });
});
