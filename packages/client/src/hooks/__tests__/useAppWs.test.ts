import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useAppWsEvent, useAppWsState } from '../useAppWs';
import { _reset as resetWebSocket, connect } from '../../lib/app-websocket';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';

describe('useAppWsState', () => {
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

  describe('state selection', () => {
    it('should select connected state', () => {
      // First connect via useAppWsEvent
      renderHook(() => useAppWsEvent());

      const { result } = renderHook(() => useAppWsState(s => s.connected));

      expect(result.current).toBe(false);

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      expect(result.current).toBe(true);
    });

    it('should select sessionsSynced state', () => {
      renderHook(() => useAppWsEvent());

      const { result } = renderHook(() => useAppWsState(s => s.sessionsSynced));

      expect(result.current).toBe(false);

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(
          JSON.stringify({ type: 'sessions-sync', sessions: [], activityStates: [] })
        );
      });

      expect(result.current).toBe(true);
    });

    it('should select agentsSynced state', () => {
      renderHook(() => useAppWsEvent());

      const { result } = renderHook(() => useAppWsState(s => s.agentsSynced));

      expect(result.current).toBe(false);

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(
          JSON.stringify({ type: 'agents-sync', agents: [] })
        );
      });

      expect(result.current).toBe(true);
    });

    it('should support multiple concurrent subscriptions with different selectors', () => {
      renderHook(() => useAppWsEvent());

      const { result: connectedResult } = renderHook(() => useAppWsState(s => s.connected));
      const { result: syncedResult } = renderHook(() => useAppWsState(s => s.sessionsSynced));

      expect(connectedResult.current).toBe(false);
      expect(syncedResult.current).toBe(false);

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      // Only connected should change
      expect(connectedResult.current).toBe(true);
      expect(syncedResult.current).toBe(false);

      act(() => {
        ws?.simulateMessage(
          JSON.stringify({ type: 'sessions-sync', sessions: [], activityStates: [] })
        );
      });

      // Now both should be true
      expect(connectedResult.current).toBe(true);
      expect(syncedResult.current).toBe(true);
    });
  });
});

describe('useAppWsEvent', () => {
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
    it('should connect on mount when not connected', () => {
      renderHook(() => useAppWsEvent());

      const ws = MockWebSocket.getLastInstance();
      expect(ws).toBeDefined();
      expect(ws?.url).toBe('ws://localhost:3000/ws/app');
    });

    it('should send request-sync on mount when already connected (navigation case)', () => {
      // Simulate: User was on Dashboard, navigated away, WebSocket stayed connected
      connect();
      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      // Clear send mock to isolate the request-sync call
      ws?.send.mockClear();

      // Now mount the hook (simulating returning to Dashboard)
      renderHook(() => useAppWsEvent());

      // Should send request-sync instead of creating new connection
      expect(ws?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'request-sync' }));
      // Should not create a new WebSocket
      expect(MockWebSocket.getInstances().length).toBe(1);
    });

    it('should not send request-sync when connecting for the first time', () => {
      renderHook(() => useAppWsEvent());

      const ws = MockWebSocket.getLastInstance();
      // Before connection opens, send should not be called
      expect(ws?.send).not.toHaveBeenCalled();
    });
  });

  describe('message handling', () => {
    it('should call onSessionsSync for sessions-sync message', () => {
      const onSessionsSync = mock(() => {});
      renderHook(() => useAppWsEvent({ onSessionsSync }));

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
      renderHook(() => useAppWsEvent({ onSessionCreated }));

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
      renderHook(() => useAppWsEvent({ onSessionUpdated }));

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
      renderHook(() => useAppWsEvent({ onSessionDeleted }));

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
      renderHook(() => useAppWsEvent({ onWorkerActivity }));

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
      renderHook(() => useAppWsEvent({ onSessionsSync }));

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
      renderHook(() => useAppWsEvent({ onSessionsSync, onWorkerActivity }));

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(JSON.stringify({ type: 'unknown-type', data: 'test' }));
      });

      expect(onSessionsSync).not.toHaveBeenCalled();
      expect(onWorkerActivity).not.toHaveBeenCalled();
    });

    it('should call onAgentsSync for agents-sync message', () => {
      const onAgentsSync = mock(() => {});
      renderHook(() => useAppWsEvent({ onAgentsSync }));

      const ws = MockWebSocket.getLastInstance();
      const mockAgents = [
        {
          id: 'agent-1',
          name: 'Test Agent',
          commandTemplate: 'test {{prompt}}',
          isBuiltIn: false,
          capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
        },
      ];

      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(
          JSON.stringify({
            type: 'agents-sync',
            agents: mockAgents,
          })
        );
      });

      expect(onAgentsSync).toHaveBeenCalledWith(mockAgents);
    });

    it('should call onAgentCreated for agent-created message', () => {
      const onAgentCreated = mock(() => {});
      renderHook(() => useAppWsEvent({ onAgentCreated }));

      const ws = MockWebSocket.getLastInstance();
      const mockAgent = {
        id: 'agent-1',
        name: 'New Agent',
        commandTemplate: 'newagent {{prompt}}',
        isBuiltIn: false,
        capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
      };

      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(
          JSON.stringify({
            type: 'agent-created',
            agent: mockAgent,
          })
        );
      });

      expect(onAgentCreated).toHaveBeenCalledWith(mockAgent);
    });

    it('should call onAgentUpdated for agent-updated message', () => {
      const onAgentUpdated = mock(() => {});
      renderHook(() => useAppWsEvent({ onAgentUpdated }));

      const ws = MockWebSocket.getLastInstance();
      const mockAgent = {
        id: 'agent-1',
        name: 'Updated Agent',
        commandTemplate: 'updated {{prompt}}',
        isBuiltIn: false,
        capabilities: { supportsContinue: true, supportsHeadlessMode: false, supportsActivityDetection: false },
      };

      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(
          JSON.stringify({
            type: 'agent-updated',
            agent: mockAgent,
          })
        );
      });

      expect(onAgentUpdated).toHaveBeenCalledWith(mockAgent);
    });

    it('should call onAgentDeleted for agent-deleted message', () => {
      const onAgentDeleted = mock(() => {});
      renderHook(() => useAppWsEvent({ onAgentDeleted }));

      const ws = MockWebSocket.getLastInstance();

      act(() => {
        ws?.simulateOpen();
        ws?.simulateMessage(
          JSON.stringify({
            type: 'agent-deleted',
            agentId: 'agent-1',
          })
        );
      });

      expect(onAgentDeleted).toHaveBeenCalledWith('agent-1');
    });
  });

  // Note: Reconnection logic is now handled by the singleton module (app-websocket.ts)
  // Tests for reconnection should be in the module's test file

  describe('options updates', () => {
    it('should use updated callback references', () => {
      const onSessionsSync1 = mock(() => {});
      const onSessionsSync2 = mock(() => {});

      const { rerender } = renderHook(
        ({ onSessionsSync }) => useAppWsEvent({ onSessionsSync }),
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
      renderHook(() => useAppWsEvent());

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
