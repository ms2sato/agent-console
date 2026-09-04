import { describe, it, expect } from 'bun:test';
import { isPositiveInteger, POSITIVE_INTEGER_MESSAGE } from '../positive-integer';

describe('isPositiveInteger', () => {
  it('accepts 1 and other positive integers', () => {
    expect(isPositiveInteger(1)).toBe(true);
    expect(isPositiveInteger(128_000)).toBe(true);
  });

  it('rejects 0', () => {
    expect(isPositiveInteger(0)).toBe(false);
  });

  it('rejects negative integers', () => {
    expect(isPositiveInteger(-1)).toBe(false);
  });

  it('rejects non-integers', () => {
    expect(isPositiveInteger(1.5)).toBe(false);
  });
});

describe('POSITIVE_INTEGER_MESSAGE', () => {
  it('is the exact message shown next to a rejected field', () => {
    expect(POSITIVE_INTEGER_MESSAGE).toBe('Must be a positive integer');
  });
});
