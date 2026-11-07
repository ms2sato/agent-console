import { describe, it, expect } from 'bun:test';
import { toInstructionExcerpt, INSTRUCTION_EXCERPT_MAX_CHARS } from '../inbound-instruction-excerpt.js';

describe('toInstructionExcerpt', () => {
  it('takes the first non-empty line, skipping blank and whitespace-only lines', () => {
    expect(toInstructionExcerpt('\n  \r\n  Do the thing  \nsecond line')).toBe('Do the thing');
  });

  it('returns an empty string when there is no non-empty line', () => {
    expect(toInstructionExcerpt('')).toBe('');
    expect(toInstructionExcerpt(' \n\t\n')).toBe('');
  });

  it('cuts at the cap by code points: 119 and 120 whole, 121 cut, a surrogate pair kept whole', () => {
    expect(toInstructionExcerpt('a'.repeat(119))).toBe('a'.repeat(119));
    expect(toInstructionExcerpt('a'.repeat(120))).toBe('a'.repeat(120));
    expect(toInstructionExcerpt('a'.repeat(121))).toBe('a'.repeat(INSTRUCTION_EXCERPT_MAX_CHARS));
    expect(toInstructionExcerpt(`${'a'.repeat(119)}😀x`)).toBe(`${'a'.repeat(119)}😀`);
  });
});
