import { describe, it, expect, mock, beforeEach, afterEach, spyOn, jest } from 'bun:test';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';
import {
  connect,
  disconnectSession,
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

      // Disconnect only session-1
      disconnectSession('session-1');

      // Session-1 WebSocket should be closed
      expect(instances[0]?.close).toHaveBeenCalled();

      // Session-2 WebSocket should NOT be closed
      expect(instances[1]?.close).not.toHaveBeenCalled();
    });
  });

  describe('history message handling', () => {
    it('should call onHistory callback', () => {
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Send history message
      ws?.simulateMessage(JSON.stringify({ type: 'history', data: 'terminal history' }));

      expect(callbacks.onHistory).toHaveBeenCalledWith('terminal history');
    });
  });

  describe('error message handling', () => {
    it('should call onError callback with HISTORY_LOAD_FAILED code', () => {
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Send error message with HISTORY_LOAD_FAILED code
      ws?.simulateMessage(JSON.stringify({
        type: 'error',
        message: 'Loading terminal history timed out. Try refreshing the page.',
        code: 'HISTORY_LOAD_FAILED'
      }));

      expect(callbacks.onError).toHaveBeenCalledWith(
        'Loading terminal history timed out. Try refreshing the page.',
        'HISTORY_LOAD_FAILED'
      );
    });

    it('should call onError callback without code when code is missing', () => {
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Send error message without code
      ws?.simulateMessage(JSON.stringify({
        type: 'error',
        message: 'Some error occurred'
      }));

      expect(callbacks.onError).toHaveBeenCalledWith(
        'Some error occurred',
        undefined
      );
    });

    it('should call onError callback with other error codes', () => {
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Send error message with WORKER_NOT_FOUND code
      ws?.simulateMessage(JSON.stringify({
        type: 'error',
        message: 'Worker not found',
        code: 'WORKER_NOT_FOUND'
      }));

      expect(callbacks.onError).toHaveBeenCalledWith(
        'Worker not found',
        'WORKER_NOT_FOUND'
      );
    });
  });

  describe('request-history message behavior', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should NOT send request-history on initial WebSocket connection', () => {
      // This test verifies that when a new WebSocket connection is established,
      // the client does NOT send request-history message.
      // The server automatically sends history on new connection, so client request is redundant.
      const callbacks = createTerminalCallbacks();

      // Create a new connection (no existing connection)
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      expect(ws).toBeDefined();

      // Simulate WebSocket connection opening
      ws?.simulateOpen();

      // Advance timers to process any debounced requests
      jest.advanceTimersByTime(200);

      // request-history should NOT be sent on initial connection
      // because the server automatically sends history when a client connects
      expect(ws?.send).not.toHaveBeenCalledWith(
        JSON.stringify({ type: 'request-history' })
      );
    });

    it('should send request-history on tab switch (remount with existing OPEN connection)', () => {
      // This test verifies that when a component remounts to an existing OPEN connection
      // (e.g., tab switch), the client sends request-history to refresh the terminal.
      const callbacks = createTerminalCallbacks();

      // Create initial connection and establish it
      connect('session-1', 'worker-1', callbacks);
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Clear the mock to track subsequent calls
      ws?.send.mockClear();

      // Advance past initial debounce (if any message was queued)
      jest.advanceTimersByTime(200);
      ws?.send.mockClear();

      // Simulate tab switch: connect() is called again with the existing OPEN connection
      const newCallbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', newCallbacks);

      // Advance timers to process debounced history request
      jest.advanceTimersByTime(200);

      // request-history SHOULD be sent on tab switch
      expect(ws?.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'request-history' })
      );
    });

    it('should debounce multiple rapid connect calls to prevent duplicate history requests', () => {
      // This test verifies that rapid connect() calls (e.g., React Strict Mode double render)
      // result in only one request-history message
      const callbacks = createTerminalCallbacks();

      // Create initial connection and establish it
      connect('session-1', 'worker-1', callbacks);
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Clear mock and advance past initial setup
      ws?.send.mockClear();
      jest.advanceTimersByTime(200);
      ws?.send.mockClear();

      // Simulate rapid connect() calls (like React Strict Mode)
      connect('session-1', 'worker-1', createTerminalCallbacks());
      connect('session-1', 'worker-1', createTerminalCallbacks());
      connect('session-1', 'worker-1', createTerminalCallbacks());

      // Advance timers to process debounced request
      jest.advanceTimersByTime(200);

      // Only one request-history should be sent (debounced)
      // Cast to unknown[] to access call arguments (mock typing limitation)
      const calls = ws?.send.mock.calls as unknown as unknown[][];
      const requestHistoryCalls = calls?.filter(
        (call) => call[0] === JSON.stringify({ type: 'request-history' })
      );
      expect(requestHistoryCalls?.length).toBe(1);
    });
  });
});
