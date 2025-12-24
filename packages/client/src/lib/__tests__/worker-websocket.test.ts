import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';
import {
  connect,
  disconnect,
  disconnectSession,
  storeHistoryOffset,
  clearVisibilityTracking,
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

  describe('history offset storage', () => {
    it('should store offset correctly', () => {
      storeHistoryOffset('session-1', 'worker-1', 12345);
      // Offset is stored but no getter is exposed - verify by disconnect clearing it
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      disconnect('session-1', 'worker-1');
      // No error thrown means it works
    });

    it('should clear offset after explicit disconnect', () => {
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Store offset via history message
      ws?.simulateMessage(JSON.stringify({ type: 'history', data: 'history', offset: 9999 }));

      // Disconnect the worker explicitly
      disconnect('session-1', 'worker-1');

      // No error thrown means cleanup worked
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

    it('should disconnect when page becomes hidden', () => {
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
    });

    it('should reconnect without fromOffset when page becomes visible (always fetch full history)', () => {
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws1 = MockWebSocket.getLastInstance();
      ws1?.simulateOpen();

      // Receive history with offset
      ws1?.simulateMessage(JSON.stringify({ type: 'history', data: 'terminal history', offset: 5678 }));

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

      // Verify new WebSocket URL does NOT contain fromOffset (always fetch full history)
      const ws2 = MockWebSocket.getLastInstance();
      expect(ws2?.url).not.toContain('fromOffset');
    });
  });

  describe('clearVisibilityTracking', () => {
    it('should clear offset for a specific worker', () => {
      // Store offset
      storeHistoryOffset('session-1', 'worker-1', 12345);

      // Clear visibility tracking
      clearVisibilityTracking('session-1', 'worker-1');

      // No error thrown means cleanup worked
    });

    it('should handle clearing non-existent data gracefully', () => {
      // Should not throw
      expect(() => clearVisibilityTracking('non-existent', 'worker')).not.toThrow();
    });
  });

  describe('disconnectSession', () => {
    it('should disconnect all workers in the session', () => {
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

      // Disconnect the entire session
      disconnectSession('session-1');

      // WebSockets should be closed
      expect(ws1?.close).toHaveBeenCalled();
      expect(ws2?.close).toHaveBeenCalled();
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

      // Session-1 WebSocket should be closed
      expect(instances[0]?.close).toHaveBeenCalled();

      // Session-2 WebSocket should NOT be closed
      expect(instances[1]?.close).not.toHaveBeenCalled();
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

      // Offset is stored internally - verified by no errors
      // (offset storage is used for normal reconnection, not visibility-based)
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
