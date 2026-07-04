import { Terminal } from '@xterm/headless';
import { extractRow, type TerminalRow } from './buffer-to-rows';
import { detectAndAssignLinks } from './row-pipeline';

/**
 * Throwaway headless VT replay for a paged history chunk
 * (terminal-history-paging.md §6.2).
 *
 * ANSI streams cannot be replayed from an arbitrary midpoint (cursor/screen
 * state is order-dependent), so each fetched chunk is rendered by a *throwaway*
 * `@xterm/headless` Terminal created per chunk and disposed immediately. The
 * result is the settled rows of that chunk, ready to prepend above the live
 * window. Paged chunks are settled history — extraction always uses `extractRow`
 * (never the cursor variant): there is no live cursor to bake into archived rows.
 */

// Generous fixed scrollback (not a typical-case estimate): the true worst case
// for a chunk is one row per byte. See the overflow degradation loop in the
// store — at the 16KB floor even one-byte-per-row fits within this bound.
const REPLAY_SCROLLBACK_DEFAULT = 100_000;

// Mutable so tests can shrink the bound and exercise the overflow-degradation /
// pair-fallback paths, which are untestable at the real 100k cap under
// MAX_PAGED_ROWS. Overridden via _setReplayScrollbackForTest.
let replayScrollback = REPLAY_SCROLLBACK_DEFAULT;

/**
 * @internal Exported for testing. Override the throwaway-terminal scrollback
 * bound (both the `scrollback` construction option and the overflow threshold)
 * so the overflow-degradation / pair-fallback paths are reachable below the real
 * 100k cap. Pass `null` to restore the default. Precedent: terminal-store's
 * `_setTimings`.
 */
export function _setReplayScrollbackForTest(n: number | null): void {
  replayScrollback = n ?? REPLAY_SCROLLBACK_DEFAULT;
}

// Floor for the throwaway Terminal's rows. A viewport of at least 2 rows is
// required for any coherent cursor-positioning replay; below that xterm's
// scroll-region math degenerates.
const REPLAY_ROWS_MIN = 2;

export interface ReplayResult {
  /** Settled rows of the chunk (keys 0..n-1; the store re-keys to negatives). */
  rows: TerminalRow[];
  /**
   * True when the throwaway buffer hit the scrollback cap, meaning rows were
   * silently dropped from the top and the replay is NOT authoritative. The
   * store discards it and re-requests the same range at a quartered maxBytes.
   */
  overflow: boolean;
}

/** The active buffer of a throwaway Terminal (IBuffer is not module-exported). */
type ReplayBuffer = InstanceType<typeof Terminal>['buffer']['active'];

function isBlankRow(row: TerminalRow): boolean {
  return row.segments.length === 1 && row.segments[0].text === '' && row.segments[0].style === null;
}

/**
 * Extract the settled rows of a throwaway buffer: all scrollback rows (y < baseY)
 * plus the settled prefix of the final screen (up to and including the cursor
 * row), with trailing blank rows trimmed. Rows below the cursor are the volatile
 * screen region and are discarded (§6.2). Keys are 0..n-1; callers re-key.
 * Link detection is NOT run here — the caller runs it over the final row set
 * (for the pair replay, over the joined extraction before partitioning).
 */
function extractSettledRows(buffer: ReplayBuffer, cols: number): TerminalRow[] {
  const length = buffer.length;
  const baseY = buffer.baseY;
  const cursorY = baseY + buffer.cursorY;
  const nullCell = buffer.getNullCell();

  const lastKept = Math.min(cursorY, length - 1);
  const rows: TerminalRow[] = [];
  for (let y = 0; y <= lastKept; y++) {
    const line = buffer.getLine(y);
    rows.push(
      line
        ? extractRow(line, cols, nullCell, y)
        : { key: y, segments: [{ text: '', style: null }], isWrapped: false, links: [] },
    );
  }
  while (rows.length > 0 && isBlankRow(rows[rows.length - 1])) rows.pop();
  return rows;
}

/**
 * Replay one history chunk into a throwaway terminal and extract its settled
 * rows.
 *
 * @param data     Raw chunk bytes (as a string) covering an absolute range.
 * @param cols     The live terminal's current cols (wrap parity with the window).
 * @param rows     The live terminal's current rows. A TUI that redraws a chrome
 *                 line relative to the screen bottom (e.g. an alt-cursor status
 *                 bar via `ESC7 … CUP(rows,1) … ESC8`) lands on a *different*
 *                 absolute row depending on the viewport height. Replaying at a
 *                 fixed height mispositions that write and leaks the transient
 *                 chrome into settled scrollback; replaying at the live height
 *                 keeps the paged geometry consistent with the live window (#979).
 * @param processOutput The same strip pipeline the live store applies, so paged
 *                 rows match live rows in content policy.
 */
export async function replayHistoryChunk(
  data: string,
  cols: number,
  rows: number,
  processOutput: (data: string) => string,
): Promise<ReplayResult> {
  const terminal = new Terminal({
    cols: Math.max(1, cols),
    rows: Math.max(REPLAY_ROWS_MIN, rows),
    scrollback: replayScrollback,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((resolve) => {
      terminal.write(processOutput(data), () => resolve());
    });

    const buffer = terminal.buffer.active;
    if (buffer.length >= replayScrollback) {
      return { rows: [], overflow: true };
    }

    const rows = extractSettledRows(buffer, cols);
    detectAndAssignLinks(rows);
    return { rows, overflow: false };
  } finally {
    terminal.dispose();
  }
}

export interface ReplayPairResult {
  /** C_new's settled rows: extraction[0, splitBaseY). Keys 0..n-1; store re-keys. */
  newChunkRows: TerminalRow[];
  /** C_top's seam-free rows: extraction[splitBaseY, end). Keys 0..n-1. */
  topChunkRows: TerminalRow[];
  /**
   * True when the joined pair overflowed the throwaway scrollback. The store
   * falls back to a standalone replay of C_new for this fetch (§6.2 Fallback).
   */
  overflow: boolean;
}

/**
 * Pair re-replay for seam correction (§6.2 "Seam correction — older-neighbor
 * pair re-replay (#979)").
 *
 * A range chunk begins at an arbitrary VT midpoint, so its standalone replay
 * starts without the terminal state the preceding bytes established; a
 * relative-repaint TUI's leading frame-tail then clamps at the top of the empty
 * throwaway screen and settles into scrollback as a chrome artifact. When the
 * next older chunk arrives, replaying it TOGETHER with the current top gives the
 * top's leading repaints the state its predecessor established, erasing the seam.
 *
 * Stream order: `newBytes` is the OLDER range (the just-fetched chunk `C_new`)
 * and `topBytes` is the NEWER range (the current top chunk `C_top`). C_new
 * precedes C_top in the stream, so `newBytes` is written FIRST, then `topBytes`.
 * Parameter names are oriented to the store's perspective (`msg.data` = newBytes
 * = older range; `topChunk.rawData` = topBytes = newer range).
 *
 * @returns newChunkRows (replaces C_new's rows) and topChunkRows (replaces
 *          C_top's rows, now seam-free). Link detection runs over the JOINED
 *          extraction before partitioning (LinkRanges are per-row, so the
 *          partition below is safe) — a wrapped URL crossing the boundary joins.
 */
export async function replayHistoryPair(
  newBytes: string,
  topBytes: string,
  cols: number,
  rows: number,
  processOutput: (data: string) => string,
): Promise<ReplayPairResult> {
  const terminal = new Terminal({
    cols: Math.max(1, cols),
    rows: Math.max(REPLAY_ROWS_MIN, rows),
    scrollback: replayScrollback,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((resolve) => {
      terminal.write(processOutput(newBytes), () => resolve());
    });
    // Scrollback settled so far belongs to C_new; the still-volatile screen rows
    // are exactly the state C_top's leading repaints consume (the correction).
    const splitBaseY = terminal.buffer.active.baseY;

    await new Promise<void>((resolve) => {
      terminal.write(processOutput(topBytes), () => resolve());
    });

    const buffer = terminal.buffer.active;
    if (buffer.length >= replayScrollback) {
      return { newChunkRows: [], topChunkRows: [], overflow: true };
    }

    const extracted = extractSettledRows(buffer, cols);
    // Link detection over the JOINED extraction (cross-boundary URLs join here).
    detectAndAssignLinks(extracted);
    // Partition at splitBaseY. Clamp when the final extraction is SHORTER than
    // splitBaseY (C_top's bytes ended with erases that pulled the buffer back
    // above where C_new had settled): topChunkRows is then empty, not negative.
    const split = Math.min(splitBaseY, extracted.length);
    return {
      newChunkRows: extracted.slice(0, split),
      topChunkRows: extracted.slice(split),
      overflow: false,
    };
  } finally {
    terminal.dispose();
  }
}
