import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';
import {
  connect,
  disconnect,
  subscribe,
  subscribeConnection,
  isConnected,
  _reset,
} from '../app-websocket';

describe('app-websocket', () => {
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

  describe('connect', () => {
    it('should create WebSocket with correct URL for HTTP', () => {
      connect();

      const ws = MockWebSocket.getLastInstance();
      expect(ws).toBeDefined();
      expect(ws?.url).toBe('ws://localhost:3000/ws/app');
    });

    it('should create WebSocket with wss:// for HTTPS', () => {
      Object.defineProperty(window, 'location', {
        value: { protocol: 'https:', host: 'example.com' },
        writable: true,
      });

      connect();

      const ws = MockWebSocket.getLastInstance();
      expect(ws?.url).toBe('wss://example.com/ws/app');
    });

    it('should not create duplicate connections when already connecting', () => {
      connect();
      connect();
      connect();

      expect(MockWebSocket.getInstances().length).toBe(1);
    });

    it('should not create duplicate connections when already connected', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      connect();
      connect();

      expect(MockWebSocket.getInstances().length).toBe(1);
    });

    it('should abandon CLOSING socket and create new one', () => {
      connect();
      const ws1 = MockWebSocket.getLastInstance();
      ws1!.readyState = MockWebSocket.CLOSING;

      connect();

      expect(MockWebSocket.getInstances().length).toBe(2);
    });

    it('should reset retry count on successful connection', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      expect(isConnected()).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('should close WebSocket with code 1000', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      disconnect();

      expect(ws?.close).toHaveBeenCalledWith(1000);
    });

    it('should not call close on already CLOSED socket', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws!.readyState = MockWebSocket.CLOSED;

      disconnect();

      expect(ws?.close).not.toHaveBeenCalled();
    });

    it('should not call close on CLOSING socket', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws!.readyState = MockWebSocket.CLOSING;

      disconnect();

      expect(ws?.close).not.toHaveBeenCalled();
    });

    it('should set connected to false', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      expect(isConnected()).toBe(true);

      disconnect();

      expect(isConnected()).toBe(false);
    });
  });

  describe('connection state', () => {
    it('should notify listeners on connection', () => {
      const listener = mock(() => {});
      subscribeConnection(listener);

      // Called immediately with current state (false)
      expect(listener).toHaveBeenCalledWith(false);

      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      expect(listener).toHaveBeenCalledWith(true);
    });

    it('should notify listeners on disconnection', () => {
      const listener = mock(() => {});

      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      subscribeConnection(listener);
      expect(listener).toHaveBeenCalledWith(true);

      ws?.simulateClose(1006);

      expect(listener).toHaveBeenCalledWith(false);
    });

    it('should unsubscribe connection listener', () => {
      const listener = mock(() => {});
      const unsubscribe = subscribeConnection(listener);

      unsubscribe();
      listener.mockClear();

      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('message handling', () => {
    it('should notify subscribers of valid messages', () => {
      const listener = mock(() => {});
      subscribe(listener);

      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({
        type: 'sessions-sync',
        sessions: [],
        activityStates: [],
      }));

      expect(listener).toHaveBeenCalledWith({
        type: 'sessions-sync',
        sessions: [],
        activityStates: [],
      });
    });

    it('should reject invalid message types', () => {
      const listener = mock(() => {});
      subscribe(listener);

      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({ type: 'invalid-type' }));

      expect(listener).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should reject non-object messages', () => {
      const listener = mock(() => {});
      subscribe(listener);

      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify('just a string'));

      expect(listener).not.toHaveBeenCalled();
    });

    it('should reject null messages', () => {
      const listener = mock(() => {});
      subscribe(listener);

      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify(null));

      expect(listener).not.toHaveBeenCalled();
    });

    it('should handle invalid JSON gracefully', () => {
      const listener = mock(() => {});
      subscribe(listener);

      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateMessage('not json');

      expect(listener).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should unsubscribe message listener', () => {
      const listener = mock(() => {});
      const unsubscribe = subscribe(listener);

      unsubscribe();

      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({
        type: 'sessions-sync',
        sessions: [],
        activityStates: [],
      }));

      expect(listener).not.toHaveBeenCalled();
    });

    it('should validate all DASHBOARD_MESSAGE_TYPES', () => {
      const listener = mock(() => {});
      subscribe(listener);

      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Test all valid message types
      const validTypes = [
        { type: 'sessions-sync', sessions: [], activityStates: [] },
        { type: 'session-created', session: {} },
        { type: 'session-updated', session: {} },
        { type: 'session-deleted', sessionId: 'test' },
        { type: 'worker-activity', sessionId: 'test', workerId: 'test', activityState: 'active' },
      ];

      for (const msg of validTypes) {
        ws?.simulateMessage(JSON.stringify(msg));
      }

      expect(listener).toHaveBeenCalledTimes(5);
    });
  });

  describe('close code handling', () => {
    // Helper to check if any log call contains a substring
    function wasLoggedWith(spy: ReturnType<typeof spyOn>, substring: string): boolean {
      return spy.mock.calls.some((call: unknown[]) =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes(substring))
      );
    }

    it('should not reconnect on code 1000 (Normal closure)', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateClose(1000);

      // Verify "not reconnecting" message was logged
      expect(wasLoggedWith(consoleLogSpy, 'not reconnecting')).toBe(true);
    });

    it('should not reconnect on code 1001 (Going away)', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateClose(1001);

      expect(wasLoggedWith(consoleLogSpy, 'not reconnecting')).toBe(true);
    });

    it('should not reconnect on code 1008 (Policy violation)', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateClose(1008);

      expect(wasLoggedWith(consoleLogSpy, 'not reconnecting')).toBe(true);
    });

    it('should schedule reconnection on code 1006 (Abnormal closure)', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateClose(1006);

      // Should log reconnection attempt, not "not reconnecting"
      expect(wasLoggedWith(consoleLogSpy, 'Reconnecting in')).toBe(true);
    });
  });

  describe('reconnection logic', () => {
    it('should schedule reconnection on abnormal close', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateClose(1006); // Abnormal closure

      // Verify reconnection was scheduled
      const wasLogged = consoleLogSpy.mock.calls.some((call: unknown[]) =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('Reconnecting in'))
      );
      expect(wasLogged).toBe(true);
    });

    it('should cancel reconnection on disconnect', () => {
      const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');

      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateClose(1006);

      // Disconnect should clear the scheduled reconnection
      disconnect();

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });

    it('should handle WebSocket construction error', () => {
      // Make WebSocket constructor throw
      const error = new Error('Connection refused');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).WebSocket = function() {
        throw error;
      };

      connect();

      expect(isConnected()).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should log WebSocket errors', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateError();

      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });
});
