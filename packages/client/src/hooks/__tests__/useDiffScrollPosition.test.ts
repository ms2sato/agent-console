import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useDiffScrollPosition } from '../useDiffScrollPosition';

describe('useDiffScrollPosition', () => {
  const sessionId = 'test-session';
  const workerId = 'test-worker';
  const storageKey = `agent-console:diff-scroll:${sessionId}:${workerId}`;

  beforeEach(() => {
    localStorage.clear();
  });

  describe('initial state', () => {
    it('should return null for visibleFile and initialScrollTarget when no stored value', () => {
      const { result } = renderHook(() => useDiffScrollPosition(sessionId, workerId));

      expect(result.current.visibleFile).toBe(null);
      expect(result.current.initialScrollTarget).toBe(null);
    });

    it('should read initialScrollTarget from localStorage', () => {
      localStorage.setItem(storageKey, 'src/components/Button.tsx');

      const { result } = renderHook(() => useDiffScrollPosition(sessionId, workerId));

      expect(result.current.initialScrollTarget).toBe('src/components/Button.tsx');
      // visibleFile should still be null initially
      expect(result.current.visibleFile).toBe(null);
    });
  });

  describe('setVisibleFile', () => {
    it('should update visibleFile but NOT persist to localStorage', () => {
      const { result } = renderHook(() => useDiffScrollPosition(sessionId, workerId));

      act(() => {
        result.current.setVisibleFile('src/utils/helpers.ts');
      });

      expect(result.current.visibleFile).toBe('src/utils/helpers.ts');
      // Should NOT persist to localStorage
      expect(localStorage.getItem(storageKey)).toBe(null);
    });

    it('should update when file changes without persisting', () => {
      const { result } = renderHook(() => useDiffScrollPosition(sessionId, workerId));

      act(() => {
        result.current.setVisibleFile('file1.ts');
      });
      expect(result.current.visibleFile).toBe('file1.ts');
      expect(localStorage.getItem(storageKey)).toBe(null);

      act(() => {
        result.current.setVisibleFile('file2.ts');
      });
      expect(result.current.visibleFile).toBe('file2.ts');
      expect(localStorage.getItem(storageKey)).toBe(null);
    });
  });

  describe('saveScrollPosition', () => {
    it('should update visibleFile and persist to localStorage', () => {
      const { result } = renderHook(() => useDiffScrollPosition(sessionId, workerId));

      act(() => {
        result.current.saveScrollPosition('src/utils/helpers.ts');
      });

      expect(result.current.visibleFile).toBe('src/utils/helpers.ts');
      expect(localStorage.getItem(storageKey)).toBe('src/utils/helpers.ts');
    });

    it('should update and persist when file changes', () => {
      const { result } = renderHook(() => useDiffScrollPosition(sessionId, workerId));

      act(() => {
        result.current.saveScrollPosition('file1.ts');
      });
      expect(result.current.visibleFile).toBe('file1.ts');
      expect(localStorage.getItem(storageKey)).toBe('file1.ts');

      act(() => {
        result.current.saveScrollPosition('file2.ts');
      });
      expect(result.current.visibleFile).toBe('file2.ts');
      expect(localStorage.getItem(storageKey)).toBe('file2.ts');
    });
  });

  describe('clearInitialScrollTarget', () => {
    it('should clear initialScrollTarget', () => {
      localStorage.setItem(storageKey, 'src/components/Button.tsx');

      const { result } = renderHook(() => useDiffScrollPosition(sessionId, workerId));
      expect(result.current.initialScrollTarget).toBe('src/components/Button.tsx');

      act(() => {
        result.current.clearInitialScrollTarget();
      });

      expect(result.current.initialScrollTarget).toBe(null);
    });

    it('should not affect visibleFile or localStorage', () => {
      localStorage.setItem(storageKey, 'src/components/Button.tsx');

      const { result } = renderHook(() => useDiffScrollPosition(sessionId, workerId));

      act(() => {
        result.current.saveScrollPosition('file.ts');
        result.current.clearInitialScrollTarget();
      });

      expect(result.current.initialScrollTarget).toBe(null);
      expect(result.current.visibleFile).toBe('file.ts');
      expect(localStorage.getItem(storageKey)).toBe('file.ts');
    });
  });

  describe('different session/worker combinations', () => {
    it('should use different storage keys for different sessions', () => {
      const key1 = 'agent-console:diff-scroll:session1:worker1';
      const key2 = 'agent-console:diff-scroll:session2:worker1';

      localStorage.setItem(key1, 'file1.ts');
      localStorage.setItem(key2, 'file2.ts');

      const { result: result1 } = renderHook(() => useDiffScrollPosition('session1', 'worker1'));
      const { result: result2 } = renderHook(() => useDiffScrollPosition('session2', 'worker1'));

      expect(result1.current.initialScrollTarget).toBe('file1.ts');
      expect(result2.current.initialScrollTarget).toBe('file2.ts');
    });

    it('should use different storage keys for different workers', () => {
      const key1 = 'agent-console:diff-scroll:session1:worker1';
      const key2 = 'agent-console:diff-scroll:session1:worker2';

      localStorage.setItem(key1, 'file1.ts');
      localStorage.setItem(key2, 'file2.ts');

      const { result: result1 } = renderHook(() => useDiffScrollPosition('session1', 'worker1'));
      const { result: result2 } = renderHook(() => useDiffScrollPosition('session1', 'worker2'));

      expect(result1.current.initialScrollTarget).toBe('file1.ts');
      expect(result2.current.initialScrollTarget).toBe('file2.ts');
    });
  });

  describe('localStorage error handling', () => {
    it('should return null when localStorage.getItem throws', () => {
      const getItemSpy = spyOn(localStorage, 'getItem').mockImplementation(() => {
        throw new Error('Storage error');
      });

      const { result } = renderHook(() => useDiffScrollPosition(sessionId, workerId));

      expect(result.current.initialScrollTarget).toBe(null);

      getItemSpy.mockRestore();
    });

    it('should handle localStorage.setItem throwing an error gracefully', () => {
      const setItemSpy = spyOn(localStorage, 'setItem').mockImplementation(() => {
        throw new Error('Storage quota exceeded');
      });

      const { result } = renderHook(() => useDiffScrollPosition(sessionId, workerId));

      // Should not throw, state should still update
      act(() => {
        result.current.saveScrollPosition('file.ts');
      });

      expect(result.current.visibleFile).toBe('file.ts');

      setItemSpy.mockRestore();
    });
  });

  describe('persistence across remounts', () => {
    it('should restore scroll position after unmount and remount', () => {
      const { result, unmount } = renderHook(() => useDiffScrollPosition(sessionId, workerId));

      // Save scroll position (explicit user action)
      act(() => {
        result.current.saveScrollPosition('src/MyComponent.tsx');
      });

      expect(localStorage.getItem(storageKey)).toBe('src/MyComponent.tsx');

      // Unmount
      unmount();

      // Remount - should restore the scroll target
      const { result: newResult } = renderHook(() => useDiffScrollPosition(sessionId, workerId));

      expect(newResult.current.initialScrollTarget).toBe('src/MyComponent.tsx');
    });

    it('should NOT restore scroll position from setVisibleFile (non-persisted)', () => {
      const { result, unmount } = renderHook(() => useDiffScrollPosition(sessionId, workerId));

      // Set visible file (IntersectionObserver update, NOT persisted)
      act(() => {
        result.current.setVisibleFile('src/MyComponent.tsx');
      });

      expect(localStorage.getItem(storageKey)).toBe(null);

      // Unmount
      unmount();

      // Remount - should NOT have any scroll target
      const { result: newResult } = renderHook(() => useDiffScrollPosition(sessionId, workerId));

      expect(newResult.current.initialScrollTarget).toBe(null);
    });
  });
});
