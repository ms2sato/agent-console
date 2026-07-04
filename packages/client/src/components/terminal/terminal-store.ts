import { Terminal } from '@xterm/headless';
import {
  WORKER_SERVER_MESSAGE_TYPES,
  type WorkerServerMessage,
  type WorkerClientMessage,
  type WorkerErrorCode,
  type AgentActivityState,
  type AppServerMessage,
} from '@agent-console/shared';
import { getWorkerWsUrl } from '../../lib/websocket-url.js';
import { getReconnectDelay, shouldReconnect } from '../../lib/websocket-reconnect.js';
import { subscribe as subscribeApp } from '../../lib/app-websocket.js';
import { stripSystemMessages, stripScrollbackClear as applyScrollbackFilter } from '../../lib/terminal-utils.js';
import { logger } from '../../lib/logger';
import { extractRow, extractRowWithCursor, type TerminalRow } from './buffer-to-rows';
import { detectRowLinks } from './link-detection';
import { replayHistoryChunk, replayHistoryPair } from './history-replay';
import { rowText } from './row-pipeline';

/**
 * Module-level store: the headless Terminal + WebSocket for each worker live
 * OUTSIDE React, keyed by `${sessionId}:${workerId}`. React only subscribes via
 * useSyncExternalStore. Because the live instance persists across route
 * navigation, no serialize/restore of terminal state is ever needed — returning
 * to the route reuses the same instance and its already-parsed buffer.
 *
 * This is the architectural point of the module-store renderer.
 */

export type TerminalStatus = 'connecting' | 'connected' | 'disconnected' | 'exited';

export interface TerminalSnapshot {
  version: number; // bumped on every batched buffer change
  status: TerminalStatus;
  exitInfo: { code: number; signal: string | null } | null;
  rows: TerminalRow[]; // full scrollback + viewport
  cursor: { x: number; y: number; visible: boolean }; // y = absolute row index
  cols: number;
  terminalRows: number;
  bufferType: 'normal' | 'alternate'; // 'alternate' = full-screen app (scroll is forwarded)
  mouseTracking: boolean; // app has DECSET mouse tracking on -> report clicks to the TUI
  notice: string | null; // dismissible banner (restart / truncation)
  workerError: { message: string; code?: WorkerErrorCode } | null;
  activityState: AgentActivityState | null;
  loadingHistory: boolean; // a request-history is in flight
  // --- Scroll-back history paging (terminal-history-paging.md §6) ---
  loadingOlder: boolean; // a request-history-range is in flight
  // Whether the view may fetch older history: oldestOffset > 0, more remains,
  // paging not marked unsupported, not already loading, cap not reached. The
  // view ANDs this with its scroll-at-top + normal-buffer checks (§6.1).
  canRequestOlder: boolean;
  pagedRowCount: number; // total rows prepended from the archive
  pagedTopChunkRowCount: number; // rows in the oldest paged chunk (eviction math)
  pagedCapReached: boolean; // MAX_PAGED_ROWS hit -> fetch refused, notice shown
  // Server has evicted the archive below the current top: no more history remains
  // (hasMoreHistory false) yet the top still sits above the stream origin
  // (oldestOffset > 0). Purely derived; the view shows a "no longer retained"
  // notice. Distinct from pagedCapReached (client-side memory pause, releasable)
  // (#980).
  retentionFloorReached: boolean;
}

export interface TerminalInstance {
  subscribe(listener: () => void): () => void;
  getSnapshot(): TerminalSnapshot;
  sendInput(data: string): void;
  resize(cols: number, rows: number): void;
  /** Forward scroll to the app in alternate-screen mode. positive = toward newer. */
  forwardScroll(lines: number, cell: { x: number; y: number }): void;
  /** Report a left-button press/release to the TUI (only when mouse tracking is on). */
  reportMouseButton(kind: 'press' | 'release', cell: { x: number; y: number }): void;
  /** Paste text, honoring the app's bracketed-paste (DECSET 2004) state. */
  paste(text: string): void;
  /** Clear the current worker error and force a fresh WS connection (recovery). */
  retry(): void;
  dismissNotice(): void;
  /** Fetch the next older history range (scroll-to-top trigger, §6.1). No-op
   * when a request is in flight, paging is unsupported, the cap is reached, or
   * nothing older remains. */
  requestOlderHistory(): void;
  /** Evict the oldest paged chunk once the viewport is well below it (§6.4).
   * Raises the paging cursor and re-enables fetch. No-op when no chunk paged. */
  evictTopChunk(): void;
  /** Mount reference; returns an idempotent release (Strict-Mode safe). */
  acquire(): () => void;
  dispose(): void;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const SCROLLBACK = 5000;

// --- Scroll-back history paging (terminal-history-paging.md §6) ---
// Paged-window row cap (~3x live SCROLLBACK). At the cap, upward fetch is
// refused and an inline notice renders; eviction restores headroom (§6.4).
const MAX_PAGED_ROWS = 15000;
// Per range-request byte hint; the server applies its own cap (§5.1/§6.1).
const RANGE_MAX_BYTES = 262144;
// Overflow degradation floor: at 16KB even the one-byte-per-row worst case
// fits the throwaway 100k scrollback, so the loop terminates (§6.2).
const RANGE_MIN_BYTES = 16384;
// New-client / old-server (or server rollback) guard: no matching history-range
// within this window marks paging unsupported for the connection (§5.1).
const RANGE_TIMEOUT_MS = 5000;

// Resync back-pressure (§3.4). While a fresh initial history is pending, live
// output is queued. Cap the queue (entries AND summed bytes) so an incarnation
// that never delivers its fresh history cannot grow the queue without bound; a
// breach hard-resets the buffer and relies on the pending/fresh history request
// to repopulate it. Time-box the resync itself so a lost history response does
// not leave the terminal hung in the queuing state forever.
const RESYNC_QUEUE_MAX_ENTRIES = 500;
const RESYNC_QUEUE_MAX_BYTES = 1_048_576; // 1MB, sum of queued data lengths
const RESYNC_TIMEOUT_MS = 5000;

// Default auto-dismiss delay for a store notice banner (issue #968). The legacy
// renderer auto-dismissed restart-class notices after 5s; this restores that
// parity. Exposed as a per-call parameter on setNotice so a future notice class
// can choose a longer/shorter TTL without touching the producer default.
const DEFAULT_NOTICE_TTL_MS = 5000;

// Memory-management + reconnect timings. Mutable so tests can shorten them via
// _setTimings; production values are the DEFAULT_TIMINGS below.
const DEFAULT_TIMINGS = {
  idleTtlMs: 15 * 60 * 1000, // refCount 0 -> evict after 15 min
  exitedTtlMs: 5 * 60 * 1000, // exited instances evict sooner (no live process)
  maxInstances: 12, // LRU hard cap
  maxReconnectAttempts: 100, // production parity
  reconnectDelayMs: null as number | null, // null -> getReconnectDelay (test override only)
};
type Timings = typeof DEFAULT_TIMINGS;
let timings: Timings = { ...DEFAULT_TIMINGS };

// App-WS subscribe seam: production uses the real module-level subscribe; tests
// inject a capturable fake to drive worker-restarted / session-deleted.
let appSubscribeImpl: typeof subscribeApp = subscribeApp;

const nowMs: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

// rAF batching: guard for non-browser (bun test) where requestAnimationFrame
// may be absent — fall back to a ~1-frame timeout.
const scheduleFrame: (fn: () => void) => void =
  typeof requestAnimationFrame === 'function'
    ? (fn) => requestAnimationFrame(fn)
    : (fn) => {
        setTimeout(fn, 16);
      };

class TerminalController implements TerminalInstance {
  private terminal: Terminal;
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private snapshot: TerminalSnapshot;
  private frameScheduled = false;
  private disposed = false;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null; // auto-dismiss (issue #968)
  private historyRequested = false; // per WS connection
  private noReconnect = false; // set on SESSION_DELETED / SESSION_PAUSED

  // Offset tracking for reconnect catch-up and truncation detection.
  private lastOffset = 0;
  private requestedFromOffset = 0;

  // --- Scroll-back history paging state (terminal-history-paging.md §6) ---
  // Worker incarnation generation (§3.4). null until the first tagged message;
  // any later message with a different epoch triggers a full resync.
  private epoch: number | null = null;
  // Absolute start of the live window (startOffset of the fresh initial load).
  // The floor the paging cursor returns to on a cols-resize drop (§6.2).
  private liveStartOffset = 0;
  // Absolute start of everything currently represented (live + paged). Seeded
  // by the fresh history.startOffset, moved down by each history-range (§6.1).
  private oldestOffset = 0;
  // Paged chunks, oldest first (a deque). Each carries its absolute range so
  // contiguity/eviction can reason about boundaries without re-deriving them.
  // `rawData` is retained ONLY on the current top (oldest) chunk, for the
  // older-neighbor pair re-replay seam correction (§6.2); bound: one range
  // request's maxBytes. It is dropped when the chunk stops being the top (a newer
  // pair takes over), or when the chunk goes away (eviction / cols-drop / resync
  // / teardown clear the whole array).
  private pagedChunks: Array<{
    rows: TerminalRow[];
    startOffset: number;
    endOffset: number;
    rawData?: string;
  }> = [];
  private pagedRowCount = 0;
  private hasMoreHistory = true; // more archive remains above oldestOffset
  private loadingOlder = false; // a range request is in flight
  private pagingUnsupported = false; // per-connection: old server / rollback (§5.1)
  private pagedCapReached = false; // MAX_PAGED_ROWS hit -> fetch refused (§6.4)
  // Single in-flight range request: its id, the range it covers (for overflow
  // re-request), and its timeout handle.
  private rangeRequestId: number | null = null;
  private nextRequestId = 1;
  private pendingRange: { beforeOffset: number; maxBytes: number } | null = null;
  private rangeTimer: ReturnType<typeof setTimeout> | null = null;
  // Monotonically decreasing negative-key allocator for paged rows (§6.3). Never
  // reset, keys never reused: an evicted-then-refetched chunk gets fresh keys and
  // can never collide with a still-mounted row.
  private negKeyCounter = 0;
  // Epoch-resync bookkeeping (§3.4): while a fresh initial history is pending,
  // live output is queued (not applied) and replayed after the history lands.
  private resyncing = false;
  private queuedOutput: Array<{ data: string; offset: number }> = [];
  private queuedBytes = 0; // sum of queuedOutput data lengths (cap enforcement)
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  // A request-history is outstanding on the current socket (single-flight, §3.4).
  // Uncorrelated (no requestId), so at most one may be in flight: a second would
  // race the first and let a stale response be mis-applied as a continuation.
  private historyInFlight = false;

  // Cold-start instrumentation.
  private historyStartMs = 0;
  private lastHistoryLoadMs: number | null = null;

  // Memory management.
  private refCount = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReleasedAt = 0;
  private appUnsub: () => void = () => {};

  // Row cache: rows below baseY are immutable scrollback; reuse the same object
  // reference so React.memo skips re-render. Cleared on shrink / history rewrite.
  private rowCache = new Map<number, TerminalRow>();
  private lastBufferLength = 0;

  constructor(
    private sessionId: string,
    private workerId: string,
    // Fixed for the instance's lifetime (see getOrCreateTerminal). When true,
    // CSI 3J/2J scrollback wipes are neutralized so Claude Code's per-redraw
    // clear does not destroy history; mirrors production's stripScrollbackClear
    // agent-config flag.
    private stripScrollbackClear: boolean,
  ) {
    this.terminal = new Terminal({
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      scrollback: SCROLLBACK,
      allowProposedApi: true,
    });
    this.snapshot = {
      version: 0,
      status: 'connecting',
      exitInfo: null,
      rows: [],
      cursor: { x: 0, y: 0, visible: true },
      cols: DEFAULT_COLS,
      terminalRows: DEFAULT_ROWS,
      bufferType: 'normal',
      mouseTracking: false,
      notice: null,
      workerError: null,
      activityState: null,
      loadingHistory: false,
      loadingOlder: false,
      canRequestOlder: false,
      pagedRowCount: 0,
      pagedTopChunkRowCount: 0,
      pagedCapReached: false,
      retentionFloorReached: false,
    };

    this.terminal.onScroll(() => this.scheduleNotify());
    this.terminal.onCursorMove(() => this.scheduleNotify());
    // The alt-screen enter/exit itself must trigger a fresh snapshot.
    // onBufferChange lives on the buffer namespace, not the Terminal.
    this.terminal.buffer.onBufferChange(() => this.scheduleNotify());

    this.appUnsub = appSubscribeImpl((msg) => this.handleAppMessage(msg));

    this.connect();
  }

  get lastHistoryLoadDurationMs(): number | null {
    return this.lastHistoryLoadMs;
  }

  // Interface-facing methods are arrow-function fields so consumers (e.g.
  // useSyncExternalStore) can destructure / pass them by reference without
  // losing `this`.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): TerminalSnapshot => {
    return this.snapshot;
  };

  sendInput = (data: string): void => {
    this.send({ type: 'input', data });
  };

  resize = (cols: number, rows: number): void => {
    if (cols <= 0 || rows <= 0) return;
    if (cols === this.terminal.cols && rows === this.terminal.rows) return;
    const colsChanged = cols !== this.terminal.cols;
    this.terminal.resize(cols, rows);
    this.send({ type: 'resize', cols, rows });
    // Paged chunks were replayed at the old cols; mixing widths would corrupt
    // row geometry and wrapped-line link windows, so drop them all on a cols
    // change (§6.2). The user re-pages if needed at the new width.
    if (colsChanged && this.pagedChunks.length > 0) {
      this.dropPagedChunks();
    }
    this.scheduleNotify();
  };

  // NOTE (#943 F2): scroll/mouse reports are output TO the app, not user input
  // to us. They only sendInput — they never mutate the snapshot, bump the
  // version, or touch any selection state. The store holds NO selection state at
  // all (native browser selection owns it), so there is nothing here that could
  // clear a selection on "input". Do not add xterm-style clear-selection-on-key
  // behavior to these paths.
  forwardScroll = (lines: number, cell: { x: number; y: number }): void => {
    const steps = Math.abs(Math.trunc(lines));
    if (steps === 0) return;
    const down = lines > 0; // toward newer content
    let data: string;

    if (this.terminal.modes.mouseTrackingMode !== 'none') {
      // SGR mouse wheel report per line. Button 64 = wheel up, 65 = wheel down.
      const col = clampCell(cell.x, this.terminal.cols);
      const row = clampCell(cell.y, this.terminal.rows);
      const button = down ? 65 : 64;
      data = `\x1b[<${button};${col};${row}M`.repeat(steps);
    } else {
      // No mouse tracking: emit arrow keys (SS3 form under DECCKM).
      const app = this.terminal.modes.applicationCursorKeysMode;
      const seq = down ? (app ? '\x1bOB' : '\x1b[B') : app ? '\x1bOA' : '\x1b[A';
      data = seq.repeat(steps);
    }
    this.sendInput(data);
  };

  reportMouseButton = (kind: 'press' | 'release', cell: { x: number; y: number }): void => {
    // Only report when the app enabled DECSET mouse tracking; otherwise a click
    // is a local focus gesture, not TUI input.
    if (this.terminal.modes.mouseTrackingMode === 'none') return;
    const col = clampCell(cell.x, this.terminal.cols);
    const row = clampCell(cell.y, this.terminal.rows);
    // SGR encoding, left button (0): press ends with 'M', release with 'm'.
    // x10 tracking has no release event, but SGR-encoding both is fine for the
    // renderer (a spurious release is harmless to the TUIs we target).
    const terminator = kind === 'press' ? 'M' : 'm';
    this.sendInput(`\x1b[<0;${col};${row}${terminator}`);
  };

  paste = (text: string): void => {
    // The PTY expects CR line endings; normalize \r\n and lone \n to \r (xterm's
    // IPasteEvent behavior).
    const normalized = text.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
    if (this.terminal.modes.bracketedPasteMode) {
      // One frame so the app sees the paste atomically between the markers.
      this.sendInput(`\x1b[200~${normalized}\x1b[201~`);
    } else {
      this.sendInput(normalized);
    }
  };

  retry = (): void => {
    if (this.disposed) return;
    // Recovery: drop the error, re-enable reconnect (a SESSION_* error may have
    // latched noReconnect), and open a fresh connection to the same worker. The
    // parsed buffer is preserved (mirrors production's disconnect + retry, which
    // reconnects rather than recreating the terminal).
    this.patchMeta({ workerError: null });
    this.noReconnect = false;
    this.reconnectAttempts = 0;
    this.reconnect();
  };

  dismissNotice = (): void => {
    // Manual dismiss cancels the pending auto-dismiss (issue #968).
    this.clearNoticeTimer();
    if (this.snapshot.notice === null) return;
    this.patchMeta({ notice: null });
  };

  /**
   * Show a notice banner that auto-dismisses after `ttlMs` (issue #968). A new
   * notice replaces any pending auto-dismiss (the clock resets); manual dismiss
   * and dispose cancel it. `ttlMs` is a per-call parameter so future notice
   * classes can opt into a different duration.
   */
  private setNotice(message: string, ttlMs: number = DEFAULT_NOTICE_TTL_MS): void {
    this.clearNoticeTimer();
    this.patchMeta({ notice: message });
    // Capture this timer's own handle so a stale (replaced) callback is inert: it
    // must neither null the CURRENT timer reference nor clear a successor notice.
    // Unreachable at runtime (clearTimeout is synchronous, so a replaced timer's
    // callback never fires); the guard is state-hygiene, not a live race fix.
    const handle = setTimeout(() => {
      if (this.disposed || this.noticeTimer !== handle) return;
      this.noticeTimer = null;
      this.patchMeta({ notice: null });
    }, ttlMs);
    this.noticeTimer = handle;
  }

  private clearNoticeTimer(): void {
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
  }

  /**
   * Filters applied to every history/output chunk before writing to the buffer.
   * stripSystemMessages is always applied; the CSI 3J/2J scrollback-clear filter
   * is gated on the per-instance stripScrollbackClear flag.
   */
  private processOutput(data: string): string {
    const stripped = stripSystemMessages(data);
    return this.stripScrollbackClear ? applyScrollbackFilter(stripped) : stripped;
  }

  acquire = (): (() => void) => {
    this.refCount += 1;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    let released = false;
    return () => {
      if (released) return; // idempotent under Strict-Mode double-invoke
      released = true;
      this.refCount = Math.max(0, this.refCount - 1);
      if (this.refCount === 0) {
        this.lastReleasedAt = Date.now();
        this.startIdleTimer();
      }
    };
  };

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.clearNoticeTimer();
    this.clearRangeTimer();
    this.clearResyncTimer();
    this.appUnsub();
    this.closeWs();
    this.terminal.dispose();
    this.listeners.clear();
    removeInstance(this.sessionId, this.workerId);
  };

  // --- Memory management ---

  get refCountForTest(): number {
    return this.refCount;
  }

  get lastReleasedAtForTest(): number {
    return this.lastReleasedAt;
  }

  get reconnectPendingForTest(): boolean {
    return this.reconnectTimer !== null;
  }

  get reconnectAttemptsForTest(): number {
    return this.reconnectAttempts;
  }

  get disposedForTest(): boolean {
    return this.disposed;
  }

  get noticeTimerForTest(): ReturnType<typeof setTimeout> | null {
    return this.noticeTimer;
  }

  get pagingStateForTest(): {
    epoch: number | null;
    oldestOffset: number;
    liveStartOffset: number;
    pagedRowCount: number;
    pagedChunkCount: number;
    hasMoreHistory: boolean;
    loadingOlder: boolean;
    pagingUnsupported: boolean;
    pagedCapReached: boolean;
    rangeRequestId: number | null;
    resyncing: boolean;
    queuedOutputCount: number;
    queuedBytes: number;
    historyInFlight: boolean;
    topChunkHasRaw: boolean;
    topChunkRawBytes: number;
    pagedRawCount: number;
  } {
    return {
      epoch: this.epoch,
      oldestOffset: this.oldestOffset,
      liveStartOffset: this.liveStartOffset,
      pagedRowCount: this.pagedRowCount,
      pagedChunkCount: this.pagedChunks.length,
      hasMoreHistory: this.hasMoreHistory,
      loadingOlder: this.loadingOlder,
      pagingUnsupported: this.pagingUnsupported,
      pagedCapReached: this.pagedCapReached,
      rangeRequestId: this.rangeRequestId,
      resyncing: this.resyncing,
      queuedOutputCount: this.queuedOutput.length,
      queuedBytes: this.queuedBytes,
      historyInFlight: this.historyInFlight,
      topChunkHasRaw: this.pagedChunks[0]?.rawData !== undefined,
      topChunkRawBytes: this.pagedChunks[0]?.rawData?.length ?? 0,
      pagedRawCount: this.pagedChunks.filter((c) => c.rawData !== undefined).length,
    };
  }

  private startIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const ttl = this.snapshot.status === 'exited' ? timings.exitedTtlMs : timings.idleTtlMs;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.refCount === 0) this.dispose();
    }, ttl);
  }

  // --- App-WS driven events ---

  private handleAppMessage(msg: AppServerMessage): void {
    if (this.disposed) return;
    if (msg.type === 'worker-restarted') {
      if (msg.sessionId !== this.sessionId || msg.workerId !== this.workerId) return;
      this.terminal.reset();
      this.rowCache.clear();
      this.lastBufferLength = 0;
      this.lastOffset = 0;
      // Restart resets the absolute stream to 0 under a new epoch (§4.5). Drop
      // the paged window and forget the epoch so the reconnect's initial history
      // records the new generation without a spurious mismatch resync.
      this.clearPagedState();
      this.epoch = null;
      this.resyncing = false;
      this.queuedOutput = [];
      this.queuedBytes = 0;
      this.clearResyncTimer();
      // Clear any stale error and show an auto-dismissing restart notice (#968).
      this.patchMeta({ workerError: null });
      this.setNotice('Terminal restarted');
      this.reconnect();
    } else if (msg.type === 'session-deleted') {
      if (msg.sessionId !== this.sessionId) return;
      this.dispose();
    }
  }

  // --- WebSocket ---

  private connect(): void {
    if (this.disposed) return;
    const url = getWorkerWsUrl(this.sessionId, this.workerId);
    this.historyRequested = false;
    // Paging-unsupported is per-connection (§5.1): a reconnect may land on an
    // upgraded server, so re-probe. Any in-flight range request is abandoned by
    // the socket teardown; clear its flags so the fresh connection starts clean.
    this.pagingUnsupported = false;
    this.clearRangeTimer();
    this.rangeRequestId = null;
    this.pendingRange = null;
    this.loadingOlder = false;
    // A new socket invalidates any request-history that was in flight on the old
    // one (it died with the socket). The onopen handler re-requests below.
    this.historyInFlight = false;
    // If a resync is still pending across this reconnect, the onopen re-request
    // (or an adopted in-flight one) will complete it; re-arm the timeout so a
    // dead new socket does not leave the resync hung forever.
    if (this.resyncing) this.armResyncTimer();
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.disposed) return;
      this.reconnectAttempts = 0;
      this.updateStatus('connected');
      // Request history from the last received offset (0 on first connect);
      // the server returns only the delta and catches us up after a drop.
      if (!this.historyRequested) {
        this.historyRequested = true;
        this.requestHistory();
      }
      this.send({ type: 'resize', cols: this.terminal.cols, rows: this.terminal.rows });
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      this.handleMessage(event.data);
    };

    ws.onerror = () => {
      logger.warn(`[terminal] ws error ${this.sessionId}:${this.workerId}`);
    };

    ws.onclose = (event) => {
      if (this.disposed) return;
      this.ws = null;
      // Any close invalidates an in-flight range request (its response can never
      // arrive on this dead socket). Clear it so the 5s range timer cannot fire
      // while disconnected and falsely mark paging unsupported (§5.1 / #959). This
      // runs regardless of the exited/noReconnect early returns below — the range
      // request is dead in every close path.
      this.clearRangeInFlight();
      this.loadingOlder = false;
      this.syncPagingMeta();
      // A terminated process closes the socket after the 'exit' message; keep
      // the 'exited' status and do not reconnect to a dead PTY.
      if (this.snapshot.status === 'exited') return;
      this.updateStatus('disconnected');
      // SESSION_DELETED / SESSION_PAUSED: server closes deliberately; do not
      // reconnect (mirrors worker-websocket.ts error semantics).
      if (this.noReconnect) return;
      if (!shouldReconnect(event.code)) return;
      this.scheduleReconnect();
    };
  }

  private requestHistory(): void {
    this.requestedFromOffset = this.lastOffset;
    this.historyStartMs = nowMs();
    this.historyInFlight = true;
    this.patchMeta({ loadingHistory: true });
    this.send({ type: 'request-history', fromOffset: this.lastOffset });
  }

  /** Force a fresh WS connection (worker-restarted flow). */
  private reconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeWs();
    this.updateStatus('connecting');
    this.connect();
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.snapshot.status === 'exited') return;
    if (this.noReconnect) return;
    if (this.reconnectAttempts >= timings.maxReconnectAttempts) return;
    const delay = timings.reconnectDelayMs ?? getReconnectDelay(this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.updateStatus('connecting');
      this.connect();
    }, delay);
  }

  private closeWs(): void {
    if (!this.ws) return;
    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onerror = null;
    this.ws.onclose = null;
    try {
      this.ws.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }

  private send(message: WorkerClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private handleMessage(raw: string): void {
    let message: WorkerServerMessage;
    try {
      message = JSON.parse(raw) as WorkerServerMessage;
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;
    if (!(message.type in WORKER_SERVER_MESSAGE_TYPES)) return;

    switch (message.type) {
      case 'history':
        // A history message answers the outstanding request-history, so the
        // request is no longer in flight — clear the single-flight flag BEFORE
        // the epoch check, which may discard this payload and (on a larger epoch)
        // begin a resync. Clearing here lets that resync issue a fresh request
        // rather than adopt a request that has just been answered (§3.4).
        this.historyInFlight = false;
        // Epoch is additive; a pre-upgrade server omits it (undefined) and the
        // epoch check is a no-op until the first tagged message records one.
        if (!this.acceptEpoch(message.epoch)) break;
        this.handleHistory(message.data, message.offset, message.startOffset);
        break;
      case 'output':
        if (!this.acceptEpoch(message.epoch)) break;
        // During a resync, live output is queued (not applied) until the fresh
        // initial history lands, then replayed in order (§3.4). The queue is
        // capped; a breach hard-resets rather than growing without bound.
        if (this.resyncing) {
          this.enqueueResyncOutput(message.data, message.offset);
          break;
        }
        this.lastOffset = message.offset;
        this.terminal.write(this.processOutput(message.data), () => this.scheduleNotify());
        break;
      case 'history-range':
        this.handleHistoryRange(message);
        break;
      case 'exit':
        this.updateStatus('exited', { code: message.exitCode, signal: message.signal });
        break;
      case 'error':
        this.handleError(message.message, message.code, message.requestId);
        break;
      case 'activity':
        this.patchMeta({ activityState: message.state });
        break;
      // server-restarted: no cache to invalidate; ignore.
    }
  }

  /**
   * Epoch gate (§3.4). Records the first epoch seen. On a later mismatch it
   * discards the triggering payload (the caller must `break`) and, for a NEWER
   * generation, tears down live + paged state and resyncs. Returns false when a
   * mismatch was handled (payload must be dropped).
   *
   * Epochs are server mint-timestamps (Date.now(), monotonically increasing
   * across restarts — see server worker-output-file.ts mintEpoch, with a +1
   * tiebreak). So a SMALLER epoch than the recorded one is a straggler from an
   * older incarnation (e.g. buffered output from the pre-restart socket): discard
   * it silently WITHOUT resyncing — a blanket mismatch-resync would resync
   * "backward" onto the older generation. Only a LARGER epoch is a genuine newer
   * incarnation worth resyncing to.
   *
   * `epoch` is optional so pre-upgrade servers (which omit the additive field)
   * are tolerated: an undefined epoch never records and never mismatches.
   */
  private acceptEpoch(epoch: number | undefined): boolean {
    if (typeof epoch !== 'number') return true;
    if (this.epoch === null) {
      this.epoch = epoch;
      return true;
    }
    if (epoch === this.epoch) return true;
    // Stale straggler from an older incarnation: drop without tearing down.
    if (epoch < this.epoch) return false;
    this.beginEpochResync(epoch);
    return false;
  }

  private beginEpochResync(newEpoch: number): void {
    this.terminal.reset();
    this.rowCache.clear();
    this.lastBufferLength = 0;
    this.lastOffset = 0;
    this.clearPagedState();
    this.epoch = newEpoch;
    this.resyncing = true;
    this.queuedOutput = [];
    this.queuedBytes = 0;
    this.armResyncTimer();
    // Single-flight (§3.4): if a request-history is already outstanding on the
    // CURRENT socket, ADOPT it as this resync's completion instead of sending a
    // second, uncorrelated request. Safe because a worker restart force-closes
    // the socket, so any request in flight here targets the current incarnation;
    // its response completes the resync (handleHistory forces the fresh path
    // while resyncing). A second request-history would race the first: two
    // uncorrelated responses over one shared requestedFromOffset/resyncing, so a
    // stale response could be applied as a continuation and the other appended
    // (duplicated/garbled content).
    if (!this.historyInFlight) {
      this.requestHistory();
    }
  }

  /**
   * Enqueue live output arriving during a resync, enforcing the queue caps. On a
   * breach, hard-reset the buffer (the triggering chunk is dropped; the fresh
   * history request repopulates the buffer) rather than growing unbounded.
   */
  private enqueueResyncOutput(data: string, offset: number): void {
    if (
      this.queuedOutput.length + 1 > RESYNC_QUEUE_MAX_ENTRIES ||
      this.queuedBytes + data.length > RESYNC_QUEUE_MAX_BYTES
    ) {
      this.hardResetResync('overflow');
      return;
    }
    this.queuedOutput.push({ data, offset });
    this.queuedBytes += data.length;
  }

  /**
   * Hard-reset a stuck resync (queue overflow or timeout). Wipe the buffer and
   * queue but KEEP the epoch + resyncing state: we are still waiting for THIS
   * incarnation's fresh history. Re-arm the timeout and, respecting single-flight
   * (§3.4), issue a fresh request only when none is outstanding — an already
   * in-flight (adopted) response completes the resync against the clean buffer.
   */
  private hardResetResync(reason: 'overflow' | 'timeout'): void {
    this.terminal.reset();
    this.rowCache.clear();
    this.lastBufferLength = 0;
    this.lastOffset = 0;
    this.queuedOutput = [];
    this.queuedBytes = 0;
    this.armResyncTimer();
    if (!this.historyInFlight) {
      this.requestHistory();
    }
    // Overflow dropped queued output, so notify the user; the timeout path is a
    // stalled server (no data lost yet) and stays silent.
    if (reason === 'overflow') {
      this.setNotice('Terminal resynchronized after overflow');
    }
  }

  private armResyncTimer(): void {
    this.clearResyncTimer();
    this.resyncTimer = setTimeout(() => this.onResyncTimeout(), RESYNC_TIMEOUT_MS);
  }

  private clearResyncTimer(): void {
    if (this.resyncTimer) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
    }
  }

  private onResyncTimeout(): void {
    this.resyncTimer = null;
    if (this.disposed || !this.resyncing) return;
    this.hardResetResync('timeout');
  }

  private handleHistory(data: string, offset: number, startOffset: number | undefined): void {
    // Resync predicate (§3.1): a response is a contiguous forward continuation
    // only when its window begins exactly where we asked. Any other position
    // (archived-out: startOffset > request; stale/diverged: window ends below
    // the request) is a fresh load and resets the buffer. When the server omits
    // startOffset (pre-upgrade), fall back to the legacy offset-based heuristic.
    //
    // A resync ALWAYS forces the fresh path: beginEpochResync already reset the
    // buffer, so the completing response must be applied as a fresh load and must
    // re-seed the paging cursor from its startOffset. Without this, an adopted
    // request whose requestedFromOffset happens to equal the response startOffset
    // would take the continuation path and leave paging disabled (§3.4).
    const isFresh =
      this.resyncing ||
      (typeof startOffset === 'number'
        ? startOffset !== this.requestedFromOffset
        : offset < this.requestedFromOffset);
    if (isFresh) {
      this.terminal.reset();
      this.rowCache.clear();
      this.lastBufferLength = 0;
      this.clearPagedState();
      // Seed the paging cursor at the window's absolute start (§6.1). Without a
      // server-supplied startOffset, paging past the live window is unavailable
      // (oldestOffset stays 0, hasMoreHistory false).
      if (typeof startOffset === 'number') {
        this.liveStartOffset = startOffset;
        this.oldestOffset = startOffset;
        this.hasMoreHistory = startOffset > 0;
      } else {
        this.liveStartOffset = 0;
        this.oldestOffset = 0;
        this.hasMoreHistory = false;
      }
    }
    this.lastOffset = offset;
    const bytes = data.length;
    this.terminal.write(this.processOutput(data), () => {
      this.lastHistoryLoadMs = nowMs() - this.historyStartMs;
      logger.debug(
        `[terminal] history loaded: ${bytes} bytes in ${Math.round(this.lastHistoryLoadMs)} ms`,
      );
      this.patchMeta({ loadingHistory: false });
      // Replay any output queued during the resync, dropping entries already
      // covered by this history payload (§3.4).
      if (this.resyncing) this.flushResyncQueue(offset);
      this.scheduleNotify();
    });
  }

  private flushResyncQueue(historyOffset: number): void {
    this.resyncing = false;
    this.clearResyncTimer();
    const queued = this.queuedOutput;
    this.queuedOutput = [];
    this.queuedBytes = 0;
    for (const item of queued) {
      // Entries whose end position is at or below the history offset are already
      // covered by the history payload; drop them to avoid double-application.
      if (item.offset <= historyOffset) continue;
      this.lastOffset = item.offset;
      this.terminal.write(this.processOutput(item.data), () => this.scheduleNotify());
    }
  }

  private handleError(message: string, code?: WorkerErrorCode, requestId?: number): void {
    // A range-request failure (HISTORY_LOAD_FAILED carrying the request's id)
    // clears the correlated in-flight state without surfacing a worker error;
    // the socket stays healthy and the user can re-page (§5.1).
    if (typeof requestId === 'number' && requestId === this.rangeRequestId) {
      this.clearRangeInFlight();
      this.loadingOlder = false;
      this.syncPagingMeta();
      return;
    }
    this.patchMeta({ workerError: { message, code } });
    if (code === 'SESSION_DELETED' || code === 'SESSION_PAUSED') {
      // Server will close after this error; ensure we never reconnect.
      this.noReconnect = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    }
  }

  // --- Scroll-back history paging (terminal-history-paging.md §6) ---

  requestOlderHistory = (): void => {
    if (this.disposed) return;
    if (this.loadingOlder || this.pagingUnsupported || this.pagedCapReached) return;
    if (this.resyncing || !this.hasMoreHistory || this.oldestOffset <= 0) return;
    this.sendRangeRequest(this.oldestOffset, RANGE_MAX_BYTES);
  };

  evictTopChunk = (): void => {
    if (this.disposed || this.pagedChunks.length === 0) return;
    const evicted = this.pagedChunks.shift();
    if (!evicted) return;
    this.pagedRowCount -= evicted.rows.length;
    // Raise the cursor to the evicted chunk's end (= the new top's start), so a
    // later fetch chains contiguously; restore headroom and re-enable fetch.
    this.oldestOffset = evicted.endOffset;
    this.hasMoreHistory = this.oldestOffset > 0;
    this.pagedCapReached = false;
    this.syncPagingMeta();
    this.scheduleNotify();
  };

  private sendRangeRequest(beforeOffset: number, maxBytes: number): void {
    // Only meaningful over an open socket; a phantom timeout while disconnected
    // would falsely mark paging unsupported (the reconnect re-probes anyway).
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const requestId = this.nextRequestId++;
    this.rangeRequestId = requestId;
    this.pendingRange = { beforeOffset, maxBytes };
    this.loadingOlder = true;
    this.armRangeTimer();
    this.syncPagingMeta();
    this.send({ type: 'request-history-range', requestId, beforeOffset, maxBytes });
  }

  private handleHistoryRange(msg: {
    requestId: number;
    data: string;
    startOffset: number;
    endOffset: number;
    hasMore: boolean;
    epoch: number;
  }): void {
    // Correlation (§5.1): only the single in-flight request matters. A response
    // whose id does not match is stale (survived a reset / reconnect / eviction)
    // -> discard silently without disturbing in-flight flags.
    if (this.rangeRequestId === null || msg.requestId !== this.rangeRequestId) return;
    // Correlated response: capture the request's maxBytes for a possible overflow
    // re-request, then clear the in-flight slot + timer.
    const reqMaxBytes = this.pendingRange?.maxBytes ?? RANGE_MAX_BYTES;
    this.clearRangeInFlight();
    this.loadingOlder = false;

    // Epoch mismatch: discard (a range starts at an arbitrary VT midpoint and
    // can never be applied as a fresh load) and resync (§3.4).
    if (typeof msg.epoch === 'number' && this.epoch !== null && msg.epoch !== this.epoch) {
      this.syncPagingMeta();
      this.beginEpochResync(msg.epoch);
      return;
    }
    // Contiguity: the response must abut the current window top (§5.1).
    if (msg.endOffset !== this.oldestOffset) {
      this.syncPagingMeta();
      return;
    }
    // Unavailable / pruned range: nothing more reachable above.
    if (msg.data === '') {
      this.hasMoreHistory = false;
      this.syncPagingMeta();
      return;
    }
    void this.applyRangeChunk(msg, reqMaxBytes);
  }

  private async applyRangeChunk(
    msg: { data: string; startOffset: number; endOffset: number; hasMore: boolean },
    reqMaxBytes: number,
  ): Promise<void> {
    const cols = this.terminal.cols;
    // Replay at the live viewport height so bottom-anchored TUI chrome lands on
    // the same absolute row it would live (#979). Unlike cols — where a mismatch
    // breaks wrap parity and forces us to drop chunks (see `resize`) — a rows
    // mismatch only shifts where transient chrome settles, so a rows-only resize
    // does NOT invalidate already-paged chunks.
    const rows = this.terminal.rows;

    // Seam correction (§6.2): if the current top chunk retained its raw bytes,
    // replay THIS (older) chunk together with the top so the top's leading
    // repaints see the state its predecessor established. Otherwise standalone.
    const topChunk = this.pagedChunks[0];
    const topRaw = topChunk?.rawData;
    if (topRaw === undefined) {
      await this.applyStandaloneChunk(msg, reqMaxBytes, cols, rows);
      return;
    }

    let pair: Awaited<ReturnType<typeof replayHistoryPair>>;
    try {
      pair = await replayHistoryPair(msg.data, topRaw, cols, rows, (d) => this.processOutput(d));
    } catch {
      return;
    }
    if (this.disposed) return;
    // The window may have moved while awaiting (resync / reconnect / resize /
    // cols drop); only apply if still contiguous with the current top. When this
    // holds, topChunk is still pagedChunks[0] (the single-in-flight guard and an
    // unchanged oldestOffset together rule out any concurrent mutation).
    if (msg.endOffset !== this.oldestOffset) return;

    if (pair.overflow) {
      // The joined pair overflowed the throwaway scrollback: fall back to a
      // standalone replay of C_new for THIS fetch. One interior seam stays
      // uncorrected; the fetch loop is not perturbed (§6.2 Fallback).
      await this.applyStandaloneChunk(msg, reqMaxBytes, cols, rows);
      return;
    }

    // Advance the cursor regardless of renderable content (§6.2). BYTE RANGES are
    // untouched: each chunk keeps its own start/endOffset exactly as fetched —
    // row attribution may shift across the boundary but eviction bookkeeping is
    // byte-range-based.
    this.oldestOffset = msg.startOffset;
    this.hasMoreHistory = msg.hasMore;

    // The seam-corrected rows always replace the top chunk's rows (strictly
    // better). Fresh negative keys for all rows of BOTH replaced chunks (§6.3
    // never reuses keys; the old rows' keys are not returned to the pool).
    this.rekeyDownward(pair.topChunkRows);
    topChunk.rows = pair.topChunkRows;

    if (pair.newChunkRows.length > 0) {
      // A real new top takes over: it retains the raw for the NEXT older fetch;
      // the former top no longer needs its raw (its seam is now corrected).
      this.rekeyDownward(pair.newChunkRows);
      delete topChunk.rawData;
      this.pagedChunks.unshift({
        rows: pair.newChunkRows,
        startOffset: msg.startOffset,
        endOffset: msg.endOffset,
        rawData: msg.data,
      });
    } else {
      // Edge: the older range was all-blank -> no new chunk is pushed (advance-
      // only, mirroring the standalone empty-chunk case), but the top-chunk row
      // replacement still applies. KEEP the top's rawData: it stays the top, and
      // the NEXT older fetch pairs against it again (the next boundary sits below
      // it, between the next fetch and this chunk).
    }

    this.recomputePagedRowCount();
    this.syncPagingMeta();
    this.scheduleNotify();
  }

  /** Standalone throwaway replay + apply of a single older chunk (the pre-seam-
   * correction path, and the pair-overflow fallback). */
  private async applyStandaloneChunk(
    msg: { data: string; startOffset: number; endOffset: number; hasMore: boolean },
    reqMaxBytes: number,
    cols: number,
    rows: number,
  ): Promise<void> {
    let result: Awaited<ReturnType<typeof replayHistoryChunk>>;
    try {
      result = await replayHistoryChunk(msg.data, cols, rows, (d) => this.processOutput(d));
    } catch {
      return;
    }
    if (this.disposed) return;
    if (msg.endOffset !== this.oldestOffset) return;

    if (result.overflow) {
      // Degrade: re-request the SAME range at a quartered maxBytes (floor 16KB).
      this.sendRangeRequest(this.oldestOffset, Math.max(RANGE_MIN_BYTES, Math.floor(reqMaxBytes / 4)));
      return;
    }

    // Advance the cursor regardless of renderable content (an all-blank chunk
    // still consumed its range and paging must continue past it).
    this.oldestOffset = msg.startOffset;
    this.hasMoreHistory = msg.hasMore;

    if (result.rows.length > 0) {
      // Fresh negative keys, allocated downward, never reused (§6.3).
      this.rekeyDownward(result.rows);
      // Raw is retained on the current top only: the arriving chunk becomes the
      // new top, so drop the previous top's raw (no-op when it had none).
      if (this.pagedChunks[0]) delete this.pagedChunks[0].rawData;
      // Each new chunk is older than all prior paged chunks -> front of the deque.
      this.pagedChunks.unshift({
        rows: result.rows,
        startOffset: msg.startOffset,
        endOffset: msg.endOffset,
        rawData: msg.data,
      });
    } else {
      // All-blank chunk: advance-only (no chunk pushed). Drop any retained top
      // raw — this consumed range now sits between the top and the next fetch, so
      // a pair replay across it would be non-contiguous. The next fetch replays
      // standalone (an accepted, rare seam).
      if (this.pagedChunks[0]) delete this.pagedChunks[0].rawData;
    }

    this.recomputePagedRowCount();
    this.syncPagingMeta();
    this.scheduleNotify();
  }

  /** Assign fresh downward negative keys to a batch of rows (§6.3). */
  private rekeyDownward(rows: TerminalRow[]): void {
    for (const row of rows) {
      this.negKeyCounter -= 1;
      row.key = this.negKeyCounter;
    }
  }

  /** Recompute pagedRowCount from the chunks and latch the §6.4 cap. The cap is
   * a latch cleared only by eviction, so this never clears it. */
  private recomputePagedRowCount(): void {
    this.pagedRowCount = this.pagedChunks.reduce((sum, c) => sum + c.rows.length, 0);
    if (this.pagedRowCount >= MAX_PAGED_ROWS) this.pagedCapReached = true;
  }

  /** Full teardown of paged state (resync / restart). Keys are never reused, so
   * negKeyCounter is deliberately NOT reset. */
  private clearPagedState(): void {
    this.pagedChunks = [];
    this.pagedRowCount = 0;
    this.oldestOffset = 0;
    this.liveStartOffset = 0;
    this.hasMoreHistory = true;
    this.pagedCapReached = false;
    this.loadingOlder = false;
    this.clearRangeInFlight();
  }

  /** Drop paged chunks on a cols resize (§6.2): return the cursor to the live
   * window's start so re-paging refetches at the new width. */
  private dropPagedChunks(): void {
    this.pagedChunks = [];
    this.pagedRowCount = 0;
    this.oldestOffset = this.liveStartOffset;
    this.hasMoreHistory = this.liveStartOffset > 0;
    this.pagedCapReached = false;
    this.loadingOlder = false;
    this.clearRangeInFlight();
    this.syncPagingMeta();
  }

  private clearRangeInFlight(): void {
    this.clearRangeTimer();
    this.rangeRequestId = null;
    this.pendingRange = null;
  }

  private armRangeTimer(): void {
    this.clearRangeTimer();
    this.rangeTimer = setTimeout(() => this.onRangeTimeout(), RANGE_TIMEOUT_MS);
  }

  private clearRangeTimer(): void {
    if (this.rangeTimer) {
      clearTimeout(this.rangeTimer);
      this.rangeTimer = null;
    }
  }

  private onRangeTimeout(): void {
    this.rangeTimer = null;
    if (this.disposed || this.rangeRequestId === null) return;
    // No matching history-range within the window: old server / rollback (§5.1).
    this.pagingUnsupported = true;
    this.rangeRequestId = null;
    this.pendingRange = null;
    this.loadingOlder = false;
    this.syncPagingMeta();
  }

  private computeCanRequestOlder(): boolean {
    return (
      !this.loadingOlder &&
      !this.pagingUnsupported &&
      !this.pagedCapReached &&
      !this.resyncing &&
      this.hasMoreHistory &&
      this.oldestOffset > 0
    );
  }

  // Server-side retention floor: no more archive remains above the current top
  // (hasMoreHistory false) yet the top still sits above the stream origin
  // (oldestOffset > 0), i.e. the server evicted the bytes we would page next.
  // Purely derived from existing paging state — no mutable field of its own
  // (#980). Row-independent, so it is safe to publish from both the immediate
  // syncPagingMeta patch and the rAF pagingMetaPatch.
  private computeRetentionFloorReached(): boolean {
    return !this.hasMoreHistory && this.oldestOffset > 0;
  }

  private pagingMetaPatch(): Partial<TerminalSnapshot> {
    // Paged rows are a normal-buffer scrollback concept; the alt-screen has no
    // scrollback. Gate the published COUNTS on the active buffer type so they
    // flip to 0 in the SAME rebuild that drops the paged rows from snapshot.rows
    // (Test 1 invariant: pagedRowCount === number of negative-key rows). The
    // chunks themselves are retained and their counts return on the normal
    // buffer. Only rebuildSnapshot uses this patch (syncPagingMeta publishes the
    // row-independent flags separately), so counts and rows always flip together.
    const inNormal = this.terminal.buffer.active.type === 'normal';
    return {
      loadingOlder: this.loadingOlder,
      canRequestOlder: this.computeCanRequestOlder(),
      pagedRowCount: inNormal ? this.pagedRowCount : 0,
      pagedTopChunkRowCount: inNormal ? (this.pagedChunks[0]?.rows.length ?? 0) : 0,
      pagedCapReached: this.pagedCapReached,
      retentionFloorReached: this.computeRetentionFloorReached(),
    };
  }

  private syncPagingMeta(): void {
    // Immediate patch carries ONLY the row-independent flags. The row COUNTS
    // (pagedRowCount / pagedTopChunkRowCount) are published exclusively by
    // rebuildSnapshot (via pagingMetaPatch), in lockstep with snapshot.rows.
    //
    // WHY the counts must not publish here: the view's prepend/eviction anchor
    // compensation and the §6.4 eviction math key on the counts being exactly
    // consistent with snapshot.rows. applyRangeChunk mutates pagedRowCount
    // synchronously but the prepended rows only enter snapshot.rows on the next
    // rAF rebuildSnapshot. If syncPagingMeta published the new count now, the
    // view would see "N paged rows" while snapshot.rows (and the DOM) still hold
    // none, and the anchor effect would compensate scrollTop against a DOM
    // without those rows — the scroll jump that let §6.4 eviction cannibalize a
    // just-applied chunk (issue #959). The same hazard exists in the shrink
    // direction (evict / cols-drop): a count dropping to 0 before the rows are
    // removed would jump the viewport upward. Keeping counts on rebuildSnapshot
    // only makes both directions atomic with the rows.
    this.patchMeta({
      loadingOlder: this.loadingOlder,
      canRequestOlder: this.computeCanRequestOlder(),
      pagedCapReached: this.pagedCapReached,
      retentionFloorReached: this.computeRetentionFloorReached(),
    });
  }

  // --- Snapshot building ---

  private updateStatus(
    status: TerminalStatus,
    exitInfo?: { code: number; signal: string | null },
  ): void {
    this.snapshot = {
      ...this.snapshot,
      status,
      exitInfo: exitInfo ?? this.snapshot.exitInfo,
      version: this.snapshot.version + 1,
    };
    this.notify();
  }

  private patchMeta(partial: Partial<TerminalSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...partial,
      version: this.snapshot.version + 1,
    };
    this.notify();
  }

  private scheduleNotify(): void {
    if (this.disposed || this.frameScheduled) return;
    this.frameScheduled = true;
    scheduleFrame(() => {
      this.frameScheduled = false;
      if (this.disposed) return;
      this.rebuildSnapshot();
      this.notify();
    });
  }

  private rebuildSnapshot(): void {
    const buffer = this.terminal.buffer.active;
    const cols = this.terminal.cols;
    const length = buffer.length;
    const baseY = buffer.baseY;
    const nullCell = buffer.getNullCell();

    // Clear cache when the buffer shrank (reset / alt-buffer switch).
    if (length < this.lastBufferLength) {
      this.rowCache.clear();
    }
    this.lastBufferLength = length;

    // At the scrollback cap the buffer length is constant while lines shift up,
    // so absolute index y no longer identifies the same line -> disable caching.
    if (length >= SCROLLBACK + this.terminal.rows) {
      this.rowCache.clear();
    }

    const cursorY = baseY + buffer.cursorY;
    const cursorX = buffer.cursorX;

    const rows: TerminalRow[] = [];
    const freshYs = new Set<number>(); // rows (re)built this frame
    const freshScrollbackYs: number[] = []; // fresh scrollback rows to cache after links
    let minFreshY = -1;
    for (let y = 0; y < length; y++) {
      const isScrollback = y < baseY;
      const isCursorRow = y === cursorY;

      if (isScrollback && !isCursorRow) {
        const cached = this.rowCache.get(y);
        if (cached) {
          rows.push(cached);
          continue;
        }
      }

      const line = buffer.getLine(y);
      const row: TerminalRow = line
        ? isCursorRow
          ? extractRowWithCursor(line, cols, nullCell, y, cursorX)
          : extractRow(line, cols, nullCell, y)
        : { key: y, segments: [{ text: '', style: null }], isWrapped: false, links: [] };

      rows.push(row);
      freshYs.add(y);
      if (minFreshY === -1) minFreshY = y;
      // Cache immutable scrollback rows AFTER links are attached (below).
      if (isScrollback && !isCursorRow) freshScrollbackYs.push(y);
    }

    // Detect links only for freshly-built rows, expanding left to the head of a
    // soft-wrapped logical line so a URL that wraps across the cache boundary is
    // joined. Cached rows keep the links computed when they were built (correct:
    // a wrapped line's rows scroll into cache together, after the join existed).
    if (minFreshY !== -1) {
      let windowStart = minFreshY;
      while (windowStart > 0 && rows[windowStart].isWrapped) windowStart--;
      const window = rows.slice(windowStart).map((r) => ({
        key: r.key,
        text: rowText(r),
        isWrapped: r.isWrapped,
      }));
      const linkMap = detectRowLinks(window);
      for (const y of freshYs) {
        rows[y].links = linkMap.get(rows[y].key) ?? [];
      }
    }
    for (const y of freshScrollbackYs) {
      this.rowCache.set(y, rows[y]);
    }

    // Paged history rows (archive) render ABOVE the live window. They carry
    // their own links (from the replay pipeline) and stable negative keys, and
    // never enter the live rowCache (§6.3). Suppressed on the alt-screen (no
    // scrollback semantics); the counts in pagingMetaPatch flip to 0 in lockstep
    // in this same rebuild. The chunks are retained and reappear on normal.
    const pagedRows =
      buffer.type === 'normal' && this.pagedChunks.length > 0
        ? this.pagedChunks.flatMap((c) => c.rows)
        : [];

    this.snapshot = {
      ...this.snapshot,
      version: this.snapshot.version + 1,
      rows: pagedRows.length > 0 ? [...pagedRows, ...rows] : rows,
      cursor: { x: cursorX, y: cursorY, visible: true },
      cols,
      terminalRows: this.terminal.rows,
      bufferType: buffer.type,
      mouseTracking: this.terminal.modes.mouseTrackingMode !== 'none',
      ...this.pagingMetaPatch(),
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Clamp a 1-based cell coordinate into [1, max]. */
function clampCell(value: number, max: number): number {
  return Math.min(max, Math.max(1, Math.round(value)));
}

// --- Module-level registry ---
//
// Instances survive React unmounts (invariant 1) but not forever: reference
// counting + idle TTL + an LRU hard cap keep memory bounded (roadmap "Memory
// management design"). refCount>0 instances are never evicted.

const instances = new Map<string, TerminalController>();

function keyOf(sessionId: string, workerId: string): string {
  // JSON-encoded tuple so no separator character can cause a key collision.
  return JSON.stringify([sessionId, workerId]);
}

function removeInstance(sessionId: string, workerId: string): void {
  instances.delete(keyOf(sessionId, workerId));
}

/** Evict the least-recently-released refCount-0 instance to honor the LRU cap. */
function evictOverCap(): void {
  if (instances.size < timings.maxInstances) return;
  let victim: TerminalController | null = null;
  for (const instance of instances.values()) {
    if (instance.refCountForTest > 0) continue;
    if (victim === null || instance.lastReleasedAtForTest < victim.lastReleasedAtForTest) {
      victim = instance;
    }
  }
  // No idle instance to evict (all busy) -> allow overflow rather than drop a
  // mounted terminal.
  victim?.dispose();
}

export interface TerminalOptions {
  /**
   * When true, neutralize CSI 3J/2J scrollback wipes (Claude Code redraw). The
   * flag is read ONCE, when the instance is first created. Because the registry
   * returns the existing instance for a repeated key, a differing flag on a
   * later call is IGNORED — config is fixed per instance lifetime. This is
   * acceptable because the agent's stripScrollbackClear config is static per
   * worker. Defaults to true to preserve the always-on labs behavior; the
   * production-parity adapter passes an explicit value.
   */
  stripScrollbackClear?: boolean;
}

export function getOrCreateTerminal(
  sessionId: string,
  workerId: string,
  opts?: TerminalOptions,
): TerminalInstance {
  const key = keyOf(sessionId, workerId);
  let instance = instances.get(key);
  if (!instance) {
    evictOverCap();
    instance = new TerminalController(sessionId, workerId, opts?.stripScrollbackClear ?? true);
    instances.set(key, instance);
  }
  return instance;
}

/** @internal Test helper: dispose and clear all live instances + reset config. */
export function _resetTerminals(): void {
  for (const instance of Array.from(instances.values())) {
    instance.dispose();
  }
  instances.clear();
  timings = { ...DEFAULT_TIMINGS };
  appSubscribeImpl = subscribeApp;
}

/** @internal Test helper: override memory-management / reconnect timings. */
export function _setTimings(partial: Partial<Timings>): void {
  timings = { ...timings, ...partial };
}

/** @internal Test helper: inject a capturable app-WS subscribe seam. */
export function _setAppSubscribe(impl: typeof subscribeApp): void {
  appSubscribeImpl = impl;
}

/** @internal Test helper: read internal state for assertions. */
export function _inspect(instance: TerminalInstance): {
  refCount: number;
  lastReleasedAt: number;
  reconnectPending: boolean;
  reconnectAttempts: number;
  disposed: boolean;
  lastHistoryLoadMs: number | null;
  noticeTimer: ReturnType<typeof setTimeout> | null;
  paging: TerminalController['pagingStateForTest'];
} {
  const t = instance as TerminalController;
  return {
    refCount: t.refCountForTest,
    lastReleasedAt: t.lastReleasedAtForTest,
    reconnectPending: t.reconnectPendingForTest,
    reconnectAttempts: t.reconnectAttemptsForTest,
    disposed: t.disposedForTest,
    lastHistoryLoadMs: t.lastHistoryLoadDurationMs,
    noticeTimer: t.noticeTimerForTest,
    paging: t.pagingStateForTest,
  };
}
