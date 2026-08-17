/**
 * The claude-sdk engine (docs/design/embedded-agent-sdk-engine.md): hosts a
 * Claude Agent SDK session inside the same subprocess harness the
 * native-loop engine (agent-loop.ts) runs in, mapping the SDK's own message
 * stream onto the SAME NDJSON event vocabulary the native engine emits (see
 * that document's Appendix A for the authoritative mapping table this file
 * implements).
 *
 * `query()` is called exactly ONCE per engine lifetime, in the constructor.
 * Subsequent user turns are pushed onto a live `AsyncIterable<SDKUserMessage>`
 * (`UserMessageQueue`) that the SDK reads from -- this is the SDK's own
 * streaming-input mechanism for a multi-turn session on one `Query`, verified
 * live against SDK 2.1.233 (see the design doc and #1333's task notes).
 */

import { query, type Options, type Query, type SDKMessage, type SDKUserMessage, type SpawnedProcess, type SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
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
 * Streaming-input queue backing `query()`'s `prompt: AsyncIterable<SDKUserMessage>`.
 * A pushed message is delivered to the next waiting `stream()` consumer
 * immediately; otherwise it buffers until the consumer catches up. `close()`
 * signals end-of-stream once any already-queued items have drained -- unused
 * in Phase 1 (the engine's `Query` lives for the subprocess's whole life),
 * kept for shutdown-path completeness.
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

export interface SdkEngineDeps {
  cwd: string;
  model: string;
  /** Definition/init `systemPrompt`, appended to the SDK's own default preset. */
  systemPromptAppend?: string;
  enabledTools?: EmbeddedAgentToolName[];
  mcp: { baseUrl: string; token: string };
  emit: (event: EmbeddedAgentEvent) => void;
  /** DI seam for tests; defaults to the real SDK `query` function. */
  queryFn?: typeof query;
}

/**
 * The claude-sdk engine. See the module header for the overall shape; see
 * docs/design/embedded-agent-sdk-engine.md Appendix A for the per-event
 * mapping this class implements in `handleMessage` and its helpers.
 */
export class SdkEngine implements Engine {
  private readonly deps: SdkEngineDeps;
  private readonly queryFn: typeof query;
  private readonly queue = new UserMessageQueue();
  private readonly allowedToolNames: Set<string>;
  private readonly query: Query;

  private currentTurnId: string | null = null;
  private iterationText = '';
  private currentTurnDeferred: { resolve: () => void } | null = null;
  private dead = false;

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
    const enabledToolNames = deps.enabledTools ?? DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS;
    this.allowedToolNames = new Set(enabledToolNames);

    const options: Options = {
      executable: 'bun',
      cwd: deps.cwd,
      model: deps.model,
      tools: [...enabledToolNames],
      mcpServers: {
        'agent-console': {
          type: 'http',
          url: deps.mcp.baseUrl,
          headers: { Authorization: `Bearer ${deps.mcp.token}` },
          alwaysLoad: true,
        },
      },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      settingSources: [],
      settings: { autoCompactEnabled: false },
      spawnClaudeCodeProcess,
      ...(deps.systemPromptAppend !== undefined
        ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: deps.systemPromptAppend } }
        : {}),
    };

    // Exactly ONE production call site for the SDK's query() function --
    // this is both the DI seam Pin 1(a) exercises and the grep-containment
    // target Pin 1(b) verifies (see __tests__/sdk-engine.test.ts).
    this.query = this.queryFn({ prompt: this.queue.stream(), options });

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
    void this.consumeLoop();
    this.deps.emit({ v: 1, type: 'ready' });
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
   * Context Handoff (Phase 2, out of scope for Phase 1): graceful
   * not-yet-supported stub. Emits the same active/idle bracket a real
   * handoff would, with a turn-error explaining the gap, rather than
   * throwing (main.ts's dispatch wraps `loop.handoff()` in `.catch`
   * already, but a clean graceful-reject is better UX than an
   * unhandled-shape crash).
   */
  async handoff(): Promise<void> {
    this.deps.emit({ v: 1, type: 'state', state: 'active' });
    this.deps.emit({
      v: 1,
      type: 'turn-error',
      turnId: crypto.randomUUID(),
      message: 'Context handoff is not yet supported for the SDK engine (Phase 2).',
    });
    this.deps.emit({ v: 1, type: 'state', state: 'idle' });
  }

  /** Closes the underlying SDK query, which terminates its child `claude`
   * process -- otherwise it leaks when our own process exits (no OS
   * process-group magic guarantees the child dies with us). */
  dispose(): void {
    try {
      this.query.close();
    } catch {
      // Already closed / never fully started -- nothing more to release.
    }
  }

  private async consumeLoop(): Promise<void> {
    try {
      for await (const message of this.query) {
        this.handleMessage(message);
        if (this.dead) break;
      }
    } catch (err) {
      this.handleFatal(`SDK transport error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private handleMessage(message: SDKMessage): void {
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
        this.handleResult(message);
        return;
      default:
        // Every other SDKMessage type (rate_limit_event, hook/task/
        // notification/etc. system subtypes, ...) has no native counterpart
        // in Phase 1 -- ignored silently per Appendix A's coverage note.
        return;
    }
  }

  /**
   * `sdk-session-id` is emitted on every occurrence of this message (it
   * recurs across turns on the same live session -- last-write-wins is the
   * contract; see packages/shared/src/types/embedded-agent.ts's doc comment
   * on the event). Pin 2 (S5, #1333 AC) containment ALSO runs here, live,
   * on every occurrence -- not only in a unit test -- per the Architect's
   * ruling: a session holding tools we intended to deny must be terminated,
   * not merely flagged. Because system:init cannot arrive before the first
   * prompt is in flight (the same finding that decouples `ready`), this
   * check necessarily runs CONCURRENT WITH the first turn: a violating
   * session may have already started (or even completed) processing before
   * the fatal-terminate below fires. This is an accepted residual -- a few
   * hundred ms of the forbidden tool being nominally "available" before we
   * notice and kill the session -- not a design gap.
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
        this.deps.emit({ v: 1, type: 'assistant-delta', turnId: this.requireTurnId(), text: delta.text });
      } else if (delta.type === 'thinking_delta') {
        this.deps.emit({
          v: 1,
          type: 'assistant-thinking-delta',
          turnId: this.requireTurnId(),
          text: delta.thinking,
        });
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

  /** Emits the completed iteration's assistant-message at `message_stop`.
   * Tool calls are NOT buffered here -- they are emitted immediately as they
   * are observed, in `handleAssistantMessage` below. (A prior version of this
   * engine buffered `tool_use` blocks and flushed them here, after the
   * assistant-message emit, to match the native engine's emission order. A
   * live run found the SDK's own `tool_result` echo can arrive on the wire
   * BEFORE the buffered `tool-call` it belongs to -- e.g. for a fast tool
   * like Glob -- producing an unknown-callId `tool-result` client-side. See
   * `handleAssistantMessage`'s doc comment and
   * docs/design/embedded-agent-sdk-engine.md Appendix A's `tool-call` row
   * correction trail for the full account.) */
  private emitAssistantMessage(): void {
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
   */
  private handleAssistantMessage(message: AssistantMessagePayload): void {
    for (const block of message.content) {
      if (block.type === 'tool_use') {
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
   */
  private handleUserMessage(message: UserMessagePayload): void {
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
   * flushed here anyway (loudly logged) rather than dropped. Either way,
   * emits `state: idle` and settles the pending turn. */
  private handleResult(message: ResultMessage): void {
    const turnId = this.requireTurnId();
    this.flushOrphanedToolResults(turnId);
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
