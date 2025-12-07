import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

  send = vi.fn();
  close = vi.fn(() => {
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

describe('useDashboardWebSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.clearInstances();
    (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket =
      MockWebSocket as unknown as typeof WebSocket;

    // Mock window.location
    Object.defineProperty(window, 'location', {
      value: { host: 'localhost:3000' },
      writable: true,
    });

    // Suppress console output
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
    vi.restoreAllMocks();
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
      const onSync = vi.fn();
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

    it('should call onActivity for session-activity message', () => {
      const onActivity = vi.fn();
      renderHook(() => useDashboardWebSocket({ onActivity }));

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(
          JSON.stringify({
            type: 'session-activity',
            sessionId: 'session-1',
            activityState: 'active',
          })
        );
      });

      expect(onActivity).toHaveBeenCalledWith('session-1', 'active');
    });

    it('should handle invalid JSON gracefully', () => {
      const onSync = vi.fn();
      renderHook(() => useDashboardWebSocket({ onSync }));

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage('not valid json');
      });

      expect(onSync).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalled();
    });

    it('should handle unknown message types gracefully', () => {
      const onSync = vi.fn();
      const onActivity = vi.fn();
      renderHook(() => useDashboardWebSocket({ onSync, onActivity }));

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(JSON.stringify({ type: 'unknown-type', data: 'test' }));
      });

      expect(onSync).not.toHaveBeenCalled();
      expect(onActivity).not.toHaveBeenCalled();
    });
  });

  describe('reconnection logic', () => {
    it('should attempt reconnection on close', () => {
      renderHook(() => useDashboardWebSocket());

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
        ws?.simulateClose();
      });

      // Should schedule reconnection
      expect(MockWebSocket.getInstances().length).toBe(1);

      // Advance timer to trigger reconnection (initial delay ~1000ms)
      act(() => {
        vi.advanceTimersByTime(1500);
      });

      // Should have created a new WebSocket
      expect(MockWebSocket.getInstances().length).toBe(2);
    });

    it('should use exponential backoff for retries', () => {
      // Mock Math.random to get consistent jitter
      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      renderHook(() => useDashboardWebSocket());

      const getWsCount = () => MockWebSocket.getInstances().length;
      expect(getWsCount()).toBe(1);

      // First connection closes
      act(() => {
        MockWebSocket.getLastInstance()?.simulateOpen();
        MockWebSocket.getLastInstance()?.simulateClose();
      });

      // First retry after ~1000ms
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(getWsCount()).toBe(2);

      // Second close
      act(() => {
        MockWebSocket.getLastInstance()?.simulateClose();
      });

      // Second retry should be after ~2000ms (exponential backoff)
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(getWsCount()).toBe(2); // Not yet

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(getWsCount()).toBe(3); // Now reconnected
    });

    it('should cap retry delay at MAX_RETRY_DELAY (30s)', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      renderHook(() => useDashboardWebSocket());

      // Simulate many failed connections to reach max delay
      for (let i = 0; i < 10; i++) {
        act(() => {
          MockWebSocket.getLastInstance()?.simulateOpen();
          MockWebSocket.getLastInstance()?.simulateClose();
        });
        act(() => {
          vi.advanceTimersByTime(35000); // More than max delay
        });
      }

      const wsCount = MockWebSocket.getInstances().length;

      // One more close
      act(() => {
        MockWebSocket.getLastInstance()?.simulateClose();
      });

      // Should reconnect within max delay (30s + jitter)
      act(() => {
        vi.advanceTimersByTime(35000);
      });

      expect(MockWebSocket.getInstances().length).toBe(wsCount + 1);
    });

    it('should reset retry count on successful connection', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      renderHook(() => useDashboardWebSocket());

      // First close - schedules retry with base delay
      act(() => {
        MockWebSocket.getLastInstance()?.simulateOpen();
        MockWebSocket.getLastInstance()?.simulateClose();
      });

      // Wait for first retry
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      const secondWs = MockWebSocket.getLastInstance();

      // Second connection succeeds, then closes
      act(() => {
        secondWs?.simulateOpen(); // This resets retry count
        secondWs?.simulateClose();
      });

      // Retry should use base delay again (~1000ms), not exponential
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(MockWebSocket.getInstances().length).toBe(2);

      act(() => {
        vi.advanceTimersByTime(700);
      });
      expect(MockWebSocket.getInstances().length).toBe(3);
    });

    it('should not reconnect after unmount', () => {
      const { unmount } = renderHook(() => useDashboardWebSocket());

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      // Unmount before close
      unmount();

      act(() => {
        ws?.simulateClose();
      });

      // Advance time - should not create new connection
      act(() => {
        vi.advanceTimersByTime(5000);
      });

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

    it('should clear retry timeout on unmount', () => {
      const { unmount } = renderHook(() => useDashboardWebSocket());

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
        ws?.simulateClose(); // This schedules a retry
      });

      // Unmount before retry fires
      unmount();

      // Advance time past retry delay
      act(() => {
        vi.advanceTimersByTime(5000);
      });

      // Should not have created new connection
      expect(MockWebSocket.getInstances().length).toBe(1);
    });
  });

  describe('options updates', () => {
    it('should use updated callback references', () => {
      const onSync1 = vi.fn();
      const onSync2 = vi.fn();

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

      expect(console.error).toHaveBeenCalled();
    });
  });
});
