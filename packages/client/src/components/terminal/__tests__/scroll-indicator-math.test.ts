import { describe, it, expect } from 'bun:test';
import {
  computeIndicatorGeometry,
  hasOverflow,
  MIN_INDICATOR_HEIGHT,
} from '../scroll-indicator-math';

describe('hasOverflow', () => {
  it('is false when content fits (with 1px tolerance)', () => {
    expect(hasOverflow({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 })).toBe(false);
    expect(hasOverflow({ scrollTop: 0, scrollHeight: 101, clientHeight: 100 })).toBe(false);
  });

  it('is true when content overflows beyond tolerance', () => {
    expect(hasOverflow({ scrollTop: 0, scrollHeight: 200, clientHeight: 100 })).toBe(true);
  });
});

describe('computeIndicatorGeometry', () => {
  it('height is proportional to the visible fraction', () => {
    // clientHeight^2 / scrollHeight = 100*100/400 = 25
    const { height } = computeIndicatorGeometry({
      scrollTop: 0,
      scrollHeight: 400,
      clientHeight: 100,
    });
    expect(height).toBe(25);
  });

  it('height is floored at MIN_INDICATOR_HEIGHT', () => {
    // raw = 100*100/2000 = 5 -> floored to 24
    const { height } = computeIndicatorGeometry({
      scrollTop: 0,
      scrollHeight: 2000,
      clientHeight: 100,
    });
    expect(height).toBe(MIN_INDICATOR_HEIGHT);
  });

  it('top is 0 at the top of the scroll range', () => {
    const { top } = computeIndicatorGeometry({ scrollTop: 0, scrollHeight: 400, clientHeight: 100 });
    expect(top).toBe(0);
  });

  it('top reaches the bottom of the track when fully scrolled', () => {
    // height 25, track = 100 - 25 = 75; scrollable = 300; scrollTop = 300 -> top = 75
    const { top, height } = computeIndicatorGeometry({
      scrollTop: 300,
      scrollHeight: 400,
      clientHeight: 100,
    });
    expect(height).toBe(25);
    expect(top).toBe(75);
  });

  it('top is clamped to the track and never exceeds it', () => {
    // Over-scrolled scrollTop beyond scrollable -> clamped to track (75)
    const { top } = computeIndicatorGeometry({
      scrollTop: 999,
      scrollHeight: 400,
      clientHeight: 100,
    });
    expect(top).toBe(75);
  });

  it('top is 0 when there is no scrollable range', () => {
    const { top } = computeIndicatorGeometry({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 });
    expect(top).toBe(0);
  });
});
