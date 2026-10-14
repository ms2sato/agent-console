import { describe, it, expect } from 'bun:test';
import { detectRowLinks, mayContinuePreviousRow, type DetectRow } from '../link-detection';

function row(key: number, text: string, isWrapped = false, fillsLastColumn = false): DetectRow {
  return { key, text, isWrapped, fillsLastColumn };
}

describe('detectRowLinks', () => {
  it('detects a mid-row URL and reports its column range', () => {
    const links = detectRowLinks([row(0, 'see http://example.com now')]);
    expect(links.get(0)).toEqual([{ start: 4, end: 22, href: 'http://example.com' }]);
  });

  it('trims trailing punctuation from the URL', () => {
    const links = detectRowLinks([row(0, 'visit https://example.com/path).')]);
    const [link] = links.get(0)!;
    expect(link.href).toBe('https://example.com/path');
    // The trailing ')' and '.' are excluded from the range.
    expect(row(0, 'visit https://example.com/path).').text.slice(link.start, link.end)).toBe(
      'https://example.com/path',
    );
  });

  it('does not match non-http(s) schemes or dotted plain text', () => {
    expect(detectRowLinks([row(0, 'foo://bar baz.qux ok')]).size).toBe(0);
    expect(detectRowLinks([row(0, 'a sentence. with dots.')]).size).toBe(0);
  });

  it('detects adjacent URLs on one row', () => {
    const links = detectRowLinks([row(0, 'http://a.com http://b.com')]).get(0)!;
    expect(links.map((l) => l.href)).toEqual(['http://a.com', 'http://b.com']);
    expect(links[0]).toMatchObject({ start: 0, end: 12 });
    expect(links[1]).toMatchObject({ start: 13, end: 25 });
  });

  it('joins a URL wrapped across two rows and maps ranges per row', () => {
    // 'http://example.com/very' + 'long/path' joined = full URL.
    const r0 = 'http://example.com/very';
    const r1 = 'long/path';
    const links = detectRowLinks([row(0, r0), row(1, r1, true)]);
    expect(links.get(0)).toEqual([{ start: 0, end: r0.length, href: r0 + r1 }]);
    expect(links.get(1)).toEqual([{ start: 0, end: r1.length, href: r0 + r1 }]);
  });

  it('joins a URL wrapped across three rows', () => {
    const a = 'https://example.com/aaaa';
    const b = 'bbbbcccc';
    const c = 'dddd';
    const href = a + b + c;
    const links = detectRowLinks([row(0, a), row(1, b, true), row(2, c, true)]);
    expect(links.get(0)).toEqual([{ start: 0, end: a.length, href }]);
    expect(links.get(1)).toEqual([{ start: 0, end: b.length, href }]);
    expect(links.get(2)).toEqual([{ start: 0, end: c.length, href }]);
  });

  it('does not join across a non-wrapped (logical) line boundary', () => {
    // Second row is a NEW logical line (isWrapped=false), so no join.
    const links = detectRowLinks([row(0, 'http://example.com/a'), row(1, 'b/c', false)]);
    expect(links.get(0)).toEqual([{ start: 0, end: 20, href: 'http://example.com/a' }]);
    expect(links.has(1)).toBe(false);
  });

  it('indexes by code units so CJK text around a URL keeps correct ranges', () => {
    // Two leading CJK chars (2 code units), then the URL.
    const text = 'あい http://example.com END';
    const [link] = detectRowLinks([row(0, text)]).get(0)!;
    expect(text.slice(link.start, link.end)).toBe('http://example.com');
    expect(link.start).toBe(3); // 'あ','い',' ' = 3 code units
  });

  it('returns an empty map for rows with no URLs', () => {
    expect(detectRowLinks([row(0, ''), row(1, 'plain text')]).size).toBe(0);
  });

  describe('hard-wrapped (TUI-authored) URL breaks', () => {
    const r0 = 'see https://example.com/' + 'a'.repeat(10);
    const r1 = 'bcd/end';

    it('(a) joins across a break when row 1 fills the last column', () => {
      const href = r0.slice(4) + r1;
      const links = detectRowLinks([row(0, r0, false, true), row(1, r1)]);
      expect(links.get(0)).toEqual([{ start: 4, end: r0.length, href }]);
      expect(links.get(1)).toEqual([{ start: 0, end: r1.length, href }]);
    });

    it('(b) joins across three rows', () => {
      const r2 = 'xyz';
      const href = r0.slice(4) + r1 + r2;
      const links = detectRowLinks([
        row(0, r0, false, true),
        row(1, r1, false, true),
        row(2, r2),
      ]);
      expect(links.get(0)![0].href).toBe(href);
      expect(links.get(1)).toEqual([{ start: 0, end: r1.length, href }]);
      expect(links.get(2)).toEqual([{ start: 0, end: r2.length, href }]);
    });

    it('(c) does not join when row 1 does not fill the last column', () => {
      const links = detectRowLinks([row(0, r0, false, false), row(1, r1)]);
      expect(links.get(0)).toEqual([{ start: 4, end: r0.length, href: r0.slice(4) }]);
      expect(links.has(1)).toBe(false);
    });

    it('(d) does not join when the next row starts with a space', () => {
      const links = detectRowLinks([row(0, r0, false, true), row(1, ' next')]);
      expect(links.get(0)).toEqual([{ start: 4, end: r0.length, href: r0.slice(4) }]);
      expect(links.has(1)).toBe(false);
    });

    it('(d2) does not join when the next row starts with a non-URL, non-space character', () => {
      // \S+ would swallow these, so only the continuation-start guard keeps the href short.
      for (const next of ['│ box', '"quoted"', '<tag>']) {
        const links = detectRowLinks([row(0, r0, false, true), row(1, next)]);
        expect(links.get(0)).toEqual([{ start: 4, end: r0.length, href: r0.slice(4) }]);
        expect(links.has(1)).toBe(false);
      }
    });

    it('(e) does not join when row 1 ends in sentence punctuation at the last column', () => {
      const dotted = 'see https://example.com/a.';
      const links = detectRowLinks([row(0, dotted, false, true), row(1, 'next')]);
      expect(links.get(0)).toEqual([{ start: 4, end: dotted.length - 1, href: 'https://example.com/a' }]);
      expect(links.has(1)).toBe(false);
    });

    it('(f) does not join when the URL ends mid-row even though the row fills the last column', () => {
      const t = 'https://a.b/c more-text-to-col';
      const links = detectRowLinks([row(0, t, false, true), row(1, 'continues')]);
      expect(links.get(0)).toEqual([{ start: 0, end: 13, href: 'https://a.b/c' }]);
      expect(links.has(1)).toBe(false);
    });

    it('(g) a full row with no URL does not glue to a following row that starts a URL', () => {
      const prose = 'x'.repeat(20);
      const next = 'https://example.com/z';
      const links = detectRowLinks([row(0, prose, false, true), row(1, next)]);
      expect(links.has(0)).toBe(false);
      expect(links.get(1)).toEqual([{ start: 0, end: next.length, href: next }]);
    });

    it('does not synthesise a URL from a row that ends in a partial scheme', () => {
      // Row 1 has an earlier, closed URL and then ends in 'ht'; blind gluing of 'ht' + 'tps://x.y'
      // would create a new link whose row-1 range starts inside the prose.
      const first = 'see https://a.b/c ht';
      const links = detectRowLinks([row(0, first, false, true), row(1, 'tps://x.y/z')]);
      expect(links.get(0)).toEqual([{ start: 4, end: 17, href: 'https://a.b/c' }]);
      expect(links.has(1)).toBe(false);
    });
  });

  describe('mayContinuePreviousRow', () => {
    const full = row(0, 'https://a.b/c', false, true);
    const notFull = row(0, 'https://a.b/c', false, false);

    it('is true for a soft-wrap continuation regardless of fill', () => {
      expect(mayContinuePreviousRow(notFull, row(1, ' x', true))).toBe(true);
    });

    it('is true for a full previous row and a URL-plausible start', () => {
      expect(mayContinuePreviousRow(full, row(1, 'abc'))).toBe(true);
      expect(mayContinuePreviousRow(full, row(1, '/path'))).toBe(true);
    });

    it('is false for a non-full previous row, a space start, or an empty row', () => {
      expect(mayContinuePreviousRow(notFull, row(1, 'abc'))).toBe(false);
      expect(mayContinuePreviousRow(full, row(1, ' abc'))).toBe(false);
      expect(mayContinuePreviousRow(full, row(1, ''))).toBe(false);
    });
  });

  it('handles an empty rows array and a single full row', () => {
    expect(detectRowLinks([]).size).toBe(0);
    expect(detectRowLinks([row(0, 'https://a.b/c', false, true)]).get(0)).toEqual([
      { start: 0, end: 13, href: 'https://a.b/c' },
    ]);
  });
});
