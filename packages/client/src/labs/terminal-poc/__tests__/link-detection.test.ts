import { describe, it, expect } from 'bun:test';
import { detectRowLinks, type DetectRow } from '../link-detection';

function row(key: number, text: string, isWrapped = false): DetectRow {
  return { key, text, isWrapped };
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
});
