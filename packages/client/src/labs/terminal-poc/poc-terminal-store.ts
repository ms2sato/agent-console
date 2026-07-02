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
import { stripSystemMessages, stripScrollbackClear } from '../../lib/terminal-utils.js';
import { logger } from '../../lib/logger';
import { extractRow, extractRowWithCursor, type PocRow } from './buffer-to-rows';
import { detectRowLinks } from './link-detection';

/**
 * Filters applied to every history/output chunk before writing to the buffer.
 * stripScrollbackClear neutralizes CSI 3J/2J so Claude Code's per-redraw
 * scrollback wipe does not destroy history. Always-on in the PoC; the
 * production port makes stripScrollbackClear conditional per agent config
 * (`stripScrollbackClear` flag; roadmap PR-1 scope).
 */
function processOutput(data: string): string {
  return stripScrollbackClear(stripSystemMessages(data));
}

/**
 * Module-level store: the headless Terminal + WebSocket for each worker live
 * OUTSIDE React, keyed by `${sessionId}:${workerId}`. React only subscribes via
 * useSyncExternalStore. Because the live instance persists across route
 * navigation, no serialize/restore of terminal state is ever needed — returning
 * to the route reuses the same instance and its already-parsed buffer.
 *
 * This is the architectural point of the PoC.
 */

export type PocStatus = 'connecting' | 'connected' | 'disconnected' | 'exited';

export interface PocSnapshot {
  version: number; // bumped on every batched buffer change
  status: PocStatus;
  exitInfo: { code: number; signal: string | null } | null;
  rows: PocRow[]; // full scrollback + viewport
  cursor: { x: number; y: number; visible: boolean }; // y = absolute row index
  cols: number;
  terminalRows: number;
  bufferType: 'normal' | 'alternate'; // 'alternate' = full-screen app (scroll is forwarded)
  mouseTracking: boolean; // app has DECSET mouse tracking on -> report clicks to the TUI
  notice: string | null; // dismissible banner (restart / truncation)
  workerError: { message: string; code?: WorkerErrorCode } | null;
  activityState: AgentActivityState | null;
  loadingHistory: boolean; // a request-history is in flight
}

export interface PocTerminalInstance {
  subscribe(listener: () => void): () => void;
  getSnapshot(): PocSnapshot;
  sendInput(data: string): void;
  resize(cols: number, rows: number): void;
  /** Forward scroll to the app in alternate-screen mode. positive = toward newer. */
  forwardScroll(lines: number, cell: { x: number; y: number }): void;
  /** Report a left-button press/release to the TUI (only when mouse tracking is on). */
  reportMouseButton(kind: 'press' | 'release', cell: { x: number; y: number }): void;
  /** Paste text, honoring the app's bracketed-paste (DECSET 2004) state. */
  paste(text: string): void;
  dismissNotice(): void;
  /** Mount reference; returns an idempotent release (Strict-Mode safe). */
  acquire(): () => void;
  dispose(): void;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const SCROLLBACK = 5000;

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

class PocTerminal implements PocTerminalInstance {
  private terminal: Terminal;
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private snapshot: PocSnapshot;
  private frameScheduled = false;
  private disposed = false;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private historyRequested = false; // per WS connection
  private noReconnect = false; // set on SESSION_DELETED / SESSION_PAUSED

  // Offset tracking for reconnect catch-up and truncation detection.
  private lastOffset = 0;
  private requestedFromOffset = 0;

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
  private rowCache = new Map<number, PocRow>();
  private lastBufferLength = 0;

  constructor(
    private sessionId: string,
    private workerId: string,
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

  getSnapshot = (): PocSnapshot => {
    return this.snapshot;
  };

  sendInput = (data: string): void => {
    this.send({ type: 'input', data });
  };

  resize = (cols: number, rows: number): void => {
    if (cols <= 0 || rows <= 0) return;
    if (cols === this.terminal.cols && rows === this.terminal.rows) return;
    this.terminal.resize(cols, rows);
    this.send({ type: 'resize', cols, rows });
    this.scheduleNotify();
  };

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
    // PoC (a spurious release is harmless to the TUIs we target).
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

  dismissNotice = (): void => {
    if (this.snapshot.notice === null) return;
    this.patchMeta({ notice: null });
  };

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
      this.patchMeta({ notice: 'Terminal restarted', workerError: null });
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
      logger.warn(`[poc-terminal] ws error ${this.sessionId}:${this.workerId}`);
    };

    ws.onclose = (event) => {
      if (this.disposed) return;
      this.ws = null;
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
        this.handleHistory(message.data, message.offset);
        break;
      case 'output':
        this.lastOffset = message.offset;
        this.terminal.write(processOutput(message.data), () => this.scheduleNotify());
        break;
      case 'exit':
        this.updateStatus('exited', { code: message.exitCode, signal: message.signal });
        break;
      case 'output-truncated':
        // Server dropped older output; advance our offset and surface a banner.
        this.lastOffset = message.newOffset;
        this.patchMeta({ notice: message.message });
        break;
      case 'error':
        this.handleError(message.message, message.code);
        break;
      case 'activity':
        this.patchMeta({ activityState: message.state });
        break;
      // server-restarted: no cache to invalidate; ignore.
    }
  }

  private handleHistory(data: string, offset: number): void {
    // Truncation regression: the server's available data starts below what we
    // asked for (restart / rotation) -> reset and treat the payload as full.
    if (offset < this.requestedFromOffset) {
      this.terminal.reset();
      this.rowCache.clear();
      this.lastBufferLength = 0;
    }
    this.lastOffset = offset;
    const bytes = data.length;
    this.terminal.write(processOutput(data), () => {
      this.lastHistoryLoadMs = nowMs() - this.historyStartMs;
      logger.debug(
        `[poc-terminal] history loaded: ${bytes} bytes in ${Math.round(this.lastHistoryLoadMs)} ms`,
      );
      this.patchMeta({ loadingHistory: false });
      this.scheduleNotify();
    });
  }

  private handleError(message: string, code?: WorkerErrorCode): void {
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

  // --- Snapshot building ---

  private updateStatus(
    status: PocStatus,
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

  private patchMeta(partial: Partial<PocSnapshot>): void {
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

    const rows: PocRow[] = [];
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
      const row: PocRow = line
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

    this.snapshot = {
      ...this.snapshot,
      version: this.snapshot.version + 1,
      rows,
      cursor: { x: cursorX, y: cursorY, visible: true },
      cols,
      terminalRows: this.terminal.rows,
      bufferType: buffer.type,
      mouseTracking: this.terminal.modes.mouseTrackingMode !== 'none',
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

/** Concatenated text of a row's segments (the offset space link ranges use). */
function rowText(row: PocRow): string {
  return row.segments.map((s) => s.text).join('');
}

// --- Module-level registry ---
//
// Instances survive React unmounts (invariant 1) but not forever: reference
// counting + idle TTL + an LRU hard cap keep memory bounded (roadmap "Memory
// management design"). refCount>0 instances are never evicted.

const instances = new Map<string, PocTerminal>();

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
  let victim: PocTerminal | null = null;
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

export function getOrCreatePocTerminal(sessionId: string, workerId: string): PocTerminalInstance {
  const key = keyOf(sessionId, workerId);
  let instance = instances.get(key);
  if (!instance) {
    evictOverCap();
    instance = new PocTerminal(sessionId, workerId);
    instances.set(key, instance);
  }
  return instance;
}

/** @internal Test helper: dispose and clear all live instances + reset config. */
export function _resetPocTerminals(): void {
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
export function _inspect(instance: PocTerminalInstance): {
  refCount: number;
  lastReleasedAt: number;
  reconnectPending: boolean;
  reconnectAttempts: number;
  disposed: boolean;
  lastHistoryLoadMs: number | null;
} {
  const t = instance as PocTerminal;
  return {
    refCount: t.refCountForTest,
    lastReleasedAt: t.lastReleasedAtForTest,
    reconnectPending: t.reconnectPendingForTest,
    reconnectAttempts: t.reconnectAttemptsForTest,
    disposed: t.disposedForTest,
    lastHistoryLoadMs: t.lastHistoryLoadDurationMs,
  };
}
