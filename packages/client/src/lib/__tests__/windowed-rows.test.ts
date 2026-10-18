import { describe, it, expect } from 'bun:test';
import { computeRowWindow } from '../windowed-rows';

const base = { viewportHeight: 200, rowHeight: 20, overscan: 5 };

describe('computeRowWindow', () => {
  it('mounts the visible rows plus the overscan below when scrolled to the top', () => {
    // 200px / 20px = 10 visible rows (0..9), +5 overscan below.
    expect(computeRowWindow({ ...base, scrollTop: 0, rowCount: 1000 })).toEqual({ start: 0, end: 15 });
  });

  it('mounts overscan on both sides in the middle of the list', () => {
    // scrollTop 2000 -> first visible row 100; last visible exclusive 110.
    expect(computeRowWindow({ ...base, scrollTop: 2000, rowCount: 1000 })).toEqual({ start: 95, end: 115 });
  });

  it('includes a partially visible row at the bottom edge', () => {
    // scrollTop 10 -> rows 0..10 are at least partly visible (row 10 starts at 200 < 210).
    expect(computeRowWindow({ ...base, scrollTop: 10, rowCount: 1000, overscan: 0 })).toEqual({ start: 0, end: 11 });
  });

  it('clamps the end to the row count', () => {
    expect(computeRowWindow({ ...base, scrollTop: 19900, rowCount: 1000 })).toEqual({ start: 990, end: 1000 });
  });

  it('keeps one row mounted when the scroll position is past the end', () => {
    const w = computeRowWindow({ ...base, scrollTop: 1_000_000, rowCount: 10 });
    expect(w).toEqual({ start: 9, end: 10 });
  });

  it('returns an empty window for zero rows (boundary: empty input)', () => {
    expect(computeRowWindow({ ...base, scrollTop: 0, rowCount: 0 })).toEqual({ start: 0, end: 0 });
  });

  it('treats a negative scroll position (overscroll bounce) as the top', () => {
    expect(computeRowWindow({ ...base, scrollTop: -50, rowCount: 1000 })).toEqual({ start: 0, end: 15 });
  });

  it('mounts a single row for a single-row list', () => {
    expect(computeRowWindow({ ...base, scrollTop: 0, rowCount: 1 })).toEqual({ start: 0, end: 1 });
  });
});
