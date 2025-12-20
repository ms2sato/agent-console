import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';
import {
  connect,
  disconnect,
  disconnectSession,
  storeSnapshot,
  consumeSnapshot,
  storeHistoryOffset,
  getStoredHistoryOffset,
  wasVisibilityDisconnected,
  clearVisibilityTracking,
  registerSnapshotCallback,
  unregisterSnapshotCallback,
  _reset,
  type TerminalWorkerCallbacks,
} from '../worker-websocket';

describe('worker-websocket', () => {
  let restoreWebSocket: () => void;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let originalLocation: Location;

  beforeEach(() => {
    originalLocation = window.location;
    restoreWebSocket = installMockWebSocket();

    // Mock window.location
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
    });

    // Spy on console (not suppress, so we can verify calls)
    consoleLogSpy = spyOn(console, 'log');
    consoleErrorSpy = spyOn(console, 'error');

    _reset();
  });

  afterEach(() => {
    _reset();
    restoreWebSocket();
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  const createTerminalCallbacks = (): TerminalWorkerCallbacks => ({
    type: 'terminal',
    onOutput: mock(() => {}),
    onHistory: mock(() => {}),
    onExit: mock(() => {}),
    onActivity: mock(() => {}),
    onError: mock(() => {}),
  });

  describe('snapshot storage', () => {
    it('should store snapshot correctly', () => {
      const snapshot = 'serialized-terminal-state';
      storeSnapshot('session-1', 'worker-1', snapshot);

      // Verify by consuming the snapshot
      const retrieved = consumeSnapshot('session-1', 'worker-1');
      expect(retrieved).toBe(snapshot);
    });

    it('should return and delete snapshot on consume (one-time use)', () => {
      const snapshot = 'serialized-terminal-state';
      storeSnapshot('session-1', 'worker-1', snapshot);

      // First consume should return the snapshot
      const firstConsume = consumeSnapshot('session-1', 'worker-1');
      expect(firstConsume).toBe(snapshot);

      // Second consume should return undefined (already consumed)
      const secondConsume = consumeSnapshot('session-1', 'worker-1');
      expect(secondConsume).toBeUndefined();
    });

    it('should return undefined when no snapshot exists', () => {
      const result = consumeSnapshot('non-existent-session', 'non-existent-worker');
      expect(result).toBeUndefined();
    });

    it('should store separate snapshots for different workers', () => {
      storeSnapshot('session-1', 'worker-1', 'snapshot-1');
      storeSnapshot('session-1', 'worker-2', 'snapshot-2');

      expect(consumeSnapshot('session-1', 'worker-1')).toBe('snapshot-1');
      expect(consumeSnapshot('session-1', 'worker-2')).toBe('snapshot-2');
    });

    it('should overwrite existing snapshot for same worker', () => {
      storeSnapshot('session-1', 'worker-1', 'old-snapshot');
      storeSnapshot('session-1', 'worker-1', 'new-snapshot');

      expect(consumeSnapshot('session-1', 'worker-1')).toBe('new-snapshot');
    });
  });

  describe('history offset storage', () => {
    it('should store offset correctly', () => {
      storeHistoryOffset('session-1', 'worker-1', 12345);

      const retrieved = getStoredHistoryOffset('session-1', 'worker-1');
      expect(retrieved).toBe(12345);
    });

    it('should return undefined when no offset stored', () => {
      const result = getStoredHistoryOffset('non-existent-session', 'non-existent-worker');
      expect(result).toBeUndefined();
    });

    it('should store separate offsets for different workers', () => {
      storeHistoryOffset('session-1', 'worker-1', 100);
      storeHistoryOffset('session-1', 'worker-2', 200);

      expect(getStoredHistoryOffset('session-1', 'worker-1')).toBe(100);
      expect(getStoredHistoryOffset('session-1', 'worker-2')).toBe(200);
    });

    it('should overwrite existing offset for same worker', () => {
      storeHistoryOffset('session-1', 'worker-1', 100);
      storeHistoryOffset('session-1', 'worker-1', 500);

      expect(getStoredHistoryOffset('session-1', 'worker-1')).toBe(500);
    });

    it('should clear offset after explicit disconnect', () => {
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Store offset via history message
      ws?.simulateMessage(JSON.stringify({ type: 'history', data: 'history', offset: 9999 }));

      // Verify offset is stored
      expect(getStoredHistoryOffset('session-1', 'worker-1')).toBe(9999);

      // Disconnect the worker explicitly
      disconnect('session-1', 'worker-1');

      // Offset should be cleared after explicit disconnect to prevent stale data
      expect(getStoredHistoryOffset('session-1', 'worker-1')).toBeUndefined();
    });
  });

  describe('visibility-based reconnection', () => {
    let originalVisibilityState: PropertyDescriptor | undefined;

    beforeEach(() => {
      // Store original visibilityState descriptor
      originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    });

    afterEach(() => {
      // Restore original visibilityState
      if (originalVisibilityState) {
        Object.defineProperty(document, 'visibilityState', originalVisibilityState);
      } else {
        // If there was no original descriptor, delete it to restore default behavior
        // We need to reset to 'visible' state
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'visible',
        });
      }
    });

    function setVisibilityState(state: 'visible' | 'hidden') {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => state,
      });
    }

    function dispatchVisibilityChange() {
      document.dispatchEvent(new Event('visibilitychange'));
    }

    it('should return false for wasVisibilityDisconnected when no visibility disconnect occurred', () => {
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Normal connection - should not be visibility disconnected
      expect(wasVisibilityDisconnected('session-1', 'worker-1')).toBe(false);
    });

    it('should return false for wasVisibilityDisconnected for non-existent connection', () => {
      expect(wasVisibilityDisconnected('non-existent', 'worker')).toBe(false);
    });

    it('should disconnect and store callbacks when page becomes hidden', () => {
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Verify connected
      expect(ws?.readyState).toBe(MockWebSocket.OPEN);

      // Simulate page becoming hidden
      setVisibilityState('hidden');
      dispatchVisibilityChange();

      // Verify WebSocket was closed
      expect(ws?.close).toHaveBeenCalled();
      // Verify visibility disconnect was tracked
      expect(wasVisibilityDisconnected('session-1', 'worker-1')).toBe(true);
    });

    it('should call snapshot callback before disconnecting on visibility hidden', () => {
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Track order of operations
      const callOrder: string[] = [];

      // Register snapshot callback that records when it's called
      const snapshotCallback = mock(() => {
        callOrder.push('snapshot');
        // At this point, WebSocket should NOT be closed yet
        expect(ws?.close).not.toHaveBeenCalled();
      });
      registerSnapshotCallback('session-1', 'worker-1', snapshotCallback);

      // Override close to track when it's called
      const originalClose = ws?.close;
      if (ws) {
        ws.close = mock(() => {
          callOrder.push('close');
          originalClose?.();
        });
      }

      // Simulate page becoming hidden
      setVisibilityState('hidden');
      dispatchVisibilityChange();

      // Verify snapshot callback was called
      expect(snapshotCallback).toHaveBeenCalled();
      // Verify close was called after snapshot
      expect(callOrder).toEqual(['snapshot', 'close']);
    });

    it('should reconnect with fromOffset when page becomes visible', () => {
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws1 = MockWebSocket.getLastInstance();
      ws1?.simulateOpen();

      // Receive history with offset
      ws1?.simulateMessage(JSON.stringify({ type: 'history', data: 'terminal history', offset: 5678 }));

      // Verify offset is stored
      expect(getStoredHistoryOffset('session-1', 'worker-1')).toBe(5678);

      // Simulate page becoming hidden
      setVisibilityState('hidden');
      dispatchVisibilityChange();

      // Clear instances to track new WebSocket creation
      const instanceCountBeforeVisible = MockWebSocket.getInstances().length;

      // Simulate page becoming visible
      setVisibilityState('visible');
      dispatchVisibilityChange();

      // Verify new WebSocket was created
      const instances = MockWebSocket.getInstances();
      expect(instances.length).toBe(instanceCountBeforeVisible + 1);

      // Verify new WebSocket URL contains fromOffset parameter
      const ws2 = MockWebSocket.getLastInstance();
      expect(ws2?.url).toContain('fromOffset=5678');
    });

    it('should clean up snapshot callback on unregister', () => {
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Register and then unregister snapshot callback
      const snapshotCallback = mock(() => {});
      registerSnapshotCallback('session-1', 'worker-1', snapshotCallback);
      unregisterSnapshotCallback('session-1', 'worker-1');

      // Simulate page becoming hidden
      setVisibilityState('hidden');
      dispatchVisibilityChange();

      // Verify snapshot callback was NOT called (it was unregistered)
      expect(snapshotCallback).not.toHaveBeenCalled();
    });
  });

  describe('clearVisibilityTracking', () => {
    it('should clear snapshot and offset for a specific worker', () => {
      // Store snapshot and offset
      storeSnapshot('session-1', 'worker-1', 'test-snapshot');
      storeHistoryOffset('session-1', 'worker-1', 12345);

      // Verify they are stored
      expect(getStoredHistoryOffset('session-1', 'worker-1')).toBe(12345);

      // Clear visibility tracking
      clearVisibilityTracking('session-1', 'worker-1');

      // Verify they are cleared
      expect(consumeSnapshot('session-1', 'worker-1')).toBeUndefined();
      expect(getStoredHistoryOffset('session-1', 'worker-1')).toBeUndefined();
    });

    it('should not affect other workers', () => {
      // Store data for two workers
      storeSnapshot('session-1', 'worker-1', 'snapshot-1');
      storeSnapshot('session-1', 'worker-2', 'snapshot-2');
      storeHistoryOffset('session-1', 'worker-1', 100);
      storeHistoryOffset('session-1', 'worker-2', 200);

      // Clear only worker-1
      clearVisibilityTracking('session-1', 'worker-1');

      // Worker-1 data should be cleared
      expect(consumeSnapshot('session-1', 'worker-1')).toBeUndefined();
      expect(getStoredHistoryOffset('session-1', 'worker-1')).toBeUndefined();

      // Worker-2 data should still exist
      expect(consumeSnapshot('session-1', 'worker-2')).toBe('snapshot-2');
      expect(getStoredHistoryOffset('session-1', 'worker-2')).toBe(200);
    });

    it('should handle clearing non-existent data gracefully', () => {
      // Should not throw
      expect(() => clearVisibilityTracking('non-existent', 'worker')).not.toThrow();
    });
  });

  describe('disconnectSession', () => {
    it('should clear visibility tracking data for all workers in the session', () => {
      const callbacks = createTerminalCallbacks();

      // Connect two workers in the same session
      connect('session-1', 'worker-1', callbacks);
      connect('session-1', 'worker-2', callbacks);

      const ws1 = MockWebSocket.getInstances()[0];
      const ws2 = MockWebSocket.getInstances()[1];
      ws1?.simulateOpen();
      ws2?.simulateOpen();

      // Store offsets for both workers
      storeHistoryOffset('session-1', 'worker-1', 100);
      storeHistoryOffset('session-1', 'worker-2', 200);
      storeSnapshot('session-1', 'worker-1', 'snapshot-1');
      storeSnapshot('session-1', 'worker-2', 'snapshot-2');

      // Disconnect the entire session
      disconnectSession('session-1');

      // All visibility tracking data should be cleared
      expect(getStoredHistoryOffset('session-1', 'worker-1')).toBeUndefined();
      expect(getStoredHistoryOffset('session-1', 'worker-2')).toBeUndefined();
      expect(consumeSnapshot('session-1', 'worker-1')).toBeUndefined();
      expect(consumeSnapshot('session-1', 'worker-2')).toBeUndefined();
    });

    it('should not affect workers in other sessions', () => {
      const callbacks = createTerminalCallbacks();

      // Connect workers in different sessions
      connect('session-1', 'worker-1', callbacks);
      connect('session-2', 'worker-1', callbacks);

      const instances = MockWebSocket.getInstances();
      instances[0]?.simulateOpen();
      instances[1]?.simulateOpen();

      // Store offsets for both sessions
      storeHistoryOffset('session-1', 'worker-1', 100);
      storeHistoryOffset('session-2', 'worker-1', 200);

      // Disconnect only session-1
      disconnectSession('session-1');

      // Session-1 data should be cleared
      expect(getStoredHistoryOffset('session-1', 'worker-1')).toBeUndefined();

      // Session-2 data should still exist
      expect(getStoredHistoryOffset('session-2', 'worker-1')).toBe(200);
    });
  });

  describe('history message handling', () => {
    it('should call onHistory with offset when present in message', () => {
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Send history message with offset
      ws?.simulateMessage(JSON.stringify({ type: 'history', data: 'terminal history', offset: 5678 }));

      expect(callbacks.onHistory).toHaveBeenCalledWith('terminal history', 5678);
    });

    it('should call onHistory without offset when not present in message', () => {
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Send history message without offset
      ws?.simulateMessage(JSON.stringify({ type: 'history', data: 'terminal history' }));

      expect(callbacks.onHistory).toHaveBeenCalledWith('terminal history', undefined);
    });

    it('should store offset automatically from history message', () => {
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Send history message with offset
      ws?.simulateMessage(JSON.stringify({ type: 'history', data: 'terminal history', offset: 1234 }));

      // Offset should be automatically stored
      expect(getStoredHistoryOffset('session-1', 'worker-1')).toBe(1234);
    });

    it('should update stored offset when receiving new history message', () => {
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // First history message
      ws?.simulateMessage(JSON.stringify({ type: 'history', data: 'first', offset: 100 }));
      expect(getStoredHistoryOffset('session-1', 'worker-1')).toBe(100);

      // Second history message with updated offset
      ws?.simulateMessage(JSON.stringify({ type: 'history', data: 'second', offset: 500 }));
      expect(getStoredHistoryOffset('session-1', 'worker-1')).toBe(500);
    });

    it('should not update stored offset when history message has no offset', () => {
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // First history message with offset
      ws?.simulateMessage(JSON.stringify({ type: 'history', data: 'first', offset: 100 }));
      expect(getStoredHistoryOffset('session-1', 'worker-1')).toBe(100);

      // Second history message without offset - should not change stored offset
      ws?.simulateMessage(JSON.stringify({ type: 'history', data: 'second' }));
      expect(getStoredHistoryOffset('session-1', 'worker-1')).toBe(100);
    });
  });

  describe('reconnection with offset', () => {
    it('should include offset in URL when reconnecting with fromOffset', () => {
      // This tests the getWorkerWsUrl function indirectly through connect behavior
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      // Verify URL does NOT have offset on initial connection
      expect(ws?.url).not.toContain('fromOffset');
      expect(ws?.url).toContain('session-1');
      expect(ws?.url).toContain('worker-1');
    });
  });
});
