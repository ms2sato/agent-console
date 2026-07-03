import { describe, it, expect, afterEach } from 'bun:test';
import { joinSelectedRows, collectSelectedRowPieces } from '../copy-text';

describe('joinSelectedRows', () => {
  it('returns empty string for no rows', () => {
    expect(joinSelectedRows([])).toBe('');
  });

  it('returns a single row verbatim', () => {
    expect(joinSelectedRows([{ text: 'hello', isWrapped: false }])).toBe('hello');
  });

  it('joins soft-wrapped continuation rows with no separator', () => {
    const joined = joinSelectedRows([
      { text: 'http://example.com/very', isWrapped: false },
      { text: 'long/path', isWrapped: true },
    ]);
    expect(joined).toBe('http://example.com/verylong/path');
  });

  it('joins a URL wrapped across three rows into one line', () => {
    const joined = joinSelectedRows([
      { text: 'https://example.com/', isWrapped: false },
      { text: 'aaaa', isWrapped: true },
      { text: 'bbbb', isWrapped: true },
    ]);
    expect(joined).toBe('https://example.com/aaaabbbb');
  });

  it('separates hard (non-wrapped) rows with newlines', () => {
    const joined = joinSelectedRows([
      { text: 'line one', isWrapped: false },
      { text: 'line two', isWrapped: false },
    ]);
    expect(joined).toBe('line one\nline two');
  });

  it('mixes wrapped and hard rows correctly', () => {
    // logical line 1 (wrapped across 2 rows), then a hard break, then logical line 2.
    const joined = joinSelectedRows([
      { text: 'wrapped-', isWrapped: false },
      { text: 'continuation', isWrapped: true },
      { text: 'second command', isWrapped: false },
      { text: 'also-', isWrapped: false },
      { text: 'wrapped', isWrapped: true },
    ]);
    expect(joined).toBe('wrapped-continuation\nsecond command\nalso-wrapped');
  });

  it('preserves partial edge text (only separators change)', () => {
    // First and last rows carry already-sliced partial selections.
    const joined = joinSelectedRows([
      { text: 'com/very', isWrapped: false }, // partial start
      { text: 'long/pa', isWrapped: true }, // partial end
    ]);
    expect(joined).toBe('com/verylong/pa');
  });
});

describe('collectSelectedRowPieces (DOM)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function makeContainer(rowTexts: string[]): HTMLDivElement {
    const container = document.createElement('div');
    for (const t of rowTexts) {
      const row = document.createElement('div');
      row.textContent = t;
      container.appendChild(row);
    }
    document.body.appendChild(container);
    return container;
  }

  it('slices partial first/last rows and joins wrapped rows into one line', () => {
    // Row 1 is a soft-wrap continuation of row 0.
    const container = makeContainer(['http://example.com/very', 'long/path']);
    const [r0, r1] = Array.from(container.children);
    const range = document.createRange();
    // Select from offset 7 of row 0 ('example...') through offset 4 of row 1 ('long').
    range.setStart(r0.firstChild!, 7);
    range.setEnd(r1.firstChild!, 4);

    const pieces = collectSelectedRowPieces(container, range, (i) => i === 1);
    expect(pieces).toEqual([
      { text: 'example.com/very', isWrapped: false },
      { text: 'long', isWrapped: true },
    ]);
    expect(joinSelectedRows(pieces)).toBe('example.com/verylong');
  });

  it('separates hard rows with newline when not wrapped', () => {
    const container = makeContainer(['line one', 'line two']);
    const [r0, r1] = Array.from(container.children);
    const range = document.createRange();
    range.setStart(r0.firstChild!, 0);
    range.setEnd(r1.firstChild!, 8);

    const pieces = collectSelectedRowPieces(container, range, () => false);
    expect(joinSelectedRows(pieces)).toBe('line one\nline two');
  });
});
