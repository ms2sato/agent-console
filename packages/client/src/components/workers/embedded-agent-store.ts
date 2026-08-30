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
  type EmbeddedAgentServerNotification,
  type ExitReason,
  type RestorePreservation,
} from '@agent-console/shared';
import { getWorkerWsUrl } from '../../lib/websocket-url.js';
import { getReconnectDelay, shouldReconnect } from '../../lib/websocket-reconnect.js';
import { subscribe as subscribeApp } from '../../lib/app-websocket.js';
import { logger } from '../../lib/logger.js';
import { generateClientId } from '../../lib/id.js';

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
  | {
      key: string;
      kind: 'user-message';
      id: string;
      text: string;
      // Present iff this row is a system-originated internal notification
      // rather than a real human/API-caller message -- mirrors
      // EmbeddedAgentServerEvent's `notification` field one-to-one; see that
      // field's doc comment for the discriminator rationale.
      notification?: EmbeddedAgentServerNotification;
    }
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
  /**
   * `reason` mirrors the wire event's field one-to-one, absence included --
   * see EmbeddedAgentServerEvent's `exited` doc comment. The store carries it
   * verbatim so the view has no store-side default to undo, and every
   * consumer tests `reason === 'evicted'` rather than truthiness.
   */
  | { key: string; kind: 'exited'; code: number | null; reason?: ExitReason }
  /**
   * Transcript Restore, R1: the turn identified by `turnId` was cut off by a
   * process boundary and never answered. Server-authored -- deliberately a
   * distinct kind from `turn-error`, which represents an error an ENGINE
   * reported. Nothing errored here; a process went away.
   */
  | { key: string; kind: 'turn-interrupted'; turnId: string }
  | {
      key: string;
      kind: 'context-compacted';
      source: 'auto' | 'manual';
      summary?: string;
      /** See the wire event's doc comment: how much context this compaction consumed and produced. */
      preTokens?: number;
      postTokens?: number;
      /**
       * The input limit the PROVIDER named, when this compaction was forced by
       * an over-window rejection that stated one. Their number, not ours --
       * contrast `appearsClamped` on a usage reading, which is our own
       * judgement and therefore carries none.
       */
      providerStatedWindowTokens?: number;
    }
  /**
   * LEGACY, retained deliberately (#1401): no engine emits `context-handoff`
   * any more, but persisted transcripts written before the compaction swap
   * contain those rows and replay them on every history load. Dropping this
   * entry kind (or its render case in EmbeddedAgentWorkerView) would make an
   * old transcript render with a silent hole where a real boundary was.
   */
  | { key: string; kind: 'context-handoff'; distillation: string }
  | { key: string; kind: 'restore-repair'; toolCallIds: string[] } // Transcript Restore (#1123)
  /**
   * Transcript Restore, R2 (#1447 stage 4): the persisted
   * `restore-failure-boundary` marker -- a reconstruction BOUNDARY of the
   * same class as `context-compacted`, but with no summary to carry (memory
   * starts from nothing at this boundary). Renders as a plain boundary line,
   * same visual family as `context-compacted`/`context-handoff`, without
   * their `<details>` disclosure since there is no summary to hide.
   */
  | { key: string; kind: 'restore-failure-boundary' }
  /**
   * Transcript Restore, R6 (#1447 stage 4): the persisted
   * `restore-failure-declaration` marker -- written into the fresh
   * (post-reset) live file when the FALLBACK path ran for a `claude-sdk`
   * worker whose `sdkSessionId` survived the reset. Restore-TRANSPARENT
   * (#1351's class), the same visual/rendering register as
   * `turn-interrupted` -- a quiet, non-boundary notification row, not a
   * reconstruction boundary. Declares that this worker's earlier
   * conversation is not shown here but the agent may still remember it,
   * and (unlike the incarnation-scoped #1449 banner) persists across every
   * subsequent incarnation until the next reset, because the divergence it
   * reports does too.
   */
  | { key: string; kind: 'restore-failure-declaration' };

/**
 * Latest known context-window usage reading (Compaction).
 * `estimated: false` means the value came straight from the provider's
 * `usage.prompt_tokens`; `estimated: true` means the loop's chars/4 fallback
 * was used (no provider usage reporting, or the fresh post-compaction seed
 * conversation). See docs/design/embedded-agent-worker.md "Token accounting".
 */
export interface EmbeddedAgentContextUsage {
  promptTokens: number;
  estimated: boolean;
  /**
   * Present only when this reading bears every mark of having been clamped by
   * the provider to its own input limit, rather than measuring the
   * conversation. OUR inference from a signature, never something the
   * provider said -- which is why it carries no number: the inferred cap IS
   * `promptTokens`, and re-sending it would put the same value on the same
   * reading twice.
   *
   * Three-valued by absence: missing means "not inferred, or a reading from
   * before this existed". There is no `false` -- no consumer needs to assert
   * that a reading was checked and found honest.
   */
  appearsClamped?: true;
}

export interface EmbeddedAgentSnapshot {
  version: number; // bumped on every change
  status: EmbeddedAgentConnectionStatus;
  entries: EmbeddedAgentChatEntry[];
  activityState: AgentActivityState;
  workerError: { message: string; code?: WorkerErrorCode } | null;
  loadingHistory: boolean;
  contextUsage: EmbeddedAgentContextUsage | null;
  /**
   * Transcript Restore (#1123 / #1205). Server-authoritative: mirrors the
   * `completed` field of the most recently accepted `restore-info` message
   * for the current epoch (`restoring = completed === false`). A successful
   * restore does NOT mint a new epoch (only a restore FAILURE does), so this
   * can no longer be derived client-side from a local "have we folded the
   * new incarnation's `ready` event yet" flag -- the server sends a second,
   * `completed: true` `restore-info` push the moment the new incarnation's
   * `ready` event is observed server-side, and that push is what flips this
   * back to false. Always false when no restore happened for this worker's
   * current incarnation (e.g. a first-ever activation never sends
   * `restore-info` at all).
   */
  restoring: boolean;
  /**
   * The `restoredMessageCount` from the most recently accepted
   * `restore-info` for the current epoch; null before any has been received
   * this epoch. The wire field and this snapshot field are deliberately the
   * same name because they are the same concept end to end: how many entries
   * were recovered from the persisted transcript (replayed messages plus a
   * compaction summary, excluding only the freshly-assembled system prompt).
   * It is therefore genuinely 0 for a worker that was activated but never
   * spoken to -- it is NOT a reconstruction array's length, and has no
   * floor of 1. Used to render "Loading N previous messages..." (wording is
   * deliberately engine-neutral -- see EmbeddedAgentWorkerView.tsx's comment
   * above that block, or docs/design/embedded-agent-sdk-engine.md §4.3).
   * This field's persistence past `restoring` flipping back to false (see
   * the `restoring` doc comment above) is also depended on by
   * EmbeddedAgentWorkerView.tsx's SDK-engine restore-divergence notice
   * (`hadPriorTranscriptThisIncarnation`), so a future change to when this
   * field resets to null must account for it.
   */
  restoredMessageCount: number | null;
  /**
   * Transcript Restore, R1: the `sdkResumed` field of the most recently
   * accepted `restore-info` for the current epoch, verbatim -- INCLUDING its
   * absence, which is carried as `undefined` rather than normalised.
   *
   * THREE-VALUED, and the third value is the point: `undefined` means "this
   * engine has no such concept" (an `openai-api` worker never sets it, and
   * neither does a `claude-sdk` worker before its first `restore-info`),
   * while `false` means "this incarnation's SDK session did not resume" --
   * the OUTCOME, never an attempt or an intent, since one of its four routes
   * is a worker with no persisted session id where neither exists. The route
   * list lives with the wire type in `@agent-console/shared`'s
   * `types/session.ts`. Only `false` may drive the divergence notice. Any
   * consumer writing `!sdkResumed` collapses the two and puts a permanent
   * false warning on every `openai-api` worker -- test `=== false`.
   */
  sdkResumed: boolean | undefined;
  /**
   * Transcript Restore (#1449): whether the most recently accepted
   * `restore-info` for the current epoch is the FAILURE form (`failed:
   * true`) rather than the success form. False when no `restore-info` has
   * been accepted this epoch, INCLUDING before any has arrived and after a
   * genuine epoch bump (`resetChatState` clears it back to false so a new
   * incarnation's own restore-info -- success or failure -- re-declares it
   * from scratch; see `resetChatState`'s doc comment). Does not itself say
   * D2 vs Loss -- that direction is derived in EmbeddedAgentWorkerView.tsx
   * from this flag plus the engine plus `sdkResumed`, per the design doc's
   * "Failure form: what it declares, and the D1/D2/Loss derivation rule
   * (#1449)".
   */
  restoreFailed: boolean;
  /**
   * Transcript Restore, R4 (#1447 stage 4): the `preservation` field of the
   * most recently accepted `restore-info` FAILURE form for the current
   * epoch, verbatim -- INCLUDING its absence, which is carried as
   * `undefined` rather than normalised. Meaningless while `restoreFailed` is
   * false; not reset independently of it.
   *
   * - `'in-band'`: R1's PRIMARY path -- the transcript is still the visible
   *   display (`entries`), no reset happened. The banner must not claim a
   *   separate "diagnostic copy" -- the copy IS the transcript.
   * - `'sidecar'`: R1's FALLBACK path, and the best-effort sidecar rename
   *   succeeded. The banner may claim sidecar preservation.
   * - `'lost'`: the fallback path ran AND the sidecar rename itself failed.
   *   Nothing was preserved anywhere; the banner must not claim it was.
   * - `undefined`: a pre-stage-4 server (wire-compat), OR simply "no
   *   restore-info accepted this epoch yet". EmbeddedAgentWorkerView.tsx
   *   renders today's unconditional copy for this case, per the design
   *   doc's "The client's exact copy, both directions".
   */
  preservation: RestorePreservation | undefined;
  /**
   * R1 (#1455): the worker's CURRENT exit state, independent of any
   * historical `exited` transcript ROW. Single writer: set from the
   * `exited` event's own `code`/`reason` in `foldEvent`'s `'exited'` case,
   * cleared back to `null` by the `'ready'` case (a fresh incarnation
   * coming up means "no live current exit"). Mirrors the row's own
   * `reason !== undefined` handling -- absence stays absent, never
   * normalised to a default reason.
   *
   * THREE-VALUED, and `null` is the point: it means "not exited right
   * now" (either genuinely running, or nothing observed yet this
   * connection), never "exited for an unknown reason". This is what lets a
   * consumer distinguish "affordance" (non-null, non-evicted) from
   * "no affordance" (null, or evicted) WITHOUT scanning `entries` for the
   * last exit row -- scanning entries is exactly the row-equals-state
   * conflation that let every historical exit row keep offering a Restart
   * action even after a later restart superseded it (the bug this field
   * exists to remove; see EmbeddedAgentWorkerView.tsx's render body for the
   * consumer).
   *
   * Deliberately NOT `AgentActivityState` (`@agent-console/shared`): that
   * shared type also drives PTY-backed agent workers and has no
   * exited-with-reason shape -- see design-principles.md "Define types by
   * what they represent, not where they're used".
   */
  currentExit: { code: number | null; reason?: ExitReason } | null;
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

  // Transcript Restore (#1123 / #1205) bookkeeping.
  private restoreRepairRenderedThisLoad = false;

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
      contextUsage: null,
      restoring: false,
      restoredMessageCount: null,
      sdkResumed: undefined,
      restoreFailed: false,
      preservation: undefined,
      currentExit: null,
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
    const clientMessageId = generateClientId();
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
      case 'restore-info': {
        // Transcript Restore (#1123). Dual-delivered by the server (fast-path
        // push + every bootstrap re-delivery for the incarnation's lifetime)
        // -- acceptEpoch is the cross-incarnation staleness guard, exactly
        // like `history`/`output`. Unlike `history`/`output`, this message
        // carries its own payload that must survive a NEWER-epoch reset:
        // acceptEpoch returning false covers two different cases (stale
        // epoch, dropped without side effects; or newer epoch, which
        // synchronously ran beginEpochReset and set this.epoch = epoch
        // before returning). Applying against whatever epoch we ended up on
        // -- rather than bailing out on any `false` return -- means this
        // message's data is used immediately in the newer-epoch case instead
        // of being discarded on the bet that a later bootstrap redelivery
        // will resend it on this same connection (it won't; redelivery only
        // fires on a fresh WS connection's onOpen). A genuinely stale epoch
        // never updates this.epoch, so it is still correctly dropped here.
        this.acceptEpoch(message.epoch);
        if (this.epoch === message.epoch) {
          // Discriminated union (#1449): the failure form carries none of
          // the success form's reconstruction-shaped fields, so branch
          // BEFORE reading any of them -- checked `=== true`, never
          // truthiness, matching this file's existing discipline for
          // `completed`/`sdkResumed`.
          if (message.failed === true) {
            this.applyRestoreFailure(message.sdkResumed, message.preservation);
          } else {
            this.applyRestoreInfo(
              message.restoredMessageCount,
              message.repairedToolCallIds,
              message.completed,
              message.sdkResumed,
            );
          }
        }
        break;
      }
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
    // activityState is worker-LIVENESS state (is the process alive, what is
    // it doing), not display-content state -- it belongs to this
    // epoch-replacement path only, NOT to applyBytes's same-epoch fresh-load
    // branch (which also calls resetChatState, where the worker incarnation
    // hasn't changed and may still be genuinely mid-turn). A discarded
    // incarnation's last-known activityState (e.g. 'active') must not keep
    // gating the composer for a worker that no longer exists; see
    // resetChatState's doc comment for the display-state fields that DO
    // belong to a same-epoch fresh load too.
    // currentExit (#1455) is ALSO worker-liveness state by definition -- "the
    // worker's CURRENT exit state" -- so it belongs in this same
    // epoch-replacement path, for the same reason and NOT in resetChatState()'s
    // unconditional fields: a superseded incarnation's stale exit must not
    // keep driving the Restart affordance for a worker that no longer
    // exists. Same discipline activityState already carries here (CodeRabbit
    // review, cross-referencing the same-day #1480 fix for activityState in
    // this same function).
    // restoreFailed/preservation (#1447 stage 4 R2/C2 fix, CodeRabbit review)
    // belong here too, and for the SAME reason activityState does: only a
    // genuine epoch bump means a new incarnation's own restore-info is
    // coming to re-declare (or not) the failure before any window where a
    // stale value could be read. See resetChatState's doc comment for the
    // full two-caller argument.
    //
    // All four fields below are passed to resetChatState() as its
    // epoch-change-only extension, rather than patched here in a SEPARATE
    // this.patch() call, so the whole epoch-reset update -- display-content
    // fields plus these liveness/declaration fields -- reaches listeners in
    // ONE publish (#1503, CodeRabbit review). resetChatState()'s own patch()
    // and a second patch() here are each independently synchronous
    // (patch() -> notify() runs listeners immediately), so splitting them
    // let a subscriber observe an impossible intermediate snapshot between
    // the two calls: entries already emptied by the first patch, but
    // restoreFailed/preservation still carrying the STALE pre-reset
    // declaration because the second patch hadn't run yet -- e.g.
    // `preservation: 'in-band'` (which per the banner copy means "the
    // earlier transcript is still shown above") coexisting with the exact
    // `entries: []` that reset just produced. A declaration and the
    // transcript state it describes must become visible together, not one
    // publish apart.
    this.resetChatState({
      activityState: 'unknown',
      currentExit: null,
      restoreFailed: false,
      preservation: undefined,
    });
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

  /**
   * `epochChangeFields`, when provided, carries the fields that belong ONLY
   * to the epoch-REPLACEMENT call site (beginEpochReset) -- see this
   * function's own doc comment below for which fields those are and why.
   * They are threaded through as a param and merged into this function's own
   * `patch()` call, rather than left to a SEPARATE `this.patch()` call at the
   * caller, so the epoch-change caller gets exactly ONE publish for its
   * whole reset instead of two. `patch()` notifies listeners synchronously;
   * two separate calls would let a subscriber observe the display-content
   * fields already cleared (e.g. `entries: []`) while the liveness/
   * declaration fields (e.g. `restoreFailed`/`preservation`) still carried
   * their STALE pre-reset values, an impossible combination described in
   * beginEpochReset's own comment (#1503, CodeRabbit review). The same-epoch
   * call site (applyBytes) omits this argument, so its own patch stays
   * limited to the display-content subset below.
   */
  private resetChatState(
    epochChangeFields?: Pick<
      EmbeddedAgentSnapshot,
      'activityState' | 'currentExit' | 'restoreFailed' | 'preservation'
    >,
  ): void {
    this.splitter = new NdjsonLineSplitter();
    this.openAssistantIndexByTurnId.clear();
    this.openThinkingIndexByTurnId.clear();
    this.toolCallIndexByCallId.clear();
    // Transcript Restore (#1123 / #1205): a fresh load re-derives `restoring`
    // from whatever `restore-info` (re-)arrives afterward -- `restoring` is
    // driven entirely by the next accepted restore-info's `completed` field
    // (see `applyRestoreInfo`), so the reset here is just the initial value
    // pending that message. Also allows a redelivered restore-repair note to
    // re-render against the wiped list.
    this.restoreRepairRenderedThisLoad = false;
    // This function is shared by TWO call sites with different semantics,
    // and every field reset here must be re-justified against BOTH of them:
    //
    //   1. beginEpochReset -- a genuine incarnation change (the worker
    //      restarted server-side, or the fallback restore-failure route
    //      minted a fresh epoch). The next incarnation's own restore-info
    //      (success or failure) is guaranteed to arrive and re-declare
    //      whatever it needs to, before any window where a stale value
    //      could be read as describing the NEW incarnation.
    //   2. applyBytes's same-epoch `isFresh` branch -- the server
    //      pruned/evicted its buffer, or a resync's fresh load
    //      (`requestHistory()` fires on EVERY WebSocket reconnect,
    //      including a plain network blip or tab wake, not just a worker
    //      restart). The SAME live worker incarnation, possibly mid-turn.
    //      No new restore-info is coming -- a `history` response never
    //      carries one -- so nothing will ever re-declare a field cleared
    //      here.
    //
    // Fields legitimately rebuilt by BOTH call sites are DISPLAY-CONTENT
    // state (what the chat view currently shows, entirely re-derivable from
    // the fresh payload plus whatever re-declaration follows): entries,
    // restoring, restoredMessageCount, sdkResumed.
    //
    // Fields that describe something call site 2 is powerless to
    // re-declare must be excluded from the unconditional part of this
    // patch() and are reset ONLY via `epochChangeFields`, passed in by
    // beginEpochReset alongside activityState:
    //   - activityState (worker-LIVENESS state -- is the process alive,
    //     what is it doing) -- resetting it here would wrongly clear a
    //     genuinely-active worker's state on a same-epoch fresh load,
    //     wrongly releasing the composer's send-gate mid-turn.
    //   - restoreFailed/preservation (#1449, #1447 stage 4 R2/C2 -- a
    //     declared divergence must not silently disappear) -- these
    //     describe the CURRENT incarnation's restore outcome. On the
    //     PRIMARY (in-band) route the failure is declared without ever
    //     bumping the epoch (see `applyRestoreFailure`), so a same-epoch
    //     fresh load is exactly the case where a genuinely-still-true
    //     failure would otherwise be wiped with nothing left to
    //     re-declare it -- silently dropping the banner on the next
    //     ordinary reconnect even though the worker never restarted.
    //   - currentExit (#1455) -- same worker-LIVENESS reasoning as
    //     activityState above.
    //
    // When adding a new field to this function, ask which of the two
    // semantics above it belongs to, for EACH call site -- not just the one
    // you happened to be thinking about when you wrote the code. A field
    // that belongs to call site 1 only must be threaded through
    // `epochChangeFields` and merged into THIS SAME patch() call, never
    // written via a separate `this.patch()` at the caller -- see this
    // function's own doc comment above for why (coherency: one publish per
    // epoch reset, not two).
    this.patch({
      entries: [],
      restoring: false,
      restoredMessageCount: null,
      sdkResumed: undefined,
      ...epochChangeFields,
    });
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
    // Transcript Restore (#1123 / #1205): `restoring` is no longer derived
    // from folding `ready` here -- it is driven exclusively by the
    // `restore-info` message handler's `completed` field (see
    // `applyRestoreInfo`), since a successful restore does not mint a new
    // epoch and a `ready` fold can race `restore-info` in either order.
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
   * Transcript Restore (#1123 / #1205): apply a `restore-info` message
   * (fast-path push or bootstrap re-delivery -- both call this the same way;
   * the caller has already passed it through acceptEpoch). `restoring` is a
   * direct, unconditional function of THIS message's `completed` field --
   * server-authoritative, no local flag consulted -- because a successful
   * restore does not mint a new epoch and the new incarnation's `ready`
   * event can fold before or after `restore-info` arrives depending on the
   * race (see the `restoring` snapshot doc comment). Idempotent about
   * re-delivery: `restoreRepairRenderedThisLoad` guards against pushing a
   * duplicate `restore-repair` entry on every reconnect during the same
   * incarnation, but IS reset by `resetChatState()` so a fresh reconnect
   * that wipes `entries` correctly re-renders it from the redelivered data.
   */
  private applyRestoreInfo(
    restoredMessageCount: number,
    repairedToolCallIds: string[],
    completed: boolean,
    sdkResumed: boolean | undefined,
  ): void {
    const patch: Partial<EmbeddedAgentSnapshot> = {
      restoredMessageCount,
      restoring: completed === false,
      // R1: carried through verbatim, absence included. The server re-pushes
      // this whole message to correct the flag downward when a resume turns
      // out to have failed (the same re-push shape `completed` uses), so the
      // latest accepted message is always the current answer.
      sdkResumed,
    };
    if (repairedToolCallIds.length > 0 && !this.restoreRepairRenderedThisLoad) {
      this.restoreRepairRenderedThisLoad = true;
      this.pushEntry({
        key: `restore-repair-${this.entryKeyCounter++}`,
        kind: 'restore-repair',
        toolCallIds: repairedToolCallIds,
      });
      patch.entries = [...this.snapshot.entries];
    }
    this.patch(patch);
  }

  /**
   * Transcript Restore (#1449, extended #1447 stage 4 R3): apply a
   * `restore-info` FAILURE message (fast path push or bootstrap re-delivery
   * -- same caller as `applyRestoreInfo`, already passed through
   * acceptEpoch). Carries none of the success form's reconstruction-shaped
   * fields, so unlike `applyRestoreInfo` there is nothing to append to
   * `entries` here.
   *
   * R3 supersedes #1473's original "leaves entries/restoredMessageCount/
   * restoring untouched" pin, which was correct only for the reset
   * mechanism that pin was written against. R1 no longer bumps the epoch on
   * the PRIMARY (in-band) failure route, so this function -- not
   * `resetChatState` -- is now the sole clearer of this epoch's
   * incarnation-scoped restore state on that route: `restoredMessageCount`
   * to null, `restoring` to false. `entries` is deliberately NEVER touched
   * here, on EITHER route:
   *
   * - PRIMARY (in-band) route: no epoch bump happened, so `entries` still
   *   holds the pre-failure transcript exactly as C1 requires -- clearing it
   *   here would destroy the very thing this route exists to preserve.
   * - FALLBACK (sidecar/lost) route: the epoch DID bump, so `resetChatState`
   *   already wiped `entries` to `[]` (and already reset
   *   `restoredMessageCount`/`restoring`) before this message is applied --
   *   this function's clearing is redundant-but-harmless on this route, and
   *   not touching `entries` here is correct because there is nothing left
   *   to preserve or clobber.
   *
   * Idempotent about re-delivery, same as `applyRestoreInfo`: dual delivery
   * (fast-path push + bootstrap redelivery) and the R1 correction push all
   * call this the same way, and repatching the same values is a no-op.
   */
  private applyRestoreFailure(
    sdkResumed: boolean | undefined,
    preservation: RestorePreservation | undefined,
  ): void {
    this.patch({
      restoreFailed: true,
      // R1: carried through verbatim, absence included -- same correction-push
      // semantics `applyRestoreInfo` documents (the server re-pushes this
      // whole message to correct the flag downward once a resume outcome is
      // known, so the latest accepted message is always the current answer).
      sdkResumed,
      // R4 (#1447 stage 4): carried through verbatim, absence included --
      // see the snapshot field's doc comment.
      preservation,
      // R3: unconditional on every failure-form acceptance -- see this
      // function's doc comment for why this is the ONLY clearing on the
      // primary route and a harmless no-op on the fallback route.
      restoredMessageCount: null,
      restoring: false,
    });
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
        // No rendering; init handshake completed. `restoring` is NOT
        // derived from this event (#1205) -- it is driven exclusively by
        // the `restore-info` message's `completed` field, since a
        // successful restore does not mint a new epoch and this event can
        // fold before or after `restore-info` arrives depending on the
        // race. Recognized-but-not-rendered, not an unknown type: no
        // warning.
        // R1 (#1455): a fresh incarnation coming up means "no live current
        // exit" -- the single clear point for `currentExit`, mirroring the
        // single set point in the 'exited' case below.
        this.patch({ currentExit: null });
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
        this.pushEntry({
          key: `user-${event.id}`,
          kind: 'user-message',
          id: event.id,
          text: event.text,
          ...(event.notification !== undefined ? { notification: event.notification } : {}),
        });
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
        this.pushEntry({
          key: `exited-${this.entryKeyCounter++}`,
          kind: 'exited',
          code: event.code,
          // Verbatim, absence included: an older server's row carries no
          // `reason` and must stay absent here so the view renders it
          // exactly as it always did.
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        });
        // R1 (#1455): the single set point for `currentExit` -- mirrors the
        // row's own reason handling above (verbatim, absence included).
        // Cleared back to null only by the 'ready' case above.
        this.patch({
          currentExit: {
            code: event.code,
            ...(event.reason !== undefined ? { reason: event.reason } : {}),
          },
        });
        // Defensive finalize: the process exited while some turn's thinking
        // entry was still open (e.g. a crash mid-turn); no per-turnId signal
        // will ever arrive at this point, so close all open thinking entries.
        this.closeAllOpenThinking();
        return true;
      case 'context-usage':
        this.patch({ contextUsage: { promptTokens: event.promptTokens, estimated: event.estimated } });
        return false; // not a chat row
      case 'context-compacted':
        this.pushEntry({
          key: `context-compacted-${this.entryKeyCounter++}`,
          kind: 'context-compacted',
          source: event.source,
          ...(event.summary !== undefined ? { summary: event.summary } : {}),
          ...(event.preTokens !== undefined ? { preTokens: event.preTokens } : {}),
          ...(event.postTokens !== undefined ? { postTokens: event.postTokens } : {}),
        });
        return true;
      case 'context-handoff':
        // LEGACY (#1401): never emitted any more, but replayed from
        // transcripts written before the compaction swap. Folded exactly as
        // before so those rows keep rendering.
        this.pushEntry({
          key: `context-handoff-${this.entryKeyCounter++}`,
          kind: 'context-handoff',
          distillation: event.distillation,
        });
        return true;
      case 'turn-interrupted':
        this.pushEntry({
          key: `turn-interrupted-${event.turnId}`,
          kind: 'turn-interrupted',
          turnId: event.turnId,
        });
        // The interrupted turn's thinking entry, if it had one, will never
        // be finalized by any per-turnId signal -- the incarnation that
        // owned it is gone. Same defensive close as `exited` and `fatal`.
        this.closeAllOpenThinking();
        return true;
      case 'sdk-session-id':
      case 'sdk-resume-failed':
        // Server-side bookkeeping only, no client UI surface: the worker's
        // current SDK session id, and (R1) the machine-readable half of a
        // refused resume. What the USER sees about a failed resume is the
        // engine's own `turn-error` plus the divergence notice driven by
        // `restore-info.sdkResumed`, not this event. Not chat rows.
        return false;
      case 'restore-failure-boundary':
        // Transcript Restore, R2 (#1447 stage 4): a reconstruction boundary,
        // rendered as a plain marker line -- see the entry kind's doc
        // comment above.
        this.pushEntry({
          key: `restore-failure-boundary-${this.entryKeyCounter++}`,
          kind: 'restore-failure-boundary',
        });
        return true;
      case 'restore-failure-declaration':
        // Transcript Restore, R6 (#1447 stage 4): restore-TRANSPARENT --
        // rendered as a quiet notification row, the same register as
        // `turn-interrupted`, deliberately WITHOUT `closeAllOpenThinking()`:
        // that call exists for events marking an in-flight turn as orphaned
        // by a process boundary, which is not what this row declares.
        this.pushEntry({
          key: `restore-failure-declaration-${this.entryKeyCounter++}`,
          kind: 'restore-failure-declaration',
        });
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
