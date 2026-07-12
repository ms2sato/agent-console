import { describe, it, expect } from 'bun:test';
import { truncateToBytes } from '../truncate.js';

const byteLen = (s: string) => new TextEncoder().encode(s).length;

describe('truncateToBytes', () => {
  it('returns the input unchanged when it fits', () => {
    expect(truncateToBytes('hello', 10)).toEqual({ text: 'hello', truncated: false });
  });

  it('returns unchanged at exactly the byte limit', () => {
    expect(truncateToBytes('abcd', 4)).toEqual({ text: 'abcd', truncated: false });
  });

  it('truncates ASCII to the byte limit', () => {
    const r = truncateToBytes('abcdef', 4);
    expect(r).toEqual({ text: 'abcd', truncated: true });
  });

  it('never splits a multibyte character (backs off to a code-point boundary)', () => {
    // 'a' (1 byte) + 'あ' (3 bytes) = 4 bytes; limit 2 must drop the incomplete 'あ'.
    const r = truncateToBytes('aあ', 2);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe('a');
    expect(byteLen(r.text)).toBeLessThanOrEqual(2);
  });

  it('keeps a whole multibyte character when it fits exactly', () => {
    const r = truncateToBytes('aあb', 4); // 'a'(1) + 'あ'(3) = 4
    expect(r.text).toBe('aあ');
    expect(byteLen(r.text)).toBe(4);
    expect(r.truncated).toBe(true);
  });

  it('truncates a large string safely to under the limit', () => {
    const big = '😀'.repeat(10000); // 4 bytes each
    const r = truncateToBytes(big, 16384);
    expect(r.truncated).toBe(true);
    expect(byteLen(r.text)).toBeLessThanOrEqual(16384);
    // No replacement character introduced by a mid-codepoint cut.
    expect(r.text.includes('�')).toBe(false);
  });
});
