/**
 * Pure geometry for the iOS-style scroll indicator. Kept separate from the
 * component so the height/top/overflow math is unit-testable without a DOM.
 */

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface IndicatorGeometry {
  height: number;
  top: number;
}

export const MIN_INDICATOR_HEIGHT = 24;

/** Whether the content overflows enough to warrant an indicator. */
export function hasOverflow(m: ScrollMetrics): boolean {
  return m.scrollHeight > m.clientHeight + 1;
}

/**
 * Indicator thumb height + top offset. Height is proportional to the visible
 * fraction (floored at MIN_INDICATOR_HEIGHT); top maps scroll progress onto the
 * remaining track, clamped to [0, track].
 */
export function computeIndicatorGeometry(m: ScrollMetrics): IndicatorGeometry {
  const { scrollTop, scrollHeight, clientHeight } = m;
  const height = Math.max(MIN_INDICATOR_HEIGHT, (clientHeight * clientHeight) / scrollHeight);
  const scrollable = scrollHeight - clientHeight;
  const track = clientHeight - height;
  if (scrollable <= 0 || track <= 0) {
    return { height, top: 0 };
  }
  const progress = scrollTop / scrollable;
  const top = clamp(progress * track, 0, track);
  return { height, top };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
