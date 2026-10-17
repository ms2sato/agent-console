import { describe, it, expect, afterEach } from 'bun:test';
import {
  replayHistoryChunk,
  replayHistoryPair,
  replayHistoryJoint,
  _setReplayScrollbackForTest,
} from '../history-replay';

const identity = (d: string) => d;

function textOf(rows: { segments: { text: string }[] }[]): string[] {
  return rows.map((r) => r.segments.map((s) => s.text).join(''));
}

describe('replayHistoryChunk: trailing blank at a soft-wrap point', () => {
  const COLS = 20;
  const LINE = 'a'.repeat(COLS - 1) + ' ' + 'b';

  it('keeps the space that ends a full row when its continuation is in the same chunk', async () => {
    const { rows } = await replayHistoryChunk(LINE + '\r\n', COLS, 24, identity);
    expect(textOf(rows)).toEqual(['a'.repeat(COLS - 1) + ' ', 'b']);
    expect(rows[1].isWrapped).toBe(true);
  });

  // Measured limit: a chunk is replayed on its own, so the row that ends the
  // chunk has no successor in the throwaway buffer even if the live line
  // continues in the next chunk. That row keeps today's trim.
  it('limit: a full row at the very end of a chunk (continuation in the next chunk) is still trimmed', async () => {
    const { rows } = await replayHistoryChunk('a'.repeat(COLS - 1) + ' ', COLS, 24, identity);
    expect(textOf(rows)).toEqual(['a'.repeat(COLS - 1)]);
  });
});

describe('replayHistoryChunk', () => {
  it('joins a hard-wrapped URL in a replayed chunk via the shared row pipeline', async () => {
    const COLS = 40;
    const row1 = 'https://example.com/' + 'a'.repeat(COLS - 'https://example.com/'.length);
    const row2 = 'bcd/end';
    const { rows } = await replayHistoryChunk(`${row1}\r\n${row2}\r\n`, COLS, 24, identity);
    expect(textOf(rows)).toEqual([row1, row2]);
    expect(rows[1].isWrapped).toBe(false);
    expect(rows[0].fillsLastColumn).toBe(true);
    expect(rows[1].links).toEqual([{ start: 0, end: row2.length, href: row1 + row2 }]);
  });

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

describe('replayHistoryPair (seam correction §6.2)', () => {
  afterEach(() => {
    // Restore the real scrollback bound after any override.
    _setReplayScrollbackForTest(null);
  });

  // Fixture perspective (matches the store's): `newer` is the OLDER range that
  // the pair writes FIRST; `older`/`OLDER_RANGE` here is C_new's bytes and
  // `NEWER_RANGE` is C_top's bytes (the current top chunk, written SECOND).
  const OLDER_RANGE = Array.from({ length: 40 }, (_, i) => `R${String(i + 1).padStart(2, '0')}`)
    .map((s) => `${s}\r\n`)
    .join('');
  // C_top begins mid-repaint: a relative CUU that assumes its predecessor left
  // the cursor just after committed content (`\x1b[2A` up, `\r\x1b[K` clear the
  // line, write the chrome bar there), then continues with fresh committed
  // lines. Started from an EMPTY screen the CUU clamps at the top and the chrome
  // is misplaced as a leading settled row — the #979 seam artifact.
  const NEWER_RANGE =
    '\x1b[2A\r\x1b[K' +
    'CHROME-BAR' +
    '\r\n\r\n' +
    Array.from({ length: 20 }, (_, i) => `N${String(i + 1).padStart(2, '0')}`)
      .map((s) => `${s}\r\n`)
      .join('');

  // NOTE (fixture deviation): this synthetic fixture asserts the seam artifact at
  // the CHUNK BOUNDARY (the first row of the seam-sensitive chunk), not the
  // "chrome scrolled deep into scrollback" shape of a real captured relative-
  // repaint TUI. A static synthetic stream cannot reproduce the latter: the
  // scrollback-always-kept vs below-cursor-discarded extraction rules couple such
  // that any fixture making standalone leak chrome into settled rows also makes
  // the paired replay keep it (both accumulate the same scrollback), and any
  // fixture where the paired replay discards the chrome clamps the standalone to
  // a single row. The real-capture shape is covered by the E2E acceptance
  // (per the coordinator). What this fixture DOES prove is the load-bearing
  // invariant: the chunk's BOUNDARY row is correct only because the predecessor's
  // bytes were replayed first — intrinsically polarity-guarding, since a pair
  // that behaved like a standalone replay would surface the artifact at the seam.

  it('standalone replay of the newer range misplaces chrome as a leading settled row', async () => {
    const { rows } = await replayHistoryChunk(NEWER_RANGE, 80, 24, (d) => d);
    // Polarity half: without the predecessor's state the CUU clamps at the top
    // and the chrome bar lands as the FIRST (settled, non-final) row.
    expect(textOf(rows)[0]).toBe('CHROME-BAR');
    // The real committed content still follows, in order.
    expect(textOf(rows).filter((r) => /^N\d\d$/.test(r))).toEqual(
      Array.from({ length: 20 }, (_, i) => `N${String(i + 1).padStart(2, '0')}`),
    );
  });

  it('pair re-replay corrects the seam: the boundary row is content, not chrome', async () => {
    const pair = await replayHistoryPair(OLDER_RANGE, NEWER_RANGE, 80, 24, (d) => d, 'keep');
    expect(pair.overflow).toBe(false);
    // The top chunk (C_top) is the seam-sensitive one. With the predecessor
    // replayed first, its leading (boundary) row is real content, NOT the
    // spurious chrome the standalone replay produced.
    expect(textOf(pair.topChunkRows)[0]).not.toBe('CHROME-BAR');
    expect(textOf(pair.topChunkRows)[0]).toBe('R18');
    // The partition is content-contiguous across the boundary: C_new's settled
    // tail then C_top's rows, no duplication or loss at the seam.
    const newTail = textOf(pair.newChunkRows).slice(-3);
    expect(newTail).toEqual(['R15', 'R16', 'R17']);
    expect(textOf(pair.topChunkRows).slice(0, 4)).toEqual(['R18', 'R19', 'R20', 'R21']);
  });

  it('partitions a pure line-flow pair with no duplication or loss at the boundary', async () => {
    const A = Array.from({ length: 30 }, (_, i) => `A${String(i + 1).padStart(2, '0')}\r\n`).join('');
    const B = Array.from({ length: 15 }, (_, i) => `B${String(i + 1).padStart(2, '0')}\r\n`).join('');
    const sa = await replayHistoryChunk(A, 80, 24, (d) => d);
    const sb = await replayHistoryChunk(B, 80, 24, (d) => d);
    const pair = await replayHistoryPair(A, B, 80, 24, (d) => d, 'keep');
    // The joined partition equals the concatenation of the two standalone
    // extractions (the split index differs — splitBaseY counts only C_new's
    // scrolled rows — but the JOINED set is loss- and duplication-free).
    expect([...textOf(pair.newChunkRows), ...textOf(pair.topChunkRows)]).toEqual([
      ...textOf(sa.rows),
      ...textOf(sb.rows),
    ]);
  });

  it('reports overflow when the JOINED pair exceeds the scrollback cap (fallback path)', async () => {
    _setReplayScrollbackForTest(50);
    const A = Array.from({ length: 10 }, (_, i) => `A${i}\r\n`).join('');
    // B alone stays under the cap; A + B together exceed it.
    const B = Array.from({ length: 45 }, (_, i) => `B${i}\r\n`).join('');
    const pairResult = await replayHistoryPair(A, B, 80, 24, (d) => d, 'keep');
    const standaloneB = await replayHistoryChunk(B, 80, 24, (d) => d);
    expect(pairResult.overflow).toBe(true); // joined overflowed -> store falls back
    expect(pairResult.newChunkRows).toEqual([]);
    expect(pairResult.topChunkRows).toEqual([]);
    expect(standaloneB.overflow).toBe(false); // the standalone fallback fits
  });

  it('joins a URL that wraps across the corrected chunk boundary (side benefit)', async () => {
    // The URL is split across the C_new / C_top byte boundary within one logical
    // (wrapped) line; link detection over the joined extraction reconnects it.
    const newer = 'start of line https://example.com/very/long/';
    const top = 'path/that/continues/here end\r\n';
    const pair = await replayHistoryPair(newer, top, 20, 24, (d) => d, 'keep');
    const hrefs = [...pair.newChunkRows, ...pair.topChunkRows].flatMap((r) => r.links.map((l) => l.href));
    expect(hrefs.some((h) => h.includes('very/long/path/that/continues'))).toBe(true);
  });

  it("'keep' keeps the top chunk's on-screen tail; 'yield-to-newer' drops it from topChunkRows", async () => {
    const A = Array.from({ length: 30 }, (_, i) => `A${String(i + 1).padStart(2, '0')}\r\n`).join('');
    const B = Array.from({ length: 30 }, (_, i) => `B${String(i + 1).padStart(2, '0')}\r\n`).join('');
    const keep = await replayHistoryPair(A, B, 80, 24, (d) => d, 'keep');
    const yielded = await replayHistoryPair(A, B, 80, 24, (d) => d, 'yield-to-newer');
    expect(textOf(yielded.newChunkRows)).toEqual(textOf(keep.newChunkRows));
    const dropped = keep.topChunkRows.length - yielded.topChunkRows.length;
    expect(dropped).toBeGreaterThan(0);
    expect(dropped).toBeLessThanOrEqual(23);
    expect(textOf(keep.topChunkRows).slice(0, yielded.topChunkRows.length)).toEqual(textOf(yielded.topChunkRows));
  });
});

describe('replayHistoryJoint (triple seam correction §6.2, #994)', () => {
  afterEach(() => {
    _setReplayScrollbackForTest(null);
  });

  it('partitions a pure line-flow triple with no duplication or loss at either boundary', async () => {
    // Stream order (oldest first): A precedes B precedes C.
    const A = Array.from({ length: 30 }, (_, i) => `A${String(i + 1).padStart(2, '0')}\r\n`).join('');
    const B = Array.from({ length: 15 }, (_, i) => `B${String(i + 1).padStart(2, '0')}\r\n`).join('');
    const C = Array.from({ length: 10 }, (_, i) => `C${String(i + 1).padStart(2, '0')}\r\n`).join('');
    const sa = await replayHistoryChunk(A, 80, 24, (d) => d);
    const sb = await replayHistoryChunk(B, 80, 24, (d) => d);
    const sc = await replayHistoryChunk(C, 80, 24, (d) => d);
    const joint = await replayHistoryJoint([A, B, C], 80, 24, (d) => d, 'keep');
    expect(joint.overflow).toBe(false);
    expect(joint.partitions.length).toBe(3);
    // The joined partition equals the concatenation of the three standalone
    // extractions (per-partition split boundaries differ — splitBaseY_i counts
    // only the scrollback settled BEFORE that partition — but the JOINED set
    // is loss- and duplication-free).
    expect(
      joint.partitions.flatMap((rows) => textOf(rows)),
    ).toEqual([...textOf(sa.rows), ...textOf(sb.rows), ...textOf(sc.rows)]);
  });

  it("'yield-to-newer' ends the last partition at its recorded baseY and leaves the on-screen tail to the newer chunk", async () => {
    const A = Array.from({ length: 30 }, (_, i) => `A${String(i + 1).padStart(2, '0')}\r\n`).join('');
    const B = Array.from({ length: 30 }, (_, i) => `B${String(i + 1).padStart(2, '0')}\r\n`).join('');
    const C = Array.from({ length: 30 }, (_, i) => `C${String(i + 1).padStart(2, '0')}\r\n`).join('');
    const newest = await replayHistoryJoint([A, B, C], 80, 24, (d) => d, 'keep');
    const withNewer = await replayHistoryJoint([A, B, C], 80, 24, (d) => d, 'yield-to-newer');
    // Boundaries before the last are untouched.
    expect(textOf(withNewer.partitions[0])).toEqual(textOf(newest.partitions[0]));
    expect(textOf(withNewer.partitions[1])).toEqual(textOf(newest.partitions[1]));
    // The last chunk keeps its settled scrollback only: it drops exactly the tail
    // that stays on the replay screen (up to rows - 1 rows).
    const dropped = newest.partitions[2].length - withNewer.partitions[2].length;
    expect(dropped).toBeGreaterThan(0);
    expect(dropped).toBeLessThanOrEqual(23);
    expect(textOf(newest.partitions[2]).slice(0, withNewer.partitions[2].length)).toEqual(textOf(withNewer.partitions[2]));
  });

  it("'keep' ends the last partition at extracted.length; 'yield-to-newer' ends it at the last recorded baseY", async () => {
    const A = Array.from({ length: 30 }, (_, i) => `A${String(i + 1).padStart(2, '0')}\r\n`).join('');
    const B = Array.from({ length: 30 }, (_, i) => `B${String(i + 1).padStart(2, '0')}\r\n`).join('');
    const C = Array.from({ length: 30 }, (_, i) => `C${String(i + 1).padStart(2, '0')}\r\n`).join('');
    const standalone = await replayHistoryChunk(A + B + C, 80, 24, (d) => d);
    const keep = await replayHistoryJoint([A, B, C], 80, 24, (d) => d, 'keep');
    const yielded = await replayHistoryJoint([A, B, C], 80, 24, (d) => d, 'yield-to-newer');
    const total = (r: typeof keep) => r.partitions.reduce((n, p) => n + p.length, 0);
    // 'keep' covers the whole extraction; 'yield-to-newer' stops at the baseY
    // after the last write, which is the same extraction minus the on-screen tail.
    expect(total(keep)).toBe(standalone.rows.length);
    expect(total(yielded)).toBeLessThan(total(keep));
    expect(total(keep) - total(yielded)).toBeLessThanOrEqual(23);
  });

  it('reports overflow (empty partitions) when the joined triple exceeds the scrollback cap', async () => {
    _setReplayScrollbackForTest(50);
    // Each chunk alone stays under the cap; all three together exceed it.
    const A = Array.from({ length: 10 }, (_, i) => `A${i}\r\n`).join('');
    const B = Array.from({ length: 10 }, (_, i) => `B${i}\r\n`).join('');
    const C = Array.from({ length: 40 }, (_, i) => `C${i}\r\n`).join('');
    const result = await replayHistoryJoint([A, B, C], 80, 24, (d) => d, 'keep');
    expect(result.overflow).toBe(true);
    expect(result.partitions).toEqual([]);
  });

  it('corrects a wrap-boundary seam: the merge row belongs to the next chunk\'s partition, not the middle chunk\'s', async () => {
    // A (oldest) is line-flow only.
    const A = Array.from({ length: 30 }, (_, i) => `A${String(i + 1).padStart(2, '0')}\r\n`).join('');
    // B (middle) ends WITHOUT a trailing newline — a mid-word partial line
    // that the byte cut splits into (B.tail = 'hello wor', C.head = 'ld world').
    const B =
      Array.from({ length: 20 }, (_, i) => `B${String(i + 1).padStart(2, '0')}\r\n`).join('') +
      'segment-B-tail-hello wor';
    // C (newest) starts with the completion of B's partial line, then more.
    const C =
      'ld world\r\n' +
      Array.from({ length: 15 }, (_, i) => `C${String(i + 1).padStart(2, '0')}\r\n`).join('');
    const joint = await replayHistoryJoint([A, B, C], 80, 24, (d) => d, 'keep');
    expect(joint.overflow).toBe(false);
    const [, bPart, cPart] = joint.partitions;
    const bText = textOf(bPart);
    const cText = textOf(cPart);
    // Under the joint partition, B's own on-screen tail ('hello wor') was
    // still on-screen at splitBaseYs[1] capture — it did NOT settle into
    // scrollback during B's writes. So B's partition contains NEITHER the
    // partial fragment NOR the merged row. (Under the current pair-only
    // design's Step N+1 pair(new_C, B), B's rows WOULD have contained the
    // 'hello wor' row — that is the #994 duplicate this triple replay avoids.)
    expect(bText.some((line) => /hello wor$/.test(line))).toBe(false);
    expect(bText.some((line) => /hello world/.test(line))).toBe(false);
    // C's partition contains the merged row exactly once — C's leading
    // 'ld world' completed B's partial line before the next \r\n scrolled it
    // into scrollback, so the joint extraction captures the merge.
    expect(cText.filter((line) => /segment-B-tail-hello world/.test(line)).length).toBe(1);
    // And the partial fragment is NOT visible anywhere — the completion
    // covered it before extraction.
    expect(cText.some((line) => /hello wor$/.test(line) && !/hello world/.test(line))).toBe(false);
  });

  it('corrects a repaint-frame-boundary seam so chrome does not clamp as a leading settled row', async () => {
    // Mirrors the existing pair-replay test's polarity assertion, extended to
    // 3 chunks. C alone (standalone) clamps its leading CUU at the empty
    // screen top, settling 'CHROME-BAR' as a leading scrollback row. The
    // joint (A, B, C) gives C's leading repaints the state B established, so
    // the CUU lands on B's on-screen row and does NOT leak chrome into C's
    // settled scrollback.
    const A = Array.from({ length: 25 }, (_, i) => `A${String(i + 1).padStart(2, '0')}\r\n`).join(
      '',
    );
    const B =
      Array.from({ length: 20 }, (_, i) => `B${String(i + 1).padStart(2, '0')}\r\n`).join('');
    // C starts mid-repaint: relative CUU + clear + chrome-bar, then a
    // continuation into fresh committed lines. Started from an EMPTY screen
    // the CUU clamps at the top -> chrome misplaced (baseline).
    const C =
      '\x1b[2A\r\x1b[K' +
      'CHROME-BAR' +
      '\r\n\r\n' +
      Array.from({ length: 15 }, (_, i) => `C${String(i + 1).padStart(2, '0')}\r\n`).join('');
    // Baseline polarity: standalone C has 'CHROME-BAR' as its first row.
    const standaloneC = await replayHistoryChunk(C, 80, 24, (d) => d);
    expect(textOf(standaloneC.rows)[0]).toBe('CHROME-BAR');
    // Joint (A, B, C) — the chrome row is corrected.
    const joint = await replayHistoryJoint([A, B, C], 80, 24, (d) => d, 'keep');
    expect(joint.overflow).toBe(false);
    const cPart = textOf(joint.partitions[2]);
    // C's leading row is NOT the chrome bar — it is real content, because
    // the CUU landed on B's on-screen row (which existed in the joined state).
    expect(cPart[0]).not.toBe('CHROME-BAR');
  });
});
