import { describe, it, expect } from 'bun:test';
import { replayHistoryChunk } from '../history-replay';

const identity = (d: string) => d;

function textOf(rows: { segments: { text: string }[] }[]): string[] {
  return rows.map((r) => r.segments.map((s) => s.text).join(''));
}

describe('replayHistoryChunk', () => {
  it('extracts settled line-flow rows, trailing blanks trimmed', async () => {
    const { rows, overflow } = await replayHistoryChunk(
      'line one\r\nline two\r\nline three\r\n',
      80,
      identity,
    );
    expect(overflow).toBe(false);
    expect(textOf(rows)).toEqual(['line one', 'line two', 'line three']);
  });

  it('discards the volatile region below the cursor (TUI churn) without crashing', async () => {
    // Home, clear, draw, then reposition and overwrite — a redraw pattern. The
    // result is approximate by design; the assertion is that it is coherent.
    const { rows, overflow } = await replayHistoryChunk(
      '\x1b[2J\x1b[Hheader\r\nbody line\r\n\x1b[10;1Hfooter',
      80,
      identity,
    );
    expect(overflow).toBe(false);
    expect(Array.isArray(rows)).toBe(true);
    // The settled prefix up to the cursor is kept; the cursor sits on 'footer'.
    expect(textOf(rows).join('\n')).toContain('header');
  });

  it('detects a URL that wraps across replayed rows (link pipeline parity)', async () => {
    const { rows } = await replayHistoryChunk(
      'see https://example.com/very/long/path/that/wraps/around here',
      20,
      identity,
    );
    const hrefs = rows.flatMap((r) => r.links.map((l) => l.href));
    expect(hrefs.some((h) => h.startsWith('https://example.com/very/long/path'))).toBe(true);
  });

  it('reports overflow (no committed rows) when the chunk fills the scrollback cap', async () => {
    const { rows, overflow } = await replayHistoryChunk('\n'.repeat(100_001), 80, identity);
    expect(overflow).toBe(true);
    expect(rows).toEqual([]);
  });

  it('applies the processOutput filter to the chunk', async () => {
    const strip = (d: string) => d.replace(/SECRET/g, '');
    const { rows } = await replayHistoryChunk('keepSECRETme\r\n', 80, strip);
    expect(textOf(rows)).toEqual(['keepme']);
  });
});
