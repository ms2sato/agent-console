import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { CachedState } from '../terminal-state-cache';

/**
 * In-memory store for mocking idb-keyval.
 */
class MockStore {
  private store = new Map<string, unknown>();

  get(key: string): unknown {
    return this.store.get(key);
  }

  set(key: string, value: unknown): void {
    this.store.set(key, value);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  keys(): string[] {
    return Array.from(this.store.keys());
  }

  clear(): void {
    this.store.clear();
  }
}

// Create mock store before any tests run
const mockStore = new MockStore();

// Track error mock state
let getMockThrows = false;
let setMockThrows = false;
let delMockThrows = false;
let keysMockThrows = false;

// Mock idb-keyval module before importing the module under test
mock.module('idb-keyval', () => ({
  get: async (key: string) => {
    if (getMockThrows) {
      throw new Error('IndexedDB error');
    }
    return mockStore.get(key);
  },
  set: async (key: string, value: unknown) => {
    if (setMockThrows) {
      throw new Error('IndexedDB error');
    }
    mockStore.set(key, value);
  },
  del: async (key: string) => {
    if (delMockThrows) {
      throw new Error('IndexedDB error');
    }
    mockStore.delete(key);
  },
  keys: async () => {
    if (keysMockThrows) {
      throw new Error('IndexedDB error');
    }
    return mockStore.keys();
  },
}));

// Import after mocking
import {
  saveTerminalState,
  loadTerminalState,
  clearTerminalState,
  cleanupOldStates,
  isValidForServer,
} from '../terminal-state-cache';

describe('terminal-state-cache', () => {
  beforeEach(() => {
    mockStore.clear();
    getMockThrows = false;
    setMockThrows = false;
    delMockThrows = false;
    keysMockThrows = false;
  });

  afterEach(() => {
    mockStore.clear();
    getMockThrows = false;
    setMockThrows = false;
    delMockThrows = false;
    keysMockThrows = false;
  });

  const createValidState = (overrides: Partial<CachedState> = {}): CachedState => ({
    data: 'serialized-terminal-data',
    savedAt: Date.now(),
    cols: 80,
    rows: 24,
    offset: 1234,
    ...overrides,
  });

  describe('saveTerminalState', () => {
    it('should save state with correct key format', async () => {
      const state = createValidState();
      await saveTerminalState('session-1', 'worker-1', state);

      const saved = mockStore.get('terminal:session-1:worker-1');
      expect(saved).toEqual(state);
    });

    it('should handle save errors gracefully', async () => {
      setMockThrows = true;
      const state = createValidState();
      // Should not throw
      await expect(saveTerminalState('session-1', 'worker-1', state)).resolves.toBeUndefined();
    });
  });

  describe('loadTerminalState', () => {
    it('should return cached state for valid entry', async () => {
      const state = createValidState();
      mockStore.set('terminal:session-1:worker-1', state);

      const result = await loadTerminalState('session-1', 'worker-1');

      expect(result).toEqual(state);
    });

    it('should return null for non-existent entry', async () => {
      const result = await loadTerminalState('non-existent', 'worker');

      expect(result).toBeNull();
    });

    it('should return null and delete expired entry', async () => {
      const expiredState = createValidState({
        savedAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      });
      mockStore.set('terminal:session-1:worker-1', expiredState);

      const result = await loadTerminalState('session-1', 'worker-1');

      expect(result).toBeNull();
      expect(mockStore.get('terminal:session-1:worker-1')).toBeUndefined();
    });

    it('should return state that is just under 24 hours old', async () => {
      const almostExpiredState = createValidState({
        savedAt: Date.now() - 23 * 60 * 60 * 1000, // 23 hours ago
      });
      mockStore.set('terminal:session-1:worker-1', almostExpiredState);

      const result = await loadTerminalState('session-1', 'worker-1');

      expect(result).toEqual(almostExpiredState);
    });

    it('should return null and delete malformed entry (missing data)', async () => {
      const malformed = {
        savedAt: Date.now(),
        cols: 80,
        rows: 24,
        offset: 0,
      };
      mockStore.set('terminal:session-1:worker-1', malformed);

      const result = await loadTerminalState('session-1', 'worker-1');

      expect(result).toBeNull();
      expect(mockStore.get('terminal:session-1:worker-1')).toBeUndefined();
    });

    it('should return null and delete entry missing offset (old format)', async () => {
      const oldFormat = {
        data: 'serialized-data',
        savedAt: Date.now(),
        cols: 80,
        rows: 24,
        // No offset field - old format
      };
      mockStore.set('terminal:session-1:worker-1', oldFormat);

      const result = await loadTerminalState('session-1', 'worker-1');

      expect(result).toBeNull();
      expect(mockStore.get('terminal:session-1:worker-1')).toBeUndefined();
    });

    it('should return null and delete malformed entry (wrong type)', async () => {
      mockStore.set('terminal:session-1:worker-1', 'not-an-object');

      const result = await loadTerminalState('session-1', 'worker-1');

      expect(result).toBeNull();
      expect(mockStore.get('terminal:session-1:worker-1')).toBeUndefined();
    });

    it('should return null and delete null entry', async () => {
      mockStore.set('terminal:session-1:worker-1', null);

      const result = await loadTerminalState('session-1', 'worker-1');

      expect(result).toBeNull();
      expect(mockStore.get('terminal:session-1:worker-1')).toBeUndefined();
    });

    it('should handle load errors gracefully', async () => {
      getMockThrows = true;
      const result = await loadTerminalState('session-1', 'worker-1');

      expect(result).toBeNull();
    });
  });

  describe('clearTerminalState', () => {
    it('should delete the correct key', async () => {
      const state = createValidState();
      mockStore.set('terminal:session-1:worker-1', state);

      await clearTerminalState('session-1', 'worker-1');

      expect(mockStore.get('terminal:session-1:worker-1')).toBeUndefined();
    });

    it('should handle delete errors gracefully', async () => {
      delMockThrows = true;
      // Should not throw
      await expect(clearTerminalState('session-1', 'worker-1')).resolves.toBeUndefined();
    });
  });

  describe('cleanupOldStates', () => {
    it('should delete expired entries', async () => {
      const expiredState = createValidState({
        savedAt: Date.now() - 25 * 60 * 60 * 1000,
      });
      const validState = createValidState();

      mockStore.set('terminal:session-1:worker-1', expiredState);
      mockStore.set('terminal:session-2:worker-2', validState);
      mockStore.set('other-key', { foo: 'bar' }); // Non-terminal key

      await cleanupOldStates();

      // Expired entry should be deleted
      expect(mockStore.get('terminal:session-1:worker-1')).toBeUndefined();
      // Valid entry should remain
      expect(mockStore.get('terminal:session-2:worker-2')).toEqual(validState);
      // Non-terminal key should be untouched
      expect(mockStore.get('other-key')).toEqual({ foo: 'bar' });
    });

    it('should delete malformed entries', async () => {
      mockStore.set('terminal:session-1:worker-1', 'invalid');
      mockStore.set('terminal:session-2:worker-2', { wrong: 'structure' });

      await cleanupOldStates();

      expect(mockStore.get('terminal:session-1:worker-1')).toBeUndefined();
      expect(mockStore.get('terminal:session-2:worker-2')).toBeUndefined();
    });

    it('should handle keys() error gracefully', async () => {
      keysMockThrows = true;
      // Should not throw
      await expect(cleanupOldStates()).resolves.toBeUndefined();
    });

    it('should handle empty store', async () => {
      await cleanupOldStates();

      // Should complete without error
      expect(mockStore.keys().length).toBe(0);
    });
  });

  describe('isValidForServer', () => {
    it('should return true when server ID is not provided', () => {
      const state = createValidState();

      expect(isValidForServer(state, undefined)).toBe(true);
    });

    it('should return false when cached state has no serverId', () => {
      const state = createValidState(); // No serverId

      expect(isValidForServer(state, 'server-123')).toBe(false);
    });

    it('should return true when server IDs match', () => {
      const state = createValidState({ serverId: 'server-123' });

      expect(isValidForServer(state, 'server-123')).toBe(true);
    });

    it('should return false when server IDs do not match', () => {
      const state = createValidState({ serverId: 'server-123' });

      expect(isValidForServer(state, 'server-456')).toBe(false);
    });
  });

  describe('key format', () => {
    it('should handle session and worker IDs with special characters', async () => {
      const state = createValidState();
      await saveTerminalState('session-with-dashes', 'worker_with_underscores', state);

      expect(mockStore.get('terminal:session-with-dashes:worker_with_underscores')).toEqual(state);
    });

    it('should handle UUID-like IDs', async () => {
      const state = createValidState();
      const sessionId = '550e8400-e29b-41d4-a716-446655440000';
      const workerId = 'a3bb189e-8bf9-3888-9912-ace4e6543002';

      await saveTerminalState(sessionId, workerId, state);

      expect(mockStore.get(`terminal:${sessionId}:${workerId}`)).toEqual(state);
    });
  });

  describe('serverId validation in type guard', () => {
    it('should accept state with valid string serverId', async () => {
      const stateWithServerId = {
        data: 'test',
        savedAt: Date.now(),
        cols: 80,
        rows: 24,
        offset: 0,
        serverId: 'server-123',
      };
      mockStore.set('terminal:session-1:worker-1', stateWithServerId);

      const result = await loadTerminalState('session-1', 'worker-1');

      expect(result).toEqual(stateWithServerId);
    });

    it('should reject state with invalid serverId type', async () => {
      const stateWithInvalidServerId = {
        data: 'test',
        savedAt: Date.now(),
        cols: 80,
        rows: 24,
        offset: 0,
        serverId: 12345, // number instead of string
      };
      mockStore.set('terminal:session-1:worker-1', stateWithInvalidServerId);

      const result = await loadTerminalState('session-1', 'worker-1');

      expect(result).toBeNull();
    });
  });
});
