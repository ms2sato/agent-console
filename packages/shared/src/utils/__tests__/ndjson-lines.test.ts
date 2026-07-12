import { describe, it, expect } from 'bun:test';
import { NdjsonLineSplitter } from '../ndjson-lines.js';

describe('NdjsonLineSplitter', () => {
  it('splits a single chunk containing multiple complete lines', () => {
    const splitter = new NdjsonLineSplitter();
    const { lines, oversized } = splitter.push('a\nb\nc\n');
    expect(lines).toEqual(['a', 'b', 'c']);
    expect(oversized).toBe(false);
    expect(splitter.carry).toBe('');
  });

  it('leaves a trailing partial line in the carry when there is no final newline', () => {
    const splitter = new NdjsonLineSplitter();
    const { lines } = splitter.push('a\nb\npartial');
    expect(lines).toEqual(['a', 'b']);
    expect(splitter.carry).toBe('partial');
  });

  it('joins a partial line carried across pushes (split mid-line)', () => {
    const splitter = new NdjsonLineSplitter();
    const first = splitter.push('hel');
    expect(first.lines).toEqual([]);
    expect(splitter.carry).toBe('hel');

    const second = splitter.push('lo\nworld');
    expect(second.lines).toEqual(['hello']);
    expect(splitter.carry).toBe('world');
  });

  it('reassembles a multibyte character split across two pushes at the string level', () => {
    const splitter = new NdjsonLineSplitter();
    // Split around a multibyte emoji at the JS string (code unit) level.
    const first = splitter.push('emoji=\uD83D'); // high surrogate only so far
    expect(first.lines).toEqual([]);
    const second = splitter.push('\uDE00\n'); // low surrogate + newline completes it
    expect(second.lines).toEqual(['emoji=😀']);
    expect(splitter.carry).toBe('');
  });

  it('strips a trailing \\r so \\r\\n line endings produce clean lines', () => {
    const splitter = new NdjsonLineSplitter();
    const { lines } = splitter.push('a\r\nb\r\n');
    expect(lines).toEqual(['a', 'b']);
  });

  it('preserves empty lines', () => {
    const splitter = new NdjsonLineSplitter();
    const { lines } = splitter.push('a\n\nb\n');
    expect(lines).toEqual(['a', '', 'b']);
  });

  it('returns nothing and does not mutate carry on an empty chunk push', () => {
    const splitter = new NdjsonLineSplitter();
    splitter.push('partial');
    const { lines, oversized } = splitter.push('');
    expect(lines).toEqual([]);
    expect(oversized).toBe(false);
    expect(splitter.carry).toBe('partial');
  });

  it('detects an oversized completed line (byte length > max)', () => {
    const splitter = new NdjsonLineSplitter({ maxLineBytes: 4 });
    const { lines, oversized } = splitter.push('abcdef\n');
    expect(lines).toEqual(['abcdef']);
    expect(oversized).toBe(true);
  });

  it('does not flag a completed line at or under the max', () => {
    const splitter = new NdjsonLineSplitter({ maxLineBytes: 4 });
    const { oversized } = splitter.push('abcd\n');
    expect(oversized).toBe(false);
  });

  it('detects an oversized carry when no newline has arrived yet', () => {
    const splitter = new NdjsonLineSplitter({ maxLineBytes: 4 });
    const first = splitter.push('ab');
    expect(first.oversized).toBe(false);
    const second = splitter.push('cde');
    expect(second.oversized).toBe(true);
    expect(second.lines).toEqual([]);
    expect(splitter.carry).toBe('abcde');
  });

  it('measures oversize by UTF-8 byte length, not code-unit length', () => {
    // Each 'あ' is 3 UTF-8 bytes; two of them is 6 bytes but only 2 code units.
    const splitter = new NdjsonLineSplitter({ maxLineBytes: 4 });
    const { oversized } = splitter.push('ああ\n');
    expect(oversized).toBe(true);
  });

  it('exposes the buffered incomplete line via the carry getter', () => {
    const splitter = new NdjsonLineSplitter();
    splitter.push('line1\nline2-incomplete');
    expect(splitter.carry).toBe('line2-incomplete');
  });
});
