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

/**
 * Compaction at the restore boundary: the ceiling below which the WHOLE
 * conversation may still be the distillation input.
 *
 * It exists because the live turn-end path has no such ceiling -- it always
 * sends the whole conversation, and does so successfully at and above the
 * default 0.85 threshold. A single constant serving as both this cut and the
 * partial input budget would make the same machine treat the same
 * conversation differently depending only on WHERE it was triggered. The
 * value leaves room for the compaction prompt, the summary the model is
 * about to write, and the estimator's own error.
 */
const FULL_DISTILL_MAX_RATIO = 0.9;

/**
 * Compaction at the restore boundary: the input budget for a PARTIAL
 * distillation's suffix, and only that.
 *
 * Named premise: the size going in is a coarse character-count estimate, not
 * a token count, and can be wrong in either direction for any given
 * tokenizer -- so the budget measured against it stays conservative; and the
 * compaction prompt plus the summary need room of their own inside the same
 * window. Partial distillation is reached precisely BECAUSE the estimate is
 * already near the wall, which is where a conservative budget earns its keep.
 *
 * Neither ratio is operator-configurable: both are internal safety margins on
 * our own estimator, not policies an operator has the information to set.
 */
const PARTIAL_DISTILL_INPUT_RATIO = 0.7;

/**
 * Prepended to a PARTIAL distillation's summary text, and the single writer
 * of that caveat.
 *
 * It lives inside the `summary` STRING rather than in the seed sentence built
 * around it, because that string is what the `context-compacted` event
 * persists: a later Transcript Restore reseeds through the ordinary
 * `buildCompactionSeedMessages` wording, which has no way to know the
 * distillation was partial, and the caveat still reaches the model because it
 * travels in the text. `buildCompactionSeedMessages` therefore stays exactly
 * the single writer of the seed shape it already was, with no partial branch.
 *
 * See docs/design/embedded-agent-worker.md "Compaction at the restore
 * boundary" for the named degradation this accepts (the outer sentence says
 * "the earlier part"; this line corrects it in band).
 */
const PARTIAL_DISTILL_CAVEAT_LINE =
  '[Earlier messages exceeded the context window and are not covered by this summary.]';

/**
 * Reason carried by the turn-error when a partial distillation has no usable
 * input at all (a small window against a large system prompt). It names this
 * cause specifically rather than folding into the generic wording: the
 * over-window 400 that follows on the first user turn is otherwise
 * indistinguishable from every other overflow, and this is the one line that
 * explains it.
 */
const PARTIAL_DISTILL_NO_INPUT_REASON =
  'restore-boundary compaction skipped: conversation exceeds the distillation input budget';

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

/**
 * Compaction at the restore boundary: narrow a distillation request down to
 * the LARGEST TAIL SUFFIX of the conversation that fits `budgetTokens`.
 *
 * The returned array is the request as it will actually be sent -- the
 * conversation's leading system message (always kept and always counted: it
 * is the model's operating instructions for the summary it is about to
 * write), then the selected suffix, then the compaction prompt. Measuring the
 * assembled request rather than the suffix alone is what keeps the prompt's
 * own room from being double-counted or forgotten.
 *
 * One structural rule governs where a suffix may start: never at a
 * `{role:'tool'}` message. Doing so would hand the provider a tool result
 * whose owning assistant `tool_calls` entry is not in the request -- the same
 * violation mid-turn repair exists to prevent, arriving from the other
 * direction. Such a candidate is skipped, never accepted and never repaired.
 *
 * Returns `null` when not even one message fits, which the caller treats as a
 * compaction failure rather than distilling nothing.
 */
export function selectPartialDistillationMessages(
  conversation: ChatMessage[],
  promptMessage: ChatMessage,
  budgetTokens: number,
): ChatMessage[] | null {
  const hasSystemHead = conversation.length > 0 && conversation[0].role === 'system';
  const head = hasSystemHead ? [conversation[0]] : [];
  const firstSelectable = hasSystemHead ? 1 : 0;

  let best: ChatMessage[] | null = null;
  // Walk from the tail toward the head. Total size grows monotonically as the
  // start index decreases, so the first candidate that overruns the budget
  // ends the search -- nothing earlier can fit either.
  for (let start = conversation.length - 1; start >= firstSelectable; start--) {
    const candidate = [...head, ...conversation.slice(start), promptMessage];
    if (estimateTokensFromChars(candidate) > budgetTokens) break;
    if (conversation[start].role === 'tool') continue;
    best = candidate;
  }
  return best;
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
  /**
   * Whether this loop was seeded from a restored conversation rather than a
   * fresh system-prompt-only one. Gates the restore-boundary compaction: a
   * fresh conversation is one system message, and evaluating the ratio
   * against it is the vacuous case the threshold semantics already exclude.
   */
  private readonly restoredAtActivation: boolean;

  constructor(deps: AgentLoopDeps) {
    this.deps = deps;
    this.retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.sleep = deps.sleep ?? defaultSleep;
    this.conversation = deps.restoredConversation ?? [{ role: 'system', content: deps.systemPrompt }];
    this.restoredAtActivation = (deps.restoredConversation?.length ?? 0) > 0;
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
   * Compaction at the restore boundary: the SECOND firing point of the same
   * automatic predicate, evaluated once after `init` and before the first
   * user turn. See docs/design/embedded-agent-worker.md "Compaction at the
   * restore boundary".
   *
   * The turn-end trigger cannot help a worker whose RESTORED conversation is
   * already large: its first provider call goes out before any turn has
   * completed, so the trigger has not run even once and that call overflows.
   *
   * Seeding `lastTurnUsage` here is what lets `shouldAutoCompact()` -- the
   * identical predicate, not a copy of it -- decide. The seed doubles as the
   * usage reading a restored worker publishes before its first turn, which
   * previously stayed absent until a turn had completed.
   *
   * Never throws for an ordinary compaction failure: `compact()` preserves
   * the conversation and emits a turn-error, and the caller goes on to report
   * `ready` regardless. A provider that is down at activation must not be
   * able to wedge the worker.
   */
  async compactAtRestoreBoundaryIfNeeded(): Promise<void> {
    if (!this.restoredAtActivation) return;

    const estimated = estimateTokensFromChars(this.conversation);
    this.emitContextUsageIfKnown({ promptTokens: estimated, estimated: true });

    const windowTokens = this.deps.compaction.contextWindowTokens;
    if (windowTokens === undefined) return;
    if (!this.shouldAutoCompact()) return;

    if (estimated <= FULL_DISTILL_MAX_RATIO * windowTokens) {
      await this.compact('auto');
      return;
    }
    await this.compact('auto', {
      budgetTokens: Math.floor(PARTIAL_DISTILL_INPUT_RATIO * windowTokens),
    });
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
  async compact(source: 'auto' | 'manual', partial?: { budgetTokens: number }): Promise<void> {
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
      const promptMessage: ChatMessage = { role: 'user', content: compactionPromptText };
      let messages: ChatMessage[];
      if (partial === undefined) {
        messages = [...this.conversation, promptMessage];
      } else {
        // Partial distillation: the whole-conversation request is the very
        // thing that would overflow, so the INPUT -- and only the input -- is
        // narrowed. Everything downstream is this method unchanged.
        const narrowed = selectPartialDistillationMessages(
          this.conversation,
          promptMessage,
          partial.budgetTokens,
        );
        if (narrowed === null) {
          this.emitTurnError(turnId, `Context compaction failed: ${PARTIAL_DISTILL_NO_INPUT_REASON}`);
          return;
        }
        messages = narrowed;
      }

      const outcome = await this.runProviderWithRetries(messages, turnId, abort.signal, {
        emitDeltas: false,
      });
      // `outcome.kind === 'canceled'` only covers an adapter that THROWS on
      // abort (the shape `OpenAIChatAdapter`'s fetch produces). An adapter
      // that instead ends its stream cleanly when the signal trips returns a
      // perfectly ordinary `ok` carrying whatever partial text had
      // accumulated -- which would then be spliced over the conversation as
      // if it were a finished summary. Consulting the signal directly is what
      // makes the failure invariant independent of the adapter's abort style.
      // This became load-bearing when the restore boundary started cancelling
      // on a budget: what used to be an exotic mid-compaction user cancel is
      // now a routine path.
      if (outcome.kind === 'canceled' || abort.signal.aborted) {
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

      // The partial caveat is prepended BEFORE the cap so it travels at the
      // head of the persisted `summary` string, where a later restore's
      // ordinary seed wording cannot drop it.
      const summaryText =
        partial === undefined ? outcome.text : `${PARTIAL_DISTILL_CAVEAT_LINE} ${outcome.text}`;
      const summary = truncateToBytes(summaryText, WIRE_EVENT_MAX_BYTES).text;

      let newSystemPrompt: string;
      try {
        newSystemPrompt = await this.deps.reassembleSystemPrompt();
      } catch {
        // Degrade gracefully rather than abort: distillation already
        // succeeded, so the replacement must complete as a unit even in this
        // degraded form.
        newSystemPrompt = this.deps.systemPrompt;
      }

      // The seed is built BEFORE the marker is emitted so the marker can
      // carry the post-compaction size -- but nothing is MUTATED yet, so the
      // failure invariant is untouched: `this.conversation` is still the
      // pre-compaction array at this point.
      const seed = buildCompactionSeedMessages(newSystemPrompt, summary);
      const postTokens = estimateTokensFromChars(seed);

      // Emitted BEFORE the conversation mutation, and with no `await` between
      // this line and the splice below -- the persisted/broadcast marker is
      // never followed by an async gap that could leave a completed-compaction
      // marker persisted while the old conversation is still intact.
      //
      // `preTokens` is the distillation call's own prompt size and
      // `postTokens` is the seed's estimate. Reporting both is how a
      // compaction declares its own severity (see the event's doc comment in
      // shared).
      //
      // For a FULL compaction the distillation's prompt IS the conversation
      // as it stood going in, so `preTokens` means what it looks like. For a
      // PARTIAL one it is the narrowed input, which is smaller -- so the
      // marker under-reports the true before-size in exactly the case that
      // discarded the most. That is deliberate: it is the only REAL count
      // available here, and substituting our own chars/4 estimate of the full
      // conversation would report smaller still (that estimator omits tool
      // schemas and measures low -- see the design doc's "Measured: `E`
      // under-counts" note), besides mixing a provider count and an estimate
      // in one field.
      this.deps.emit({
        v: 1,
        type: 'context-compacted',
        source,
        summary,
        ...(outcome.usage !== undefined ? { preTokens: outcome.usage.promptTokens } : {}),
        postTokens,
      });

      this.conversation.splice(0, this.conversation.length, ...seed);

      this.emitContextUsageIfKnown({ promptTokens: postTokens, estimated: true });
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
