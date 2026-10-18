/**
 * Fixed-row-height windowing: given a scroll position, which rows of a long
 * list are worth mounting. Rows outside [start, end) are represented by
 * spacing only.
 */

interface RowWindowInput {
  scrollTop: number;
  viewportHeight: number;
  rowCount: number;
  rowHeight: number;
  /** Extra rows mounted above and below the visible range. */
  overscan: number;
}

export interface RowWindow {
  /** First mounted row index (inclusive). */
  start: number;
  /** One past the last mounted row index (exclusive). */
  end: number;
}

export function computeRowWindow({
  scrollTop,
  viewportHeight,
  rowCount,
  rowHeight,
  overscan,
}: RowWindowInput): RowWindow {
  if (rowCount <= 0) return { start: 0, end: 0 };
  const firstVisible = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const lastVisibleExclusive = Math.ceil((Math.max(0, scrollTop) + viewportHeight) / rowHeight);
  const start = Math.min(Math.max(0, firstVisible - overscan), rowCount - 1);
  const end = Math.min(rowCount, Math.max(start + 1, lastVisibleExclusive + overscan));
  return { start, end };
}
