import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { WS_CLOSE_CODE, type GitDiffData } from '@agent-console/shared';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';
import {
  connect,
  disconnect,
  disconnectSession,
  getState,
  subscribeState,
  _reset,
  type GitDiffWorkerCallbacks,
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

  // git-diff is the only worker type routed through this module (terminal/agent
  // PTY transport moved to the terminal store; see issues #941 / #961).
  const createGitDiffCallbacks = (): GitDiffWorkerCallbacks => ({
    type: 'git-diff',
    onDiffData: mock(() => {}),
    onDiffError: mock(() => {}),
  });

  describe('disconnectSession', () => {
    it('should disconnect all workers in the session', () => {
      const callbacks = createGitDiffCallbacks();

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
      const callbacks = createGitDiffCallbacks();

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

  describe('git-diff message handling', () => {
    it('updates state and calls onDiffError for a diff-error message', () => {
      const callbacks = createGitDiffCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      ws?.simulateMessage(JSON.stringify({ type: 'diff-error', error: 'bad diff' }));

      expect(getState('session-1', 'worker-1').diffError).toBe('bad diff');
      expect(callbacks.onDiffError).toHaveBeenCalledWith('bad diff');
    });

    it('updates state and calls onDiffData for a diff-data message', () => {
      const callbacks = createGitDiffCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      const diffData: GitDiffData = {
        summary: {
          baseCommit: 'abc123',
          targetRef: 'working-dir',
          files: [],
          totalAdditions: 0,
          totalDeletions: 0,
          updatedAt: '2026-07-03T00:00:00.000Z',
        },
        rawDiff: '',
      };
      ws?.simulateMessage(JSON.stringify({ type: 'diff-data', data: diffData }));

      expect(getState('session-1', 'worker-1').diffData).toEqual(diffData);
      expect(getState('session-1', 'worker-1').diffLoading).toBe(false);
      expect(callbacks.onDiffData).toHaveBeenCalledWith(diffData);
    });

    it('sets an error state for an unrecognized message type', () => {
      const callbacks = createGitDiffCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      ws?.simulateMessage(JSON.stringify({ type: 'not-a-real-type' }));

      expect(getState('session-1', 'worker-1').diffError).toBe('Invalid server message');
      expect(getState('session-1', 'worker-1').diffLoading).toBe(false);
    });
  });

  describe('close code handling', () => {
    // Helper to check if any log call contains a substring
    function wasLoggedWith(spy: ReturnType<typeof spyOn>, substring: string): boolean {
      return spy.mock.calls.some((call: unknown[]) =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes(substring))
      );
    }

    it('should not reconnect on NORMAL_CLOSURE (1000)', () => {
      const callbacks = createGitDiffCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateClose(WS_CLOSE_CODE.NORMAL_CLOSURE);

      expect(wasLoggedWith(consoleLogSpy, 'not reconnecting')).toBe(true);
      expect(wasLoggedWith(consoleLogSpy, 'Reconnecting session-')).toBe(false);
    });

    it('should not reconnect on GOING_AWAY (1001)', () => {
      const callbacks = createGitDiffCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateClose(WS_CLOSE_CODE.GOING_AWAY);

      expect(wasLoggedWith(consoleLogSpy, 'not reconnecting')).toBe(true);
      expect(wasLoggedWith(consoleLogSpy, 'Reconnecting session-')).toBe(false);
    });

    it('should not reconnect on POLICY_VIOLATION (1008)', () => {
      const callbacks = createGitDiffCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateClose(WS_CLOSE_CODE.POLICY_VIOLATION);

      expect(wasLoggedWith(consoleLogSpy, 'not reconnecting')).toBe(true);
      expect(wasLoggedWith(consoleLogSpy, 'Reconnecting session-')).toBe(false);
    });

    it('should reconnect on ABNORMAL_CLOSURE (1006)', () => {
      const callbacks = createGitDiffCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      expect(wasLoggedWith(consoleLogSpy, 'Reconnecting session-')).toBe(true);
      expect(wasLoggedWith(consoleLogSpy, 'not reconnecting')).toBe(false);
    });

    it('should reconnect on INTERNAL_ERROR (1011)', () => {
      const callbacks = createGitDiffCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateClose(WS_CLOSE_CODE.INTERNAL_ERROR);

      expect(wasLoggedWith(consoleLogSpy, 'Reconnecting session-')).toBe(true);
      expect(wasLoggedWith(consoleLogSpy, 'not reconnecting')).toBe(false);
    });
  });

  describe('exponential backoff', () => {
    it('should use exponential backoff delays', () => {
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout');
      const callbacks = createGitDiffCallbacks();

      connect('session-1', 'worker-1', callbacks);
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Mock Math.random to return 0.5 (produces jitter of 0, so delay = baseDelay exactly)
      const mathRandomSpy = spyOn(Math, 'random').mockReturnValue(0.5);

      ws?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      // First reconnection attempt: baseDelay = min(1000 * 2^0, 30000) = 1000
      const firstDelayCall = setTimeoutSpy.mock.calls.find(
        (call: unknown[]) => typeof call[1] === 'number' && call[1] >= 900
      );
      expect(firstDelayCall).toBeDefined();
      expect(firstDelayCall![1]).toBe(1000); // With random=0.5, jitter=0, delay=1000

      // Let the timeout fire to trigger second reconnection
      const firstCallback = firstDelayCall![0] as () => void;
      firstCallback();

      // Get the new WebSocket and close it to trigger next reconnection
      const ws2 = MockWebSocket.getLastInstance();
      ws2?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      // Second reconnection attempt: baseDelay = min(1000 * 2^1, 30000) = 2000
      const secondDelayCall = setTimeoutSpy.mock.calls.find(
        (call: unknown[]) => typeof call[1] === 'number' && call[1] === 2000
      );
      expect(secondDelayCall).toBeDefined();

      mathRandomSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    });

    it('should cap delay at MAX_RETRY_DELAY (30000ms)', () => {
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout');
      // With random=0.5, jitter=0, so delay = baseDelay exactly
      const mathRandomSpy = spyOn(Math, 'random').mockReturnValue(0.5);

      const callbacks = createGitDiffCallbacks();
      connect('session-1', 'worker-1', callbacks);
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Trigger many reconnection cycles by immediately executing setTimeout callbacks
      // We need to reach count >= 15 where 1000 * 2^15 = 32768000 > 30000
      let currentWs = ws;
      for (let i = 0; i < 16; i++) {
        currentWs?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

        // Find the latest setTimeout call and execute it
        const lastCall = setTimeoutSpy.mock.calls[setTimeoutSpy.mock.calls.length - 1];
        const callback = lastCall[0] as () => void;
        callback();

        currentWs = MockWebSocket.getLastInstance();
      }

      // At count=15, baseDelay = min(1000 * 2^15, 30000) = min(32768000, 30000) = 30000
      // The last few delays should all be capped at 30000
      const cappedCalls = setTimeoutSpy.mock.calls.filter(
        (call: unknown[]) => call[1] === 30000
      );
      expect(cappedCalls.length).toBeGreaterThan(0);

      mathRandomSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    });

    it('should add jitter to prevent thundering herd', () => {
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout');
      const callbacks = createGitDiffCallbacks();

      // Test with random=0 (minimum jitter: baseDelay * 0.3 * (0*2 - 1) = -0.3 * baseDelay)
      const mathRandomSpy = spyOn(Math, 'random').mockReturnValue(0);

      connect('session-1', 'worker-1', callbacks);
      let ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      // baseDelay = 1000, jitter = 1000 * 0.3 * (0 - 1) = -300, delay = 700
      const minJitterCall = setTimeoutSpy.mock.calls.find(
        (call: unknown[]) => call[1] === 700
      );
      expect(minJitterCall).toBeDefined();

      // Clean up and test with random=1 (maximum jitter: baseDelay * 0.3 * (1*2 - 1) = +0.3 * baseDelay)
      setTimeoutSpy.mockRestore();
      mathRandomSpy.mockRestore();
      _reset();

      const setTimeoutSpy2 = spyOn(globalThis, 'setTimeout');
      const mathRandomSpy2 = spyOn(Math, 'random').mockReturnValue(1);

      connect('session-2', 'worker-2', callbacks);
      ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      // baseDelay = 1000, jitter = 1000 * 0.3 * (2 - 1) = 300, delay = 1300
      const maxJitterCall = setTimeoutSpy2.mock.calls.find(
        (call: unknown[]) => call[1] === 1300
      );
      expect(maxJitterCall).toBeDefined();

      mathRandomSpy2.mockRestore();
      setTimeoutSpy2.mockRestore();
    });
  });

  describe('reconnection lifecycle', () => {
    it('should reset retry count on successful reconnection', () => {
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout');
      const mathRandomSpy = spyOn(Math, 'random').mockReturnValue(0.5);
      const callbacks = createGitDiffCallbacks();

      connect('session-1', 'worker-1', callbacks);
      const ws1 = MockWebSocket.getLastInstance();
      ws1?.simulateOpen();

      // Trigger first close to start reconnection
      ws1?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      // Execute the scheduled reconnection
      const firstCall = setTimeoutSpy.mock.calls[setTimeoutSpy.mock.calls.length - 1];
      (firstCall[0] as () => void)();

      // New WebSocket should have been created
      const ws2 = MockWebSocket.getLastInstance();
      expect(ws2).not.toBe(ws1);

      // Simulate successful connection - this resets retryCount to 0
      ws2?.simulateOpen();

      // Now trigger another close
      ws2?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      // Should log "attempt 1" (not "attempt 2"), indicating retryCount was reset
      const attemptOneLogged = consoleLogSpy.mock.calls.some((call: unknown[]) =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('attempt 1'))
      );
      expect(attemptOneLogged).toBe(true);

      mathRandomSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    });

    it('should give up after MAX_RETRY_COUNT retries', () => {
      // Capture setTimeout callbacks instead of executing them immediately
      const pendingCallbacks: Array<() => void> = [];
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
        ((fn: () => void) => {
          pendingCallbacks.push(fn);
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout
      );
      const mathRandomSpy = spyOn(Math, 'random').mockReturnValue(0.5);

      const callbacks = createGitDiffCallbacks();
      connect('session-1', 'worker-1', callbacks);
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Trigger first close to start reconnection chain
      ws?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      // MAX_RETRY_COUNT is 100. Each cycle: execute pending setTimeout callback
      // (which calls reconnect -> creates new WS), then close that new WS
      // (which triggers scheduleReconnect -> new setTimeout callback).
      // scheduleReconnect increments retryCount and checks MAX_RETRY_COUNT.
      for (let i = 0; i < 200 && pendingCallbacks.length > 0; i++) {
        const cb = pendingCallbacks.shift()!;
        cb();

        // Close the newly created WebSocket to trigger the next scheduleReconnect
        const latestWs = MockWebSocket.getLastInstance();
        if (latestWs && latestWs.readyState !== MockWebSocket.CLOSED) {
          latestWs.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);
        }
      }

      // Should log max retry message
      const maxRetryLogged = consoleErrorSpy.mock.calls.some((call: unknown[]) =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('Max retry attempts reached'))
      );
      expect(maxRetryLogged).toBe(true);

      mathRandomSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    });

    it('should clean up connection on max retry so future connect() works', () => {
      // Same approach: capture and manually execute setTimeout callbacks
      const pendingCallbacks: Array<() => void> = [];
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
        ((fn: () => void) => {
          pendingCallbacks.push(fn);
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout
      );
      const mathRandomSpy = spyOn(Math, 'random').mockReturnValue(0.5);

      const callbacks = createGitDiffCallbacks();
      connect('session-1', 'worker-1', callbacks);
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Exhaust all retries
      ws?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      for (let i = 0; i < 200 && pendingCallbacks.length > 0; i++) {
        const cb = pendingCallbacks.shift()!;
        cb();

        const latestWs = MockWebSocket.getLastInstance();
        if (latestWs && latestWs.readyState !== MockWebSocket.CLOSED) {
          latestWs.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);
        }
      }

      mathRandomSpy.mockRestore();
      setTimeoutSpy.mockRestore();

      // Connection should be cleaned up; getState returns default disconnected state
      const state = getState('session-1', 'worker-1');
      expect(state.connected).toBe(false);

      // A new connect() should succeed (create a new WebSocket)
      const instanceCountBefore = MockWebSocket.getInstances().length;
      const result = connect('session-1', 'worker-1', callbacks);
      expect(result).toBe(true);
      expect(MockWebSocket.getInstances().length).toBe(instanceCountBefore + 1);
    });

    it('should cancel pending reconnection on explicit disconnect', () => {
      const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');
      const callbacks = createGitDiffCallbacks();

      connect('session-1', 'worker-1', callbacks);
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();
      ws?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      // Disconnect should clear the scheduled reconnection
      disconnect('session-1', 'worker-1');

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });

    it('should not create duplicate connections on concurrent connect calls', () => {
      const callbacks = createGitDiffCallbacks();

      // Call connect multiple times with the same sessionId/workerId
      connect('session-1', 'worker-1', callbacks);
      connect('session-1', 'worker-1', callbacks);
      connect('session-1', 'worker-1', callbacks);

      // Only 1 MockWebSocket should have been created
      expect(MockWebSocket.getInstances().length).toBe(1);
    });

    it('should not create duplicate connections when already connected', () => {
      const callbacks = createGitDiffCallbacks();

      connect('session-1', 'worker-1', callbacks);
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Additional connect calls should not create new connections
      const result1 = connect('session-1', 'worker-1', callbacks);
      const result2 = connect('session-1', 'worker-1', callbacks);

      expect(result1).toBe(false);
      expect(result2).toBe(false);
      expect(MockWebSocket.getInstances().length).toBe(1);
    });

    it('should preserve retryCount during reconnection', () => {
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout');
      const mathRandomSpy = spyOn(Math, 'random').mockReturnValue(0.5);
      const callbacks = createGitDiffCallbacks();

      connect('session-1', 'worker-1', callbacks);
      const ws1 = MockWebSocket.getLastInstance();
      ws1?.simulateOpen();

      // Trigger first close - logs "attempt 1"
      ws1?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);
      expect(consoleLogSpy.mock.calls.some((call: unknown[]) =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('attempt 1'))
      )).toBe(true);

      // Execute the first reconnection timeout
      const firstTimeoutCall = setTimeoutSpy.mock.calls[setTimeoutSpy.mock.calls.length - 1];
      (firstTimeoutCall[0] as () => void)();

      // New WebSocket created, but close it again WITHOUT opening (no retryCount reset)
      const ws2 = MockWebSocket.getLastInstance();
      expect(ws2).not.toBe(ws1);
      ws2?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      // Should log "attempt 2" - retryCount was preserved from the first reconnection
      expect(consoleLogSpy.mock.calls.some((call: unknown[]) =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('attempt 2'))
      )).toBe(true);

      mathRandomSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    });

    it('should not reconnect when connection was explicitly disconnected before close fires', () => {
      const callbacks = createGitDiffCallbacks();
      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Explicitly disconnect (removes from connections map)
      disconnect('session-1', 'worker-1');

      // Now simulate close event firing (e.g., after close() was called)
      // Since connection was removed from map, onclose should not schedule reconnect
      ws?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      // Should not attempt to reconnect
      const reconnectLogged = consoleLogSpy.mock.calls.some((call: unknown[]) =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('Reconnecting session-'))
      );
      expect(reconnectLogged).toBe(false);
    });

    it('should update connection state to disconnected on close', () => {
      const callbacks = createGitDiffCallbacks();
      const listener = mock(() => {});
      subscribeState(listener);

      connect('session-1', 'worker-1', callbacks);
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      expect(getState('session-1', 'worker-1').connected).toBe(true);

      ws?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      expect(getState('session-1', 'worker-1').connected).toBe(false);
      expect(listener).toHaveBeenCalled();
    });

    it('should cancel pending reconnection when disconnectSession is called', () => {
      const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');
      const callbacks = createGitDiffCallbacks();

      connect('session-1', 'worker-1', callbacks);
      connect('session-1', 'worker-2', callbacks);

      const instances = MockWebSocket.getInstances();
      instances[0]?.simulateOpen();
      instances[1]?.simulateOpen();

      // Trigger reconnection for both workers
      instances[0]?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);
      instances[1]?.simulateClose(WS_CLOSE_CODE.ABNORMAL_CLOSURE);

      // disconnectSession should cancel pending reconnections
      disconnectSession('session-1');

      // clearTimeout should have been called for each worker's pending reconnection
      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });
  });

  describe('connection open behavior', () => {
    it('should NOT auto-send any client message on WebSocket open', async () => {
      // git-diff connections request data on demand (refresh / set-base-commit),
      // never automatically on open. Guards against a spurious auto-send regression.
      const callbacks = createGitDiffCallbacks();

      connect('session-1', 'worker-1', callbacks);

      const ws = MockWebSocket.getLastInstance();
      expect(ws).toBeDefined();

      ws?.simulateOpen();

      // Wait a bit to ensure no delayed request is sent
      await new Promise((resolve) => setTimeout(resolve, 100));

      const calls = ws?.send.mock.calls as unknown as unknown[][];
      expect(calls?.length ?? 0).toBe(0);
    });
  });
});
