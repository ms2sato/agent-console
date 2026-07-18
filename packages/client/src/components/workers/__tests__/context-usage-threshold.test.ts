import { describe, it, expect } from 'bun:test';
import { crossedThreshold } from '../context-usage-threshold';

describe('crossedThreshold', () => {
  it('fires when prevRatio is below the threshold and currentRatio reaches it exactly', () => {
    expect(crossedThreshold(0.5, 0.75, 0.75)).toBe(true);
  });

  it('does not fire again once prevRatio is already at or above the threshold', () => {
    // prevRatio exactly at threshold: a subsequent equal-or-higher reading
    // must not re-fire (prev < threshold is false).
    expect(crossedThreshold(0.75, 0.75, 0.75)).toBe(false);
    expect(crossedThreshold(0.75, 0.9, 0.75)).toBe(false);
    expect(crossedThreshold(0.8, 0.95, 0.75)).toBe(false);
  });

  it('treats a null prevRatio (first-ever reading) as 0, firing once if already above threshold', () => {
    expect(crossedThreshold(null, 0.8, 0.75)).toBe(true);
    expect(crossedThreshold(null, 0.75, 0.75)).toBe(true);
  });

  it('does not fire on a null prevRatio if the first reading is below threshold', () => {
    expect(crossedThreshold(null, 0.5, 0.75)).toBe(false);
  });

  it('does not fire when currentRatio stays below the threshold', () => {
    expect(crossedThreshold(0.1, 0.5, 0.75)).toBe(false);
  });

  it('evaluates two different thresholds independently against the same prev/current pair -- both can fire simultaneously', () => {
    // A single update jumping usage from 60% to 95% crosses both soft (0.75)
    // and hard (0.9) thresholds in the same update.
    const prevRatio = 0.6;
    const currentRatio = 0.95;
    expect(crossedThreshold(prevRatio, currentRatio, 0.75)).toBe(true);
    expect(crossedThreshold(prevRatio, currentRatio, 0.9)).toBe(true);
  });

  it('only one of two thresholds fires when currentRatio crosses just the lower one', () => {
    const prevRatio = 0.6;
    const currentRatio = 0.8;
    expect(crossedThreshold(prevRatio, currentRatio, 0.75)).toBe(true);
    expect(crossedThreshold(prevRatio, currentRatio, 0.9)).toBe(false);
  });
});
