import { describe, it, expect } from 'bun:test';
import { rowText, detectAndAssignLinks } from '../row-pipeline';
import type { TerminalRow } from '../buffer-to-rows';

function row(key: number, text: string, isWrapped = false): TerminalRow {
  return { key, segments: [{ text, style: null }], isWrapped, links: [] };
}

describe('rowText', () => {
  it('concatenates all segment texts', () => {
    const r: TerminalRow = {
      key: 0,
      segments: [
        { text: 'foo', style: null },
        { text: 'bar', style: { bold: true } },
      ],
      isWrapped: false,
      links: [],
    };
    expect(rowText(r)).toBe('foobar');
  });
});

describe('detectAndAssignLinks', () => {
  it('assigns a link to a row containing a URL', () => {
    const rows = [row(0, 'visit https://example.com now')];
    detectAndAssignLinks(rows);
    expect(rows[0].links).toHaveLength(1);
    expect(rows[0].links[0].href).toBe('https://example.com');
  });

  it('joins a URL wrapped across two rows (wrapped-line window)', () => {
    const rows = [row(0, 'see https://example.com/lo'), row(1, 'ng/path', true)];
    detectAndAssignLinks(rows);
    // Both rows carry a range for the single joined URL.
    expect(rows[0].links[0].href).toBe('https://example.com/long/path');
    expect(rows[1].links[0].href).toBe('https://example.com/long/path');
  });

  it('leaves rows without URLs link-free', () => {
    const rows = [row(0, 'plain text only')];
    detectAndAssignLinks(rows);
    expect(rows[0].links).toEqual([]);
  });

  it('is a no-op on an empty array', () => {
    expect(() => detectAndAssignLinks([])).not.toThrow();
  });
});
