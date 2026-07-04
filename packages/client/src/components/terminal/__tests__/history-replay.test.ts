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
      24,
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
      24,
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
      24,
      identity,
    );
    const hrefs = rows.flatMap((r) => r.links.map((l) => l.href));
    expect(hrefs.some((h) => h.startsWith('https://example.com/very/long/path'))).toBe(true);
  });

  it('reports overflow (no committed rows) when the chunk fills the scrollback cap', async () => {
    const { rows, overflow } = await replayHistoryChunk('\n'.repeat(100_001), 80, 24, identity);
    expect(overflow).toBe(true);
    expect(rows).toEqual([]);
  });

  it('applies the processOutput filter to the chunk', async () => {
    const strip = (d: string) => d.replace(/SECRET/g, '');
    const { rows } = await replayHistoryChunk('keepSECRETme\r\n', 80, 24, strip);
    expect(textOf(rows)).toEqual(['keepme']);
  });

  it('floors a too-small rows value instead of degenerating (#979 sanity)', async () => {
    // rows=0 would give the throwaway Terminal a zero-height viewport; the floor
    // keeps replay coherent.
    const { rows, overflow } = await replayHistoryChunk('alpha\r\nbeta\r\n', 80, 0, identity);
    expect(overflow).toBe(false);
    expect(textOf(rows)).toEqual(['alpha', 'beta']);
  });

  describe('bottom-anchored TUI chrome positioning (#979)', () => {
    // A stream of settled content lines followed by a status-bar redraw that
    // saves the cursor, jumps to the LAST row of a 39-high screen (the app's true
    // viewport height), clears it, writes chrome, then restores the cursor
    // (`ESC7 … CUP(39,1) EL … ESC8`). The absolute row that CUP(39,1) resolves to
    // depends on the replay viewport height:
    //   - rows=39 (live height): the chrome lands on row 39 — below the cursor
    //     (which settled at ~row 30) — i.e. in the volatile below-cursor region,
    //     so it is discarded and never enters paged scrollback.
    //   - rows=24 (wrong fixed height): the 30 content lines overflow the 24-row
    //     screen, so the cursor is pinned to the screen bottom; CUP(39,1) clamps
    //     to that same bottom row, and the chrome overwrites the settled cursor
    //     line — leaking transient chrome into paged history.
    const CONTENT_ROWS = 30;
    const contentLines = Array.from(
      { length: CONTENT_ROWS },
      (_, i) => `L${String(i + 1).padStart(2, '0')}`,
    ).join('\r\n');
    // ESC7 save, CUP to (39,1) [bottom row of a 39-high screen], EL clear-to-eol,
    // write the chrome marker, ESC8 restore.
    const statusRedraw = '\x1b7\x1b[39;1H\x1b[K' + 'CHROME-STATUS-BAR' + '\x1b8';
    const fixture = contentLines + '\r\n' + statusRedraw;

    it('leaks the status bar into scrollback at the wrong (fixed) height', async () => {
      const { rows } = await replayHistoryChunk(fixture, 80, 24, identity);
      // Characterization: at the wrong height the chrome settles into paged rows.
      expect(textOf(rows).join('\n')).toContain('CHROME-STATUS-BAR');
    });

    it('keeps the status bar out of scrollback at the live height', async () => {
      const { rows } = await replayHistoryChunk(fixture, 80, 39, identity);
      // At the live height the chrome lands on the volatile bottom row and is
      // discarded; only the settled content survives.
      const text = textOf(rows).join('\n');
      expect(text).not.toContain('CHROME-STATUS-BAR');
      expect(text).toContain('L01');
      expect(text).toContain('L30');
    });
  });
});
