/**
 * The claude-sdk engine (docs/design/embedded-agent-sdk-engine.md): hosts a
 * Claude Agent SDK session inside the same subprocess harness the
 * native-loop engine (agent-loop.ts) runs in, mapping the SDK's own message
 * stream onto the SAME NDJSON event vocabulary the native engine emits (see
 * that document's Appendix A for the authoritative mapping table this file
 * implements).
 *
 * `query()` is called once per LIVE SDK session -- once at construction, and
 * again on every Phase 2 session-boundary handoff (`reseed`, S4/S3 below).
 * Turns within one session are pushed onto a live
 * `AsyncIterable<SDKUserMessage>` (`UserMessageQueue`) that the SDK reads
 * from -- this is the SDK's own streaming-input mechanism for a multi-turn
 * session on one `Query`, verified live against SDK 2.1.233 (see the design
 * doc and #1333's task notes).
 */

import {
  query,
  type Options,
  type Query,
  type SDKControlGetContextUsageResponse,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import {
  DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS,
  type EmbeddedAgentEvent,
  type EmbeddedAgentToolName,
} from '@agent-console/shared';
import type { Engine } from './engine-types.js';

type SystemInitMessage = Extract<SDKMessage, { type: 'system'; subtype: 'init' }>;
type ResultMessage = Extract<SDKMessage, { type: 'result' }>;
type ResultErrorMessage = Exclude<ResultMessage, { subtype: 'success' }>;
type StreamEvent = Extract<SDKMessage, { type: 'stream_event' }>['event'];
type AssistantMessagePayload = Extract<SDKMessage, { type: 'assistant' }>['message'];
type UserMessagePayload = Extract<SDKMessage, { type: 'user' }>['message'];
type ToolResultEvent = Extract<EmbeddedAgentEvent, { type: 'tool-result' }>;

/**
 * H2 (docs/design/embedded-agent-sdk-engine.md §5): calling `getContextUsage()`
 * immediately after a turn's `result` intermittently threw "ProcessTransport
 * is not ready for writing" -- an EMPIRICAL observation on SDK 0.3.226/0.3.233
 * (both-version confirmed), NOT a documented SDK contract. ~300-500ms of
 * settle reliably fixed it in the probe. Retry-with-settle, not a bare sleep:
 * the budget below (5 settle gaps at 500ms = 2500ms across 6 attempts)
 * comfortably exceeds both the observed 300-500ms window and the AC's
 * "at least 3 attempts spanning at least 2s total" floor. Re-verify this
 * constant pair on every SDK upgrade -- the SDK-bump tracking issue's
 * checklist carries this obligation (docs/design/embedded-agent-sdk-engine.md
 * §5's re-verification note).
 */
const CONTEXT_USAGE_SETTLE_DELAY_MS = 500;
const CONTEXT_USAGE_MAX_ATTEMPTS = 6;

/**
 * PS1 tripwire (docs/design/embedded-agent-sdk-engine.md §5): `settings.
 * autoCompactEnabled: false` is verified at small scale only -- a real
 * ~1M-token full-window compaction was outside the design probe's budget.
 * This constant does not PREVENT SDK-side compaction; it makes an
 * unverified-at-scale premise LOUD instead of silent. A drop of more than
 * this ratio between two consecutive context-usage polls, with no
 * intervening handoff (`reseed()` resets the baseline), is logged as a
 * possible violation of PS1.
 */
const MATERIAL_DROP_RATIO = 0.2;

/**
 * Streaming-input queue backing `query()`'s `prompt: AsyncIterable<SDKUserMessage>`.
 * A pushed message is delivered to the next waiting `stream()` consumer
 * immediately; otherwise it buffers until the consumer catches up. `close()`
 * signals end-of-stream once any already-queued items have drained -- unused
 * in Phase 1/2 (each live `Query` runs until `dispose()` or a handoff
 * reseed), kept for shutdown-path completeness.
 */
export class UserMessageQueue {
  private pending: SDKUserMessage[] = [];
  private waiter: ((msg: SDKUserMessage | null) => void) | null = null;
  private closed = false;

  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(msg);
    } else {
      this.pending.push(msg);
    }
  }

  /** Signals end-of-stream; the generator returns after any already-queued items drain. */
  close(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      if (this.pending.length > 0) {
        yield this.pending.shift()!;
        continue;
      }
      if (this.closed) return;
      const msg = await new Promise<SDKUserMessage | null>((resolve) => {
        this.waiter = resolve;
      });
      if (msg === null) return;
      yield msg;
    }
  }
}

/**
 * Custom spawn override, passed as `Options.spawnClaudeCodeProcess`. Every
 * spawn of the actual `claude` CLI binary goes through this single function
 * (Reservation 1, docs/design/embedded-agent-sdk-engine.md §4 "Process
 * lifetime" row) -- a later idle-eviction phase has exactly one interception
 * point. We are ALREADY running as the correct OS user here: the outer
 * `spawnAsUser` elevation happened one layer up, in
 * embedded-agent-worker-service.ts, before this subprocess's own main.ts even
 * started -- this inner spawn needs no privilege elevation of its own. Node's
 * `ChildProcess` already satisfies `SpawnedProcess` structurally (stdin/stdout
 * streams, killed/exitCode/signalCode getters, on/once/off('exit'|'error',
 * ...), kill(signal)), so no adapter is needed.
 */
export function spawnClaudeCodeProcess(options: SpawnOptions): SpawnedProcess {
  return spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface SdkEngineDeps {
  cwd: string;
  model: string;
  /** Definition/init `systemPrompt`, appended to the SDK's own default preset. */
  systemPromptAppend?: string;
  enabledTools?: EmbeddedAgentToolName[];
  mcp: { baseUrl: string; token: string };
  emit: (event: EmbeddedAgentEvent) => void;
  /** Context Handoff (Phase 2, S3): loads the (possibly operator-overridden)
   * distillation prompt -- the SAME `factories.loadHandoffPrompt` the
   * native-loop engine uses (main.ts is the single writer that composes this
   * from the raw factory; see main.ts's `claude-sdk` init arm). */
  loadHandoffPrompt: () => Promise<string>;
  /** DI seam for tests; defaults to the real SDK `query` function. */
  queryFn?: typeof query;
  /** DI seam for tests: the H2 retry-with-settle delay. Defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** Outcome of one distillation turn (S3's "distill" step). */
type DistillationOutcome = { ok: true; text: string } | { ok: false; reason: string };

/**
 * The claude-sdk engine. See the module header for the overall shape; see
 * docs/design/embedded-agent-sdk-engine.md Appendix A for the per-event
 * mapping this class implements in `handleMessage` and its helpers.
 */
export class SdkEngine implements Engine {
  private readonly deps: SdkEngineDeps;
  private readonly queryFn: typeof query;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly enabledToolNames: EmbeddedAgentToolName[];
  private readonly allowedToolNames: Set<string>;
  /** S3: the ORIGINAL (Phase 1's composeSdkSystemPromptAppend output)
   * systemPrompt.append, fixed at construction. Every reseed composes THIS
   * (never a previously-reseeded value) plus the latest distillation --
   * "the original composed append ... plus the distillation", per the AC. */
  private readonly originalSystemPromptAppend: string | undefined;

  private queue = new UserMessageQueue();
  private query: Query;
  /** S4: bumped on every reseed. A `consumeLoop` invocation captures its own
   * query's generation at start; when its stream ends, a generation mismatch
   * means a NEWER query has since superseded it (an expected clean end, not
   * "the process died unexpectedly"). See `reseed` and `consumeLoop`. */
  private queryGeneration = 0;

  private currentTurnId: string | null = null;
  private iterationText = '';
  private currentTurnDeferred: { resolve: () => void } | null = null;
  private dead = false;

  /** S3: 'distillation' while the handoff's own internal turn is in flight --
   * suppresses the normal per-turn wire events (assistant-delta/-message,
   * tool-call/-result) so the distillation prompt/response never reaches the
   * client as an ordinary turn (matches the native engine's `emitDeltas:
   * false` -- see agent-loop.ts's `handoff()` doc comment for the "dangling
   * assistant-message bubble" this prevents). */
  private turnMode: 'normal' | 'distillation' = 'normal';
  private distillationText = '';
  private distillationSawToolCall = false;
  private distillationDeferred: { resolve: (outcome: DistillationOutcome) => void } | null = null;

  /** S2: previous poll's usable totalTokens, for the PS1 material-drop
   * tripwire. `null` = no baseline yet (fresh session or just-reseeded). */
  private previousTotalTokens: number | null = null;

  /**
   * Ordering guard for the tool-call/tool-result race (see this file's
   * `handleAssistantMessage` / `handleUserMessage` doc comments): callIds
   * whose `tool-call` has already been emitted, and `tool_result`-shaped
   * events queued for a callId whose `tool-call` has NOT been emitted yet.
   * callIds are unique for the engine's whole lifetime (never reused across
   * turns), so neither structure is reset per-turn -- only drained.
   */
  private readonly emittedCallIds = new Set<string>();
  private readonly pendingToolResults = new Map<string, ToolResultEvent[]>();

  constructor(deps: SdkEngineDeps) {
    this.deps = deps;
    this.queryFn = deps.queryFn ?? query;
    this.sleep = deps.sleep ?? defaultSleep;
    const enabledToolNames = deps.enabledTools ?? DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS;
    this.enabledToolNames = [...enabledToolNames];
    this.allowedToolNames = new Set(enabledToolNames);
    this.originalSystemPromptAppend = deps.systemPromptAppend;

    // Exactly ONE production call site for the SDK's query() function --
    // this is both the DI seam Pin 1(a) exercises and the grep-containment
    // target Pin 1(b) verifies (see __tests__/sdk-engine.test.ts). `reseed`
    // below is the second (and only other) production call site.
    this.query = this.queryFn({ prompt: this.queue.stream(), options: this.buildOptions(deps.systemPromptAppend) });

    // Start the background stream consumer (detached, fire-and-forget)
    // BEFORE emitting `ready`, then emit `ready` synchronously -- NOT gated
    // on the SDK's own system:init handshake. A live probe against SDK
    // 2.1.233 found system:init does not arrive until the FIRST prompt is
    // yielded on the streaming-input generator (zero events of any kind
    // while the queue is empty, not even a spawn signal); gating `ready` on
    // it would deadlock every worker with no initial prompt queued at
    // activation. Consulted with the Architect, 2026-08-17: ready is
    // decoupled from system:init by design -- see
    // docs/design/embedded-agent-sdk-engine.md Appendix A.2, the `ready`
    // row's correction trail.
    void this.consumeLoop(this.query, this.queryGeneration);
    this.deps.emit({ v: 1, type: 'ready' });
  }

  /**
   * Builds the `query()` Options battery. Used by BOTH the constructor
   * (initial construction) and `reseed` (S3's handoff successor) -- S3
   * requires every Phase 1 pin (no `resume`, allowlist `tools`,
   * `spawnClaudeCodeProcess`, `settingSources: []`, `autoCompactEnabled:
   * false`, no `apiKey`) to hold on the reseed options too. A second
   * hand-rolled options object is exactly the drift vector this single
   * builder exists to kill.
   */
  private buildOptions(systemPromptAppend: string | undefined): Options {
    return {
      executable: 'bun',
      cwd: this.deps.cwd,
      model: this.deps.model,
      tools: [...this.enabledToolNames],
      mcpServers: {
        'agent-console': {
          type: 'http',
          url: this.deps.mcp.baseUrl,
          headers: { Authorization: `Bearer ${this.deps.mcp.token}` },
          alwaysLoad: true,
        },
      },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      settingSources: [],
      settings: { autoCompactEnabled: false },
      spawnClaudeCodeProcess,
      ...(systemPromptAppend !== undefined
        ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: systemPromptAppend } }
        : {}),
    };
  }

  async runTurn(id: string, text: string): Promise<void> {
    if (this.dead) {
      this.deps.emit({
        v: 1,
        type: 'fatal',
        message: 'SDK engine session already terminated; cannot start a new turn',
      });
      return;
    }
    this.currentTurnId = id;
    this.iterationText = '';
    this.deps.emit({ v: 1, type: 'state', state: 'active' });
    return new Promise<void>((resolve) => {
      this.currentTurnDeferred = { resolve };
      this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    });
  }

  cancel(): void {
    if (this.dead) return;
    void this.query.interrupt().catch(() => {
      // Best-effort: the pending turn's eventual settlement happens via the
      // `result` message the interrupt triggers (or, on transport failure,
      // via the consumer loop's fatal path) -- nothing further to do here.
    });
  }

  /**
   * Context Handoff (Phase 2, docs/design/embedded-agent-sdk-engine.md §4
   * "Context handoff" row / S3): distill the CURRENT session's conversation
   * into a summary (a turn on the live query, wire-suppressed -- see
   * `turnMode`), emit the `context-handoff` marker, then terminate the old
   * SDK session and seed a successor via `reseed`. Brackets `state: active
   * -> idle` exactly once per call, matching the native engine's handoff
   * (agent-loop.ts) and S3's "no second `ready`" requirement -- `ready` is
   * construction-time only and is never re-emitted here.
   *
   * Handoff during an active turn: main.ts's dispatch loop already rejects a
   * `handoff` command while `turnActive` is true (same gate `user-message`
   * is subject to), so this method is never invoked concurrently with
   * `runTurn` -- the native engine is gated identically at the same layer.
   * This engine adds no additional concurrency handling because none is
   * needed.
   */
  async handoff(): Promise<void> {
    if (this.dead) {
      this.deps.emit({
        v: 1,
        type: 'fatal',
        message: 'SDK engine session already terminated; cannot start a handoff',
      });
      return;
    }
    this.deps.emit({ v: 1, type: 'state', state: 'active' });

    let promptText: string;
    try {
      promptText = await this.deps.loadHandoffPrompt();
    } catch (err) {
      this.emitHandoffFailure(`failed to load handoff prompt: ${errorMessage(err)}`);
      return;
    }

    const outcome = await this.runDistillationTurn(promptText);

    // S1: "once after each handoff attempt", regardless of outcome --
    // measured on the OLD (still-current) query, which is the semantically
    // meaningful measurement (how much context the handoff is relieving).
    await this.pollContextUsage();
    if (this.dead) {
      // pollContextUsage's H2-exhaustion path already emitted `fatal` and
      // disposed the (about-to-be-replaced) old query -- do not proceed to
      // reseed on top of a session the engine has already declared dead.
      return;
    }

    if (!outcome.ok) {
      this.emitHandoffFailure(`Context handoff failed: ${outcome.reason}`);
      return;
    }

    this.deps.emit({ v: 1, type: 'context-handoff', distillation: outcome.text });
    this.reseed(outcome.text);
    this.deps.emit({ v: 1, type: 'state', state: 'idle' });
  }

  private emitHandoffFailure(message: string): void {
    this.deps.emit({ v: 1, type: 'turn-error', turnId: crypto.randomUUID(), message });
    this.deps.emit({ v: 1, type: 'state', state: 'idle' });
  }

  /** Runs the handoff distillation prompt as a turn on the CURRENT (still
   * live) query, capturing the resulting text instead of streaming it to the
   * client (`turnMode`). No tool calls are expected; if the SDK issues any
   * anyway, the outcome is a failure -- mirrors the native engine's
   * "tool-call-only response has nothing usable to seed with" rejection. */
  private async runDistillationTurn(promptText: string): Promise<DistillationOutcome> {
    this.turnMode = 'distillation';
    this.distillationText = '';
    this.distillationSawToolCall = false;
    this.currentTurnId = crypto.randomUUID();
    return new Promise<DistillationOutcome>((resolve) => {
      this.distillationDeferred = { resolve };
      this.queue.push({ type: 'user', message: { role: 'user', content: promptText }, parent_tool_use_id: null });
    });
  }

  private settleDistillation(message: ResultMessage): void {
    const deferred = this.distillationDeferred;
    this.distillationDeferred = null;
    this.turnMode = 'normal';
    if (!deferred) return;
    if (message.subtype !== 'success') {
      deferred.resolve({ ok: false, reason: this.buildTurnErrorMessage(message) });
      return;
    }
    if (this.distillationSawToolCall || this.distillationText.trim().length === 0) {
      deferred.resolve({ ok: false, reason: 'provider returned no usable distillation' });
      return;
    }
    deferred.resolve({ ok: true, text: this.distillationText });
  }

  /**
   * S3/S4: terminates the current SDK query and constructs a successor on a
   * FRESH session id (never `resume` -- PS4 is gated everywhere, §6). The
   * successor's `systemPrompt.append` is the ORIGINAL composed append (never
   * a previously-reseeded one) plus the latest distillation, original first
   * -- matching PS3's probe-verified mechanism. Bumps `queryGeneration`
   * BEFORE constructing the new query so the OLD query's `consumeLoop`, when
   * its stream ends as a direct result of `close()` below, recognizes itself
   * as superseded rather than emitting a spurious fatal (S4).
   */
  private reseed(distillation: string): void {
    try {
      this.query.close();
    } catch {
      // Already closed / never fully started -- nothing more to release.
    }
    // No `await` between close() and the generation bump: the old
    // `consumeLoop`'s `for await` can only observe the stream ending on a
    // LATER microtask/macrotask, by which point `queryGeneration` must
    // already reflect the successor.
    this.queryGeneration++;

    const appendParts = [this.originalSystemPromptAppend, distillation].filter(
      (part): part is string => part !== undefined && part.length > 0,
    );
    const systemPromptAppend = appendParts.length > 0 ? appendParts.join('\n\n') : undefined;

    this.queue = new UserMessageQueue();
    this.query = this.queryFn({ prompt: this.queue.stream(), options: this.buildOptions(systemPromptAppend) });
    // An intentional handoff-driven drop in context usage must never itself
    // trip the PS1 material-drop tripwire (S2) -- the next usable poll
    // becomes the new baseline with nothing to compare against.
    this.previousTotalTokens = null;

    void this.consumeLoop(this.query, this.queryGeneration);
  }

  /** Closes the underlying SDK query, which terminates its child `claude`
   * process -- otherwise it leaks when our own process exits (no OS
   * process-group magic guarantees the child dies with us). Marks the engine
   * dead BEFORE calling `close()`: `close()` causes `consumeLoop`'s `for
   * await` to end (a deliberate shutdown, not an unexpected one), and
   * `handleFatal`'s early-return guard on `this.dead` relies on this
   * ordering to distinguish that from the genuinely-unexpected clean-end
   * case `consumeLoop` guards against below. */
  dispose(): void {
    this.dead = true;
    try {
      this.query.close();
    } catch {
      // Already closed / never fully started -- nothing more to release.
    }
  }

  /**
   * `query`/`generation` are captured PARAMETERS, not read from `this.query`
   * /`this.queryGeneration`, so a loop started for an OLD query keeps
   * comparing against the value it was born with even after `reseed` moves
   * `this.query`/bumps `this.queryGeneration` out from under it (S4).
   */
  private async consumeLoop(activeQuery: Query, generation: number): Promise<void> {
    try {
      for await (const message of activeQuery) {
        await this.handleMessage(message);
        if (this.dead) break;
      }
      if (generation !== this.queryGeneration) {
        // This query was superseded by a handoff reseed before its own
        // stream ended -- an EXPECTED clean end (S4), not the "process died
        // unexpectedly" case the fatal below guards against.
        return;
      }
      // The `for await` loop exited WITHOUT throwing -- the SDK's message
      // stream ended cleanly. Outside of a deliberate `dispose()` (which
      // already set `this.dead = true` before triggering this) or a
      // superseding reseed (handled above), this is unexpected: the child
      // `claude` process exited, or the SDK ended the stream, with no
      // `result` message ever settling the pending turn. Treat it exactly
      // like the throwing case below -- `handleFatal`'s own `if (this.dead)
      // return;` guard makes this a no-op on the deliberate `dispose()` path.
      this.handleFatal('SDK message stream ended unexpectedly');
    } catch (err) {
      if (generation !== this.queryGeneration) return;
      this.handleFatal(`SDK transport error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleMessage(message: SDKMessage): Promise<void> {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') this.handleSystemInit(message);
        return;
      case 'stream_event':
        this.handleStreamEvent(message.event);
        return;
      case 'assistant':
        this.handleAssistantMessage(message.message);
        return;
      case 'user':
        this.handleUserMessage(message.message);
        return;
      case 'result':
        await this.handleResult(message);
        return;
      default:
        // Every other SDKMessage type (rate_limit_event, hook/task/
        // notification/etc. system subtypes, ...) has no native counterpart
        // in Phase 1/2 -- ignored silently per Appendix A's coverage note.
        return;
    }
  }

  /**
   * `sdk-session-id` is emitted on every occurrence of this message (it
   * recurs across turns on the same live session, AND on the successor
   * session after a handoff reseed -- last-write-wins is the contract; see
   * packages/shared/src/types/embedded-agent.ts's doc comment on the event).
   * Pin 2 (S5, #1333 AC) containment ALSO runs here, live, on every
   * occurrence -- not only in a unit test -- per the Architect's ruling: a
   * session holding tools we intended to deny must be terminated, not merely
   * flagged. Because system:init cannot arrive before the first prompt is in
   * flight (the same finding that decouples `ready`), this check necessarily
   * runs CONCURRENT WITH the first turn: a violating session may have
   * already started (or even completed) processing before the fatal-
   * terminate below fires. This is an accepted residual -- a few hundred ms
   * of the forbidden tool being nominally "available" before we notice and
   * kill the session -- not a design gap.
   */
  private handleSystemInit(message: SystemInitMessage): void {
    this.deps.emit({ v: 1, type: 'sdk-session-id', sdkSessionId: message.session_id });

    // Account-level MCP connectors are NOT governed by this containment
    // check (docs/design/embedded-agent-sdk-engine.md §4.1) -- only the
    // SDK's own withheld BUILTIN tools (WebFetch/WebSearch/Task) are.
    const reportedNonMcp = message.tools.filter((name) => !name.startsWith('mcp__'));
    const leaked = reportedNonMcp.filter((name) => !this.allowedToolNames.has(name));
    if (leaked.length > 0) {
      this.handleFatal(
        `SDK session reported disallowed tool(s) outside the containment allowlist: ${leaked.join(', ')}`,
      );
    }
  }

  private handleStreamEvent(event: StreamEvent): void {
    if (event.type === 'content_block_delta') {
      const { delta } = event;
      if (delta.type === 'text_delta') {
        this.iterationText += delta.text;
        if (this.turnMode === 'normal') {
          this.deps.emit({ v: 1, type: 'assistant-delta', turnId: this.requireTurnId(), text: delta.text });
        }
      } else if (delta.type === 'thinking_delta') {
        if (this.turnMode === 'normal') {
          this.deps.emit({
            v: 1,
            type: 'assistant-thinking-delta',
            turnId: this.requireTurnId(),
            text: delta.thinking,
          });
        }
      }
      // input_json_delta (partial tool-call-argument JSON) and other delta
      // kinds: no native counterpart -- ignored.
      return;
    }
    if (event.type === 'message_stop') {
      this.emitAssistantMessage();
      return;
    }
    // message_start, content_block_start, content_block_stop, message_delta:
    // no mapping needed.
  }

  /** Emits the completed iteration's assistant-message at `message_stop`, or
   * (during a handoff's distillation turn -- `turnMode`) accumulates it into
   * `distillationText` instead of emitting anything on the wire, so the
   * client never sees a stray assistant bubble for the internal distillation
   * prompt (matches the native engine's `emitDeltas: false` intent -- see
   * agent-loop.ts's `handoff()`). Tool calls are NOT buffered here -- they
   * are emitted immediately as they are observed, in `handleAssistantMessage`
   * below. (A prior version of this engine buffered `tool_use` blocks and
   * flushed them here, after the assistant-message emit, to match the native
   * engine's emission order. A live run found the SDK's own `tool_result`
   * echo can arrive on the wire BEFORE the buffered `tool-call` it belongs
   * to -- e.g. for a fast tool like Glob -- producing an unknown-callId
   * `tool-result` client-side. See `handleAssistantMessage`'s doc comment and
   * docs/design/embedded-agent-sdk-engine.md Appendix A's `tool-call` row
   * correction trail for the full account.) */
  private emitAssistantMessage(): void {
    if (this.turnMode === 'distillation') {
      this.distillationText += this.iterationText;
      this.iterationText = '';
      return;
    }
    const turnId = this.requireTurnId();
    // Always emit the assistant message, even when the text is empty --
    // matches the native engine's "always emit" contract (e.g. a
    // tool-only response with no text still needs this event).
    this.deps.emit({ v: 1, type: 'assistant-message', turnId, text: this.iterationText });
    this.iterationText = '';
  }

  /**
   * `assistant` SDKMessages arrive one per COMPLETED content block (not one
   * per whole API response) -- text content blocks are ignored here since
   * the delta stream already emitted them.
   *
   * `tool_use` blocks are complete and fully-formed on this message (never a
   * partial/streaming form), so `tool-call` is emitted immediately here
   * rather than buffered until `message_stop` -- this may now arrive before
   * (or, for a fast tool, even after) the iteration's own `assistant-message`
   * event, which is an accepted, harmless ordering nuance for downstream
   * consumers. Immediate emission is also the guard's flush trigger: any
   * `tool-result` that arrived earlier for this exact callId (queued by
   * `handleUserMessage` below because its `tool-call` had not been emitted
   * yet) is flushed right after.
   *
   * During a handoff's distillation turn (`turnMode`), a tool_use block is
   * NOT expected -- the SDK still executes it internally regardless of
   * whether we surface it, so this only records that it happened (for
   * `settleDistillation`'s failure classification) and emits nothing.
   */
  private handleAssistantMessage(message: AssistantMessagePayload): void {
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        if (this.turnMode === 'distillation') {
          this.distillationSawToolCall = true;
          continue;
        }
        this.emitToolCall(block.id, block.name, block.input);
      }
    }
  }

  private emitToolCall(callId: string, name: string, args: unknown): void {
    this.deps.emit({ v: 1, type: 'tool-call', turnId: this.requireTurnId(), callId, name, args });
    this.emittedCallIds.add(callId);
    const queued = this.pendingToolResults.get(callId);
    if (!queued) return;
    this.pendingToolResults.delete(callId);
    for (const event of queued) this.deps.emit(event);
  }

  /**
   * SDK-synthesized tool-result echoes (and the post-interrupt marker, which
   * carries a bare `text` block that maps to nothing here -- the
   * accompanying `result` message is what surfaces as `turn-error`).
   *
   * A `tool_result` for a callId whose `tool-call` has already been emitted
   * (the common case) is emitted immediately, same as before. A `tool_result`
   * for a callId whose `tool-call` has NOT been emitted yet -- the ordering
   * race this method's doc-comment neighbor exists to guard against -- is
   * held in `pendingToolResults` instead of emitted, and flushed by
   * `emitToolCall` the moment that callId's `tool-call` does go out. Any
   * result still queued when the turn ends (`handleResult`) is emitted
   * anyway, with a loud warning, rather than silently dropped.
   *
   * During a handoff's distillation turn (`turnMode`), no tool call is
   * expected to have been emitted in the first place (see
   * `handleAssistantMessage`), so any `tool_result` echo here is silently
   * ignored -- there is no callId for it to correlate with on the wire.
   */
  private handleUserMessage(message: UserMessagePayload): void {
    if (this.turnMode === 'distillation') return;
    const { content } = message;
    if (typeof content === 'string') return;
    for (const block of content) {
      if (block.type === 'tool_result') {
        const resultText =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        const event: ToolResultEvent = {
          v: 1,
          type: 'tool-result',
          turnId: this.requireTurnId(),
          callId: block.tool_use_id,
          ok: block.is_error !== true,
          result: resultText,
        };
        if (this.emittedCallIds.has(block.tool_use_id)) {
          this.deps.emit(event);
        } else {
          const queue = this.pendingToolResults.get(block.tool_use_id) ?? [];
          queue.push(event);
          this.pendingToolResults.set(block.tool_use_id, queue);
        }
      }
    }
  }

  /** The turn's terminal signal: success emits no `turn-error` (matches
   * native); every error subtype maps to a labeled `turn-error` message.
   * Any `tool-result` still queued at this point never saw its `tool-call`
   * arrive during the turn -- a genuinely pathological case -- and is
   * flushed here anyway (loudly logged) rather than dropped. During a
   * handoff's distillation turn (`turnMode`), settles the distillation
   * promise instead of the normal per-turn machinery -- see
   * `settleDistillation`. Otherwise: polls context usage (S1), emits
   * `state: idle`, and settles the pending turn. */
  private async handleResult(message: ResultMessage): Promise<void> {
    const turnId = this.requireTurnId();
    this.flushOrphanedToolResults(turnId);

    if (this.turnMode === 'distillation') {
      this.settleDistillation(message);
      return;
    }

    await this.pollContextUsage();
    if (this.dead) {
      // pollContextUsage's H2-exhaustion path already emitted `fatal`,
      // disposed the query, and settled the pending turn -- do not also
      // emit a spurious turn-error/state:idle on top of it.
      return;
    }
    if (message.subtype !== 'success') {
      this.deps.emit({ v: 1, type: 'turn-error', turnId, message: this.buildTurnErrorMessage(message) });
    }
    this.deps.emit({ v: 1, type: 'state', state: 'idle' });
    this.settlePendingTurn();
  }

  private flushOrphanedToolResults(turnId: string): void {
    if (this.pendingToolResults.size === 0) return;
    for (const [callId, events] of this.pendingToolResults) {
      console.warn(
        `[sdk-engine] tool-result for callId=${callId} arrived but its tool-call was never observed before turn end (turnId=${turnId}); emitting anyway`,
      );
      for (const event of events) this.deps.emit(event);
    }
    this.pendingToolResults.clear();
  }

  private buildTurnErrorMessage(message: ResultErrorMessage): string {
    switch (message.subtype) {
      case 'error_during_execution':
        // Also the subtype `interrupt()` produces (confirmed live:
        // `terminal_reason: 'aborted_streaming'` on this subtype after a
        // cancel) -- cancel and genuine execution error are not
        // special-cased separately.
        return `SDK turn failed: ${message.errors.join('; ') || 'execution error'}`;
      case 'error_max_turns':
        return 'SDK turn ended: maximum turns reached';
      case 'error_max_budget_usd':
        return 'SDK turn ended: budget exceeded';
      case 'error_max_structured_output_retries':
        return 'SDK turn ended: structured-output retries exhausted';
    }
  }

  private requireTurnId(): string {
    return this.currentTurnId ?? '';
  }

  private settlePendingTurn(): void {
    if (this.currentTurnDeferred) {
      const { resolve } = this.currentTurnDeferred;
      this.currentTurnDeferred = null;
      resolve();
    }
  }

  /**
   * S1/H2: polls `getContextUsage()` with retry-with-settle. A THROW from
   * the call is the H2 race (or a genuine transport failure -- the two are
   * indistinguishable from here, which is why exhaustion is treated as
   * fatal rather than silently swallowed: a transport that never settles is
   * a wedged session, and the next turn would fail anyway). A RESOLVED but
   * unusable response (missing/non-finite `totalTokens`) is a different
   * failure mode -- skip-with-warn, not fatal, and not retried (the call
   * itself succeeded; retrying would not change a structurally-absent
   * field).
   */
  private async pollContextUsage(): Promise<void> {
    for (let attempt = 1; attempt <= CONTEXT_USAGE_MAX_ATTEMPTS; attempt++) {
      let response: SDKControlGetContextUsageResponse;
      try {
        response = await this.query.getContextUsage();
      } catch (err) {
        if (attempt === CONTEXT_USAGE_MAX_ATTEMPTS) {
          this.handleFatal(
            `SDK transport did not settle for getContextUsage() after ${CONTEXT_USAGE_MAX_ATTEMPTS} attempts (H2, docs/design/embedded-agent-sdk-engine.md §5): ${errorMessage(err)}`,
          );
          return;
        }
        await this.sleep(CONTEXT_USAGE_SETTLE_DELAY_MS);
        continue;
      }
      this.emitContextUsageIfUsable(response);
      return;
    }
  }

  private emitContextUsageIfUsable(response: SDKControlGetContextUsageResponse): void {
    const totalTokens = response?.totalTokens;
    if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens)) {
      console.warn(
        '[sdk-engine] getContextUsage() resolved without a usable totalTokens field; skipping context-usage emit',
      );
      return;
    }
    this.checkForMaterialDrop(totalTokens);
    this.deps.emit({ v: 1, type: 'context-usage', promptTokens: totalTokens, estimated: false });
    this.previousTotalTokens = totalTokens;
  }

  /** S2's PS1 tripwire: see this file's `MATERIAL_DROP_RATIO` doc comment. */
  private checkForMaterialDrop(totalTokens: number): void {
    if (
      this.previousTotalTokens !== null &&
      totalTokens < this.previousTotalTokens * (1 - MATERIAL_DROP_RATIO)
    ) {
      console.warn(
        `[sdk-engine] PS1 tripwire: totalTokens dropped from ${this.previousTotalTokens} to ${totalTokens} ` +
          `(>${MATERIAL_DROP_RATIO * 100}% drop) with no intervening handoff -- possible SDK-side compaction ` +
          'despite autoCompactEnabled:false (docs/design/embedded-agent-sdk-engine.md §5 PS1)',
      );
    }
  }

  /**
   * Reused by both the consumer-loop-crash path (transport/process failure)
   * and the Pin 2 containment violation: emits `fatal`, disposes the
   * underlying SDK query/subprocess, marks the engine dead so a LATER
   * `runTurn` fails loudly instead of hanging, and settles any pending turn
   * (resolve, not reject -- mirrors how a `turn-error` always still
   * resolves the caller's promise; the `fatal` event is what tells the
   * client something is actually wrong). Idempotent.
   */
  private handleFatal(message: string): void {
    if (this.dead) return;
    this.dead = true;
    this.deps.emit({ v: 1, type: 'fatal', message });
    this.dispose();
    this.settlePendingTurn();
  }
}
