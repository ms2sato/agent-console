import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useDashboardWebSocket } from '../useDashboardWebSocket';

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private static instances: MockWebSocket[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send = mock(() => {});
  close = mock(() => {
    this.readyState = MockWebSocket.CLOSED;
  });

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: string) {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }

  simulateError() {
    this.onerror?.(new Event('error'));
  }

  static getInstances(): MockWebSocket[] {
    return MockWebSocket.instances;
  }

  static getLastInstance(): MockWebSocket | undefined {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }

  static clearInstances() {
    MockWebSocket.instances = [];
  }
}

// Mock window.location
const originalLocation = window.location;

// Setup global WebSocket mock
const originalWebSocket = globalThis.WebSocket;

// Helper to wait for next tick (allows setTimeout(fn, 0) to execute)
const waitForNextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('useDashboardWebSocket', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    MockWebSocket.clearInstances();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).WebSocket = MockWebSocket;

    // Mock window.location
    Object.defineProperty(window, 'location', {
      value: { host: 'localhost:3000' },
      writable: true,
    });

    // Suppress console output
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('connection', () => {
    it('should connect on mount', () => {
      renderHook(() => useDashboardWebSocket());

      const ws = MockWebSocket.getLastInstance();
      expect(ws).toBeDefined();
      expect(ws?.url).toBe('ws://localhost:3000/ws/dashboard');
    });

    it('should update connected state on open', () => {
      const { result } = renderHook(() => useDashboardWebSocket());

      expect(result.current.connected).toBe(false);

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      expect(result.current.connected).toBe(true);
    });

    it('should update connected state on close', () => {
      const { result } = renderHook(() => useDashboardWebSocket());

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });
      expect(result.current.connected).toBe(true);

      act(() => {
        ws?.simulateClose();
      });
      expect(result.current.connected).toBe(false);
    });
  });

  describe('message handling', () => {
    it('should call onSync for sessions-sync message', () => {
      const onSync = mock(() => {});
      renderHook(() => useDashboardWebSocket({ onSync }));

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(
          JSON.stringify({
            type: 'sessions-sync',
            sessions: [
              { id: 'session-1', activityState: 'active' },
              { id: 'session-2', activityState: 'idle' },
            ],
          })
        );
      });

      expect(onSync).toHaveBeenCalledWith([
        { id: 'session-1', activityState: 'active' },
        { id: 'session-2', activityState: 'idle' },
      ]);
    });

    it('should call onWorkerActivity for worker-activity message', () => {
      const onWorkerActivity = mock(() => {});
      renderHook(() => useDashboardWebSocket({ onWorkerActivity }));

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(
          JSON.stringify({
            type: 'worker-activity',
            sessionId: 'session-1',
            workerId: 'worker-1',
            activityState: 'active',
          })
        );
      });

      expect(onWorkerActivity).toHaveBeenCalledWith('session-1', 'worker-1', 'active');
    });

    it('should handle invalid JSON gracefully', () => {
      const onSync = mock(() => {});
      renderHook(() => useDashboardWebSocket({ onSync }));

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage('not valid json');
      });

      expect(onSync).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should handle unknown message types gracefully', () => {
      const onSync = mock(() => {});
      const onWorkerActivity = mock(() => {});
      renderHook(() => useDashboardWebSocket({ onSync, onWorkerActivity }));

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(JSON.stringify({ type: 'unknown-type', data: 'test' }));
      });

      expect(onSync).not.toHaveBeenCalled();
      expect(onWorkerActivity).not.toHaveBeenCalled();
    });
  });

  describe('reconnection logic', () => {
    it('should attempt reconnection on close', async () => {
      // Use instant reconnection for testing
      renderHook(() => useDashboardWebSocket({ getReconnectDelay: () => 0 }));

      const initialCount = MockWebSocket.getInstances().length;
      expect(initialCount).toBe(1);

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
        ws?.simulateClose();
      });

      // Wait for next tick (reconnection is immediate with delay=0)
      await act(async () => {
        await waitForNextTick();
      });

      // Should have created a new WebSocket (reconnection happened)
      expect(MockWebSocket.getInstances().length).toBe(2);
    });

    it('should use exponential backoff for retries', async () => {
      // Track delays to verify exponential backoff
      const delays: number[] = [];
      const getReconnectDelay = (retryCount: number) => {
        const delay = 1000 * Math.pow(2, retryCount); // 1000, 2000, 4000...
        delays.push(delay);
        return 0; // Return 0 for instant reconnection in test
      };

      renderHook(() => useDashboardWebSocket({ getReconnectDelay }));

      const getWsCount = () => MockWebSocket.getInstances().length;
      expect(getWsCount()).toBe(1);

      // First connection closes
      act(() => {
        MockWebSocket.getLastInstance()?.simulateOpen();
        MockWebSocket.getLastInstance()?.simulateClose();
      });

      await act(async () => {
        await waitForNextTick();
      });
      expect(getWsCount()).toBe(2);
      expect(delays[0]).toBe(1000); // First retry: base delay

      // Second close
      act(() => {
        MockWebSocket.getLastInstance()?.simulateClose();
      });

      await act(async () => {
        await waitForNextTick();
      });
      expect(getWsCount()).toBe(3);
      expect(delays[1]).toBe(2000); // Second retry: 2x delay

      // Third close
      act(() => {
        MockWebSocket.getLastInstance()?.simulateClose();
      });

      await act(async () => {
        await waitForNextTick();
      });
      expect(getWsCount()).toBe(4);
      expect(delays[2]).toBe(4000); // Third retry: 4x delay
    });

    it('should reset retry count on successful connection', async () => {
      const delays: number[] = [];
      const getReconnectDelay = (retryCount: number) => {
        const delay = 1000 * Math.pow(2, retryCount);
        delays.push(delay);
        return 0;
      };

      renderHook(() => useDashboardWebSocket({ getReconnectDelay }));

      // First close - schedules retry with base delay
      act(() => {
        MockWebSocket.getLastInstance()?.simulateOpen();
        MockWebSocket.getLastInstance()?.simulateClose();
      });

      await act(async () => {
        await waitForNextTick();
      });
      expect(delays[0]).toBe(1000); // retryCount=0

      const secondWs = MockWebSocket.getLastInstance();

      // Second connection succeeds (resets retry count), then closes
      act(() => {
        secondWs?.simulateOpen(); // This resets retry count
        secondWs?.simulateClose();
      });

      await act(async () => {
        await waitForNextTick();
      });
      // Retry count was reset, so delay should be base delay again
      expect(delays[1]).toBe(1000); // retryCount=0 again

      expect(MockWebSocket.getInstances().length).toBe(3);
    });

    it('should not reconnect after unmount', async () => {
      // Use instant reconnection to prove it would reconnect immediately if allowed
      const { unmount } = renderHook(() =>
        useDashboardWebSocket({ getReconnectDelay: () => 0 })
      );

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      // Unmount before close
      unmount();

      act(() => {
        ws?.simulateClose();
      });

      // Wait for next tick - if reconnection was scheduled, it would have fired
      await act(async () => {
        await waitForNextTick();
      });

      // Should still be only 1 instance (no reconnection after unmount)
      expect(MockWebSocket.getInstances().length).toBe(1);
    });
  });

  describe('cleanup', () => {
    it('should close WebSocket on unmount', () => {
      const { unmount } = renderHook(() => useDashboardWebSocket());

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      unmount();

      expect(ws?.close).toHaveBeenCalled();
    });

    it('should clear retry timeout on unmount', async () => {
      // Use instant reconnection to prove retry would fire immediately if not cleared
      const { unmount } = renderHook(() =>
        useDashboardWebSocket({ getReconnectDelay: () => 0 })
      );

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
        ws?.simulateClose(); // This schedules a retry
      });

      // Unmount before retry fires (clears the timeout)
      unmount();

      // Wait for next tick - if retry was not cleared, it would have fired
      await act(async () => {
        await waitForNextTick();
      });

      // Should not have created new connection
      expect(MockWebSocket.getInstances().length).toBe(1);
    });
  });

  describe('options updates', () => {
    it('should use updated callback references', () => {
      const onSync1 = mock(() => {});
      const onSync2 = mock(() => {});

      const { rerender } = renderHook(
        ({ onSync }) => useDashboardWebSocket({ onSync }),
        { initialProps: { onSync: onSync1 } }
      );

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      // Update callback
      rerender({ onSync: onSync2 });

      // Send message
      act(() => {
        ws?.simulateMessage(
          JSON.stringify({ type: 'sessions-sync', sessions: [] })
        );
      });

      expect(onSync1).not.toHaveBeenCalled();
      expect(onSync2).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle WebSocket errors', () => {
      renderHook(() => useDashboardWebSocket());

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
        ws?.simulateError();
      });

      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });
});
