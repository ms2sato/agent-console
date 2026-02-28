import { describe, it, expect, mock, afterEach } from 'bun:test';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useIsMobile } from '../useIsMobile';

function createMockMatchMedia(matches: boolean) {
  let changeListener: ((e: { matches: boolean }) => void) | null = null;
  const mql = {
    matches,
    addEventListener: mock(
      (event: string, listener: (e: { matches: boolean }) => void) => {
        if (event === 'change') changeListener = listener;
      }
    ),
    removeEventListener: mock((event: string, _listener: unknown) => {
      if (event === 'change') changeListener = null;
    }),
  };
  const matchMedia = mock((_query: string) => mql as unknown as MediaQueryList);
  return {
    matchMedia,
    mql,
    triggerChange: (newMatches: boolean) => {
      mql.matches = newMatches;
      changeListener?.({ matches: newMatches });
    },
  };
}

describe('useIsMobile', () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    cleanup();
    window.matchMedia = originalMatchMedia;
  });

  it('returns true when viewport is below 768px', () => {
    const { matchMedia } = createMockMatchMedia(true);
    window.matchMedia = matchMedia;

    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(true);
  });

  it('returns false when viewport is 768px or above', () => {
    const { matchMedia } = createMockMatchMedia(false);
    window.matchMedia = matchMedia;

    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(false);
  });

  it('responds to matchMedia change events', () => {
    const { matchMedia, triggerChange } = createMockMatchMedia(false);
    window.matchMedia = matchMedia;

    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    act(() => {
      triggerChange(true);
    });

    expect(result.current).toBe(true);
  });

  it('cleans up event listener on unmount', () => {
    const { matchMedia, mql } = createMockMatchMedia(false);
    window.matchMedia = matchMedia;

    const { unmount } = renderHook(() => useIsMobile());

    expect(mql.addEventListener).toHaveBeenCalledWith(
      'change',
      expect.any(Function)
    );

    unmount();

    expect(mql.removeEventListener).toHaveBeenCalledWith(
      'change',
      expect.any(Function)
    );
  });
});
