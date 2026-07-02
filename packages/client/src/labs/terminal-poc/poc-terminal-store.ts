import { Terminal } from '@xterm/headless';
import {
  WORKER_SERVER_MESSAGE_TYPES,
  type WorkerServerMessage,
  type WorkerClientMessage,
} from '@agent-console/shared';
import { getWorkerWsUrl } from '../../lib/websocket-url.js';
import { stripSystemMessages, stripScrollbackClear } from '../../lib/terminal-utils.js';
import { logger } from '../../lib/logger';
import { extractRow, extractRowWithCursor, type PocRow } from './buffer-to-rows';

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
}

export interface PocTerminalInstance {
  subscribe(listener: () => void): () => void;
  getSnapshot(): PocSnapshot;
  sendInput(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const SCROLLBACK = 5000;
const RECONNECT_DELAY_MS = 1500;
const MAX_RECONNECT_ATTEMPTS = 10;

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
    };

    this.terminal.onScroll(() => this.scheduleNotify());
    this.terminal.onCursorMove(() => this.scheduleNotify());

    this.connect();
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

  dispose = (): void => {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.closeWs();
    this.terminal.dispose();
    this.listeners.clear();
    removeInstance(this.sessionId, this.workerId);
  };

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
      // Request full history once per connection; server does not push it.
      if (!this.historyRequested) {
        this.historyRequested = true;
        this.send({ type: 'request-history', fromOffset: 0 });
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

    ws.onclose = () => {
      if (this.disposed) return;
      this.ws = null;
      // A terminated process closes the socket after the 'exit' message; keep
      // the 'exited' status and do not reconnect to a dead PTY.
      if (this.snapshot.status === 'exited') return;
      this.updateStatus('disconnected');
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.snapshot.status === 'exited') return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.updateStatus('connecting');
      this.connect();
    }, RECONNECT_DELAY_MS);
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
        // Full ANSI stream. Reset first if the buffer already has content
        // (e.g. a reconnect re-requested history) to avoid double-write.
        if (this.terminal.buffer.active.length > 1 || this.lastBufferLength > 0) {
          this.terminal.reset();
          this.rowCache.clear();
        }
        this.terminal.write(processOutput(message.data), () => this.scheduleNotify());
        break;
      case 'output':
        this.terminal.write(processOutput(message.data), () => this.scheduleNotify());
        break;
      case 'exit':
        this.updateStatus('exited', { code: message.exitCode, signal: message.signal });
        break;
      case 'output-truncated':
        // History was truncated server-side; nothing to render, just note it.
        break;
      case 'error':
        logger.warn(`[poc-terminal] server error: ${message.message}`);
        break;
      // activity / server-restarted: not rendered in the PoC.
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
      if (!line) {
        rows.push({ key: y, segments: [{ text: '', style: null }] });
        continue;
      }

      const row = isCursorRow
        ? extractRowWithCursor(line, cols, nullCell, y, cursorX)
        : extractRow(line, cols, nullCell, y);

      // Cache immutable scrollback rows (not the cursor row, which changes).
      if (isScrollback && !isCursorRow) {
        this.rowCache.set(y, row);
      }
      rows.push(row);
    }

    this.snapshot = {
      ...this.snapshot,
      version: this.snapshot.version + 1,
      rows,
      cursor: { x: cursorX, y: cursorY, visible: true },
      cols,
      terminalRows: this.terminal.rows,
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

// --- Module-level registry ---
//
// INTENTIONAL LIFETIME: instances are deliberately NOT disposed when a React
// route/component unmounts. Surviving mounts is the architectural point of this
// PoC — the live headless Terminal + WebSocket replace the serialize/restore
// cache layer, so navigating away and back reuses the already-parsed buffer with
// zero rehydration. The trade-off is that instances live until dispose() is
// called explicitly (only the test helper does so today), which a static
// analyzer reads as a leak. A production adoption would add reference counting
// (mount/unmount) + idle eviction (TTL after the last WS activity); both are out
// of PoC scope.

const instances = new Map<string, PocTerminal>();

function keyOf(sessionId: string, workerId: string): string {
  // JSON-encoded tuple so no separator character can cause a key collision.
  return JSON.stringify([sessionId, workerId]);
}

function removeInstance(sessionId: string, workerId: string): void {
  instances.delete(keyOf(sessionId, workerId));
}

export function getOrCreatePocTerminal(sessionId: string, workerId: string): PocTerminalInstance {
  const key = keyOf(sessionId, workerId);
  let instance = instances.get(key);
  if (!instance) {
    instance = new PocTerminal(sessionId, workerId);
    instances.set(key, instance);
  }
  return instance;
}

/** @internal Test helper: dispose and clear all live instances. */
export function _resetPocTerminals(): void {
  for (const instance of Array.from(instances.values())) {
    instance.dispose();
  }
  instances.clear();
}
