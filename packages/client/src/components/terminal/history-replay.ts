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
const REPLAY_SCROLLBACK = 100_000;

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

function isBlankRow(row: TerminalRow): boolean {
  return row.segments.length === 1 && row.segments[0].text === '' && row.segments[0].style === null;
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
    scrollback: REPLAY_SCROLLBACK,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((resolve) => {
      terminal.write(processOutput(data), () => resolve());
    });

    const buffer = terminal.buffer.active;
    const length = buffer.length;
    if (length >= REPLAY_SCROLLBACK) {
      return { rows: [], overflow: true };
    }

    const baseY = buffer.baseY;
    const cursorY = baseY + buffer.cursorY;
    const nullCell = buffer.getNullCell();

    // Keep all scrollback rows (y < baseY) plus the settled prefix of the final
    // screen — rows up to and including the cursor row. Rows below the cursor
    // are the volatile screen region and are discarded (§6.2).
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
    // Trim trailing blank rows (the cursor commonly sits on blank tail lines).
    while (rows.length > 0 && isBlankRow(rows[rows.length - 1])) rows.pop();

    detectAndAssignLinks(rows);
    return { rows, overflow: false };
  } finally {
    terminal.dispose();
  }
}
