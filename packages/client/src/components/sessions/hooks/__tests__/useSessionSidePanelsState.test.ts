import { describe, it, expect, beforeEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { useSessionSidePanelsState, type SessionSidePanelKey } from '../useSessionSidePanelsState';

// Hardcoded literals, deliberately not imported from the hook: the tests pin
// the on-disk contract itself.
const V3_KEY = 'agent-console:session-side-panels-v3';
const V2_KEY = 'agent-console:session-side-panels-v2';

function seedV2(expanded: Record<string, unknown>, railOpen: unknown = true): string {
  const raw = JSON.stringify({ railOpen, expanded });
  localStorage.setItem(V2_KEY, raw);
  return raw;
}

function storedV3(): unknown {
  const raw = localStorage.getItem(V3_KEY);
  return raw === null ? null : JSON.parse(raw);
}

describe('useSessionSidePanelsState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('load: nothing usable stored', () => {
    it('nothing stored: rail closed, memo is the open section', () => {
      const { result } = renderHook(() => useSessionSidePanelsState());
      expect(result.current.railOpen).toBe(false);
      expect(result.current.openSection).toBe('memo');
    });

    it('unparseable JSON under v3 falls back to the default', () => {
      localStorage.setItem(V3_KEY, '{not json');
      const { result } = renderHook(() => useSessionSidePanelsState());
      expect(result.current.railOpen).toBe(false);
      expect(result.current.openSection).toBe('memo');
    });

    it('localStorage.getItem throwing falls back to the default', () => {
      const original = globalThis.localStorage;
      Object.defineProperty(globalThis, 'localStorage', {
        value: {
          getItem: () => {
            throw new Error('denied');
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
        expect(result.current.railOpen).toBe(false);
        expect(result.current.openSection).toBe('memo');
        act(() => {
          result.current.toggleRail();
        });
        expect(result.current.railOpen).toBe(true);
      } finally {
        Object.defineProperty(globalThis, 'localStorage', { value: original, writable: true, configurable: true });
      }
    });
  });

  describe('load: v3 record', () => {
    it('reads a valid v3 record', () => {
      localStorage.setItem(V3_KEY, JSON.stringify({ railOpen: true, openSection: 'bookmarks' }));
      const { result } = renderHook(() => useSessionSidePanelsState());
      expect(result.current.railOpen).toBe(true);
      expect(result.current.openSection).toBe('bookmarks');
    });

    it('reads a v3 record whose openSection is null', () => {
      localStorage.setItem(V3_KEY, JSON.stringify({ railOpen: true, openSection: null }));
      const { result } = renderHook(() => useSessionSidePanelsState());
      expect(result.current.openSection).toBeNull();
    });

    it('v3 with an unknown openSection is invalid: default when nothing else is stored', () => {
      localStorage.setItem(V3_KEY, JSON.stringify({ railOpen: true, openSection: 'nope' }));
      const { result } = renderHook(() => useSessionSidePanelsState());
      expect(result.current.railOpen).toBe(false);
      expect(result.current.openSection).toBe('memo');
    });

    it('v3 invalid with a valid v2 behind it: the v2 record is converted', () => {
      localStorage.setItem(V3_KEY, JSON.stringify({ railOpen: false, openSection: 'nope' }));
      seedV2({ memo: false, todos: false, artifacts: true, bookmarks: true }, true);
      const { result } = renderHook(() => useSessionSidePanelsState());
      expect(result.current.railOpen).toBe(true);
      expect(result.current.openSection).toBe('artifacts');
    });

    it('v3 holding malformed JSON with a valid v2 behind it converts from v2', () => {
      localStorage.setItem(V3_KEY, '{not json');
      seedV2({ memo: false, todos: false, artifacts: true, bookmarks: false }, true);
      const { result } = renderHook(() => useSessionSidePanelsState());
      expect(result.current.railOpen).toBe(true);
      expect(result.current.openSection).toBe('artifacts');
    });

    it('a valid v3 wins over a valid v2', () => {
      localStorage.setItem(V3_KEY, JSON.stringify({ railOpen: false, openSection: 'bookmarks' }));
      seedV2({ memo: true, todos: true, artifacts: true, bookmarks: true }, true);
      const { result } = renderHook(() => useSessionSidePanelsState());
      expect(result.current.railOpen).toBe(false);
      expect(result.current.openSection).toBe('bookmarks');
    });
  });

  describe('load: v2 record conversion', () => {
    it('v2 with all four expanded gives memo and keeps railOpen', () => {
      seedV2({ memo: true, todos: true, artifacts: true, bookmarks: true }, true);
      const { result } = renderHook(() => useSessionSidePanelsState());
      expect(result.current.openSection).toBe('memo');
      expect(result.current.railOpen).toBe(true);
    });

    it('v2 with only artifacts and bookmarks expanded gives artifacts', () => {
      seedV2({ memo: false, todos: false, artifacts: true, bookmarks: true }, false);
      const { result } = renderHook(() => useSessionSidePanelsState());
      expect(result.current.openSection).toBe('artifacts');
      expect(result.current.railOpen).toBe(false);
    });

    it('v2 with none expanded gives null', () => {
      seedV2({ memo: false, todos: false, artifacts: false, bookmarks: false });
      const { result } = renderHook(() => useSessionSidePanelsState());
      expect(result.current.openSection).toBeNull();
    });

    it('v2 without a todos field and memo false reads todos as expanded', () => {
      seedV2({ memo: false, artifacts: false, bookmarks: false });
      const { result } = renderHook(() => useSessionSidePanelsState());
      expect(result.current.openSection).toBe('todos');
    });

    it('v2 invalid falls back to the default', () => {
      seedV2({ memo: 'yes', todos: true, artifacts: true, bookmarks: true });
      const { result } = renderHook(() => useSessionSidePanelsState());
      expect(result.current.railOpen).toBe(false);
      expect(result.current.openSection).toBe('memo');
    });

    it('never reads the older pre-v2 key', () => {
      localStorage.setItem(
        'agent-console:session-side-panels-expanded',
        JSON.stringify({ railOpen: true, expanded: { memo: false, artifacts: false, bookmarks: false } }),
      );
      const { result } = renderHook(() => useSessionSidePanelsState());
      expect(result.current.railOpen).toBe(false);
      expect(result.current.openSection).toBe('memo');
    });
  });

  describe('toggleSection', () => {
    it('from null opens the key', () => {
      localStorage.setItem(V3_KEY, JSON.stringify({ railOpen: true, openSection: null }));
      const { result } = renderHook(() => useSessionSidePanelsState());
      act(() => result.current.toggleSection('todos'));
      expect(result.current.openSection).toBe('todos');
    });

    it('on the open key closes it', () => {
      const { result } = renderHook(() => useSessionSidePanelsState());
      act(() => result.current.toggleSection('memo'));
      expect(result.current.openSection).toBeNull();
    });

    it('on a different key switches to it', () => {
      const { result } = renderHook(() => useSessionSidePanelsState());
      act(() => result.current.toggleSection('bookmarks'));
      expect(result.current.openSection).toBe('bookmarks');
    });

    it('never touches railOpen', () => {
      const { result } = renderHook(() => useSessionSidePanelsState());
      act(() => result.current.toggleSection('todos'));
      expect(result.current.railOpen).toBe(false);
    });
  });

  describe('openRailAndExpandSection', () => {
    it('from null opens the rail and the key', () => {
      localStorage.setItem(V3_KEY, JSON.stringify({ railOpen: false, openSection: null }));
      const { result } = renderHook(() => useSessionSidePanelsState());
      act(() => result.current.openRailAndExpandSection('artifacts'));
      expect(result.current.railOpen).toBe(true);
      expect(result.current.openSection).toBe('artifacts');
    });

    it('on the already-open key keeps it open', () => {
      const { result } = renderHook(() => useSessionSidePanelsState());
      act(() => result.current.openRailAndExpandSection('memo'));
      expect(result.current.railOpen).toBe(true);
      expect(result.current.openSection).toBe('memo');
    });

    it('on a different key closes the other', () => {
      const { result } = renderHook(() => useSessionSidePanelsState());
      act(() => result.current.openRailAndExpandSection('bookmarks'));
      expect(result.current.openSection).toBe('bookmarks');
    });
  });

  describe('expandSection', () => {
    it('from null opens the key', () => {
      localStorage.setItem(V3_KEY, JSON.stringify({ railOpen: true, openSection: null }));
      const { result } = renderHook(() => useSessionSidePanelsState());
      act(() => result.current.expandSection('memo'));
      expect(result.current.openSection).toBe('memo');
    });

    it('on the open key never closes it', () => {
      const { result } = renderHook(() => useSessionSidePanelsState());
      act(() => result.current.expandSection('memo'));
      expect(result.current.openSection).toBe('memo');
    });

    it('on a different key closes the other', () => {
      const { result } = renderHook(() => useSessionSidePanelsState());
      act(() => result.current.expandSection('todos'));
      expect(result.current.openSection).toBe('todos');
    });
  });

  describe('toggleRail', () => {
    it('flips railOpen only and leaves openSection unchanged', () => {
      localStorage.setItem(V3_KEY, JSON.stringify({ railOpen: true, openSection: 'artifacts' }));
      const { result } = renderHook(() => useSessionSidePanelsState());
      act(() => result.current.toggleRail());
      expect(result.current.railOpen).toBe(false);
      expect(result.current.openSection).toBe('artifacts');
      act(() => result.current.toggleRail());
      expect(result.current.railOpen).toBe(true);
      expect(result.current.openSection).toBe('artifacts');
    });
  });

  describe('persistence', () => {
    const operations: Array<[string, (h: ReturnType<typeof useSessionSidePanelsState>) => void, unknown]> = [
      ['toggleRail', (h) => h.toggleRail(), { railOpen: true, openSection: 'memo' }],
      ['toggleSection', (h) => h.toggleSection('todos'), { railOpen: false, openSection: 'todos' }],
      ['openRailAndExpandSection', (h) => h.openRailAndExpandSection('artifacts'), { railOpen: true, openSection: 'artifacts' }],
      ['expandSection', (h) => h.expandSection('bookmarks'), { railOpen: false, openSection: 'bookmarks' }],
    ];

    for (const [name, run, expected] of operations) {
      it(`${name} writes the v3 key and never writes or removes the v2 key`, () => {
        const v2Raw = seedV2({ memo: true, todos: true, artifacts: true, bookmarks: true }, false);
        const { result } = renderHook(() => useSessionSidePanelsState());
        act(() => run(result.current));
        expect(storedV3()).toEqual(expected);
        expect(localStorage.getItem(V2_KEY)).toBe(v2Raw);
      });
    }

    it('a v3 write of every section key round-trips through a fresh load', () => {
      for (const key of ['memo', 'todos', 'artifacts', 'bookmarks'] as SessionSidePanelKey[]) {
        localStorage.clear();
        const first = renderHook(() => useSessionSidePanelsState());
        act(() => first.result.current.openRailAndExpandSection(key));
        const second = renderHook(() => useSessionSidePanelsState());
        expect(second.result.current.openSection).toBe(key);
      }
    });
  });

  describe('no data coupling', () => {
    it('the hook module imports no query hook', () => {
      const source = readFileSync(new URL('../useSessionSidePanelsState.ts', import.meta.url), 'utf8');
      const imports = source.split('\n').filter((line) => line.startsWith('import '));
      expect(imports.join('\n')).not.toMatch(/react-query|use(Session|Query)/);
    });
  });
});
