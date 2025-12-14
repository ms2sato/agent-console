import { describe, it, expect } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useSessionState } from '../useSessionState';
import type { Session, WorkerActivityInfo } from '@agent-console/shared';

// Helper to create mock session
function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: `session-${Math.random().toString(36).slice(2)}`,
    type: 'quick',
    locationPath: '/test/path',
    status: 'active',
    createdAt: new Date().toISOString(),
    workers: [],
    ...overrides,
  } as Session;
}

describe('useSessionState', () => {
  describe('initial state', () => {
    it('should start with empty sessions', () => {
      const { result } = renderHook(() => useSessionState());

      expect(result.current.sessions).toEqual([]);
      expect(result.current.wsInitialized).toBe(false);
      expect(result.current.workerActivityStates).toEqual({});
    });
  });

  describe('handleSessionsSync', () => {
    it('should set sessions and mark as initialized', () => {
      const { result } = renderHook(() => useSessionState());

      const mockSessions = [
        createMockSession({ id: 'session-1', locationPath: '/path/1' }),
        createMockSession({ id: 'session-2', locationPath: '/path/2' }),
      ];
      const mockActivityStates: WorkerActivityInfo[] = [
        { sessionId: 'session-1', workerId: 'worker-1', activityState: 'active' },
      ];

      act(() => {
        result.current.handleSessionsSync(mockSessions, mockActivityStates);
      });

      expect(result.current.sessions).toEqual(mockSessions);
      expect(result.current.wsInitialized).toBe(true);
      expect(result.current.sessionsRef.current).toEqual(mockSessions);
    });

    it('should initialize activity states from sync', () => {
      const { result } = renderHook(() => useSessionState());

      const mockSessions = [createMockSession({ id: 'session-1' })];
      const mockActivityStates: WorkerActivityInfo[] = [
        { sessionId: 'session-1', workerId: 'worker-1', activityState: 'active' },
        { sessionId: 'session-1', workerId: 'worker-2', activityState: 'idle' },
      ];

      act(() => {
        result.current.handleSessionsSync(mockSessions, mockActivityStates);
      });

      expect(result.current.workerActivityStates).toEqual({
        'session-1': {
          'worker-1': 'active',
          'worker-2': 'idle',
        },
      });
    });

    it('should handle empty sessions and activity states', () => {
      const { result } = renderHook(() => useSessionState());

      act(() => {
        result.current.handleSessionsSync([], []);
      });

      expect(result.current.sessions).toEqual([]);
      expect(result.current.wsInitialized).toBe(true);
      expect(result.current.workerActivityStates).toEqual({});
    });

    it('should replace previous sessions on re-sync', () => {
      const { result } = renderHook(() => useSessionState());

      const initialSessions = [createMockSession({ id: 'session-1' })];
      const newSessions = [createMockSession({ id: 'session-2' })];

      act(() => {
        result.current.handleSessionsSync(initialSessions, []);
      });

      act(() => {
        result.current.handleSessionsSync(newSessions, []);
      });

      expect(result.current.sessions).toEqual(newSessions);
      expect(result.current.sessionsRef.current).toEqual(newSessions);
    });
  });

  describe('handleSessionCreated', () => {
    it('should add new session to list', () => {
      const { result } = renderHook(() => useSessionState());

      const existingSession = createMockSession({ id: 'session-1' });
      const newSession = createMockSession({ id: 'session-2' });

      act(() => {
        result.current.handleSessionsSync([existingSession], []);
      });

      act(() => {
        result.current.handleSessionCreated(newSession);
      });

      expect(result.current.sessions).toHaveLength(2);
      expect(result.current.sessions[1]).toEqual(newSession);
      expect(result.current.sessionsRef.current).toHaveLength(2);
    });

    it('should work when starting from empty', () => {
      const { result } = renderHook(() => useSessionState());

      const newSession = createMockSession({ id: 'session-1' });

      act(() => {
        result.current.handleSessionCreated(newSession);
      });

      expect(result.current.sessions).toEqual([newSession]);
    });
  });

  describe('handleSessionUpdated', () => {
    it('should update existing session', () => {
      const { result } = renderHook(() => useSessionState());

      const session = createMockSession({ id: 'session-1', title: 'Original' });

      act(() => {
        result.current.handleSessionsSync([session], []);
      });

      const updatedSession = { ...session, title: 'Updated' };

      act(() => {
        result.current.handleSessionUpdated(updatedSession);
      });

      expect(result.current.sessions[0].title).toBe('Updated');
      expect(result.current.sessionsRef.current[0].title).toBe('Updated');
    });

    it('should not affect other sessions', () => {
      const { result } = renderHook(() => useSessionState());

      const session1 = createMockSession({ id: 'session-1', title: 'Session 1' });
      const session2 = createMockSession({ id: 'session-2', title: 'Session 2' });

      act(() => {
        result.current.handleSessionsSync([session1, session2], []);
      });

      const updatedSession1 = { ...session1, title: 'Updated Session 1' };

      act(() => {
        result.current.handleSessionUpdated(updatedSession1);
      });

      expect(result.current.sessions[0].title).toBe('Updated Session 1');
      expect(result.current.sessions[1].title).toBe('Session 2');
    });

    it('should handle non-existent session gracefully', () => {
      const { result } = renderHook(() => useSessionState());

      const session = createMockSession({ id: 'session-1' });
      const nonExistentSession = createMockSession({ id: 'non-existent' });

      act(() => {
        result.current.handleSessionsSync([session], []);
      });

      act(() => {
        result.current.handleSessionUpdated(nonExistentSession);
      });

      // Original session should remain unchanged
      expect(result.current.sessions).toHaveLength(1);
      expect(result.current.sessions[0].id).toBe('session-1');
    });
  });

  describe('handleSessionDeleted', () => {
    it('should remove session from list', () => {
      const { result } = renderHook(() => useSessionState());

      const session1 = createMockSession({ id: 'session-1' });
      const session2 = createMockSession({ id: 'session-2' });

      act(() => {
        result.current.handleSessionsSync([session1, session2], []);
      });

      act(() => {
        result.current.handleSessionDeleted('session-1');
      });

      expect(result.current.sessions).toHaveLength(1);
      expect(result.current.sessions[0].id).toBe('session-2');
      expect(result.current.sessionsRef.current).toHaveLength(1);
    });

    it('should clean up activity states for deleted session', () => {
      const { result } = renderHook(() => useSessionState());

      const session = createMockSession({ id: 'session-1' });
      const activityStates: WorkerActivityInfo[] = [
        { sessionId: 'session-1', workerId: 'worker-1', activityState: 'active' },
      ];

      act(() => {
        result.current.handleSessionsSync([session], activityStates);
      });

      expect(result.current.workerActivityStates['session-1']).toBeDefined();

      act(() => {
        result.current.handleSessionDeleted('session-1');
      });

      expect(result.current.workerActivityStates['session-1']).toBeUndefined();
    });

    it('should handle non-existent session gracefully', () => {
      const { result } = renderHook(() => useSessionState());

      const session = createMockSession({ id: 'session-1' });

      act(() => {
        result.current.handleSessionsSync([session], []);
      });

      act(() => {
        result.current.handleSessionDeleted('non-existent');
      });

      expect(result.current.sessions).toHaveLength(1);
    });
  });

  describe('handleWorkerActivity', () => {
    it('should update worker activity state', () => {
      const { result } = renderHook(() => useSessionState());

      act(() => {
        result.current.handleWorkerActivity('session-1', 'worker-1', 'active');
      });

      expect(result.current.workerActivityStates).toEqual({
        'session-1': { 'worker-1': 'active' },
      });
    });

    it('should update existing worker state', () => {
      const { result } = renderHook(() => useSessionState());

      act(() => {
        result.current.handleWorkerActivity('session-1', 'worker-1', 'active');
      });

      act(() => {
        result.current.handleWorkerActivity('session-1', 'worker-1', 'idle');
      });

      expect(result.current.workerActivityStates['session-1']['worker-1']).toBe('idle');
    });

    it('should handle multiple workers in same session', () => {
      const { result } = renderHook(() => useSessionState());

      act(() => {
        result.current.handleWorkerActivity('session-1', 'worker-1', 'active');
        result.current.handleWorkerActivity('session-1', 'worker-2', 'idle');
      });

      expect(result.current.workerActivityStates).toEqual({
        'session-1': {
          'worker-1': 'active',
          'worker-2': 'idle',
        },
      });
    });

    it('should handle multiple sessions', () => {
      const { result } = renderHook(() => useSessionState());

      act(() => {
        result.current.handleWorkerActivity('session-1', 'worker-1', 'active');
        result.current.handleWorkerActivity('session-2', 'worker-2', 'asking');
      });

      expect(result.current.workerActivityStates).toEqual({
        'session-1': { 'worker-1': 'active' },
        'session-2': { 'worker-2': 'asking' },
      });
    });
  });

  describe('setSessionsFromApi', () => {
    it('should update sessionsRef when not initialized', () => {
      const { result } = renderHook(() => useSessionState());

      const apiSessions = [createMockSession({ id: 'session-1' })];

      act(() => {
        result.current.setSessionsFromApi(apiSessions);
      });

      expect(result.current.sessionsRef.current).toEqual(apiSessions);
    });

    it('should not update sessionsRef when already initialized via WebSocket', () => {
      const { result } = renderHook(() => useSessionState());

      const wsSessions = [createMockSession({ id: 'ws-session' })];
      const apiSessions = [createMockSession({ id: 'api-session' })];

      act(() => {
        result.current.handleSessionsSync(wsSessions, []);
      });

      act(() => {
        result.current.setSessionsFromApi(apiSessions);
      });

      // Should still be WS sessions, not API sessions
      expect(result.current.sessionsRef.current).toEqual(wsSessions);
    });
  });

  describe('integration scenarios', () => {
    it('should handle full lifecycle: sync -> create -> update -> delete', () => {
      const { result } = renderHook(() => useSessionState());

      // Initial sync
      const session1 = createMockSession({ id: 'session-1', title: 'Session 1' });
      act(() => {
        result.current.handleSessionsSync([session1], []);
      });
      expect(result.current.sessions).toHaveLength(1);

      // Create new session
      const session2 = createMockSession({ id: 'session-2', title: 'Session 2' });
      act(() => {
        result.current.handleSessionCreated(session2);
      });
      expect(result.current.sessions).toHaveLength(2);

      // Update first session
      act(() => {
        result.current.handleSessionUpdated({ ...session1, title: 'Updated Session 1' });
      });
      expect(result.current.sessions.find(s => s.id === 'session-1')?.title).toBe('Updated Session 1');

      // Delete second session
      act(() => {
        result.current.handleSessionDeleted('session-2');
      });
      expect(result.current.sessions).toHaveLength(1);
      expect(result.current.sessions[0].id).toBe('session-1');
    });

    it('should handle rapid state changes', () => {
      const { result } = renderHook(() => useSessionState());

      // Rapid session creations
      act(() => {
        for (let i = 0; i < 10; i++) {
          result.current.handleSessionCreated(createMockSession({ id: `session-${i}` }));
        }
      });

      expect(result.current.sessions).toHaveLength(10);

      // Rapid activity updates
      act(() => {
        for (let i = 0; i < 10; i++) {
          result.current.handleWorkerActivity(`session-${i}`, 'worker-1', 'active');
        }
      });

      expect(Object.keys(result.current.workerActivityStates)).toHaveLength(10);
    });
  });
});
