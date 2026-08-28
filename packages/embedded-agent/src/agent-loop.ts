/**
 * The embedded-agent turn cycle.
 *
 * Owns the in-memory conversation and drives one user turn: stream provider
 * output, emit structured events, execute tool calls through the MCP executor,
 * feed results back, and repeat until the model stops calling tools (or a cap /
 * error / cancel ends the turn). Provider failures retry with backoff; the
 * conversation stays usable after a turn-error so the next user message can
 * continue.
 */

import { DEFAULT_COMPACTION_THRESHOLD, type EmbeddedAgentEvent } from '@agent-console/shared';
import type { ToolExecutor } from './mcp.js';
import {
  ProviderError,
  type ChatMessage,
  type ProviderAdapter,
  type ToolCall,
  type ToolDefinition,
} from './providers/types.js';
import { truncateToBytes } from './truncate.js';
import { buildCompactionSeedMessages } from './conversation-seed.js';
import {
  COMPACT_TOOL_NAME,
  COMPACT_TOOL_SCHEDULED_RESULT,
  compactToolDefinition,
} from './compact-tool.js';
import { pushSyntheticToolError } from './tool-call-repair.js';

const TOOL_RESULT_MAX_BYTES = 16384;
/**
 * Cap for the assistant-message text and tool-call args on the wire. Well below
 * the server's 1 MiB per-line protocol-integrity kill, so a healthy long
 * assistant output or a large tool-call argument never trips that guard.
 */
const WIRE_EVENT_MAX_BYTES = 262144;
const DEFAULT_RETRY_DELAYS_MS: [number, number] = [500, 2000];
const MAX_PROVIDER_ATTEMPTS = 3;
const MAX_MALFORMED_REASKS = 2;

export interface AgentLoopDeps {
  adapter: ProviderAdapter;
  model: string;
  tools: ToolDefinition[];
  executor: ToolExecutor;
  emit: (event: EmbeddedAgentEvent) => void;
  systemPrompt: string;
  maxToolIterations: number;
  retryDelaysMs?: [number, number];
  sleep?: (ms: number) => Promise<void>;
  /** Compaction: re-runs loadInstructions + assembleSystemPrompt. */
  reassembleSystemPrompt: () => Promise<string>;
  /** Compaction: loads the (possibly operator-overridden) distillation prompt. */
  loadCompactionPrompt: () => Promise<string>;
  /**
   * Compaction's activation-time configuration (the init command's
   * `compaction` object). `auto` is the WORKER's toggle and can change at
   * runtime via {@link AgentLoop.setAutoCompaction}; the other two come from
   * the definition and are fixed for the subprocess's lifetime.
   */
  compaction: { auto: boolean; contextWindowTokens?: number; threshold?: number };
  /** Transcript Restore (#1123): seeds this.conversation directly from a server-reconstructed array, skipping the fresh [{role:'system',...}] seed. Absent = today's v1 fresh-conversation behavior. */
  restoredConversation?: ChatMessage[];
}

interface ProviderToolCall {
  callId: string;
  name: string;
  argsJson: string;
}

interface TurnUsage {
  promptTokens: number;
  estimated: boolean;
}

/**
 * How a user turn ended, as seen by the turn-boundary compaction step.
 * `canceled` is distinguished from `error` because it is the one ending that
 * DISCARDS a pending compaction reservation: cancel means "stop what you were
 * doing", and the tool call was part of what was being done.
 */
type TurnEnding = 'completed' | 'error' | 'canceled';

type ProviderOutcome =
  | { kind: 'ok'; text: string; toolCalls: ProviderToolCall[]; usage?: TurnUsage }
  | { kind: 'error'; message: string }
  | { kind: 'canceled' };

type ParsedToolArgs =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse tool-call arguments and require a plain JSON object. An empty-string
 * argsJson counts as `{}`. Deep JSON-schema validation is deliberately
 * delegated to the MCP server's zod layer; the loop only checks shape.
 */
function parseToolArgs(argsJson: string): ParsedToolArgs {
  const source = argsJson.trim() === '' ? '{}' : argsJson;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: 'tool arguments must be a JSON object' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Cap the tool-call args emitted on the wire. The tool is always executed with
 * the full parsed value; only the emitted `args` is bounded. When the raw
 * argsJson is within the cap the parsed object is emitted as-is; when it exceeds
 * the cap the UTF-8-safe-truncated JSON string is emitted instead (the wire
 * schema accepts `unknown`), keeping the event line under the server's line-kill.
 */
function capToolCallArgsForWire(argsJson: string, parsedValue: Record<string, unknown>): unknown {
  const { text, truncated } = truncateToBytes(argsJson, WIRE_EVENT_MAX_BYTES);
  return truncated ? text : parsedValue;
}

/**
 * Fallback token estimate for providers that ignore `stream_options` and
 * never send `usage`: chars/4 summed over every message's `.content` in the
 * given array, rounded. `tool_calls` on assistant messages are not counted --
 * only `.content` size matters for this coarse estimate.
 */
function estimateTokensFromChars(messages: ChatMessage[]): number {
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.round(totalChars / 4);
}

export class AgentLoop {
  private readonly deps: AgentLoopDeps;
  private readonly retryDelaysMs: [number, number];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly conversation: ChatMessage[];
  /**
   * The tool list published to the provider. `Compact` is prepended here
   * rather than merged into the builtin registry, which is what puts it
   * structurally outside `enabledTools`' reach -- see compact-tool.ts.
   */
  private readonly tools: ToolDefinition[];
  private currentAbort: AbortController | null = null;
  /** Compaction: the worker's auto toggle. Mutable -- see setAutoCompaction. */
  private autoCompaction: boolean;
  /**
   * Compaction: a `Compact` tool call was made during the current turn and
   * is booked for the turn boundary. Idempotent by construction (a boolean,
   * so a second call within the same turn books nothing further).
   */
  private pendingCompact = false;
  /** The last turn's terminal usage reading -- the auto threshold's input. */
  private lastTurnUsage: TurnUsage | undefined;

  constructor(deps: AgentLoopDeps) {
    this.deps = deps;
    this.retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.sleep = deps.sleep ?? defaultSleep;
    this.conversation = deps.restoredConversation ?? [{ role: 'system', content: deps.systemPrompt }];
    this.tools = [compactToolDefinition, ...deps.tools];
    this.autoCompaction = deps.compaction.auto;
  }

  /** Abort the in-flight turn, if any. No-op when no turn is active. */
  cancel(): void {
    this.currentAbort?.abort();
  }

  /**
   * Compaction: reflect a change to the worker's auto toggle without waiting
   * for the next activation. Idempotent; takes effect at the next turn
   * boundary, which is the only point the flag is read.
   */
  setAutoCompaction(enabled: boolean): void {
    this.autoCompaction = enabled;
  }

  /**
   * Run one user turn, then settle Compaction at the turn boundary. The two
   * are one call deliberately: `main.ts` holds `turnActive` for the whole
   * returned promise, so no user message can interleave between the turn
   * ending and the compaction that follows it.
   */
  async runTurn(id: string, text: string): Promise<void> {
    const ending = await this.runUserTurn(id, text);
    await this.settleCompactionAtTurnBoundary(ending);
  }

  /**
   * Compaction's turn-boundary step. Precedence is deliberate: a cancel
   * discards the reservation entirely; otherwise an explicit `Compact` call
   * wins over the automatic threshold (the user asked, so no threshold gate
   * and no small-context exemption applies); the automatic path runs only
   * after a cleanly-completed turn, since a turn that ended in an error has
   * no fresh usage reading worth acting on.
   */
  private async settleCompactionAtTurnBoundary(ending: TurnEnding): Promise<void> {
    if (ending === 'canceled') {
      this.pendingCompact = false;
      return;
    }
    if (this.pendingCompact) {
      this.pendingCompact = false;
      await this.compact('manual');
      return;
    }
    if (ending !== 'completed') return;
    if (!this.shouldAutoCompact()) return;
    await this.compact('auto');
  }

  /**
   * Whether the automatic threshold has been crossed. Every `false` here is
   * a distinct reason, and two of them are structural rather than numeric:
   * an absent `contextWindowTokens` means there is no denominator at all (we
   * do not guess the model's window -- guessing low would compact
   * conversations with plenty of room left), and an absent usage reading
   * means no provider call produced one this turn (the vacuous case, e.g. an
   * empty conversation: the ratio is not small, it is absent).
   */
  private shouldAutoCompact(): boolean {
    if (!this.autoCompaction) return false;
    const windowTokens = this.deps.compaction.contextWindowTokens;
    if (windowTokens === undefined) return false;
    const usage = this.lastTurnUsage;
    if (usage === undefined) return false;
    const threshold = this.deps.compaction.threshold ?? DEFAULT_COMPACTION_THRESHOLD;
    return usage.promptTokens / windowTokens >= threshold;
  }

  private async runUserTurn(id: string, text: string): Promise<TurnEnding> {
    const turnId = id;
    const abort = new AbortController();
    this.currentAbort = abort;

    try {
      this.deps.emit({ v: 1, type: 'state', state: 'active' });
      this.conversation.push({ role: 'user', content: text });

      let malformedReAsks = 0;
      // Last-attempt-wins: overwritten on every successful provider attempt
      // this turn, emitted once at the turn's actual conclusion (see Token
      // accounting -- "turn-scoped, last-attempt wins" in the design doc).
      let turnUsage: TurnUsage | undefined;

      for (let iteration = 0; iteration < this.deps.maxToolIterations; iteration++) {
        const outcome = await this.runProviderWithRetries(this.conversation, turnId, abort.signal);
        if (outcome.kind === 'canceled') {
          this.emitContextUsageIfKnown(turnUsage);
          this.emitTurnError(turnId, 'turn canceled');
          return 'canceled';
        }
        if (outcome.kind === 'error') {
          this.emitContextUsageIfKnown(turnUsage);
          this.emitTurnError(turnId, outcome.message);
          return 'error';
        }
        turnUsage = outcome.usage;

        // Always emit the assistant message, even when the text is empty.
        this.deps.emit({
          v: 1,
          type: 'assistant-message',
          turnId,
          text: truncateToBytes(outcome.text, WIRE_EVENT_MAX_BYTES).text,
        });
        this.conversation.push(this.buildAssistantMessage(outcome.text, outcome.toolCalls));

        if (outcome.toolCalls.length === 0) {
          this.emitContextUsageIfKnown(turnUsage);
          this.emitIdle();
          return 'completed';
        }

        // Track which of this assistant message's tool calls already have a
        // tool-role response. On any early return the conversation must stay
        // valid for the next turn: every tool_call needs a matching response,
        // otherwise a strict OpenAI-compatible provider rejects the next
        // request.
        const responded = new Set<string>();

        for (const call of outcome.toolCalls) {
          const parsed = parseToolArgs(call.argsJson);
          if (!parsed.ok) {
            if (malformedReAsks >= MAX_MALFORMED_REASKS) {
              this.fillPendingToolResponses(
                outcome.toolCalls,
                responded,
                'tool call not completed: turn ended after repeated malformed arguments',
              );
              this.emitContextUsageIfKnown(turnUsage);
              this.emitTurnError(
                turnId,
                `tool arguments could not be parsed after ${MAX_MALFORMED_REASKS} re-asks: ${parsed.message}`,
              );
              return 'error';
            }
            malformedReAsks++;
            this.conversation.push({
              role: 'tool',
              tool_call_id: call.callId,
              content: `Error: tool arguments were not a valid JSON object (${parsed.message}). Please re-issue the call with corrected arguments.`,
            });
            responded.add(call.callId);
            continue;
          }

          if (abort.signal.aborted) {
            this.fillPendingToolResponses(outcome.toolCalls, responded, 'tool call canceled');
            this.emitContextUsageIfKnown(turnUsage);
            this.emitTurnError(turnId, 'turn canceled');
            return 'canceled';
          }
          this.deps.emit({
            v: 1,
            type: 'tool-call',
            turnId,
            callId: call.callId,
            name: call.name,
            args: capToolCallArgsForWire(call.argsJson, parsed.value),
          });
          const result = await this.callToolOrReserveCompaction(call.name, parsed.value, abort.signal);
          if (abort.signal.aborted) {
            this.fillPendingToolResponses(outcome.toolCalls, responded, 'tool call canceled');
            this.emitContextUsageIfKnown(turnUsage);
            this.emitTurnError(turnId, 'turn canceled');
            return 'canceled';
          }
          const { text: truncated } = truncateToBytes(result.result, TOOL_RESULT_MAX_BYTES);
          this.deps.emit({
            v: 1,
            type: 'tool-result',
            turnId,
            callId: call.callId,
            ok: result.ok,
            result: truncated,
          });
          this.conversation.push({
            role: 'tool',
            tool_call_id: call.callId,
            content: truncated,
          });
          responded.add(call.callId);
        }
      }

      this.emitContextUsageIfKnown(turnUsage);
      this.emitTurnError(turnId, 'maximum tool iterations reached');
      return 'error';
    } finally {
      this.currentAbort = null;
    }
  }

  /**
   * Dispatch one tool call. `Compact` is intercepted by name BEFORE the
   * executor is reached -- that interception is what keeps it outside
   * `enabledTools`, since the executor is the only thing `enabledTools`
   * configures. The interception sits between the caller's `tool-call` emit
   * and its `tool-result` emit, so the call surfaces in the transcript
   * through exactly the same path every other tool call uses: a user must be
   * able to see that the agent reserved a compaction, or a compaction that
   * appears from nowhere is indistinguishable from a bug.
   */
  private async callToolOrReserveCompaction(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; result: string }> {
    if (name === COMPACT_TOOL_NAME) {
      this.pendingCompact = true;
      return { ok: true, result: COMPACT_TOOL_SCHEDULED_RESULT };
    }
    return this.deps.executor.callTool(name, args, signal);
  }

  /**
   * Push a synthetic tool-role response for every tool call that has not yet
   * been answered, so the conversation remains valid (each tool_call has a
   * matching response) for the next user turn after an early return.
   */
  private fillPendingToolResponses(
    toolCalls: ProviderToolCall[],
    responded: Set<string>,
    reason: string,
  ): void {
    for (const call of toolCalls) {
      if (responded.has(call.callId)) continue;
      pushSyntheticToolError(this.conversation, call.callId, reason);
      responded.add(call.callId);
    }
  }

  private buildAssistantMessage(text: string, toolCalls: ProviderToolCall[]): ChatMessage {
    if (toolCalls.length === 0) {
      return { role: 'assistant', content: text };
    }
    const tool_calls: ToolCall[] = toolCalls.map((call) => ({
      id: call.callId,
      type: 'function',
      function: { name: call.name, arguments: call.argsJson },
    }));
    return { role: 'assistant', content: text, tool_calls };
  }

  private async runProviderWithRetries(
    messages: ChatMessage[],
    turnId: string,
    signal: AbortSignal,
    opts: { emitDeltas: boolean } = { emitDeltas: true },
  ): Promise<ProviderOutcome> {
    for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt++) {
      try {
        return await this.runProviderAttempt(messages, turnId, signal, opts);
      } catch (err) {
        if (signal.aborted) {
          return { kind: 'canceled' };
        }
        // Non-retryable provider errors (4xx like 400/401/404) fail fast without
        // burning retries/backoff -- they will never succeed on retry.
        if (err instanceof ProviderError && !err.retryable) {
          return { kind: 'error', message: errorMessage(err) };
        }
        if (attempt === MAX_PROVIDER_ATTEMPTS) {
          return { kind: 'error', message: errorMessage(err) };
        }
        await this.sleep(this.retryDelayFor(attempt, err));
        if (signal.aborted) {
          return { kind: 'canceled' };
        }
      }
    }
    // Unreachable: the loop either returns a result or an error at the last attempt.
    return { kind: 'error', message: 'provider retry loop exhausted' };
  }

  private retryDelayFor(attempt: number, err: unknown): number {
    if (err instanceof ProviderError && err.retryAfterMs !== undefined) {
      return err.retryAfterMs;
    }
    return this.retryDelaysMs[attempt - 1] ?? this.retryDelaysMs[this.retryDelaysMs.length - 1];
  }

  private async runProviderAttempt(
    messages: ChatMessage[],
    turnId: string,
    signal: AbortSignal,
    opts: { emitDeltas: boolean },
  ): Promise<{ kind: 'ok'; text: string; toolCalls: ProviderToolCall[]; usage: TurnUsage }> {
    let text = '';
    const toolCalls: ProviderToolCall[] = [];
    let providerUsage:
      | { promptTokens: number; completionTokens: number; totalTokens: number }
      | undefined;

    for await (const event of this.deps.adapter.run({
      model: this.deps.model,
      messages,
      tools: this.tools,
      signal,
    })) {
      switch (event.type) {
        case 'text-delta':
          text += event.text;
          // Compaction: the distillation call (compact() ->
          // runProviderWithRetries with emitDeltas: false) must NOT stream its
          // text on the wire -- only the context-compacted marker (with the
          // full summary) is meant to reach the client. Streaming these
          // deltas anyway leaves a dangling assistant-message bubble on the
          // client (compact() never emits the closing assistant-message for
          // this turnId; only runUserTurn does).
          if (opts.emitDeltas) this.deps.emit({ v: 1, type: 'assistant-delta', turnId, text: event.text });
          break;
        case 'reasoning-delta':
          // Thinking/reasoning content is a separate stream from the final
          // answer text: it is NOT accumulated into `text` (would otherwise
          // leak into the assistant-message and the next turn's conversation
          // history). There is no terminal/final counterpart event -- the
          // iteration's unconditional `assistant-message` emit is the
          // implicit end-of-thinking boundary the client uses instead.
          if (opts.emitDeltas) this.deps.emit({ v: 1, type: 'assistant-thinking-delta', turnId, text: event.text });
          break;
        case 'tool-call':
          toolCalls.push({ callId: event.callId, name: event.name, argsJson: event.argsJson });
          break;
        case 'done':
          if (event.usage !== undefined) providerUsage = event.usage;
          break;
      }
    }

    const usage: TurnUsage =
      providerUsage !== undefined
        ? { promptTokens: providerUsage.promptTokens, estimated: false }
        : { promptTokens: estimateTokensFromChars(messages), estimated: true };

    return { kind: 'ok', text, toolCalls, usage };
  }

  /**
   * Compaction: distill the conversation so far into a summary, then
   * atomically replace the conversation with a fresh system prompt plus a
   * seed message carrying that summary. See
   * docs/design/embedded-agent-worker.md "`AgentLoop.compact()`" for the
   * normative step list and the failure invariant this method must uphold:
   * every early-return path here returns strictly before the
   * `context-compacted` marker is emitted, so `this.conversation` is NEVER
   * mutated without that marker having been emitted first.
   *
   * Never runs mid-turn -- both callers are the turn boundary (see
   * `settleCompactionAtTurnBoundary`). Splicing the conversation array while
   * a provider request is in flight would destroy the in-flight turn.
   */
  async compact(source: 'auto' | 'manual'): Promise<void> {
    const abort = new AbortController();
    this.currentAbort = abort;

    try {
      this.deps.emit({ v: 1, type: 'state', state: 'active' });
      const turnId = crypto.randomUUID();

      let compactionPromptText: string;
      try {
        compactionPromptText = await this.deps.loadCompactionPrompt();
      } catch (err) {
        this.emitTurnError(turnId, `failed to load compaction prompt: ${errorMessage(err)}`);
        return;
      }

      // Transient request array -- NEVER pushed onto this.conversation.
      const messages: ChatMessage[] = [
        ...this.conversation,
        { role: 'user', content: compactionPromptText },
      ];

      const outcome = await this.runProviderWithRetries(messages, turnId, abort.signal, {
        emitDeltas: false,
      });
      if (outcome.kind === 'canceled') {
        this.emitTurnError(turnId, 'Context compaction failed: turn canceled');
        return;
      }
      if (outcome.kind === 'error') {
        this.emitTurnError(turnId, `Context compaction failed: ${outcome.message}`);
        return;
      }
      // No tool calls are expected or handled for the distillation request;
      // if the provider returns any anyway, they are ignored entirely -- but a
      // tool-call-only (or empty/whitespace-only text) response has nothing
      // usable to replace the conversation's head with, so it is rejected as
      // a failure rather than silently replacing the conversation with an
      // empty or partial summary (preserve-on-failure).
      if (outcome.toolCalls.length > 0 || outcome.text.trim().length === 0) {
        this.emitTurnError(
          turnId,
          'Context compaction failed: provider returned no usable summary',
        );
        return;
      }

      // The distillation call's own usage -- reflects the (large,
      // pre-compaction) prompt size -- emitted before the replacement. See
      // "Compaction's own usage" in docs/design/embedded-agent-worker.md.
      this.emitContextUsageIfKnown(outcome.usage);

      const summary = truncateToBytes(outcome.text, WIRE_EVENT_MAX_BYTES).text;

      let newSystemPrompt: string;
      try {
        newSystemPrompt = await this.deps.reassembleSystemPrompt();
      } catch {
        // Degrade gracefully rather than abort: distillation already
        // succeeded, so the replacement must complete as a unit even in this
        // degraded form.
        newSystemPrompt = this.deps.systemPrompt;
      }

      // Emitted BEFORE the conversation mutation, and with no `await` between
      // this line and the splice below -- the persisted/broadcast marker is
      // never followed by an async gap that could leave a completed-compaction
      // marker persisted while the old conversation is still intact.
      this.deps.emit({ v: 1, type: 'context-compacted', source, summary });

      this.conversation.splice(0, this.conversation.length, ...buildCompactionSeedMessages(newSystemPrompt, summary));

      this.emitContextUsageIfKnown({
        promptTokens: estimateTokensFromChars(this.conversation),
        estimated: true,
      });
      this.emitIdle();
    } finally {
      this.currentAbort = null;
    }
  }

  private emitTurnError(turnId: string, message: string): void {
    this.deps.emit({ v: 1, type: 'turn-error', turnId, message });
    this.emitIdle();
  }

  private emitIdle(): void {
    this.deps.emit({ v: 1, type: 'state', state: 'idle' });
  }

  private emitContextUsageIfKnown(usage: TurnUsage | undefined): void {
    if (usage === undefined) return;
    // Also the auto-compaction threshold's input: the reading the loop just
    // published IS the one the threshold is compared against, so there is no
    // second, separately-maintained notion of "current usage" to drift.
    this.lastTurnUsage = usage;
    this.deps.emit({
      v: 1,
      type: 'context-usage',
      promptTokens: usage.promptTokens,
      estimated: usage.estimated,
    });
  }
}
