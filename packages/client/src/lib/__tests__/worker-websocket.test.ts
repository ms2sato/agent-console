import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';
import {
  connect,
  disconnectSession,
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

  // DISABLED: Visibility-based reconnection is currently disabled to avoid performance overhead.
  // The event listener registration in worker-websocket.ts is commented out.
  // These tests are skipped until the feature is re-enabled.
  describe.skip('visibility-based reconnection', () => {
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
    it('should call onHistory callback with data and offset', () => {
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Send history message with offset
      ws?.simulateMessage(JSON.stringify({ type: 'history', data: 'terminal history', offset: 5678 }));

      expect(callbacks.onHistory).toHaveBeenCalledWith('terminal history', 5678);
    });
  });

  describe('output message handling', () => {
    it('should call onOutput callback with data and offset', () => {
      const callbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Send output message with offset
      ws?.simulateMessage(JSON.stringify({ type: 'output', data: 'terminal output', offset: 1234 }));

      expect(callbacks.onOutput).toHaveBeenCalledWith('terminal output', 1234);
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
    it('should NOT send request-history automatically on WebSocket connection', async () => {
      // This test verifies that worker-websocket does NOT automatically send request-history.
      // History requests are now the responsibility of Terminal.tsx, which decides
      // the appropriate fromOffset based on cache state.
      const callbacks = createTerminalCallbacks();

      // Create a new connection
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      expect(ws).toBeDefined();

      // Simulate WebSocket connection opening
      ws?.simulateOpen();

      // Wait a bit to ensure no delayed request is sent
      await new Promise((resolve) => setTimeout(resolve, 300));

      // request-history should NOT be sent automatically
      const calls = ws?.send.mock.calls as unknown as unknown[][];
      const requestHistoryCalls = calls?.filter(
        (call) => {
          try {
            const msg = JSON.parse(call[0] as string);
            return msg.type === 'request-history';
          } catch {
            return false;
          }
        }
      );
      expect(requestHistoryCalls?.length ?? 0).toBe(0);
    });

    it('should NOT send request-history automatically on tab switch (remount with existing OPEN connection)', async () => {
      // This test verifies that connect() does NOT automatically send request-history
      // even when called with an existing OPEN connection (tab switch scenario).
      const callbacks = createTerminalCallbacks();

      // Create initial connection and establish it
      connect('session-1', 'worker-1', callbacks);
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Wait for initial setup
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Clear the mock to track subsequent calls
      ws?.send.mockClear();

      // Simulate tab switch: connect() is called again with the existing OPEN connection
      const newCallbacks = createTerminalCallbacks();
      connect('session-1', 'worker-1', newCallbacks);

      // Wait a bit to ensure no delayed request is sent
      await new Promise((resolve) => setTimeout(resolve, 300));

      // request-history should NOT be sent automatically
      const calls = ws?.send.mock.calls as unknown as unknown[][];
      const requestHistoryCalls = calls?.filter(
        (call) => {
          try {
            const msg = JSON.parse(call[0] as string);
            return msg.type === 'request-history';
          } catch {
            return false;
          }
        }
      );
      expect(requestHistoryCalls?.length ?? 0).toBe(0);
    });
  });
});
