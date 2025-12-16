import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useAppWebSocket } from '../useAppWebSocket';
import { _reset as resetWebSocket } from '../../lib/app-websocket';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';

describe('useAppWebSocket', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let restoreWebSocket: () => void;
  let originalLocation: Location;

  beforeEach(() => {
    originalLocation = window.location;
    restoreWebSocket = installMockWebSocket();

    // Mock window.location
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
    });

    // Suppress console output
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    // Reset singleton state
    resetWebSocket();
  });

  afterEach(() => {
    restoreWebSocket();
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('connection', () => {
    it('should connect on mount', () => {
      renderHook(() => useAppWebSocket());

      const ws = MockWebSocket.getLastInstance();
      expect(ws).toBeDefined();
      expect(ws?.url).toBe('ws://localhost:3000/ws/app');
    });

    it('should update connected state on open', () => {
      const { result } = renderHook(() => useAppWebSocket());

      expect(result.current.connected).toBe(false);

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      expect(result.current.connected).toBe(true);
    });

    it('should update connected state on close', () => {
      const { result } = renderHook(() => useAppWebSocket());

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
    it('should call onSessionsSync for sessions-sync message', () => {
      const onSessionsSync = mock(() => {});
      renderHook(() => useAppWebSocket({ onSessionsSync }));

      const ws = MockWebSocket.getLastInstance();
      const mockSessions = [
        { id: 'session-1', type: 'quick', locationPath: '/path/1', status: 'active', createdAt: '2024-01-01', workers: [] },
        { id: 'session-2', type: 'quick', locationPath: '/path/2', status: 'active', createdAt: '2024-01-01', workers: [] },
      ];
      const mockActivityStates = [
        { sessionId: 'session-1', workerId: 'worker-1', activityState: 'active' },
      ];

      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(
          JSON.stringify({
            type: 'sessions-sync',
            sessions: mockSessions,
            activityStates: mockActivityStates,
          })
        );
      });

      expect(onSessionsSync).toHaveBeenCalledWith(mockSessions, mockActivityStates);
    });

    it('should call onSessionCreated for session-created message', () => {
      const onSessionCreated = mock(() => {});
      renderHook(() => useAppWebSocket({ onSessionCreated }));

      const ws = MockWebSocket.getLastInstance();
      const mockSession = { id: 'session-1', type: 'quick', locationPath: '/path/1', status: 'active', createdAt: '2024-01-01', workers: [] };

      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(
          JSON.stringify({
            type: 'session-created',
            session: mockSession,
          })
        );
      });

      expect(onSessionCreated).toHaveBeenCalledWith(mockSession);
    });

    it('should call onSessionUpdated for session-updated message', () => {
      const onSessionUpdated = mock(() => {});
      renderHook(() => useAppWebSocket({ onSessionUpdated }));

      const ws = MockWebSocket.getLastInstance();
      const mockSession = { id: 'session-1', type: 'quick', locationPath: '/path/1', status: 'active', createdAt: '2024-01-01', workers: [], title: 'Updated Title' };

      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(
          JSON.stringify({
            type: 'session-updated',
            session: mockSession,
          })
        );
      });

      expect(onSessionUpdated).toHaveBeenCalledWith(mockSession);
    });

    it('should call onSessionDeleted for session-deleted message', () => {
      const onSessionDeleted = mock(() => {});
      renderHook(() => useAppWebSocket({ onSessionDeleted }));

      const ws = MockWebSocket.getLastInstance();

      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(
          JSON.stringify({
            type: 'session-deleted',
            sessionId: 'session-1',
          })
        );
      });

      expect(onSessionDeleted).toHaveBeenCalledWith('session-1');
    });

    it('should call onWorkerActivity for worker-activity message', () => {
      const onWorkerActivity = mock(() => {});
      renderHook(() => useAppWebSocket({ onWorkerActivity }));

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
      const onSessionsSync = mock(() => {});
      renderHook(() => useAppWebSocket({ onSessionsSync }));

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage('not valid json');
      });

      expect(onSessionsSync).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should handle unknown message types gracefully', () => {
      const onSessionsSync = mock(() => {});
      const onWorkerActivity = mock(() => {});
      renderHook(() => useAppWebSocket({ onSessionsSync, onWorkerActivity }));

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(JSON.stringify({ type: 'unknown-type', data: 'test' }));
      });

      expect(onSessionsSync).not.toHaveBeenCalled();
      expect(onWorkerActivity).not.toHaveBeenCalled();
    });
  });

  // Note: Reconnection logic is now handled by the singleton module (app-websocket.ts)
  // Tests for reconnection should be in the module's test file

  describe('options updates', () => {
    it('should use updated callback references', () => {
      const onSessionsSync1 = mock(() => {});
      const onSessionsSync2 = mock(() => {});

      const { rerender } = renderHook(
        ({ onSessionsSync }) => useAppWebSocket({ onSessionsSync }),
        { initialProps: { onSessionsSync: onSessionsSync1 } }
      );

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      // Update callback
      rerender({ onSessionsSync: onSessionsSync2 });

      // Send message
      act(() => {
        ws?.simulateMessage(
          JSON.stringify({ type: 'sessions-sync', sessions: [], activityStates: [] })
        );
      });

      expect(onSessionsSync1).not.toHaveBeenCalled();
      expect(onSessionsSync2).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle WebSocket errors', () => {
      renderHook(() => useAppWebSocket());

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
        ws?.simulateError();
      });

      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  // Note: Stale WebSocket handling tests were removed because the singleton
  // module now manages WebSocket lifecycle. The hook simply subscribes to
  // the singleton and doesn't need to track stale connections.
});
