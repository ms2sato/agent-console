import { describe, it, expect, beforeEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useSessionViewMode, STORAGE_KEY } from '../useSessionViewMode';

describe('useSessionViewMode', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('viewMode', () => {
    it('should default to flat', () => {
      const { result } = renderHook(() => useSessionViewMode());
      expect(result.current.viewMode).toBe('flat');
    });

    it('should read tree from localStorage', () => {
      localStorage.setItem(STORAGE_KEY, 'tree');
      const { result } = renderHook(() => useSessionViewMode());
      expect(result.current.viewMode).toBe('tree');
    });

    it('should ignore invalid localStorage values', () => {
      localStorage.setItem(STORAGE_KEY, 'invalid');
      const { result } = renderHook(() => useSessionViewMode());
      expect(result.current.viewMode).toBe('flat');
    });

    it('should use the documented storage key', () => {
      expect(STORAGE_KEY).toBe('session-view-mode');
    });
  });

  describe('setViewMode', () => {
    it('should update viewMode and persist to localStorage', () => {
      const { result } = renderHook(() => useSessionViewMode());

      act(() => {
        result.current.setViewMode('tree');
      });

      expect(result.current.viewMode).toBe('tree');
      expect(localStorage.getItem(STORAGE_KEY)).toBe('tree');
    });

    it('should toggle back to flat', () => {
      const { result } = renderHook(() => useSessionViewMode());

      act(() => {
        result.current.setViewMode('tree');
      });
      act(() => {
        result.current.setViewMode('flat');
      });

      expect(result.current.viewMode).toBe('flat');
      expect(localStorage.getItem(STORAGE_KEY)).toBe('flat');
    });

    it('should restore the persisted mode on remount', () => {
      const first = renderHook(() => useSessionViewMode());
      act(() => {
        first.result.current.setViewMode('tree');
      });
      first.unmount();

      const second = renderHook(() => useSessionViewMode());
      expect(second.result.current.viewMode).toBe('tree');
    });

    it('should still update state when localStorage throws', () => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = () => {
        throw new Error('quota');
      };
      try {
        const { result } = renderHook(() => useSessionViewMode());
        act(() => {
          result.current.setViewMode('tree');
        });
        expect(result.current.viewMode).toBe('tree');
      } finally {
        Storage.prototype.setItem = original;
      }
    });
  });
});
