import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { CachedState } from '../terminal-state-cache';
import {
  register,
  unregister,
  markDirty,
  flush,
  hasPendingSaves,
  getRegistrySize,
  clearRegistry,
  setIdleSaveDelay,
  resetIdleSaveDelay,
  getIdleSaveDelay,
  setSaveFunction,
  resetSaveFunction,
  setTruncationCheckFunction,
  resetTruncationCheckFunction,
  DEFAULT_IDLE_SAVE_DELAY_MS,
} from '../terminal-state-save-manager';

// Track saveTerminalState calls
const saveTerminalStateCalls: Array<{
  sessionId: string;
  workerId: string;
  state: CachedState;
}> = [];

// Mock save function for testing
const mockSaveTerminalState = async (
  sessionId: string,
  workerId: string,
  state: CachedState
): Promise<void> => {
  saveTerminalStateCalls.push({ sessionId, workerId, state });
};

// Use a short delay for testing (50ms)
const TEST_IDLE_DELAY_MS = 50;

describe('terminal-state-save-manager', () => {
  beforeEach(() => {
    clearRegistry();
    saveTerminalStateCalls.length = 0;
    setIdleSaveDelay(TEST_IDLE_DELAY_MS);
    setSaveFunction(mockSaveTerminalState);
  });

  afterEach(() => {
    clearRegistry();
    saveTerminalStateCalls.length = 0;
    resetIdleSaveDelay();
    resetSaveFunction();
    // Reset truncation-check unconditionally so an assertion failure in a
    // test that overrode it does not leak the forced-true behavior into
    // subsequent tests.
    resetTruncationCheckFunction();
  });

  const createValidState = (
    overrides: Partial<CachedState> = {}
  ): CachedState => ({
    data: 'serialized-terminal-data',
    savedAt: Date.now(),
    cols: 80,
    rows: 24,
    offset: 1234,
    ...overrides,
  });

  describe('register and unregister', () => {
    it('should register a worker', () => {
      const getState = () => createValidState();

      register('session-1', 'worker-1', getState);

      expect(getRegistrySize()).toBe(1);
    });

    it('should unregister a worker', async () => {
      const getState = () => createValidState();
      register('session-1', 'worker-1', getState);

      await unregister('session-1', 'worker-1');

      expect(getRegistrySize()).toBe(0);
    });

    it('should handle unregister for non-existent worker', async () => {
      // Should not throw
      await unregister('non-existent', 'worker');
      expect(getRegistrySize()).toBe(0);
    });

    it('should replace existing registration', () => {
      const getState1 = () => createValidState({ data: 'state-1' });
      const getState2 = () => createValidState({ data: 'state-2' });

      register('session-1', 'worker-1', getState1);
      register('session-1', 'worker-1', getState2);

      expect(getRegistrySize()).toBe(1);
    });
  });

  describe('markDirty', () => {
    it('should mark worker as dirty', () => {
      const getState = () => createValidState();
      register('session-1', 'worker-1', getState);

      markDirty('session-1', 'worker-1');

      expect(hasPendingSaves()).toBe(true);
    });

    it('should do nothing for non-existent worker', () => {
      markDirty('non-existent', 'worker');

      expect(hasPendingSaves()).toBe(false);
    });

    it('should save after idle timeout', async () => {
      const state = createValidState();
      const getState = () => state;
      register('session-1', 'worker-1', getState);

      markDirty('session-1', 'worker-1');

      // Wait for idle timeout plus a small buffer
      await new Promise((resolve) =>
        setTimeout(resolve, TEST_IDLE_DELAY_MS + 50)
      );

      expect(saveTerminalStateCalls.length).toBe(1);
      expect(saveTerminalStateCalls[0]).toEqual({
        sessionId: 'session-1',
        workerId: 'worker-1',
        state,
      });
    });

    it('should reset idle timer on subsequent markDirty calls', async () => {
      const state = createValidState();
      const getState = () => state;
      register('session-1', 'worker-1', getState);

      // Mark dirty and wait half the timeout
      markDirty('session-1', 'worker-1');
      await new Promise((resolve) =>
        setTimeout(resolve, TEST_IDLE_DELAY_MS / 2)
      );

      // Mark dirty again - should reset the timer
      markDirty('session-1', 'worker-1');
      await new Promise((resolve) =>
        setTimeout(resolve, TEST_IDLE_DELAY_MS / 2)
      );

      // Should not have saved yet (timer was reset)
      expect(saveTerminalStateCalls.length).toBe(0);

      // Wait for the rest of the timeout
      await new Promise((resolve) =>
        setTimeout(resolve, TEST_IDLE_DELAY_MS / 2 + 50)
      );

      // Now it should have saved
      expect(saveTerminalStateCalls.length).toBe(1);
    });

    it('should not save if getState returns null', async () => {
      const getState = () => null;
      register('session-1', 'worker-1', getState);

      markDirty('session-1', 'worker-1');

      // Wait for idle timeout
      await new Promise((resolve) =>
        setTimeout(resolve, TEST_IDLE_DELAY_MS + 50)
      );

      expect(saveTerminalStateCalls.length).toBe(0);
      expect(hasPendingSaves()).toBe(false);
    });
  });

  describe('unregister saves dirty state', () => {
    it('should save dirty state on unregister', async () => {
      const state = createValidState();
      const getState = () => state;
      register('session-1', 'worker-1', getState);
      markDirty('session-1', 'worker-1');

      await unregister('session-1', 'worker-1');

      expect(saveTerminalStateCalls.length).toBe(1);
      expect(saveTerminalStateCalls[0]).toEqual({
        sessionId: 'session-1',
        workerId: 'worker-1',
        state,
      });
    });

    it('should not save clean state on unregister', async () => {
      const state = createValidState();
      const getState = () => state;
      register('session-1', 'worker-1', getState);

      await unregister('session-1', 'worker-1');

      expect(saveTerminalStateCalls.length).toBe(0);
    });

    it('should clear idle timeout on unregister', async () => {
      const state = createValidState();
      const getState = () => state;
      register('session-1', 'worker-1', getState);
      markDirty('session-1', 'worker-1');

      await unregister('session-1', 'worker-1');

      // Wait for what would have been the idle timeout
      await new Promise((resolve) =>
        setTimeout(resolve, TEST_IDLE_DELAY_MS + 50)
      );

      // Should only have saved once (on unregister, not on idle timeout)
      expect(saveTerminalStateCalls.length).toBe(1);
    });
  });

  describe('flush', () => {
    it('should save all dirty workers', async () => {
      const state1 = createValidState({ data: 'state-1' });
      const state2 = createValidState({ data: 'state-2' });
      register('session-1', 'worker-1', () => state1);
      register('session-2', 'worker-2', () => state2);

      markDirty('session-1', 'worker-1');
      markDirty('session-2', 'worker-2');

      await flush();

      expect(saveTerminalStateCalls.length).toBe(2);
      expect(saveTerminalStateCalls).toContainEqual({
        sessionId: 'session-1',
        workerId: 'worker-1',
        state: state1,
      });
      expect(saveTerminalStateCalls).toContainEqual({
        sessionId: 'session-2',
        workerId: 'worker-2',
        state: state2,
      });
    });

    it('should not save clean workers', async () => {
      const state1 = createValidState({ data: 'state-1' });
      const state2 = createValidState({ data: 'state-2' });
      register('session-1', 'worker-1', () => state1);
      register('session-2', 'worker-2', () => state2);

      // Only mark worker-1 as dirty
      markDirty('session-1', 'worker-1');

      await flush();

      expect(saveTerminalStateCalls.length).toBe(1);
      expect(saveTerminalStateCalls[0]).toEqual({
        sessionId: 'session-1',
        workerId: 'worker-1',
        state: state1,
      });
    });

    it('should clear idle timeouts after flush', async () => {
      const state = createValidState();
      register('session-1', 'worker-1', () => state);
      markDirty('session-1', 'worker-1');

      await flush();

      // Wait for what would have been the idle timeout
      await new Promise((resolve) =>
        setTimeout(resolve, TEST_IDLE_DELAY_MS + 50)
      );

      // Should only have saved once (on flush, not on idle timeout)
      expect(saveTerminalStateCalls.length).toBe(1);
    });

    it('should handle empty registry', async () => {
      await flush();

      expect(saveTerminalStateCalls.length).toBe(0);
    });

    it('should skip workers where getState returns null', async () => {
      const state = createValidState();
      register('session-1', 'worker-1', () => null);
      register('session-2', 'worker-2', () => state);

      markDirty('session-1', 'worker-1');
      markDirty('session-2', 'worker-2');

      await flush();

      expect(saveTerminalStateCalls.length).toBe(1);
      expect(saveTerminalStateCalls[0]).toEqual({
        sessionId: 'session-2',
        workerId: 'worker-2',
        state,
      });
    });
  });

  describe('hasPendingSaves', () => {
    it('should return false when registry is empty', () => {
      expect(hasPendingSaves()).toBe(false);
    });

    it('should return false when no workers are dirty', () => {
      register('session-1', 'worker-1', () => createValidState());
      register('session-2', 'worker-2', () => createValidState());

      expect(hasPendingSaves()).toBe(false);
    });

    it('should return true when a worker is dirty', () => {
      register('session-1', 'worker-1', () => createValidState());
      markDirty('session-1', 'worker-1');

      expect(hasPendingSaves()).toBe(true);
    });

    it('should return false after flush', async () => {
      register('session-1', 'worker-1', () => createValidState());
      markDirty('session-1', 'worker-1');

      await flush();

      expect(hasPendingSaves()).toBe(false);
    });

    it('should return false after idle save completes', async () => {
      register('session-1', 'worker-1', () => createValidState());
      markDirty('session-1', 'worker-1');

      // Wait for idle timeout
      await new Promise((resolve) =>
        setTimeout(resolve, TEST_IDLE_DELAY_MS + 50)
      );

      expect(hasPendingSaves()).toBe(false);
    });
  });

  describe('clearRegistry', () => {
    it('should clear all registrations', () => {
      register('session-1', 'worker-1', () => createValidState());
      register('session-2', 'worker-2', () => createValidState());

      clearRegistry();

      expect(getRegistrySize()).toBe(0);
    });

    it('should clear pending timeouts', async () => {
      register('session-1', 'worker-1', () => createValidState());
      markDirty('session-1', 'worker-1');

      clearRegistry();

      // Wait for what would have been the idle timeout
      await new Promise((resolve) =>
        setTimeout(resolve, TEST_IDLE_DELAY_MS + 50)
      );

      // Should not have saved (registry was cleared)
      expect(saveTerminalStateCalls.length).toBe(0);
    });
  });

  describe('unregister race with concurrent re-register', () => {
    // These tests reproduce the following race:
    // 1. Terminal A unmounts -> React cleanup fires `unregister(...)` fire-and-forget.
    // 2. Inside unregister, execution suspends on `await workerState.pendingSave`.
    // 3. A new Terminal (same sessionId:workerId, e.g. a fast tab switch back)
    //    mounts and calls `register(...)`, which OVERWRITES the registry slot.
    // 4. Suspended unregister resumes and unconditionally calls
    //    `registry.delete(key)`, wiping the newly-registered entry.
    // 5. On the next unmount, `unregister` sees no entry and the second
    //    Terminal's cache save is silently lost.
    //
    // The fix guards `registry.delete(key)` with an object-identity check
    // (`registry.get(key) === workerState`) so an in-flight unregister for
    // a stale entry never touches a replacement entry.

    it('should not delete a re-registered entry after the in-flight save completes', async () => {
      let resolveSlowSave: (() => void) | null = null;
      const slowSavePromise = new Promise<void>((resolve) => {
        resolveSlowSave = resolve;
      });
      setSaveFunction(async (sessionId, workerId, state) => {
        saveTerminalStateCalls.push({ sessionId, workerId, state });
        await slowSavePromise;
      });

      const stateA = createValidState({ data: 'state-A' });
      const stateB = createValidState({ data: 'state-B' });

      // Mount A: register + markDirty. Wait for the idle timer to fire so the
      // executeIdleSave path assigns `workerState.pendingSave` to the slow save.
      register('session-1', 'worker-1', () => stateA);
      markDirty('session-1', 'worker-1');
      await new Promise((resolve) =>
        setTimeout(resolve, TEST_IDLE_DELAY_MS + 20)
      );
      expect(saveTerminalStateCalls.length).toBe(1);

      // Fire-and-forget unregister — suspends on `await workerState.pendingSave`.
      const unregisterPromise = unregister('session-1', 'worker-1');
      // Yield a microtask so unregister enters the await state.
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Concurrent re-register (simulating a fast Terminal re-mount).
      register('session-1', 'worker-1', () => stateB);
      expect(getRegistrySize()).toBe(1);

      // Release the slow save so the in-flight unregister resumes and runs its
      // trailing `registry.delete(key)`.
      resolveSlowSave!();
      await unregisterPromise;

      // With the fix: identity guard skips the delete because the entry was
      // replaced. Without the fix: entry B is deleted here.
      expect(getRegistrySize()).toBe(1);

      // Additionally, markDirty must still target entry B — proving the
      // surviving entry is entry B, not a resurrected entry A.
      markDirty('session-1', 'worker-1');
      expect(hasPendingSaves()).toBe(true);
    });

    it('should not delete a re-registered entry when unregister exits via truncation branch', async () => {
      let resolveSlowSave: (() => void) | null = null;
      const slowSavePromise = new Promise<void>((resolve) => {
        resolveSlowSave = resolve;
      });
      setSaveFunction(async (sessionId, workerId, state) => {
        saveTerminalStateCalls.push({ sessionId, workerId, state });
        await slowSavePromise;
      });

      const stateA = createValidState({ data: 'state-A' });
      const stateB = createValidState({ data: 'state-B' });

      register('session-1', 'worker-1', () => stateA);
      markDirty('session-1', 'worker-1');
      await new Promise((resolve) =>
        setTimeout(resolve, TEST_IDLE_DELAY_MS + 20)
      );

      const unregisterPromise = unregister('session-1', 'worker-1');
      await new Promise((resolve) => setTimeout(resolve, 10));

      register('session-1', 'worker-1', () => stateB);
      expect(getRegistrySize()).toBe(1);

      // Force the unregister to take the truncation branch when it resumes.
      // The truncation branch has its own `registry.delete(key)` at the top of
      // the else path — it must also be identity-guarded.
      setTruncationCheckFunction(() => true);

      resolveSlowSave!();
      await unregisterPromise;

      // With the fix: identity guard also protects the truncation-branch delete.
      // Without the fix: entry B is deleted from the truncation branch.
      expect(getRegistrySize()).toBe(1);
      // afterEach resets the truncation-check function; no need to reset here.
    });
  });

  describe('idle delay configuration', () => {
    it('should have default delay of 60 seconds', () => {
      resetIdleSaveDelay();
      expect(getIdleSaveDelay()).toBe(60_000);
      expect(DEFAULT_IDLE_SAVE_DELAY_MS).toBe(60_000);
    });

    it('should allow setting custom delay', () => {
      setIdleSaveDelay(100);
      expect(getIdleSaveDelay()).toBe(100);
    });

    it('should reset to default delay', () => {
      setIdleSaveDelay(100);
      resetIdleSaveDelay();
      expect(getIdleSaveDelay()).toBe(60_000);
    });
  });
});
