import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { WS_CLOSE_CODE } from '@agent-console/shared';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';
import {
  connect,
  disconnect,
  subscribe,
  subscribeState,
  getState,
  requestSync,
  _reset,
  _setRetryCount,
  MAX_RETRY_COUNT,
  LAST_RESORT_RETRY_DELAY,
} from '../app-websocket';

describe('app-websocket', () => {
  let restoreWebSocket: () => void;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;
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
    consoleWarnSpy = spyOn(console, 'warn');
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
    consoleWarnSpy.mockRestore();
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
      ws1!.simulateClosing();

      connect();

      expect(MockWebSocket.getInstances().length).toBe(2);
    });

    it('should reset retry count on successful connection', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      expect(getState().connected).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('should close WebSocket with code NORMAL_CLOSURE', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      disconnect();

      expect(ws?.close).toHaveBeenCalledWith(WS_CLOSE_CODE.NORMAL_CLOSURE);
    });

    it('should not call close on already CLOSED socket', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateClose();

      disconnect();

      expect(ws?.close).not.toHaveBeenCalled();
    });

    it('should not call close on CLOSING socket', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateClosing();

      disconnect();

      expect(ws?.close).not.toHaveBeenCalled();
    });

    it('should set connected to false', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      expect(getState().connected).toBe(true);

      disconnect();

      expect(getState().connected).toBe(false);
    });
  });

  describe('connection state', () => {
    it('should notify listeners on connection', () => {
      const listener = mock(() => {});
      subscribeState(listener);

      // Initial state
      expect(getState().connected).toBe(false);

      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Listener should be called when state changes
      expect(listener).toHaveBeenCalled();
      expect(getState().connected).toBe(true);
    });

    it('should notify listeners on disconnection', () => {
      const listener = mock(() => {});

      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      subscribeState(listener);
      listener.mockClear();

      ws?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      expect(listener).toHaveBeenCalled();
      expect(getState().connected).toBe(false);
    });

    it('should unsubscribe state listener', () => {
      const listener = mock(() => {});
      const unsubscribe = subscribeState(listener);

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

    it('should not reconnect on NORMAL_CLOSURE', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateClose(WS_CLOSE_CODE.NORMAL_CLOSURE);

      // Verify "not reconnecting" message was logged
      expect(wasLoggedWith(consoleLogSpy, 'not reconnecting')).toBe(true);
    });

    it('should not reconnect on GOING_AWAY', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateClose(WS_CLOSE_CODE.GOING_AWAY);

      expect(wasLoggedWith(consoleLogSpy, 'not reconnecting')).toBe(true);
    });

    it('should not reconnect on POLICY_VIOLATION', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateClose(WS_CLOSE_CODE.POLICY_VIOLATION);

      expect(wasLoggedWith(consoleLogSpy, 'not reconnecting')).toBe(true);
    });

    it('should schedule reconnection on ABNORMAL_CLOSURE', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      // Should log reconnection attempt, not "not reconnecting"
      expect(wasLoggedWith(consoleLogSpy, 'Reconnecting in')).toBe(true);
    });
  });

  describe('reconnection logic', () => {
    it('should schedule reconnection on abnormal close', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

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
      ws?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      // Disconnect should clear the scheduled reconnection
      disconnect();

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });

    it('should enter last-resort mode after MAX_RETRY_COUNT retries', () => {
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout');

      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Set retry count to max to simulate exhausted normal retries
      _setRetryCount(MAX_RETRY_COUNT);

      // Trigger reconnection
      ws?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      // Should log last-resort mode message
      const wasLogged = consoleWarnSpy.mock.calls.some((call: unknown[]) =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('last-resort reconnection mode'))
      );
      expect(wasLogged).toBe(true);

      // Should schedule reconnection at the last-resort interval
      const lastResortCall = setTimeoutSpy.mock.calls.find(
        (call: unknown[]) => call[1] === LAST_RESORT_RETRY_DELAY
      );
      expect(lastResortCall).toBeDefined();

      setTimeoutSpy.mockRestore();
    });

    it('should reset to normal backoff after successful reconnection from last-resort mode', () => {
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
        // Execute callback immediately to simulate timer firing
        ((fn: () => void) => { fn(); return 0 as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout
      );

      connect();
      const ws1 = MockWebSocket.getLastInstance();
      ws1?.simulateOpen();

      // Set retry count to max to enter last-resort mode
      _setRetryCount(MAX_RETRY_COUNT);

      // Trigger close - scheduleReconnect enters last-resort mode and setTimeout fires immediately
      ws1?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      setTimeoutSpy.mockRestore();

      // A new connection should have been created by the last-resort retry
      const ws2 = MockWebSocket.getLastInstance();
      expect(ws2).not.toBe(ws1);

      // Simulate successful connection - this resets retryCount to 0
      ws2?.simulateOpen();
      expect(getState().connected).toBe(true);

      // Now trigger another close - should use normal backoff, not last-resort
      const setTimeoutSpy2 = spyOn(globalThis, 'setTimeout');
      ws2?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      // Should log normal reconnection message (not last-resort)
      const normalReconnectLogged = consoleLogSpy.mock.calls.some((call: unknown[]) =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('Reconnecting in') && arg.includes('attempt 1'))
      );
      expect(normalReconnectLogged).toBe(true);

      // Should NOT have scheduled at last-resort interval
      const lastResortCall = setTimeoutSpy2.mock.calls.find(
        (call: unknown[]) => call[1] === LAST_RESORT_RETRY_DELAY
      );
      expect(lastResortCall).toBeUndefined();

      setTimeoutSpy2.mockRestore();
    });

    it('should handle WebSocket construction error', () => {
      // Make WebSocket constructor throw
      const error = new Error('Connection refused');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).WebSocket = function() {
        throw error;
      };

      connect();

      expect(getState().connected).toBe(false);
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

  describe('send (via requestSync)', () => {
    it('should send message when connected', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      const result = requestSync();

      expect(result).toBe(true);
      expect(ws?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'request-sync' }));
    });

    it('should return false when not connected', () => {
      const result = requestSync();

      expect(result).toBe(false);
    });

    it('should return false when WebSocket is connecting', () => {
      connect();
      // WebSocket is in CONNECTING state by default

      const result = requestSync();

      expect(result).toBe(false);
    });

    it('should return false when WebSocket is closing', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws!.simulateClosing();

      const result = requestSync();

      expect(result).toBe(false);
    });
  });

  describe('requestSync', () => {
    it('should send request-sync message', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      const result = requestSync();

      expect(result).toBe(true);
      expect(ws?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'request-sync' }));
    });

    it('should reset sessionsSynced to false when sent', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // First, simulate receiving sessions-sync to set sessionsSynced to true
      ws?.simulateMessage(JSON.stringify({
        type: 'sessions-sync',
        sessions: [],
        activityStates: [],
      }));
      expect(getState().sessionsSynced).toBe(true);

      // Now request sync - should reset to false
      requestSync();

      expect(getState().sessionsSynced).toBe(false);
    });

    it('should not send request-sync when not connected', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateMessage(JSON.stringify({
        type: 'sessions-sync',
        sessions: [],
        activityStates: [],
      }));
      expect(getState().sessionsSynced).toBe(true);

      // Disconnect - this resets sessionsSynced to false (CRITICAL fix)
      ws?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);
      expect(getState().connected).toBe(false);
      expect(getState().sessionsSynced).toBe(false);  // Reset on disconnect

      // Try to request sync while disconnected
      const result = requestSync();

      // Should not send (not connected)
      expect(result).toBe(false);
      // sessionsSynced remains false (was reset on disconnect, not changed by failed send)
      expect(getState().sessionsSynced).toBe(false);
    });

    it('should return false when not connected', () => {
      const result = requestSync();

      expect(result).toBe(false);
    });

    it('should skip duplicate request-sync calls when pending', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // First call should succeed
      const result1 = requestSync();
      expect(result1).toBe(true);
      expect(ws?.send).toHaveBeenCalledTimes(1);

      // Second call should be skipped (pending)
      const result2 = requestSync();
      expect(result2).toBe(false);
      expect(ws?.send).toHaveBeenCalledTimes(1);

      // Third call should also be skipped
      const result3 = requestSync();
      expect(result3).toBe(false);
      expect(ws?.send).toHaveBeenCalledTimes(1);

      // Verify log message
      const wasLogged = consoleLogSpy.mock.calls.some((call: unknown[]) =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('Sync already pending'))
      );
      expect(wasLogged).toBe(true);
    });

    it('should allow new request-sync after receiving sessions-sync', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // First request
      requestSync();
      expect(ws?.send).toHaveBeenCalledTimes(1);

      // Receive response - clears pending state
      ws?.simulateMessage(JSON.stringify({
        type: 'sessions-sync',
        sessions: [],
        activityStates: [],
      }));

      // Second request should now succeed
      const result = requestSync();
      expect(result).toBe(true);
      expect(ws?.send).toHaveBeenCalledTimes(2);
    });

    it('should allow new request-sync after disconnect clears pending state', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // First request
      requestSync();
      expect(ws?.send).toHaveBeenCalledTimes(1);

      // Disconnect clears pending state
      ws?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      // Reconnect
      connect();
      const ws2 = MockWebSocket.getLastInstance();
      ws2?.simulateOpen();

      // Should be able to request sync again
      const result = requestSync();
      expect(result).toBe(true);
    });
  });

  describe('disconnect state reset', () => {
    it('should reset sessionsSynced and agentsSynced on disconnect', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Receive sync messages to set synced states to true
      ws?.simulateMessage(JSON.stringify({
        type: 'sessions-sync',
        sessions: [],
        activityStates: [],
      }));
      ws?.simulateMessage(JSON.stringify({
        type: 'agents-sync',
        agents: [],
      }));

      expect(getState().connected).toBe(true);
      expect(getState().sessionsSynced).toBe(true);
      expect(getState().agentsSynced).toBe(true);

      // Disconnect
      ws?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      // All sync states should be reset
      expect(getState().connected).toBe(false);
      expect(getState().sessionsSynced).toBe(false);
      expect(getState().agentsSynced).toBe(false);
    });

    it('should reset sync states on normal closure too', () => {
      connect();
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      ws?.simulateMessage(JSON.stringify({
        type: 'sessions-sync',
        sessions: [],
        activityStates: [],
      }));
      expect(getState().sessionsSynced).toBe(true);

      ws?.simulateClose(WS_CLOSE_CODE.NORMAL_CLOSURE);

      expect(getState().sessionsSynced).toBe(false);
      expect(getState().agentsSynced).toBe(false);
    });
  });
});
