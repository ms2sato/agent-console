import * as v from 'valibot';
import {
  NdjsonLineSplitter,
  EmbeddedAgentStreamEventSchema,
  WORKER_SERVER_MESSAGE_TYPES,
  type EmbeddedAgentStreamEvent,
  type EmbeddedAgentClientMessage,
  type WorkerServerMessage,
  type WorkerClientMessage,
  type WorkerErrorCode,
  type AgentActivityState,
  type AppServerMessage,
} from '@agent-console/shared';
import { getWorkerWsUrl } from '../../lib/websocket-url.js';
import { getReconnectDelay, shouldReconnect } from '../../lib/websocket-reconnect.js';
import { subscribe as subscribeApp } from '../../lib/app-websocket.js';
import { logger } from '../../lib/logger.js';

/**
 * Module-level store for embedded-agent workers, mirroring
 * `../terminal/terminal-store.ts`'s architecture: a live WebSocket per
 * `${sessionId}:${workerId}` lives OUTSIDE React and is exposed via
 * useSyncExternalStore. Unlike the terminal store, there is no headless
 * xterm buffer here -- the worker WS channel's byte-offset/epoch framing is
 * content-agnostic (see docs/design/embedded-agent-worker.md "WebSocket &
 * client protocol"); the payload is NDJSON events folded into a chat
 * view-model instead of ANSI bytes fed to a terminal emulator.
 */

export type EmbeddedAgentConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface EmbeddedAgentToolResult {
  ok: boolean;
  result: string;
}

/**
 * One row in the chat view-model. `key` is stable across re-renders and
 * across a delta -> final transition (same entry object, same key) so React
 * lists don't remount mid-stream.
 */
export type EmbeddedAgentChatEntry =
  | { key: string; kind: 'user-message'; id: string; text: string }
  | { key: string; kind: 'assistant-message'; turnId: string; text: string; streaming: boolean }
  | { key: string; kind: 'assistant-thinking'; turnId: string; text: string; streaming: boolean }
  | {
      key: string;
      kind: 'tool-call';
      turnId: string;
      callId: string;
      name: string;
      args: unknown;
      result: EmbeddedAgentToolResult | null;
    }
  | { key: string; kind: 'turn-error'; turnId: string; message: string }
  | { key: string; kind: 'fatal'; message: string }
  | { key: string; kind: 'exited'; code: number | null };

export interface EmbeddedAgentSnapshot {
  version: number; // bumped on every change
  status: EmbeddedAgentConnectionStatus;
  entries: EmbeddedAgentChatEntry[];
  activityState: AgentActivityState;
  workerError: { message: string; code?: WorkerErrorCode } | null;
  loadingHistory: boolean;
}

export interface EmbeddedAgentInstance {
  subscribe(listener: () => void): () => void;
  getSnapshot(): EmbeddedAgentSnapshot;
  /**
   * Send a user message (`embedded-user-message`). Resolves once the server
   * has echoed the message back as a `user-message` event (confirmed
   * accepted), or rejects if the WS is not connected, the server rejects the
   * send (e.g. `TURN_IN_PROGRESS`), or the worker restarts before either
   * happens. Callers (MessagePanel via `onSend`) rely on rejection to avoid
   * clearing the input draft.
   */
  sendUserMessage(text: string): Promise<void>;
  /** Abort the in-flight turn (`embedded-cancel`). */
  cancel(): void;
  /**
   * Force a fresh WebSocket connection. The server's onOpen handler
   * re-activates the loop when `subprocess === null` (the exited-worker
   * case), so this is what a "Restart" action drives.
   */
  restart(): void;
  /** Clear a latched worker error and reconnect (recovery). */
  retry(): void;
  /** Dismiss the current non-fatal worker error without reconnecting. */
  dismissError(): void;
  /** Mount reference; returns an idempotent release (Strict-Mode safe). */
  acquire(): () => void;
  dispose(): void;
}

const DEFAULT_TIMINGS = {
  idleTtlMs: 15 * 60 * 1000, // refCount 0 -> evict after 15 min (parity with terminal-store)
  maxReconnectAttempts: 100,
  reconnectDelayMs: null as number | null, // null -> getReconnectDelay (test override only)
};
type Timings = typeof DEFAULT_TIMINGS;
let timings: Timings = { ...DEFAULT_TIMINGS };

// App-WS subscribe seam: production uses the real module-level subscribe;
// tests inject a capturable fake to drive session-deleted.
let appSubscribeImpl: typeof subscribeApp = subscribeApp;

type EmbeddedAgentSendMessage =
  | EmbeddedAgentClientMessage
  | Extract<WorkerClientMessage, { type: 'request-history' | 'request-history-range' }>;

class EmbeddedAgentController implements EmbeddedAgentInstance {
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private snapshot: EmbeddedAgentSnapshot;
  private disposed = false;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private historyRequested = false; // per WS connection
  private noReconnect = false; // set on SESSION_DELETED / SESSION_PAUSED

  // Offset/epoch tracking (§3.1/§3.4 of terminal-history-paging.md; the same
  // byte-offset/epoch framing is reused content-agnostically here).
  private lastOffset = 0;
  private requestedFromOffset = 0;
  private epoch: number | null = null;

  // Epoch-resync bookkeeping (mirrors terminal-store.ts's resyncing /
  // queuedOutput, §3.4). While a fresh history response for a bumped epoch
  // is outstanding, live `output` frames for the SAME (already-bumped)
  // epoch must not be folded immediately -- acceptEpoch has already
  // recorded the new epoch by the time beginEpochReset runs, so those
  // frames would pass the epoch gate and fold into `entries` right away.
  // The eventual history response (requested from offset 0, covering
  // everything the server has appended since activation, INCLUDING those
  // same bytes) would then fold them a second time. Queuing defers folding
  // until the history response lands, so the queue can drop whatever the
  // history payload already covers and only apply the genuinely-newer tail.
  //
  // Deliberately NOT ported: terminal-store's queue byte/entry cap
  // (RESYNC_QUEUE_MAX_ENTRIES/BYTES) and resync timeout (RESYNC_TIMEOUT_MS).
  // Those exist there because raw terminal output can be high-volume and
  // continuous. NDJSON chat events are comparatively tiny (server caps any
  // single line at 1 MiB and kills the subprocess on a breach) and the
  // resync window is only the gap between an epoch bump and one
  // request-history round trip -- at most a handful of small lines (ready,
  // state, maybe an early delta). An unbounded stall is already covered by
  // the store's existing behavior: `loadingHistory` stays true and is
  // visible to the UI, exactly as an ordinary never-answered request-history
  // would behave today (there is no timeout anywhere else in this store
  // either). Revisit if dogfood ever shows a resync that doesn't complete.
  private resyncing = false;
  private queuedOutput: Array<{ data: string; offset: number }> = [];

  // Tracks the in-flight sendUserMessage promise, if any (§ sendUserMessage
  // doc comment). Only one send can be outstanding at a time in practice --
  // MessagePanel disables the Send button while its own onSend promise is
  // pending -- so a single slot (rather than a queue/map) is sufficient.
  private pendingSend: {
    resolve: () => void;
    reject: (err: Error) => void;
    clientMessageId: string;
  } | null = null;

  private splitter = new NdjsonLineSplitter();

  // Index maps for folding streamed events into the entries array. Cleared
  // on every fresh (non-continuation) history load / epoch reset.
  private openAssistantIndexByTurnId = new Map<string, number>();
  private openThinkingIndexByTurnId = new Map<string, number>();
  private toolCallIndexByCallId = new Map<string, number>();
  private entryKeyCounter = 0;

  // Memory management (parity with terminal-store, minus the LRU cap -- the
  // number of concurrently mounted embedded-agent tabs is expected to be
  // small; add a cap if that assumption stops holding).
  private refCount = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private appUnsub: () => void = () => {};

  constructor(
    private sessionId: string,
    private workerId: string,
  ) {
    this.snapshot = {
      version: 0,
      status: 'connecting',
      entries: [],
      activityState: 'unknown',
      workerError: null,
      loadingHistory: false,
    };
    this.appUnsub = appSubscribeImpl((msg) => this.handleAppMessage(msg));
    this.connect();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): EmbeddedAgentSnapshot => this.snapshot;

  sendUserMessage = (text: string): Promise<void> => {
    // Defensive: superseded by the new send below. Should not happen in
    // practice (MessagePanel disables Send while a prior send is pending)
    // but avoids leaking an unsettled promise if it ever does.
    this.rejectPendingSend('Superseded by a newer send');
    const clientMessageId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const sent = this.send({ type: 'embedded-user-message', text, clientMessageId });
      if (!sent) {
        reject(new Error('Not connected'));
        return;
      }
      this.pendingSend = { resolve, reject, clientMessageId };
    });
  };

  cancel = (): void => {
    this.send({ type: 'embedded-cancel' });
  };

  restart = (): void => {
    this.reconnect();
  };

  retry = (): void => {
    if (this.disposed) return;
    this.patch({ workerError: null });
    this.noReconnect = false;
    this.reconnectAttempts = 0;
    this.reconnect();
  };

  dismissError = (): void => {
    if (this.snapshot.workerError === null) return;
    this.patch({ workerError: null });
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
      if (this.refCount === 0) this.startIdleTimer();
    };
  };

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectPendingSend('Worker disposed');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.appUnsub();
    this.closeWs();
    this.listeners.clear();
    removeInstance(this.sessionId, this.workerId);
  };

  // --- Test-only accessors ---

  get refCountForTest(): number {
    return this.refCount;
  }

  get disposedForTest(): boolean {
    return this.disposed;
  }

  // --- Memory management ---

  private startIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.refCount === 0) this.dispose();
    }, timings.idleTtlMs);
  }

  // --- App-WS driven events ---

  private handleAppMessage(msg: AppServerMessage): void {
    if (this.disposed) return;
    if (msg.type === 'session-deleted' && msg.sessionId === this.sessionId) {
      this.dispose();
    }
  }

  // --- WebSocket lifecycle ---

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
      if (!this.historyRequested) {
        this.historyRequested = true;
        this.requestHistory();
      }
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      this.handleMessage(event.data);
    };

    ws.onerror = () => {
      logger.warn(`[embedded-agent] ws error ${this.sessionId}:${this.workerId}`);
    };

    ws.onclose = (event) => {
      if (this.disposed) return;
      this.ws = null;
      this.updateStatus('disconnected');
      if (this.noReconnect) {
        // No reconnect will ever happen, so no future echo/error can settle
        // a pending send -- reject now rather than hanging forever.
        this.rejectPendingSend('Connection closed before the message was confirmed');
        return;
      }
      if (!shouldReconnect(event.code)) {
        this.rejectPendingSend('Connection closed before the message was confirmed');
        return;
      }
      this.scheduleReconnect();
    };
  }

  /** Force a fresh WS connection (used by restart() and retry()). */
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

  /** Returns whether the message was actually written to an open socket. */
  private send(message: EmbeddedAgentSendMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private resolvePendingSend(): void {
    if (!this.pendingSend) return;
    this.pendingSend.resolve();
    this.pendingSend = null;
  }

  private rejectPendingSend(message: string): void {
    if (!this.pendingSend) return;
    this.pendingSend.reject(new Error(message));
    this.pendingSend = null;
  }

  private requestHistory(): void {
    this.requestedFromOffset = this.lastOffset;
    this.patch({ loadingHistory: true });
    this.send({ type: 'request-history', fromOffset: this.lastOffset });
  }

  // --- Server -> client message handling ---

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
        if (!this.acceptEpoch(message.epoch)) break;
        this.applyBytes(message.data, message.offset, message.startOffset);
        break;
      case 'output':
        if (!this.acceptEpoch(message.epoch)) break;
        // During an epoch resync, live output for the (already-bumped)
        // current epoch is queued instead of folded immediately -- the
        // outstanding history response will cover it; see the `resyncing`
        // field comment.
        if (this.resyncing) {
          this.queuedOutput.push({ data: message.data, offset: message.offset });
          break;
        }
        this.applyBytes(message.data, message.offset, undefined);
        break;
      case 'activity':
        this.patch({ activityState: message.state });
        break;
      case 'error':
        this.handleError(message.message, message.code);
        break;
      // 'history-range': no UI trigger requests older ranges for embedded-agent
      // in v1 (no scroll-up paging over chat history); silently ignored if a
      // stray response ever arrives.
      // 'exit': PTY-only in practice -- the server represents subprocess exit
      // via a server-authored `exited` NDJSON row instead (the socket itself
      // stays open). Ignored defensively if it ever arrives.
      // 'server-restarted': embedded-agent workers rely on the epoch-mismatch
      // mechanism instead (see acceptEpoch); no explicit push is sent.
    }
  }

  /**
   * Epoch gate, same semantics as terminal-store's `acceptEpoch`: every
   * activation mints a fresh epoch and truncates the output stream (v1 has
   * no revive path), so a LARGER epoch than recorded means the worker
   * restarted server-side and the accumulated chat state must be dropped and
   * re-fetched from scratch. A SMALLER epoch is a straggler from a
   * superseded incarnation and is dropped without resetting anything.
   */
  private acceptEpoch(epoch: number | undefined): boolean {
    if (typeof epoch !== 'number') return true;
    if (this.epoch === null) {
      this.epoch = epoch;
      return true;
    }
    if (epoch === this.epoch) return true;
    if (epoch < this.epoch) return false;
    this.beginEpochReset(epoch);
    return false;
  }

  private beginEpochReset(newEpoch: number): void {
    // The worker restarted server-side; whatever send was in flight will
    // never be echoed back in the old epoch. Reject so the caller (and
    // MessagePanel's draft-preservation) doesn't hang forever.
    this.rejectPendingSend('Worker restarted before the message was confirmed');
    this.resetChatState();
    this.epoch = newEpoch;
    this.lastOffset = 0;
    // Start (or restart, on a second epoch bump before the first resync
    // completed) queuing live output for the new epoch until its history
    // response arrives -- see the `resyncing` field comment. Any items
    // queued for a now-superseded epoch are dropped along with the rest of
    // the chat state above.
    this.resyncing = true;
    this.queuedOutput = [];
    // Always issue a fresh request for the NEW epoch, even if a request was
    // already outstanding when the epoch bumped. That prior request targets
    // the OLD epoch; its eventual (stale) response is dropped by acceptEpoch
    // (wrong epoch) and can never satisfy the new epoch's history. A guard
    // that skipped this call whenever a request was already in flight left
    // the store stuck at loadingHistory: true forever, since no fresh
    // request for the new epoch would ever be sent.
    this.requestHistory();
  }

  private resetChatState(): void {
    this.splitter = new NdjsonLineSplitter();
    this.openAssistantIndexByTurnId.clear();
    this.openThinkingIndexByTurnId.clear();
    this.toolCallIndexByCallId.clear();
    this.patch({ entries: [] });
  }

  /**
   * Apply a chunk of history/output bytes: split into complete NDJSON lines
   * (carrying a partial trailing line across chunks via the shared
   * splitter), parse + fold each into the chat view-model.
   *
   * `startOffset` is present on `history` responses and absent on `output`.
   * A history response whose window does not start exactly where we asked
   * (server evicted/pruned, or this is a resync's fresh load) is a FRESH
   * load: the accumulated entries are dropped before folding.
   */
  private applyBytes(data: string, offset: number, startOffset: number | undefined): void {
    const isFresh =
      typeof startOffset === 'number' ? startOffset !== this.requestedFromOffset : false;
    if (isFresh) {
      this.resetChatState();
    }
    this.lastOffset = offset;
    const { lines } = this.splitter.push(data);
    let changed = false;
    for (const line of lines) {
      if (line.length === 0) continue;
      if (this.foldLine(line)) changed = true;
    }
    if (changed || isFresh) {
      this.patch({ loadingHistory: false, entries: [...this.snapshot.entries] });
    } else {
      this.patch({ loadingHistory: false });
    }
    // A `history` response that lands while an epoch resync is outstanding
    // completes that resync: replay whatever output arrived and was queued
    // in the meantime, now that we know exactly what this history payload
    // already covers. This MUST run before the reject check below -- a
    // pending send's confirming echo can be sitting in the resync queue
    // (not yet folded) at the moment this history response arrives, and
    // flushing gives it a chance to resolve the pending send before the
    // reject below would otherwise fire and kill it (#1120).
    if (typeof startOffset === 'number' && this.resyncing) {
      this.flushResyncQueue(offset);
    }
    // A history response (startOffset is only ever set for those, never for
    // live `output`) covers everything the server has from `requestedFromOffset`
    // onward. If a send confirmation is still pending after folding it AND
    // after the resync-queue flush above, the write must have been lost when
    // the connection dropped before the server received it (an accepted
    // send's echo would already have resolved it via foldEvent's
    // user-message case, either during this fold or during the flush above)
    // -- reject so the caller doesn't hang waiting for a confirmation that
    // will never arrive.
    if (typeof startOffset === 'number' && this.pendingSend !== null) {
      this.rejectPendingSend('Reconnected but the message was not confirmed');
    }
  }

  /**
   * Replay output queued during an epoch resync (see the `resyncing` field
   * comment), now that the resync's history response has landed at
   * `historyOffset`. Queued entries whose absolute end offset is already
   * covered by that history payload are dropped (they were already folded
   * as part of it); anything strictly newer is folded via the normal
   * live-output path, in arrival order, through the same (already-fresh)
   * splitter the history response itself was just parsed with.
   */
  private flushResyncQueue(historyOffset: number): void {
    this.resyncing = false;
    const queued = this.queuedOutput;
    this.queuedOutput = [];
    for (const item of queued) {
      if (item.offset <= historyOffset) continue;
      this.applyBytes(item.data, item.offset, undefined);
    }
  }

  /** Parse one NDJSON line and fold it into `this.snapshot.entries`. Returns
   * whether the entries array was mutated. */
  private foldLine(line: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      logger.warn(`[embedded-agent] malformed NDJSON line, skipping: ${line.slice(0, 200)}`);
      return false;
    }
    // Client replay parser MUST use the full EmbeddedAgentStreamEventSchema
    // union (loop events + server-authored user-message/exited), never the
    // loop-only EmbeddedAgentEventSchema -- parsing with the narrower schema
    // would silently drop every server-authored row from replayed history.
    // See docs/design/embedded-agent-worker.md "WebSocket & client protocol".
    const result = v.safeParse(EmbeddedAgentStreamEventSchema, parsed);
    if (!result.success) {
      logger.warn('[embedded-agent] unrecognized/invalid NDJSON event, skipping', { line: line.slice(0, 200) });
      return false;
    }
    return this.foldEvent(result.output);
  }

  private foldEvent(event: EmbeddedAgentStreamEvent): boolean {
    switch (event.type) {
      case 'ready':
        // No rendering; init handshake completed.
        return false;
      case 'state':
        // Activity is driven by the separate WorkerServerMessage {type:
        // 'activity'} envelope, not this NDJSON row -- see the WS routing
        // layer's broadcastActivity. Recognized-but-not-rendered, not an
        // unknown type: no warning.
        return false;
      case 'assistant-delta':
        this.appendAssistant(event.turnId, event.text, null);
        return true;
      case 'assistant-thinking-delta':
        this.appendThinking(event.turnId, event.text);
        return true;
      case 'assistant-message':
        this.appendAssistant(event.turnId, null, event.text);
        // `assistant-message` is emitted unconditionally exactly once per
        // loop iteration and is the only end-of-thinking-segment signal on
        // the wire (there is no terminal/"final" assistant-thinking-delta
        // event) -- see docs/design/embedded-agent-worker.md turn-cycle
        // notes and packages/embedded-agent/src/agent-loop.ts's
        // runProviderAttempt. Finalize any still-open thinking entry for
        // the same turn here.
        this.closeOpenThinking(event.turnId);
        return true;
      case 'tool-call':
        this.pushToolCall(event.turnId, event.callId, event.name, event.args);
        return true;
      case 'tool-result':
        return this.applyToolResult(event.callId, { ok: event.ok, result: event.result });
      case 'turn-error':
        this.pushEntry({
          key: `turn-error-${event.turnId}-${this.entryKeyCounter++}`,
          kind: 'turn-error',
          turnId: event.turnId,
          message: event.message,
        });
        // Defensive finalize: a turn that errors out mid-reasoning must not
        // leave its thinking entry permanently streaming (no other event
        // will ever finalize it for this turnId).
        this.closeOpenThinking(event.turnId);
        return true;
      case 'fatal':
        this.pushEntry({ key: `fatal-${this.entryKeyCounter++}`, kind: 'fatal', message: event.message });
        // Defensive finalize: a fatal error mid-reasoning must not leave any
        // turn's thinking entry permanently streaming (no other event will
        // ever finalize it), mirroring the 'exited' handler above.
        this.closeAllOpenThinking();
        return true;
      case 'user-message':
        this.pushEntry({ key: `user-${event.id}`, kind: 'user-message', id: event.id, text: event.text });
        // Confirms THIS client's own sendUserMessage() was accepted -- correlated
        // by clientMessageId, not "any user-message event", so a different
        // client's (or a different tab's) echo cannot falsely resolve our
        // pending send. Undefined-vs-undefined (no pending, or a legacy replay
        // row with no clientMessageId) is safe: resolvePendingSend() is a no-op
        // when pendingSend is null.
        if (this.pendingSend?.clientMessageId === event.clientMessageId) {
          this.resolvePendingSend();
        }
        return true;
      case 'exited':
        this.pushEntry({ key: `exited-${this.entryKeyCounter++}`, kind: 'exited', code: event.code });
        // Defensive finalize: the process exited while some turn's thinking
        // entry was still open (e.g. a crash mid-turn); no per-turnId signal
        // will ever arrive at this point, so close all open thinking entries.
        this.closeAllOpenThinking();
        return true;
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  }

  private pushEntry(entry: EmbeddedAgentChatEntry): void {
    this.snapshot.entries.push(entry);
  }

  /**
   * Accumulate delta text and/or finalize the current OPEN assistant-message
   * entry for `turnId`. A turn can produce multiple assistant messages
   * across successive tool-use iterations sharing the same `turnId`; once an
   * entry is finalized (streaming: false) its slot is cleared from the open
   * index so the next delta for the same turnId starts a fresh entry rather
   * than reopening the finalized one.
   *
   * Entries are replaced (never mutated in place) so consumers that memoize
   * per-entry by object reference (e.g. `React.memo`) re-render correctly on
   * every delta/finalize.
   */
  private appendAssistant(turnId: string, delta: string | null, final: string | null): void {
    const idx = this.openAssistantIndexByTurnId.get(turnId);
    if (idx === undefined) {
      const entry: EmbeddedAgentChatEntry = {
        key: `assistant-${turnId}-${this.entryKeyCounter++}`,
        kind: 'assistant-message',
        turnId,
        text: final ?? delta ?? '',
        streaming: final === null,
      };
      this.snapshot.entries.push(entry);
      if (final === null) {
        this.openAssistantIndexByTurnId.set(turnId, this.snapshot.entries.length - 1);
      }
      return;
    }
    const existing = this.snapshot.entries[idx];
    if (existing.kind !== 'assistant-message') return;
    const text = final !== null ? final : existing.text + (delta ?? '');
    const streaming = final === null;
    this.snapshot.entries[idx] = { ...existing, text, streaming };
    if (final !== null) this.openAssistantIndexByTurnId.delete(turnId);
  }

  /**
   * Accumulate a thinking-delta chunk into the OPEN assistant-thinking entry
   * for `turnId`, opening a new entry on the first chunk. Mirrors
   * `appendAssistant`'s accumulate logic, but simpler: there is no terminal
   * "final" thinking event on the wire, so `streaming` stays `true` until
   * `closeOpenThinking`/`closeAllOpenThinking` finalizes it (see the
   * `assistant-message`/`turn-error`/`exited` cases in `foldEvent`).
   *
   * Entries are replaced (never mutated in place) -- same React.memo
   * reference-equality rationale as `appendAssistant`.
   */
  private appendThinking(turnId: string, delta: string): void {
    const idx = this.openThinkingIndexByTurnId.get(turnId);
    if (idx === undefined) {
      const entry: EmbeddedAgentChatEntry = {
        key: `thinking-${turnId}-${this.entryKeyCounter++}`,
        kind: 'assistant-thinking',
        turnId,
        text: delta,
        streaming: true,
      };
      this.snapshot.entries.push(entry);
      this.openThinkingIndexByTurnId.set(turnId, this.snapshot.entries.length - 1);
      return;
    }
    const existing = this.snapshot.entries[idx];
    if (existing.kind !== 'assistant-thinking') return;
    this.snapshot.entries[idx] = { ...existing, text: existing.text + delta };
  }

  /** Finalize (streaming: false) the open thinking entry for `turnId`, if any. */
  private closeOpenThinking(turnId: string): void {
    const idx = this.openThinkingIndexByTurnId.get(turnId);
    if (idx === undefined) return;
    const existing = this.snapshot.entries[idx];
    if (existing.kind === 'assistant-thinking') {
      this.snapshot.entries[idx] = { ...existing, streaming: false };
    }
    this.openThinkingIndexByTurnId.delete(turnId);
  }

  /** Finalize every still-open thinking entry, regardless of turnId. */
  private closeAllOpenThinking(): void {
    for (const turnId of Array.from(this.openThinkingIndexByTurnId.keys())) {
      this.closeOpenThinking(turnId);
    }
  }

  private pushToolCall(turnId: string, callId: string, name: string, args: unknown): void {
    const entry: EmbeddedAgentChatEntry = {
      key: `tool-${callId}`,
      kind: 'tool-call',
      turnId,
      callId,
      name,
      args,
      result: null,
    };
    this.snapshot.entries.push(entry);
    this.toolCallIndexByCallId.set(callId, this.snapshot.entries.length - 1);
  }

  private applyToolResult(callId: string, result: EmbeddedAgentToolResult): boolean {
    const idx = this.toolCallIndexByCallId.get(callId);
    if (idx === undefined) {
      // Defensive: a tool-result without a matching tool-call violates the
      // documented protocol invariant. Log and drop rather than fabricate a
      // placeholder card.
      logger.warn(`[embedded-agent] tool-result for unknown callId, skipping: ${callId}`);
      return false;
    }
    const existing = this.snapshot.entries[idx];
    if (existing.kind !== 'tool-call') return false;
    this.snapshot.entries[idx] = { ...existing, result };
    return true;
  }

  private handleError(message: string, code?: WorkerErrorCode): void {
    this.patch({ workerError: { message, code } });
    // A send-reject (e.g. TURN_IN_PROGRESS) arrives here, not as a
    // rejected `send()` call -- reject the pending promise so MessagePanel
    // preserves the input draft instead of clearing it optimistically.
    this.rejectPendingSend(message);
    if (code === 'SESSION_DELETED' || code === 'SESSION_PAUSED') {
      this.noReconnect = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    }
    // A failed request-history during an epoch resync means the fresh
    // history reply that flushResyncQueue normally waits for will never
    // arrive -- without this, every subsequent live `output` frame would
    // keep queuing forever (resyncing never flips back to false), freezing
    // the chat view until a full reconnect. `lastOffset` is still 0 here
    // (beginEpochReset reset it before anything could be queued, and queued
    // frames never advance it), so flushResyncQueue(0) applies the ENTIRE
    // queue -- nothing is dropped as "already covered", because no history
    // was ever folded in this failure path, so there is no duplication
    // risk. This trades "wait forever for a history reply that will never
    // come" for "degraded-but-live": skip the failed load, apply whatever
    // live output already arrived, and let normal live-output handling
    // resume from there.
    if (code === 'HISTORY_LOAD_FAILED' && this.resyncing) {
      this.flushResyncQueue(this.lastOffset);
    }
  }

  // --- Snapshot helpers ---

  private updateStatus(status: EmbeddedAgentConnectionStatus): void {
    this.patch({ status });
  }

  private patch(partial: Partial<EmbeddedAgentSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial, version: this.snapshot.version + 1 };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

// --- Module-level registry ---

const instances = new Map<string, EmbeddedAgentController>();

function keyOf(sessionId: string, workerId: string): string {
  return JSON.stringify([sessionId, workerId]);
}

function removeInstance(sessionId: string, workerId: string): void {
  instances.delete(keyOf(sessionId, workerId));
}

export function getOrCreateEmbeddedAgentWorker(
  sessionId: string,
  workerId: string,
): EmbeddedAgentInstance {
  const key = keyOf(sessionId, workerId);
  let instance = instances.get(key);
  if (!instance) {
    instance = new EmbeddedAgentController(sessionId, workerId);
    instances.set(key, instance);
  }
  return instance;
}

/** @internal Test helper: dispose and clear all live instances + reset config. */
export function _resetEmbeddedAgentWorkers(): void {
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
export function _inspect(instance: EmbeddedAgentInstance): {
  refCount: number;
  disposed: boolean;
} {
  const c = instance as EmbeddedAgentController;
  return { refCount: c.refCountForTest, disposed: c.disposedForTest };
}
