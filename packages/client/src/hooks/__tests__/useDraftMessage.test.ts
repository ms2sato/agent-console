import { describe, it, expect, beforeEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useDraftMessage, clearDraftsForSession, _getDraftsMap } from '../useDraftMessage';

describe('useDraftMessage', () => {
  beforeEach(() => {
    _getDraftsMap().clear();
  });

  it('should initialize with empty content when no draft exists', () => {
    const { result } = renderHook(() => useDraftMessage('s1', 'w1'));
    expect(result.current.content).toBe('');
  });

  it('should initialize with existing draft content', () => {
    _getDraftsMap().set('s1:w1', 'saved draft');
    const { result } = renderHook(() => useDraftMessage('s1', 'w1'));
    expect(result.current.content).toBe('saved draft');
  });

  it('should update content and persist to map', () => {
    const { result } = renderHook(() => useDraftMessage('s1', 'w1'));

    act(() => {
      result.current.setContent('hello');
    });

    expect(result.current.content).toBe('hello');
    expect(_getDraftsMap().get('s1:w1')).toBe('hello');
  });

  it('should remove map entry when content is set to empty string', () => {
    const { result } = renderHook(() => useDraftMessage('s1', 'w1'));

    act(() => {
      result.current.setContent('hello');
    });
    expect(_getDraftsMap().has('s1:w1')).toBe(true);

    act(() => {
      result.current.setContent('');
    });
    expect(_getDraftsMap().has('s1:w1')).toBe(false);
  });

  it('should accept a function updater', () => {
    const { result } = renderHook(() => useDraftMessage('s1', 'w1'));

    act(() => {
      result.current.setContent('hello');
    });
    act(() => {
      result.current.setContent((prev) => prev + ' world');
    });

    expect(result.current.content).toBe('hello world');
    expect(_getDraftsMap().get('s1:w1')).toBe('hello world');
  });

  it('should save current draft and load new one when worker changes', () => {
    const { result, rerender } = renderHook(
      ({ sessionId, workerId }) => useDraftMessage(sessionId, workerId),
      { initialProps: { sessionId: 's1', workerId: 'w1' } },
    );

    act(() => {
      result.current.setContent('draft for w1');
    });

    // Switch to w2
    rerender({ sessionId: 's1', workerId: 'w2' });

    expect(result.current.content).toBe('');
    expect(_getDraftsMap().get('s1:w1')).toBe('draft for w1');
  });

  it('should restore draft when switching back to a previous worker', () => {
    const { result, rerender } = renderHook(
      ({ sessionId, workerId }) => useDraftMessage(sessionId, workerId),
      { initialProps: { sessionId: 's1', workerId: 'w1' } },
    );

    act(() => {
      result.current.setContent('draft for w1');
    });

    // Switch to w2 and write a draft
    rerender({ sessionId: 's1', workerId: 'w2' });
    act(() => {
      result.current.setContent('draft for w2');
    });

    // Switch back to w1
    rerender({ sessionId: 's1', workerId: 'w1' });
    expect(result.current.content).toBe('draft for w1');

    // Switch back to w2
    rerender({ sessionId: 's1', workerId: 'w2' });
    expect(result.current.content).toBe('draft for w2');
  });

  it('should handle different sessions independently', () => {
    _getDraftsMap().set('s1:w1', 'session 1 draft');
    _getDraftsMap().set('s2:w1', 'session 2 draft');

    const { result: r1 } = renderHook(() => useDraftMessage('s1', 'w1'));
    const { result: r2 } = renderHook(() => useDraftMessage('s2', 'w1'));

    expect(r1.current.content).toBe('session 1 draft');
    expect(r2.current.content).toBe('session 2 draft');
  });

  it('should clear draft from both state and map', () => {
    const { result } = renderHook(() => useDraftMessage('s1', 'w1'));

    act(() => {
      result.current.setContent('some draft');
    });
    expect(_getDraftsMap().has('s1:w1')).toBe(true);

    act(() => {
      result.current.clearDraft();
    });

    expect(result.current.content).toBe('');
    expect(_getDraftsMap().has('s1:w1')).toBe(false);
  });

  it('should handle undefined workerId gracefully', () => {
    const { result } = renderHook(() => useDraftMessage('s1', undefined));
    expect(result.current.content).toBe('');

    // setContent should not throw with undefined workerId
    act(() => {
      result.current.setContent('ignored');
    });
    expect(result.current.content).toBe('ignored');
    expect(_getDraftsMap().size).toBe(0);
  });
});

describe('clearDraftsForSession', () => {
  beforeEach(() => {
    _getDraftsMap().clear();
  });

  it('should remove all drafts for the given session', () => {
    _getDraftsMap().set('s1:w1', 'draft 1');
    _getDraftsMap().set('s1:w2', 'draft 2');
    _getDraftsMap().set('s2:w1', 'other session');

    clearDraftsForSession('s1');

    expect(_getDraftsMap().has('s1:w1')).toBe(false);
    expect(_getDraftsMap().has('s1:w2')).toBe(false);
    expect(_getDraftsMap().get('s2:w1')).toBe('other session');
  });

  it('should do nothing when no drafts exist for the session', () => {
    _getDraftsMap().set('s2:w1', 'other session');

    clearDraftsForSession('s1');

    expect(_getDraftsMap().size).toBe(1);
    expect(_getDraftsMap().get('s2:w1')).toBe('other session');
  });

  it('should not match session IDs that are prefixes of other IDs', () => {
    _getDraftsMap().set('s1:w1', 'short session');
    _getDraftsMap().set('s10:w1', 'longer session id');

    clearDraftsForSession('s1');

    expect(_getDraftsMap().has('s1:w1')).toBe(false);
    expect(_getDraftsMap().get('s10:w1')).toBe('longer session id');
  });
});
