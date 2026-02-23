import { describe, it, expect } from 'bun:test';
import { formatTimestamp, formatAbsoluteTimestamp } from '../format';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatTimestamp', () => {
  it('returns "just now" for less than 60 seconds ago', () => {
    const now = Date.now();
    expect(formatTimestamp(now - 30 * SECOND)).toBe('just now');
  });

  it('returns minutes ago for timestamps between 1 and 59 minutes', () => {
    const now = Date.now();
    expect(formatTimestamp(now - 5 * MINUTE)).toBe('5m ago');
  });

  it('returns hours ago for timestamps between 1 and 23 hours', () => {
    const now = Date.now();
    expect(formatTimestamp(now - 3 * HOUR)).toBe('3h ago');
  });

  it('returns days ago for timestamps between 1 and 6 days', () => {
    const now = Date.now();
    expect(formatTimestamp(now - 2 * DAY)).toBe('2d ago');
  });

  describe('boundary conditions', () => {
    it('returns "just now" at exactly 59 seconds', () => {
      const now = Date.now();
      expect(formatTimestamp(now - 59 * SECOND)).toBe('just now');
    });

    it('returns "1m ago" at exactly 60 seconds', () => {
      const now = Date.now();
      expect(formatTimestamp(now - 60 * SECOND)).toBe('1m ago');
    });

    it('returns "59m ago" at exactly 59 minutes', () => {
      const now = Date.now();
      expect(formatTimestamp(now - 59 * MINUTE)).toBe('59m ago');
    });

    it('returns "1h ago" at exactly 60 minutes', () => {
      const now = Date.now();
      expect(formatTimestamp(now - 60 * MINUTE)).toBe('1h ago');
    });

    it('returns "23h ago" at exactly 23 hours', () => {
      const now = Date.now();
      expect(formatTimestamp(now - 23 * HOUR)).toBe('23h ago');
    });

    it('returns "1d ago" at exactly 24 hours', () => {
      const now = Date.now();
      expect(formatTimestamp(now - 24 * HOUR)).toBe('1d ago');
    });

    it('returns "6d ago" at exactly 6 days', () => {
      const now = Date.now();
      expect(formatTimestamp(now - 6 * DAY)).toBe('6d ago');
    });

    it('returns a locale-formatted date for 7+ days ago', () => {
      const now = Date.now();
      const result = formatTimestamp(now - 7 * DAY);
      expect(typeof result).toBe('string');
      expect(result).not.toMatch(/d ago$/);
      expect(result).not.toBe('just now');
    });
  });
});

describe('formatAbsoluteTimestamp', () => {
  it('returns a string for a valid timestamp', () => {
    const result = formatAbsoluteTimestamp(1700000000000);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('produces consistent output for the same input', () => {
    const timestamp = 1700000000000;
    const result1 = formatAbsoluteTimestamp(timestamp);
    const result2 = formatAbsoluteTimestamp(timestamp);
    expect(result1).toBe(result2);
  });
});
