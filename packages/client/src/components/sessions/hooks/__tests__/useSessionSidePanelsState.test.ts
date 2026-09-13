import { describe, it, expect, beforeEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useSessionSidePanelsState } from '../useSessionSidePanelsState';

const STORAGE_KEY = 'agent-console:session-side-panels-v2';

describe('useSessionSidePanelsState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('initial state', () => {
    it('defaults to the rail open and all three sections expanded (R3\') when nothing is stored', () => {
      const { result } = renderHook(() => useSessionSidePanelsState());

      expect(result.current.railOpen).toBe(true);
      expect(result.current.expanded).toEqual({ memo: true, artifacts: true, bookmarks: true });
    });
  });

  describe('localStorage initialization', () => {
    it('never reads a value stored under the OLD (pre-#1640) key', () => {
      // Hardcoded literal, deliberately not imported from any constant --
      // this is how the test's reach is measured: if the storage-key
      // constant in the hook were reverted to this old literal, the hook
      // would read this seeded value and diverge from the R3' default,
      // failing this exact assertion. The seeded value is deliberately
      // NEW-schema-shaped (it has railOpen + expanded) even though it
      // represents old-key semantics (all closed) -- so a reverted key
      // produces a detectably WRONG result (all-closed) rather than falling
      // through corrupt-storage validation into the same default anyway.
      localStorage.setItem(
        'agent-console:session-side-panels-expanded',
        JSON.stringify({ railOpen: false, expanded: { memo: false, artifacts: false, bookmarks: false } })
      );

      const { result } = renderHook(() => useSessionSidePanelsState());

      expect(result.current.railOpen).toBe(true);
      expect(result.current.expanded).toEqual({ memo: true, artifacts: true, bookmarks: true });
    });

    it('reads a previously-persisted record under the NEW key, railOpen and expanded independently', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ railOpen: false, expanded: { memo: true, artifacts: false, bookmarks: true } })
      );

      const { result } = renderHook(() => useSessionSidePanelsState());

      expect(result.current.railOpen).toBe(false);
      expect(result.current.expanded).toEqual({ memo: true, artifacts: false, bookmarks: true });
    });

    it('falls back to the default on invalid JSON', () => {
      localStorage.setItem(STORAGE_KEY, 'not-json');

      const { result } = renderHook(() => useSessionSidePanelsState());

      expect(result.current.railOpen).toBe(true);
      expect(result.current.expanded).toEqual({ memo: true, artifacts: true, bookmarks: true });
    });

    it('falls back to the default when railOpen is missing', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ expanded: { memo: false, artifacts: false, bookmarks: false } })
      );

      const { result } = renderHook(() => useSessionSidePanelsState());

      expect(result.current.railOpen).toBe(true);
      expect(result.current.expanded).toEqual({ memo: true, artifacts: true, bookmarks: true });
    });

    it('falls back to the default when expanded is missing a key', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ railOpen: false, expanded: { memo: true, artifacts: false } })
      );

      const { result } = renderHook(() => useSessionSidePanelsState());

      expect(result.current.railOpen).toBe(true);
      expect(result.current.expanded).toEqual({ memo: true, artifacts: true, bookmarks: true });
    });

    it('falls back to the default on a non-boolean field', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ railOpen: 'yes', expanded: { memo: false, artifacts: false, bookmarks: false } })
      );

      const { result } = renderHook(() => useSessionSidePanelsState());

      expect(result.current.railOpen).toBe(true);
      expect(result.current.expanded).toEqual({ memo: true, artifacts: true, bookmarks: true });
    });
  });

  describe('toggleRail', () => {
    it('flips railOpen only, leaving expanded untouched', () => {
      const { result } = renderHook(() => useSessionSidePanelsState());

      act(() => {
        result.current.toggleRail();
      });

      expect(result.current.railOpen).toBe(false);
      expect(result.current.expanded).toEqual({ memo: true, artifacts: true, bookmarks: true });

      act(() => {
        result.current.toggleRail();
      });

      expect(result.current.railOpen).toBe(true);
      expect(result.current.expanded).toEqual({ memo: true, artifacts: true, bookmarks: true });
    });

    it('persists railOpen under the new storage key', () => {
      const { result } = renderHook(() => useSessionSidePanelsState());

      act(() => {
        result.current.toggleRail();
      });

      expect(localStorage.getItem(STORAGE_KEY)).toBe(
        JSON.stringify({ railOpen: false, expanded: { memo: true, artifacts: true, bookmarks: true } })
      );
    });
  });

  describe('toggleSection', () => {
    it('flips one section without affecting railOpen or the other sections', () => {
      const { result } = renderHook(() => useSessionSidePanelsState());

      act(() => {
        result.current.toggleSection('memo');
      });

      expect(result.current.railOpen).toBe(true);
      expect(result.current.expanded).toEqual({ memo: false, artifacts: true, bookmarks: true });

      act(() => {
        result.current.toggleSection('bookmarks');
      });

      expect(result.current.railOpen).toBe(true);
      expect(result.current.expanded).toEqual({ memo: false, artifacts: true, bookmarks: false });
    });

    it('persists the full updated record to the single global key', () => {
      const { result } = renderHook(() => useSessionSidePanelsState());

      act(() => {
        result.current.toggleSection('memo');
      });

      expect(localStorage.getItem(STORAGE_KEY)).toBe(
        JSON.stringify({ railOpen: true, expanded: { memo: false, artifacts: true, bookmarks: true } })
      );
    });
  });

  describe('openRailAndExpandSection', () => {
    it('atomically sets railOpen true and the target section true, in one update', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ railOpen: false, expanded: { memo: false, artifacts: false, bookmarks: false } })
      );
      const { result } = renderHook(() => useSessionSidePanelsState());
      expect(result.current.railOpen).toBe(false);

      act(() => {
        result.current.openRailAndExpandSection('memo');
      });

      expect(result.current.railOpen).toBe(true);
      expect(result.current.expanded).toEqual({ memo: true, artifacts: false, bookmarks: false });
    });

    it('is idempotent when the target section is already expanded -- it must not flip it back off', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ railOpen: false, expanded: { memo: true, artifacts: false, bookmarks: false } })
      );
      const { result } = renderHook(() => useSessionSidePanelsState());
      expect(result.current.railOpen).toBe(false);
      expect(result.current.expanded.memo).toBe(true);

      act(() => {
        result.current.openRailAndExpandSection('memo');
      });

      // This is the case that a two-sequential-toggle implementation would
      // get wrong: toggling an already-true section would flip it to false.
      expect(result.current.railOpen).toBe(true);
      expect(result.current.expanded.memo).toBe(true);
    });
  });

  describe('localStorage error handling', () => {
    // `spyOn(localStorage, 'getItem'/'setItem')` does NOT intercept calls in
    // this Bun test environment -- measured empirically with a standalone
    // probe: Bun's built-in `localStorage` global dispatches through an
    // internal binding that ignores a reassigned/spied property on the
    // JS-visible object, even with `.mockImplementation()`. A spied
    // `getItem`/`setItem` that throws is therefore never actually called;
    // the two tests below would pass vacuously (the real implementation
    // runs, `getItem` after `localStorage.clear()` returns `null` anyway,
    // and `setItem` writes successfully) without ever exercising the
    // hook's catch branch.
    //
    // The technique that DOES intercept: replace the entire `localStorage`
    // global via `Object.defineProperty`, not just one of its methods --
    // this actually swaps which object the internal binding is proxying to
    // stdlib method dispatch through. Always restore the original object,
    // even on assertion failure, so a failing test does not poison every
    // later test file loaded in the same process.
    it('handles localStorage.getItem throwing an error by yielding the default', () => {
      const original = globalThis.localStorage;
      Object.defineProperty(globalThis, 'localStorage', {
        value: {
          getItem: () => {
            throw new Error('Storage error');
          },
          setItem: () => {},
          removeItem: () => {},
          clear: () => {},
        },
        writable: true,
        configurable: true,
      });

      try {
        const { result } = renderHook(() => useSessionSidePanelsState());

        expect(result.current.railOpen).toBe(true);
        expect(result.current.expanded).toEqual({ memo: true, artifacts: true, bookmarks: true });
      } finally {
        Object.defineProperty(globalThis, 'localStorage', {
          value: original,
          writable: true,
          configurable: true,
        });
      }
    });

    it('handles localStorage.setItem throwing an error gracefully -- state still updates', () => {
      const original = globalThis.localStorage;
      Object.defineProperty(globalThis, 'localStorage', {
        value: {
          getItem: () => null,
          setItem: () => {
            throw new Error('Storage quota exceeded');
          },
          removeItem: () => {},
          clear: () => {},
        },
        writable: true,
        configurable: true,
      });

      try {
        const { result } = renderHook(() => useSessionSidePanelsState());

        act(() => {
          result.current.toggleRail();
        });

        expect(result.current.railOpen).toBe(false);
      } finally {
        Object.defineProperty(globalThis, 'localStorage', {
          value: original,
          writable: true,
          configurable: true,
        });
      }
    });
  });

  describe('storage-key polarity', () => {
    // `spyOn(localStorage, 'setItem')` cannot be used here -- measured
    // empirically, Bun's built-in `localStorage` global dispatches
    // `setItem`/`getItem` through an internal binding that ignores a
    // reassigned/spied property on the JS-visible object, so the spy is
    // never invoked regardless of mockImplementation. `getItem` on the
    // exact literal key has the same detection power for this polarity
    // check: if the storage-key constant in the hook were reverted to the
    // old literal, the hook would write there instead and this key would
    // read back `null`.
    it('writes under the NEW literal key -- reverting the key constant fails this assertion', () => {
      const { result } = renderHook(() => useSessionSidePanelsState());

      act(() => {
        result.current.toggleRail();
      });

      const raw = localStorage.getItem('agent-console:session-side-panels-v2');
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw as string)).toEqual({
        railOpen: false,
        expanded: { memo: true, artifacts: true, bookmarks: true },
      });
    });
  });
});
