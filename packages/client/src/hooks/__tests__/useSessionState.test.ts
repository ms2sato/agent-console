import { describe, it, expect } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useSessionState } from '../useSessionState';
import type { Session, WorkerActivityInfo, Worker } from '@agent-console/shared';

// Helper to create a mock worker
function createMockWorker(id: string): Worker {
  return {
    id,
    name: `Worker ${id}`,
    type: 'terminal',
    activated: true,
    createdAt: new Date().toISOString(),
  };
}

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

    it('should not add session if not yet in the list (replace-only)', () => {
      const { result } = renderHook(() => useSessionState());

      const session = createMockSession({ id: 'session-1' });
      const unknownSession = createMockSession({ id: 'session-2', title: 'Unknown' });

      act(() => {
        result.current.handleSessionsSync([session], []);
      });

      act(() => {
        result.current.handleSessionUpdated(unknownSession);
      });

      expect(result.current.sessions).toHaveLength(1);
      expect(result.current.sessions[0].id).toBe('session-1');
      expect(result.current.sessionsRef.current).toHaveLength(1);
    });

    it('should not resurrect a deleted session', () => {
      const { result } = renderHook(() => useSessionState());

      const session = createMockSession({ id: 'session-1', title: 'Original' });

      act(() => {
        result.current.handleSessionsSync([session], []);
      });

      // Delete the session
      act(() => {
        result.current.handleSessionDeleted('session-1');
      });
      expect(result.current.sessions).toHaveLength(0);

      // Stale update arrives after deletion - should NOT re-add the session
      act(() => {
        result.current.handleSessionUpdated({ ...session, title: 'Stale Update' });
      });

      expect(result.current.sessions).toHaveLength(0);
      expect(result.current.sessionsRef.current).toHaveLength(0);
    });

    it('should prune workerActivityStates for removed workers', () => {
      const { result } = renderHook(() => useSessionState());

      const worker1 = createMockWorker('worker-1');
      const worker2 = createMockWorker('worker-2');
      const session = createMockSession({
        id: 'session-1',
        workers: [worker1, worker2],
      });

      act(() => {
        result.current.handleSessionsSync([session], [
          { sessionId: 'session-1', workerId: 'worker-1', activityState: 'active' },
          { sessionId: 'session-1', workerId: 'worker-2', activityState: 'idle' },
        ]);
      });

      expect(result.current.workerActivityStates['session-1']).toEqual({
        'worker-1': 'active',
        'worker-2': 'idle',
      });

      // Worker-2 is removed from session
      const updatedSession = { ...session, workers: [worker1] };

      act(() => {
        result.current.handleSessionUpdated(updatedSession);
      });

      expect(result.current.workerActivityStates['session-1']).toEqual({
        'worker-1': 'active',
      });
      expect(result.current.workerActivityStates['session-1']['worker-2']).toBeUndefined();
    });

    it('should remove session entry from workerActivityStates when all workers are removed', () => {
      const { result } = renderHook(() => useSessionState());

      const worker1 = createMockWorker('worker-1');
      const session = createMockSession({
        id: 'session-1',
        workers: [worker1],
      });

      act(() => {
        result.current.handleSessionsSync([session], [
          { sessionId: 'session-1', workerId: 'worker-1', activityState: 'active' },
        ]);
      });

      // All workers removed
      const updatedSession = { ...session, workers: [] };

      act(() => {
        result.current.handleSessionUpdated(updatedSession);
      });

      expect(result.current.workerActivityStates['session-1']).toBeUndefined();
    });

    it('should not modify workerActivityStates when workers have not changed', () => {
      const { result } = renderHook(() => useSessionState());

      const worker1 = createMockWorker('worker-1');
      const session = createMockSession({
        id: 'session-1',
        workers: [worker1],
        title: 'Original',
      });

      act(() => {
        result.current.handleSessionsSync([session], [
          { sessionId: 'session-1', workerId: 'worker-1', activityState: 'active' },
        ]);
      });

      const statesBefore = result.current.workerActivityStates;

      // Update title only, same workers
      act(() => {
        result.current.handleSessionUpdated({ ...session, title: 'Updated' });
      });

      // Same reference since no pruning was needed
      expect(result.current.workerActivityStates).toBe(statesBefore);
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

  describe('handleSessionPaused', () => {
    it('should replace session with the server-provided paused session', () => {
      const { result } = renderHook(() => useSessionState());

      const session = createMockSession({ id: 'session-1', activationState: 'running' });

      act(() => {
        result.current.handleSessionsSync([session], []);
      });

      const pausedSession = createMockSession({
        id: 'session-1',
        activationState: 'hibernated',
        pausedAt: '2025-01-01T00:00:00.000Z',
      });

      act(() => {
        result.current.handleSessionPaused(pausedSession);
      });

      expect(result.current.sessions[0].pausedAt).toBe('2025-01-01T00:00:00.000Z');
      expect(result.current.sessions[0].activationState).toBe('hibernated');
      expect(result.current.sessionsRef.current[0].pausedAt).toBe('2025-01-01T00:00:00.000Z');
      expect(result.current.sessionsRef.current[0].activationState).toBe('hibernated');
    });

    it('should not affect other sessions', () => {
      const { result } = renderHook(() => useSessionState());

      const session1 = createMockSession({ id: 'session-1', activationState: 'running' });
      const session2 = createMockSession({ id: 'session-2', activationState: 'running' });

      act(() => {
        result.current.handleSessionsSync([session1, session2], []);
      });

      const pausedSession1 = createMockSession({
        id: 'session-1',
        activationState: 'hibernated',
        pausedAt: '2025-01-01T00:00:00.000Z',
      });

      act(() => {
        result.current.handleSessionPaused(pausedSession1);
      });

      expect(result.current.sessions[0].pausedAt).toBeDefined();
      expect(result.current.sessions[1].pausedAt).toBeUndefined();
      expect(result.current.sessions[1].activationState).toBe('running');
    });

    it('should clean up workerActivityStates for paused session', () => {
      const { result } = renderHook(() => useSessionState());

      const worker1 = createMockWorker('worker-1');
      const session1 = createMockSession({ id: 'session-1', workers: [worker1] });
      const session2 = createMockSession({ id: 'session-2', workers: [createMockWorker('worker-2')] });

      act(() => {
        result.current.handleSessionsSync([session1, session2], [
          { sessionId: 'session-1', workerId: 'worker-1', activityState: 'asking' },
          { sessionId: 'session-2', workerId: 'worker-2', activityState: 'active' },
        ]);
      });

      expect(result.current.workerActivityStates['session-1']).toBeDefined();
      expect(result.current.workerActivityStates['session-2']).toBeDefined();

      const pausedSession1 = createMockSession({
        id: 'session-1',
        activationState: 'hibernated',
        pausedAt: '2025-01-01T00:00:00.000Z',
        workers: [worker1],
      });

      act(() => {
        result.current.handleSessionPaused(pausedSession1);
      });

      // Activity states for paused session should be cleaned up
      expect(result.current.workerActivityStates['session-1']).toBeUndefined();
      // Activity states for other sessions should be preserved
      expect(result.current.workerActivityStates['session-2']).toEqual({ 'worker-2': 'active' });
    });
  });

  describe('handleSessionResumed', () => {
    it('should add resumed session if not in list', () => {
      const { result } = renderHook(() => useSessionState());

      act(() => {
        result.current.handleSessionsSync([], []);
      });

      const resumedSession = createMockSession({ id: 'session-1', activationState: 'running' });

      act(() => {
        result.current.handleSessionResumed(resumedSession, []);
      });

      expect(result.current.sessions).toHaveLength(1);
      expect(result.current.sessions[0].id).toBe('session-1');
      expect(result.current.sessionsRef.current).toHaveLength(1);
    });

    it('should update existing session when resumed', () => {
      const { result } = renderHook(() => useSessionState());

      const session = createMockSession({ id: 'session-1', activationState: 'hibernated', pausedAt: '2024-01-01T00:00:00.000Z' });

      act(() => {
        result.current.handleSessionsSync([session], []);
      });

      const resumedSession = createMockSession({ id: 'session-1', activationState: 'running' });

      act(() => {
        result.current.handleSessionResumed(resumedSession, []);
      });

      expect(result.current.sessions).toHaveLength(1);
      expect(result.current.sessions[0].activationState).toBe('running');
      expect(result.current.sessions[0].pausedAt).toBeUndefined();
    });

    it('should initialize activity states from activityStates parameter', () => {
      const { result } = renderHook(() => useSessionState());

      const session = createMockSession({ id: 'session-1', activationState: 'hibernated', pausedAt: '2024-01-01T00:00:00.000Z' });

      act(() => {
        result.current.handleSessionsSync([session], []);
      });

      const resumedSession = createMockSession({ id: 'session-1', activationState: 'running' });
      const activityStates: WorkerActivityInfo[] = [
        { sessionId: 'session-1', workerId: 'worker-1', activityState: 'active' },
        { sessionId: 'session-1', workerId: 'worker-2', activityState: 'idle' },
      ];

      act(() => {
        result.current.handleSessionResumed(resumedSession, activityStates);
      });

      expect(result.current.workerActivityStates['session-1']).toEqual({
        'worker-1': 'active',
        'worker-2': 'idle',
      });
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
