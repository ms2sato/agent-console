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

export interface ReplayJointResult {
  /**
   * N partitioned row arrays in the same order as the input `chunks` (oldest
   * first, in stream order). Empty partitions on overflow.
   * Keys are 0..n-1 per partition; callers re-key.
   */
  partitions: TerminalRow[][];
  /**
   * True when the joined write overflowed the throwaway scrollback. Partitions
   * are `[]` in that case; callers fall back per §6.2 Fallback.
   */
  overflow: boolean;
}

/**
 * Joint N-chunk re-replay for seam correction (§6.2 "Seam correction — older-
 * neighbor pair re-replay (#979)", generalized to N chunks for #994).
 *
 * A range chunk begins at an arbitrary VT midpoint, so its standalone replay
 * starts without the terminal state the preceding bytes established. When
 * multiple sequential chunks are replayed TOGETHER — writing them in stream
 * order into one throwaway terminal and capturing `baseY` BETWEEN each write —
 * every seam between adjacent chunks is corrected in one pass. The extracted
 * rows are partitioned at those captured `baseY` values, so each chunk's rows
 * are the scrollback it produced BEFORE the next chunk's first byte landed —
 * the "on-screen" cursor row (potentially merged mid-line with the next chunk's
 * head) belongs to the NEXT chunk's partition.
 *
 * This solves the #994 pair-chain re-inclusion bug: in the old two-chunk pair
 * (`replayHistoryPair` semantics, still supported below), the older chunk's
 * on-screen tail landed in the newer chunk's partition on THIS fetch, but the
 * next fetch's pair replay had no way to know the older chunk's rows had
 * already been split that way — it re-included the same seam row in its own
 * `topChunkRows` partition. The joint replay of 3+ chunks lets each pair of
 * boundaries be settled in one context.
 *
 * @param chunks   Raw bytes for chunks in stream order (oldest first). The
 *                 first entry is `C_new` (just fetched); subsequent entries are
 *                 previously-fetched chunks in stream order (i.e. what the
 *                 store's `pagedChunks[0]`, `pagedChunks[1]`, … held).
 * @param cols     Live terminal cols (wrap parity).
 * @param rows     Live terminal rows (bottom-anchored chrome positioning, #979).
 * @param processOutput  Same strip pipeline the live store applies.
 * @returns  N partitions in the same order as `chunks`. Empty on overflow.
 */
export async function replayHistoryJoint(
  chunks: string[],
  cols: number,
  rows: number,
  processOutput: (data: string) => string,
): Promise<ReplayJointResult> {
  const terminal = new Terminal({
    cols: Math.max(1, cols),
    rows: Math.max(REPLAY_ROWS_MIN, rows),
    scrollback: replayScrollback,
    allowProposedApi: true,
  });
  try {
    // Capture baseY BETWEEN each chunk write. splitBaseYs[i] is baseY AFTER
    // writing chunks[i]; the last one is used as `extracted.length` implicitly
    // in the partitioning below.
    const splitBaseYs: number[] = [];
    for (const chunk of chunks) {
      await new Promise<void>((resolve) => {
        terminal.write(processOutput(chunk), () => resolve());
      });
      splitBaseYs.push(terminal.buffer.active.baseY);
    }

    const buffer = terminal.buffer.active;
    if (buffer.length >= replayScrollback) {
      return { partitions: [], overflow: true };
    }

    const extracted = extractSettledRows(buffer, cols);
    // Link detection over the JOINED extraction (cross-boundary URLs join here).
    detectAndAssignLinks(extracted);

    // Partition at the captured baseYs. For chunks[i], the partition is
    // extracted[start_i, end_i), where:
    //   start_0 = 0, start_i>0 = splitBaseYs[i-1]
    //   end_last = extracted.length, end_i<last = splitBaseYs[i]
    // Clamp each boundary to extracted.length: a final erase can pull the buffer
    // back above where an earlier chunk had settled, in which case that
    // partition becomes empty rather than negative.
    const partitions: TerminalRow[][] = [];
    let cursor = 0;
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const end = isLast ? extracted.length : Math.min(splitBaseYs[i], extracted.length);
      const start = Math.min(cursor, end);
      partitions.push(extracted.slice(start, end));
      cursor = end;
    }
    return { partitions, overflow: false };
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
 * pair re-replay (#979)"). Delegates to {@link replayHistoryJoint} with two
 * chunks and returns a pair-shaped result for callers that reason about two
 * partitions specifically (test coverage for the N=2 degenerate case and
 * fallback callers that only ever hold one previous chunk's raw).
 *
 * Stream order: `newBytes` is the OLDER range (the just-fetched chunk `C_new`)
 * and `topBytes` is the NEWER range (the current top chunk `C_top`). C_new
 * precedes C_top in the stream, so `newBytes` is written FIRST, then `topBytes`.
 * Parameter names are oriented to the store's perspective (`msg.data` = newBytes
 * = older range; `topChunk.rawData` = topBytes = newer range).
 */
export async function replayHistoryPair(
  newBytes: string,
  topBytes: string,
  cols: number,
  rows: number,
  processOutput: (data: string) => string,
): Promise<ReplayPairResult> {
  const joint = await replayHistoryJoint([newBytes, topBytes], cols, rows, processOutput);
  if (joint.overflow) {
    return { newChunkRows: [], topChunkRows: [], overflow: true };
  }
  return {
    newChunkRows: joint.partitions[0] ?? [],
    topChunkRows: joint.partitions[1] ?? [],
    overflow: false,
  };
}
