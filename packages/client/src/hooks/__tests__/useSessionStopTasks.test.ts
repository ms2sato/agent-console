import { describe, it, expect } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useSessionStopTasks } from '../useSessionStopTasks';

describe('useSessionStopTasks', () => {
  it('addTask adds a new task and returns true', () => {
    const { result } = renderHook(() => useSessionStopTasks());

    let added = false;
    act(() => {
      added = result.current.addTask({ sessionId: 'session-1', action: 'stop', sessionTitle: 'My Session' });
    });

    expect(added).toBe(true);
    expect(result.current.tasks).toEqual([
      { sessionId: 'session-1', action: 'stop', sessionTitle: 'My Session', error: null },
    ]);
  });

  it('addTask returns false and does not create a duplicate for an existing sessionId', () => {
    const { result } = renderHook(() => useSessionStopTasks());

    act(() => {
      result.current.addTask({ sessionId: 'session-1', action: 'stop' });
    });

    let secondAdded = true;
    act(() => {
      // Even a different action for the same sessionId must be rejected --
      // at most one task per session, regardless of action.
      secondAdded = result.current.addTask({ sessionId: 'session-1', action: 'pause' });
    });

    expect(secondAdded).toBe(false);
    expect(result.current.tasks.length).toBe(1);
    expect(result.current.tasks[0].action).toBe('stop');
  });

  it('removeTask removes the task', () => {
    const { result } = renderHook(() => useSessionStopTasks());

    act(() => {
      result.current.addTask({ sessionId: 'session-1', action: 'stop' });
    });
    expect(result.current.tasks.length).toBe(1);

    act(() => {
      result.current.removeTask('session-1');
    });

    expect(result.current.tasks).toEqual([]);
  });

  it('markAsFailed sets the error and keeps the task', () => {
    const { result } = renderHook(() => useSessionStopTasks());

    act(() => {
      result.current.addTask({ sessionId: 'session-1', action: 'pause' });
    });

    act(() => {
      result.current.markAsFailed('session-1', 'Network error');
    });

    expect(result.current.tasks).toEqual([
      { sessionId: 'session-1', action: 'pause', sessionTitle: undefined, error: 'Network error' },
    ]);
  });

  it('getTask returns undefined for an unknown sessionId', () => {
    const { result } = renderHook(() => useSessionStopTasks());

    expect(result.current.getTask('unknown-session')).toBeUndefined();
  });
});
