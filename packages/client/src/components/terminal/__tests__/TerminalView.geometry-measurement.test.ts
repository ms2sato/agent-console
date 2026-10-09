import { describe, it, expect } from 'bun:test';
import { parseFinitePadding } from '../TerminalView';

// Level (a) of the #1899 three-level pin: `parseFinitePadding`, the pure
// measurement function extracted out of TerminalView's `applyResize`, tested
// in isolation. This test is deliberately scoped to ONE level only -- it says
// nothing about terminal-store's resize() guard (level (b), see
// terminal-store.test.ts) or about TerminalView's mount behavior under
// happy-dom (level (c), see TerminalView.resize-nan-guard.test.tsx).
//
// happy-dom's getComputedStyle() returns '' (not a resolved "0px") for an
// unset CSS padding, because it applies no real CSS engine -- Tailwind's
// `px-2 py-1` classes on the scroll container are never resolved there. This
// test pins `parseFinitePadding`'s own contract: it must always return a
// finite number, never NaN, for any input it is given.
describe('parseFinitePadding (#1899 level a)', () => {
  it('returns a finite 0 for an empty string (happy-dom unresolved padding)', () => {
    const result = parseFinitePadding('');
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(0);
  });

  it('returns a finite 0 for undefined', () => {
    const result = parseFinitePadding(undefined);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(0);
  });

  it('parses a resolved pixel value correctly', () => {
    const result = parseFinitePadding('0px');
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(0);
  });
});
