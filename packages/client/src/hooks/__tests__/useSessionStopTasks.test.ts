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
      { sessionId: 'session-1', action: 'stop', sessionTitle: 'My Session', status: 'pending', error: null },
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
      { sessionId: 'session-1', action: 'pause', sessionTitle: undefined, status: 'failed', error: 'Network error' },
    ]);
  });

  it('getTask returns undefined for an unknown sessionId', () => {
    const { result } = renderHook(() => useSessionStopTasks());

    expect(result.current.getTask('unknown-session')).toBeUndefined();
  });

  it('starts with zero tasks', () => {
    const { result } = renderHook(() => useSessionStopTasks());
    expect(result.current.tasks).toEqual([]);
  });

  it('markAsSucceeded sets status succeeded and clears a previous error', () => {
    const { result } = renderHook(() => useSessionStopTasks());
    act(() => {
      result.current.addTask({ sessionId: 'session-1', action: 'pause', sessionTitle: 'T' });
    });
    act(() => {
      result.current.markAsFailed('session-1', 'boom');
    });
    act(() => {
      result.current.markAsSucceeded('session-1');
    });

    expect(result.current.tasks).toEqual([
      { sessionId: 'session-1', action: 'pause', sessionTitle: 'T', status: 'succeeded', error: null },
    ]);
  });

  it('markAsSucceeded on an unknown session is a no-op', () => {
    const { result } = renderHook(() => useSessionStopTasks());
    act(() => {
      result.current.markAsSucceeded('nope');
    });
    expect(result.current.tasks).toEqual([]);
  });

  it('markAsPending resets a failed task to pending and clears the error', () => {
    const { result } = renderHook(() => useSessionStopTasks());
    act(() => {
      result.current.addTask({ sessionId: 'session-1', action: 'stop' });
    });
    act(() => {
      result.current.markAsFailed('session-1', 'boom');
    });
    act(() => {
      result.current.markAsPending('session-1');
    });

    expect(result.current.tasks[0].status).toBe('pending');
    expect(result.current.tasks[0].error).toBeNull();
  });

  it('addTask replaces a succeeded task for the same session but rejects a pending or failed one', () => {
    const { result } = renderHook(() => useSessionStopTasks());
    act(() => {
      result.current.addTask({ sessionId: 'session-1', action: 'pause' });
    });
    act(() => {
      result.current.markAsFailed('session-1', 'boom');
    });

    let added = true;
    act(() => {
      added = result.current.addTask({ sessionId: 'session-1', action: 'pause' });
    });
    expect(added).toBe(false);

    act(() => {
      result.current.markAsSucceeded('session-1');
    });
    act(() => {
      added = result.current.addTask({ sessionId: 'session-1', action: 'pause' });
    });
    expect(added).toBe(true);
    expect(result.current.tasks.length).toBe(1);
    expect(result.current.tasks[0].status).toBe('pending');
  });

  it('tracks mixed pending / succeeded / failed tasks independently', () => {
    const { result } = renderHook(() => useSessionStopTasks());
    act(() => {
      result.current.addTask({ sessionId: 'a', action: 'pause' });
      result.current.addTask({ sessionId: 'b', action: 'stop' });
      result.current.addTask({ sessionId: 'c', action: 'pause' });
    });
    act(() => {
      result.current.markAsSucceeded('b');
      result.current.markAsFailed('c', 'x');
    });

    expect(result.current.tasks.map((t) => [t.sessionId, t.status])).toEqual([
      ['a', 'pending'],
      ['b', 'succeeded'],
      ['c', 'failed'],
    ]);
  });
});
