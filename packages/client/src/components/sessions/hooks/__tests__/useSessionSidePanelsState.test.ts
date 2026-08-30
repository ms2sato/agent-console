import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useSessionSidePanelsState } from '../useSessionSidePanelsState';

const STORAGE_KEY = 'agent-console:session-side-panels-expanded';

describe('useSessionSidePanelsState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('initial state', () => {
    it('defaults to all three sections closed (R3)', () => {
      const { result } = renderHook(() => useSessionSidePanelsState());

      expect(result.current.expanded).toEqual({ memo: false, artifacts: false, bookmarks: false });
    });
  });

  describe('localStorage initialization', () => {
    it('reads a previously-persisted record', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ memo: true, artifacts: false, bookmarks: true }));

      const { result } = renderHook(() => useSessionSidePanelsState());

      expect(result.current.expanded).toEqual({ memo: true, artifacts: false, bookmarks: true });
    });

    it('falls back to the all-closed default on invalid JSON', () => {
      localStorage.setItem(STORAGE_KEY, 'not-json');

      const { result } = renderHook(() => useSessionSidePanelsState());

      expect(result.current.expanded).toEqual({ memo: false, artifacts: false, bookmarks: false });
    });

    it('falls back to the all-closed default on a structurally corrupt record (missing key)', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ memo: true, artifacts: false }));

      const { result } = renderHook(() => useSessionSidePanelsState());

      expect(result.current.expanded).toEqual({ memo: false, artifacts: false, bookmarks: false });
    });

    it('falls back to the all-closed default on a non-boolean field', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ memo: 'yes', artifacts: false, bookmarks: true }));

      const { result } = renderHook(() => useSessionSidePanelsState());

      expect(result.current.expanded).toEqual({ memo: false, artifacts: false, bookmarks: false });
    });
  });

  describe('toggleSection', () => {
    it('toggles one section without affecting the others (state-ownership pin)', () => {
      const { result } = renderHook(() => useSessionSidePanelsState());

      act(() => {
        result.current.toggleSection('memo');
      });

      expect(result.current.expanded).toEqual({ memo: true, artifacts: false, bookmarks: false });

      act(() => {
        result.current.toggleSection('bookmarks');
      });

      expect(result.current.expanded).toEqual({ memo: true, artifacts: false, bookmarks: true });
    });

    it('toggles a section back off', () => {
      const { result } = renderHook(() => useSessionSidePanelsState());

      act(() => {
        result.current.toggleSection('artifacts');
      });
      expect(result.current.expanded.artifacts).toBe(true);

      act(() => {
        result.current.toggleSection('artifacts');
      });
      expect(result.current.expanded.artifacts).toBe(false);
    });

    it('persists the full updated record to the single global key', () => {
      const { result } = renderHook(() => useSessionSidePanelsState());

      act(() => {
        result.current.toggleSection('memo');
      });

      expect(localStorage.getItem(STORAGE_KEY)).toBe(
        JSON.stringify({ memo: true, artifacts: false, bookmarks: false })
      );

      act(() => {
        result.current.toggleSection('bookmarks');
      });

      expect(localStorage.getItem(STORAGE_KEY)).toBe(
        JSON.stringify({ memo: true, artifacts: false, bookmarks: true })
      );
    });
  });

  describe('localStorage error handling', () => {
    it('handles localStorage.getItem throwing an error by yielding the all-closed default', () => {
      const getItemSpy = spyOn(localStorage, 'getItem').mockImplementation(() => {
        throw new Error('Storage error');
      });

      const { result } = renderHook(() => useSessionSidePanelsState());

      expect(result.current.expanded).toEqual({ memo: false, artifacts: false, bookmarks: false });

      getItemSpy.mockRestore();
    });

    it('handles localStorage.setItem throwing an error gracefully -- state still updates', () => {
      const setItemSpy = spyOn(localStorage, 'setItem').mockImplementation(() => {
        throw new Error('Storage quota exceeded');
      });

      const { result } = renderHook(() => useSessionSidePanelsState());

      act(() => {
        result.current.toggleSection('memo');
      });

      expect(result.current.expanded).toEqual({ memo: true, artifacts: false, bookmarks: false });

      setItemSpy.mockRestore();
    });
  });
});
