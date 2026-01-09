import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import {
  useSidebarState,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
} from '../useSidebarState';

const SIDEBAR_COLLAPSED_KEY = 'agent-console:sidebar-collapsed';
const SIDEBAR_WIDTH_KEY = 'agent-console:sidebar-width';

describe('useSidebarState', () => {
  // Clear localStorage before each test
  beforeEach(() => {
    localStorage.clear();
  });

  describe('initial state', () => {
    it('should default to collapsed=false and width=224', () => {
      const { result } = renderHook(() => useSidebarState());

      expect(result.current.collapsed).toBe(false);
      expect(result.current.width).toBe(SIDEBAR_DEFAULT_WIDTH);
    });
  });

  describe('localStorage initialization', () => {
    it('should read initial collapsed value from localStorage', () => {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(true));

      const { result } = renderHook(() => useSidebarState());

      expect(result.current.collapsed).toBe(true);
    });

    it('should read initial width value from localStorage', () => {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, JSON.stringify(300));

      const { result } = renderHook(() => useSidebarState());

      expect(result.current.width).toBe(300);
    });

    it('should clamp width from localStorage to min/max bounds', () => {
      // Test value below min
      localStorage.setItem(SIDEBAR_WIDTH_KEY, JSON.stringify(50));
      const { result: resultMin } = renderHook(() => useSidebarState());
      expect(resultMin.current.width).toBe(SIDEBAR_MIN_WIDTH);

      // Test value above max
      localStorage.clear();
      localStorage.setItem(SIDEBAR_WIDTH_KEY, JSON.stringify(1000));
      const { result: resultMax } = renderHook(() => useSidebarState());
      expect(resultMax.current.width).toBe(SIDEBAR_MAX_WIDTH);
    });
  });

  describe('setCollapsed', () => {
    it('should update collapsed state and persist to localStorage', () => {
      const { result } = renderHook(() => useSidebarState());

      act(() => {
        result.current.setCollapsed(true);
      });

      expect(result.current.collapsed).toBe(true);
      expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe(JSON.stringify(true));
    });

    it('should update from true to false', () => {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(true));
      const { result } = renderHook(() => useSidebarState());

      act(() => {
        result.current.setCollapsed(false);
      });

      expect(result.current.collapsed).toBe(false);
      expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe(JSON.stringify(false));
    });
  });

  describe('toggle', () => {
    it('should toggle collapsed state from false to true', () => {
      const { result } = renderHook(() => useSidebarState());

      act(() => {
        result.current.toggle();
      });

      expect(result.current.collapsed).toBe(true);
      expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe(JSON.stringify(true));
    });

    it('should toggle collapsed state from true to false', () => {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(true));
      const { result } = renderHook(() => useSidebarState());

      act(() => {
        result.current.toggle();
      });

      expect(result.current.collapsed).toBe(false);
      expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe(JSON.stringify(false));
    });

    it('should toggle multiple times correctly', () => {
      const { result } = renderHook(() => useSidebarState());

      act(() => {
        result.current.toggle();
      });
      expect(result.current.collapsed).toBe(true);

      act(() => {
        result.current.toggle();
      });
      expect(result.current.collapsed).toBe(false);

      act(() => {
        result.current.toggle();
      });
      expect(result.current.collapsed).toBe(true);
    });
  });

  describe('setWidth', () => {
    it('should update width and persist to localStorage', () => {
      const { result } = renderHook(() => useSidebarState());

      act(() => {
        result.current.setWidth(300);
      });

      expect(result.current.width).toBe(300);
      expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(JSON.stringify(300));
    });
  });

  describe('setWidth clamping', () => {
    it('should clamp width to minimum bound', () => {
      const { result } = renderHook(() => useSidebarState());

      act(() => {
        result.current.setWidth(50);
      });

      expect(result.current.width).toBe(SIDEBAR_MIN_WIDTH);
      expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(JSON.stringify(SIDEBAR_MIN_WIDTH));
    });

    it('should clamp width to maximum bound', () => {
      const { result } = renderHook(() => useSidebarState());

      act(() => {
        result.current.setWidth(1000);
      });

      expect(result.current.width).toBe(SIDEBAR_MAX_WIDTH);
      expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(JSON.stringify(SIDEBAR_MAX_WIDTH));
    });

    it('should accept values within bounds', () => {
      const { result } = renderHook(() => useSidebarState());

      act(() => {
        result.current.setWidth(250);
      });

      expect(result.current.width).toBe(250);
    });

    it('should accept exact minimum value', () => {
      const { result } = renderHook(() => useSidebarState());

      act(() => {
        result.current.setWidth(SIDEBAR_MIN_WIDTH);
      });

      expect(result.current.width).toBe(SIDEBAR_MIN_WIDTH);
    });

    it('should accept exact maximum value', () => {
      const { result } = renderHook(() => useSidebarState());

      act(() => {
        result.current.setWidth(SIDEBAR_MAX_WIDTH);
      });

      expect(result.current.width).toBe(SIDEBAR_MAX_WIDTH);
    });
  });

  describe('localStorage error handling', () => {
    it('should default to false when localStorage has invalid JSON for collapsed', () => {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, 'invalid-json');

      const { result } = renderHook(() => useSidebarState());

      expect(result.current.collapsed).toBe(false);
    });

    it('should default to DEFAULT_WIDTH when localStorage has invalid JSON for width', () => {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, 'invalid-json');

      const { result } = renderHook(() => useSidebarState());

      expect(result.current.width).toBe(SIDEBAR_DEFAULT_WIDTH);
    });

    it('should handle localStorage.getItem throwing an error', () => {
      const getItemSpy = spyOn(localStorage, 'getItem').mockImplementation(() => {
        throw new Error('Storage error');
      });

      const { result } = renderHook(() => useSidebarState());

      expect(result.current.collapsed).toBe(false);
      expect(result.current.width).toBe(SIDEBAR_DEFAULT_WIDTH);

      getItemSpy.mockRestore();
    });

    it('should handle localStorage.setItem throwing an error gracefully', () => {
      const setItemSpy = spyOn(localStorage, 'setItem').mockImplementation(() => {
        throw new Error('Storage quota exceeded');
      });

      const { result } = renderHook(() => useSidebarState());

      // Should not throw, state should still update
      act(() => {
        result.current.setCollapsed(true);
        result.current.setWidth(300);
      });

      expect(result.current.collapsed).toBe(true);
      expect(result.current.width).toBe(300);

      setItemSpy.mockRestore();
    });
  });

  describe('constants', () => {
    it('should export correct constant values', () => {
      expect(SIDEBAR_MIN_WIDTH).toBe(150);
      expect(SIDEBAR_MAX_WIDTH).toBe(400);
      expect(SIDEBAR_DEFAULT_WIDTH).toBe(224);
    });
  });
});
