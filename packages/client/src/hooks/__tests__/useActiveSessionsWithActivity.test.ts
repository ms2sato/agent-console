import { describe, it, expect } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { useActiveSessionsWithActivity } from '../useActiveSessionsWithActivity';
import type { Session, AgentActivityState } from '@agent-console/shared';

// Helper to create mock session
function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: `session-${Math.random().toString(36).slice(2)}`,
    type: 'quick',
    locationPath: '/test/path',
    status: 'active',
    activationState: 'running',
    createdAt: new Date().toISOString(),
    workers: [],
    ...overrides,
  } as Session;
}

// Helper to create worker activity states
function createWorkerActivityStates(
  entries: Array<{ sessionId: string; workerId: string; state: AgentActivityState }>
): Record<string, Record<string, AgentActivityState>> {
  const result: Record<string, Record<string, AgentActivityState>> = {};
  for (const { sessionId, workerId, state } of entries) {
    if (!result[sessionId]) {
      result[sessionId] = {};
    }
    result[sessionId][workerId] = state;
  }
  return result;
}

describe('useActiveSessionsWithActivity', () => {
  describe('empty input', () => {
    it('should return empty array for empty sessions', () => {
      const { result } = renderHook(() =>
        useActiveSessionsWithActivity([], {})
      );

      expect(result.current).toEqual([]);
    });

    it('should return empty array for sessions with empty activity states', () => {
      const sessions = [createMockSession({ id: 'session-1' })];

      const { result } = renderHook(() =>
        useActiveSessionsWithActivity(sessions, {})
      );

      expect(result.current).toEqual([]);
    });
  });

  describe('unknown activity filtering', () => {
    it('should filter out sessions with unknown activity state', () => {
      const sessions = [
        createMockSession({ id: 'session-1' }),
        createMockSession({ id: 'session-2' }),
      ];
      const activityStates = createWorkerActivityStates([
        { sessionId: 'session-1', workerId: 'worker-1', state: 'unknown' },
      ]);

      const { result } = renderHook(() =>
        useActiveSessionsWithActivity(sessions, activityStates)
      );

      expect(result.current).toEqual([]);
    });

    it('should filter out sessions with no activity states entry', () => {
      const sessions = [createMockSession({ id: 'session-1' })];

      const { result } = renderHook(() =>
        useActiveSessionsWithActivity(sessions, {})
      );

      expect(result.current).toEqual([]);
    });

    it('should filter out sessions with empty workers in activity states', () => {
      const sessions = [createMockSession({ id: 'session-1' })];
      const activityStates = { 'session-1': {} };

      const { result } = renderHook(() =>
        useActiveSessionsWithActivity(sessions, activityStates)
      );

      expect(result.current).toEqual([]);
    });
  });

  describe('single session with activity', () => {
    it('should return session with asking state', () => {
      const session = createMockSession({ id: 'session-1' });
      const activityStates = createWorkerActivityStates([
        { sessionId: 'session-1', workerId: 'worker-1', state: 'asking' },
      ]);

      const { result } = renderHook(() =>
        useActiveSessionsWithActivity([session], activityStates)
      );

      expect(result.current).toHaveLength(1);
      expect(result.current[0].session.id).toBe('session-1');
      expect(result.current[0].activityState).toBe('asking');
    });

    it('should return session with idle state', () => {
      const session = createMockSession({ id: 'session-1' });
      const activityStates = createWorkerActivityStates([
        { sessionId: 'session-1', workerId: 'worker-1', state: 'idle' },
      ]);

      const { result } = renderHook(() =>
        useActiveSessionsWithActivity([session], activityStates)
      );

      expect(result.current).toHaveLength(1);
      expect(result.current[0].activityState).toBe('idle');
    });

    it('should return session with active state', () => {
      const session = createMockSession({ id: 'session-1' });
      const activityStates = createWorkerActivityStates([
        { sessionId: 'session-1', workerId: 'worker-1', state: 'active' },
      ]);

      const { result } = renderHook(() =>
        useActiveSessionsWithActivity([session], activityStates)
      );

      expect(result.current).toHaveLength(1);
      expect(result.current[0].activityState).toBe('active');
    });
  });

  describe('priority sorting', () => {
    it('should sort asking before idle', () => {
      const sessions = [
        createMockSession({ id: 'idle-session' }),
        createMockSession({ id: 'asking-session' }),
      ];
      const activityStates = createWorkerActivityStates([
        { sessionId: 'idle-session', workerId: 'worker-1', state: 'idle' },
        { sessionId: 'asking-session', workerId: 'worker-1', state: 'asking' },
      ]);

      const { result } = renderHook(() =>
        useActiveSessionsWithActivity(sessions, activityStates)
      );

      expect(result.current).toHaveLength(2);
      expect(result.current[0].session.id).toBe('asking-session');
      expect(result.current[1].session.id).toBe('idle-session');
    });

    it('should sort idle before active', () => {
      const sessions = [
        createMockSession({ id: 'active-session' }),
        createMockSession({ id: 'idle-session' }),
      ];
      const activityStates = createWorkerActivityStates([
        { sessionId: 'active-session', workerId: 'worker-1', state: 'active' },
        { sessionId: 'idle-session', workerId: 'worker-1', state: 'idle' },
      ]);

      const { result } = renderHook(() =>
        useActiveSessionsWithActivity(sessions, activityStates)
      );

      expect(result.current).toHaveLength(2);
      expect(result.current[0].session.id).toBe('idle-session');
      expect(result.current[1].session.id).toBe('active-session');
    });

    it('should sort asking > idle > active', () => {
      const sessions = [
        createMockSession({ id: 'active-session' }),
        createMockSession({ id: 'asking-session' }),
        createMockSession({ id: 'idle-session' }),
      ];
      const activityStates = createWorkerActivityStates([
        { sessionId: 'active-session', workerId: 'worker-1', state: 'active' },
        { sessionId: 'asking-session', workerId: 'worker-1', state: 'asking' },
        { sessionId: 'idle-session', workerId: 'worker-1', state: 'idle' },
      ]);

      const { result } = renderHook(() =>
        useActiveSessionsWithActivity(sessions, activityStates)
      );

      expect(result.current).toHaveLength(3);
      expect(result.current[0].session.id).toBe('asking-session');
      expect(result.current[1].session.id).toBe('idle-session');
      expect(result.current[2].session.id).toBe('active-session');
    });

    it('should maintain order for same priority', () => {
      const sessions = [
        createMockSession({ id: 'idle-1' }),
        createMockSession({ id: 'idle-2' }),
        createMockSession({ id: 'idle-3' }),
      ];
      const activityStates = createWorkerActivityStates([
        { sessionId: 'idle-1', workerId: 'worker-1', state: 'idle' },
        { sessionId: 'idle-2', workerId: 'worker-1', state: 'idle' },
        { sessionId: 'idle-3', workerId: 'worker-1', state: 'idle' },
      ]);

      const { result } = renderHook(() =>
        useActiveSessionsWithActivity(sessions, activityStates)
      );

      expect(result.current).toHaveLength(3);
      // All have same priority, so relative order should be preserved
      expect(result.current.map(s => s.session.id)).toEqual(['idle-1', 'idle-2', 'idle-3']);
    });
  });

  describe('multiple workers aggregation', () => {
    it('should pick highest priority state among workers (asking)', () => {
      const session = createMockSession({ id: 'session-1' });
      const activityStates = createWorkerActivityStates([
        { sessionId: 'session-1', workerId: 'worker-1', state: 'active' },
        { sessionId: 'session-1', workerId: 'worker-2', state: 'asking' },
        { sessionId: 'session-1', workerId: 'worker-3', state: 'idle' },
      ]);

      const { result } = renderHook(() =>
        useActiveSessionsWithActivity([session], activityStates)
      );

      expect(result.current).toHaveLength(1);
      expect(result.current[0].activityState).toBe('asking');
    });

    it('should pick highest priority state among workers (idle over active)', () => {
      const session = createMockSession({ id: 'session-1' });
      const activityStates = createWorkerActivityStates([
        { sessionId: 'session-1', workerId: 'worker-1', state: 'active' },
        { sessionId: 'session-1', workerId: 'worker-2', state: 'idle' },
        { sessionId: 'session-1', workerId: 'worker-3', state: 'active' },
      ]);

      const { result } = renderHook(() =>
        useActiveSessionsWithActivity([session], activityStates)
      );

      expect(result.current).toHaveLength(1);
      expect(result.current[0].activityState).toBe('idle');
    });

    it('should ignore unknown workers when aggregating', () => {
      const session = createMockSession({ id: 'session-1' });
      const activityStates = createWorkerActivityStates([
        { sessionId: 'session-1', workerId: 'worker-1', state: 'unknown' },
        { sessionId: 'session-1', workerId: 'worker-2', state: 'active' },
      ]);

      const { result } = renderHook(() =>
        useActiveSessionsWithActivity([session], activityStates)
      );

      expect(result.current).toHaveLength(1);
      expect(result.current[0].activityState).toBe('active');
    });

    it('should return unknown if all workers are unknown', () => {
      const session = createMockSession({ id: 'session-1' });
      const activityStates = createWorkerActivityStates([
        { sessionId: 'session-1', workerId: 'worker-1', state: 'unknown' },
        { sessionId: 'session-1', workerId: 'worker-2', state: 'unknown' },
      ]);

      const { result } = renderHook(() =>
        useActiveSessionsWithActivity([session], activityStates)
      );

      // Session with only unknown workers should be filtered out
      expect(result.current).toHaveLength(0);
    });
  });

  describe('mixed sessions', () => {
    it('should filter and sort correctly with mixed states', () => {
      const sessions = [
        createMockSession({ id: 'unknown-only' }),
        createMockSession({ id: 'active-session' }),
        createMockSession({ id: 'asking-session' }),
        createMockSession({ id: 'no-activity' }),
        createMockSession({ id: 'idle-session' }),
      ];
      const activityStates = createWorkerActivityStates([
        { sessionId: 'unknown-only', workerId: 'worker-1', state: 'unknown' },
        { sessionId: 'active-session', workerId: 'worker-1', state: 'active' },
        { sessionId: 'asking-session', workerId: 'worker-1', state: 'asking' },
        // no-activity has no entry
        { sessionId: 'idle-session', workerId: 'worker-1', state: 'idle' },
      ]);

      const { result } = renderHook(() =>
        useActiveSessionsWithActivity(sessions, activityStates)
      );

      // Should exclude unknown-only and no-activity
      expect(result.current).toHaveLength(3);
      // Should be sorted: asking > idle > active
      expect(result.current[0].session.id).toBe('asking-session');
      expect(result.current[1].session.id).toBe('idle-session');
      expect(result.current[2].session.id).toBe('active-session');
    });

    it('should handle complex scenario with multiple workers per session', () => {
      const sessions = [
        createMockSession({ id: 'session-a' }), // Will have asking (highest from workers)
        createMockSession({ id: 'session-b' }), // Will have idle (highest from workers)
        createMockSession({ id: 'session-c' }), // Will have active only
      ];
      const activityStates = createWorkerActivityStates([
        { sessionId: 'session-a', workerId: 'worker-1', state: 'active' },
        { sessionId: 'session-a', workerId: 'worker-2', state: 'asking' },
        { sessionId: 'session-b', workerId: 'worker-1', state: 'idle' },
        { sessionId: 'session-b', workerId: 'worker-2', state: 'active' },
        { sessionId: 'session-c', workerId: 'worker-1', state: 'active' },
      ]);

      const { result } = renderHook(() =>
        useActiveSessionsWithActivity(sessions, activityStates)
      );

      expect(result.current).toHaveLength(3);
      expect(result.current[0].session.id).toBe('session-a');
      expect(result.current[0].activityState).toBe('asking');
      expect(result.current[1].session.id).toBe('session-b');
      expect(result.current[1].activityState).toBe('idle');
      expect(result.current[2].session.id).toBe('session-c');
      expect(result.current[2].activityState).toBe('active');
    });
  });

  describe('memoization behavior', () => {
    it('should return same reference for same inputs', () => {
      const sessions = [createMockSession({ id: 'session-1' })];
      const activityStates = createWorkerActivityStates([
        { sessionId: 'session-1', workerId: 'worker-1', state: 'active' },
      ]);

      const { result, rerender } = renderHook(() =>
        useActiveSessionsWithActivity(sessions, activityStates)
      );

      const firstResult = result.current;
      rerender();
      const secondResult = result.current;

      expect(firstResult).toBe(secondResult);
    });

    it('should return new reference when sessions change', () => {
      const initialSessions = [createMockSession({ id: 'session-1' })];
      const activityStates = createWorkerActivityStates([
        { sessionId: 'session-1', workerId: 'worker-1', state: 'active' },
        { sessionId: 'session-2', workerId: 'worker-1', state: 'idle' },
      ]);

      const { result, rerender } = renderHook(
        ({ sessions }) => useActiveSessionsWithActivity(sessions, activityStates),
        { initialProps: { sessions: initialSessions } }
      );

      const firstResult = result.current;

      const newSessions = [
        ...initialSessions,
        createMockSession({ id: 'session-2' }),
      ];
      rerender({ sessions: newSessions });

      expect(result.current).not.toBe(firstResult);
      expect(result.current).toHaveLength(2);
    });
  });
});
