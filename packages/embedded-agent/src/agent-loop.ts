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

import {
  DEFAULT_COMPACTION_THRESHOLD,
  type EmbeddedAgentAttachment,
  type EmbeddedAgentEvent,
  type EmbeddedAgentRestoredUsage,
} from '@agent-console/shared';
import type { ToolExecutor } from './mcp.js';
import {
  ProviderError,
  type ProviderErrorDetail,
  type ChatMessage,
  type ContentPart,
  type ProviderAdapter,
  type ToolCall,
  type ToolDefinition,
} from './providers/types.js';
import { isContextOverflowError, extractProviderStatedLimit } from './context-overflow.js';
import { detectClampedReading } from './window-drift.js';
import { truncateToBytes } from './truncate.js';
import { buildCompactionSeedMessages } from './conversation-seed.js';
import { buildUserMessageContent } from './attachment-content.js';
import {
  COMPACT_TOOL_NAME,
  COMPACT_TOOL_SCHEDULED_RESULT,
  compactToolDefinition,
} from './compact-tool.js';
import { pushSyntheticToolError } from './tool-call-repair.js';
import { assignSyntheticToolCallIds } from './tool-call-ids.js';

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
 * "the earlier part"; this line corrects it in-band).
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
  /**
   * agent-surface.md Ruling 3 (#1554): the resolved worker-override, or
   * absent when no override is set. Pass-through to every
   * {@link ProviderRunRequest} this loop issues -- see that type's own
   * doc comment for the consumption site.
   */
  reasoningEffort?: string;
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
  /**
   * The newest authoritative context reading from the persisted log,
   * extracted server-side at restore reconstruction. See
   * docs/design/embedded-agent-worker.md "Seed extraction". Absent when the
   * worker never produced one -- the estimator fallback then stands, bias and
   * all. Read ONLY by `compactAtRestoreBoundaryIfNeeded`; once a turn has run,
   * that turn's own reading supersedes it.
   */
  restoredUsage?: EmbeddedAgentRestoredUsage;
  /**
   * Message-attachment resolution: confinement roots a `Read`-eligible
   * attachment path must resolve under, and whether this definition's
   * provider can see image content parts. Both default to the closed/absent
   * state (`[]` / `false`) when omitted, matching pre-existing behavior for a
   * turn with no attachments.
   */
  attachmentRoots?: string[];
  supportsImages?: boolean;
}

export interface ProviderToolCall {
  callId: string;
  name: string;
  argsJson: string;
}

interface TurnUsage {
  promptTokens: number;
  estimated: boolean;
  /**
   * Window drift, signal 2: this reading bears every mark of having been
   * clamped by the provider to its own input limit. Decided where the reading
   * is produced, because that is the only place the REQUEST is still in hand
   * -- the predicate compares the provider's number against our estimate of
   * what we sent, and nothing downstream of here still has the messages.
   */
  appearsClamped?: true;
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
  | {
      kind: 'error';
      /** Display only. No layer may re-parse this to decide what happened. */
      message: string;
      /**
       * The provider's wire error as STRUCTURE, copied from `ProviderError`
       * rather than re-derived. `status` and `detail` are what any classifier
       * consumes; `message` is for humans.
       *
       * Both are absent when the failure did not come from a `ProviderError`
       * at all (a retry loop exhausting itself, an internal fault) or when the
       * body was not the provider's JSON envelope -- an edge proxy's HTML
       * rejection being the case that matters, since a classifier keyed on
       * structure then has nothing to match and cannot fire.
       */
      status?: number;
      detail?: ProviderErrorDetail;
    }
  | {
      kind: 'canceled';
      /**
       * Whatever text had accumulated before the abort landed, when there was
       * any. `kind` states WHAT HAPPENED -- the request was aborted -- and this
       * states WHAT SURVIVED it. Classifying an abort at the source without
       * carrying the payload would be right about the first and quietly lossy
       * about the second, foreclosing partial text for every future consumer.
       * Both of today's consumers end the turn and read only `kind`.
       */
      partialText?: string;
    };

/**
 * Copy a `ProviderError`'s structure into the outcome. The composed message
 * stays display-only; `status` and `detail` are what travel for decisions.
 */
function providerErrorOutcome(err: ProviderError): { kind: 'error'; message: string; status?: number; detail?: ProviderErrorDetail } {
  return {
    kind: 'error',
    message: errorMessage(err),
    ...(err.status !== undefined ? { status: err.status } : {}),
    ...(err.detail !== undefined ? { detail: err.detail } : {}),
  };
}

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
 * Character length of a message's `.content` for the coarse chars/4
 * estimator below. A user message's content may be a `ContentPart[]` when it
 * carries image attachments -- image parts contribute 0 chars to
 * this fallback estimate, an accepted approximation since this estimator
 * only ever runs when the provider doesn't report real `usage`.
 */
function contentCharLength(content: string | ContentPart[]): number {
  if (typeof content === 'string') return content.length;
  return content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 0), 0);
}

/**
 * Fallback token estimate for providers that ignore `stream_options` and
 * never send `usage`: chars/4 summed over every message's `.content` in the
 * given array, rounded. `tool_calls` on assistant messages are not counted --
 * only `.content` size matters for this coarse estimate.
 */
function estimateTokensFromChars(messages: ChatMessage[]): number {
  const totalChars = messages.reduce((sum, m) => sum + contentCharLength(m.content), 0);
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
/**
 * How much of a tool result survives shrinking. The content is about to be
 * summarised, so what a reader needs from it is its shape and opening -- a
 * file's first lines, an error's text, a command's first output -- not its
 * bulk. 512 characters keeps that and collapses a 16 KiB dump to roughly a
 * hundred tokens.
 */
const SHRUNK_TOOL_RESULT_HEAD_CHARS = 512;

/** Marks a shrunk tool result so the summary cannot mistake it for the whole. */
function shrinkToolContent(content: string): string {
  if (content.length <= SHRUNK_TOOL_RESULT_HEAD_CHARS) return content;
  const head = content.slice(0, SHRUNK_TOOL_RESULT_HEAD_CHARS);
  return `${head}\n[elided: original ${content.length} bytes]`;
}

/**
 * Builds the mid-turn escape's distillation input by SHRINKING content, not by
 * selecting messages.
 *
 * The escape and the restore boundary face oppositely-shaped conversations, so
 * they cannot share an input strategy. `selectPartialDistillationMessages`
 * keeps the largest tail suffix -- right at a restore boundary, where the tail
 * is recent conversation. **Mid-turn the tail is the bloat**: a tool message
 * runs to `TOOL_RESULT_MAX_BYTES` (16 KiB, roughly 4,096 estimated tokens) and
 * `maxToolIterations` defaults to 25, so the escape's most likely trigger is
 * exactly the case where the newest messages are the enormous ones. Selecting
 * the tail there would keep those and discard the user's original question.
 *
 * Worse, the arithmetic fails inside the regime this exists to serve. With a
 * budget of `0.7 x W`, at `W = 12,000` that is 8,400 -- about two tool results.
 * Below roughly `W < 6,000` the first candidate already overruns, the walk
 * breaks immediately, and the selector returns `null`. The escape would be
 * unable to fire at all in part of the very population it is for.
 *
 * Shrinking satisfies both constraints structurally:
 *
 * - **No message is dropped**, so every `tool_call` keeps its matching `tool`
 *   message and the restore-boundary pairing invariant is untouched by
 *   construction rather than by care.
 * - The user's question survives, so the summary describes the conversation
 *   instead of its tail.
 * - The dead zone disappears: a capped tool message costs tens of tokens.
 *
 * Falls back to tail-suffix selection only when shrinking every tool result
 * still overruns -- a conversation whose bulk is not in tool output. Returns
 * `null` when even that cannot fit, which the caller must surface as a failure:
 * appearing to fire and changing nothing is forbidden.
 */
export function buildShrunkDistillationInput(
  conversation: ChatMessage[],
  promptMessage: ChatMessage,
  budgetTokens: number,
): ChatMessage[] | null {
  const assembled = [...conversation, promptMessage];
  if (estimateTokensFromChars(assembled) <= budgetTokens) return assembled;

  // Work on a copy; the live conversation is never mutated by input building.
  const shrunk = conversation.map((m) => ({ ...m }));

  // LARGEST FIRST. Each shrink buys tokens proportional to what it removes, so
  // the biggest offenders first reaches the budget with the fewest messages
  // damaged -- the ordering is about how much detail survives, not about
  // whether it fits.
  const toolIndices = shrunk
    .map((m, i) => ({ i, size: typeof m.content === 'string' ? m.content.length : 0, isTool: m.role === 'tool' }))
    .filter((e) => e.isTool && e.size > SHRUNK_TOOL_RESULT_HEAD_CHARS)
    .sort((a, b) => b.size - a.size);

  for (const { i } of toolIndices) {
    const msg = shrunk[i];
    if (typeof msg.content !== 'string') continue;
    msg.content = shrinkToolContent(msg.content);
    const candidate = [...shrunk, promptMessage];
    if (estimateTokensFromChars(candidate) <= budgetTokens) return candidate;
  }

  // Shrinking was not enough: the bulk is not in tool output. Fall back to the
  // shipped selector rather than inventing a second selection rule.
  return selectPartialDistillationMessages(conversation, promptMessage, budgetTokens);
}

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
  /**
   * The controller `cancel()` aborts, and the one field two different
   * operations take turns owning: `runUserTurn` installs its controller for
   * the length of a turn, `compact()` installs its own for the length of a
   * distillation. The contract lives here rather than in either of them
   * because it is the thing both answer to.
   *
   * **`cancel` is not an instruction to a particular turn. It is an
   * instruction to the incarnation: stop whatever cancellable operation is
   * currently running.** Which one that is, is decided by whoever holds this
   * field at the moment the cancel lands -- the turn if one is running, the
   * boundary compaction if that is. So a user cancel arriving while
   * `settleCompactionAtTurnBoundary` is distilling aborts the COMPACTION,
   * not a turn, and that is the intended reading rather than a leak between
   * two paths that were meant to be separate.
   *
   * Measured against what the user actually asked for -- "stop what the
   * agent is doing" -- stopping the current activity is the right answer. A
   * boundary compaction is discretionary work the user never requested;
   * `compact()`'s preserve-on-failure path leaves the conversation exactly as
   * it was; and abandoning it gets the worker to idle sooner, which is the
   * observable the user is reaching for.
   *
   * **A cancel does not reserve a future operation.** One that arrives in the
   * gap between the two assignments -- after a turn has cleared the field and
   * before the boundary compaction installs its own -- does nothing at all.
   * That is a consequence of the rule above, not a defect to be fixed by
   * carrying a "cancel requested" flag forward: a flag would let a cancel the
   * user issued against a finished turn silently kill an operation that had
   * not started when they issued it.
   *
   * Two notes for future edits:
   *
   * - The change that gave the distillation core a RECEIVED signal rather
   *   than one of its own has LANDED, and it preserved this rule: the wrapper
   *   still installs and holds the controller across the boundary call, and
   *   the mid-turn escape runs on the turn's existing signal, so the field's
   *   single holder at any instant is unchanged. Nothing here needed
   *   re-deciding for it, and nothing does now.
   *
   *   Written in the future tense while that change was in flight, which made
   *   it undatable once the change landed: a later reader could not tell
   *   whether the code in front of them was the one it meant, and the
   *   reassurance attached to an unidentifiable referent.
   * - Any change that gives turns and compactions SEPARATE controllers does
   *   NOT preserve it -- it silently answers "which operation does a cancel
   *   stop" differently. That question has to be re-ruled, and this comment
   *   rewritten, in the same change that separates them.
   */
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
   * Whether this loop was seeded from a restored conversation that actually
   * CARRIES something, rather than a bare system-prompt head. Gates the
   * restore-boundary compaction: evaluating the ratio against a lone system
   * message is the vacuous case the threshold semantics already exclude.
   *
   * The test is `> 1`, not `> 0`, and the difference is load-bearing now that
   * the check is decided by a persisted reading rather than by estimating the
   * array in front of it. A reconstruction legitimately yields a length-1
   * array -- the server sends `[{role:'system'}]` whenever the restore window
   * replayed no messages, which a rotated live window can produce by starting
   * after the last `assistant-message` and before the `context-usage` that
   * followed it. Under `> 0` that array counted as a restore; the estimate of
   * one system message is tiny, so nothing fired and the flaw stayed
   * invisible. A reading does not shrink with the window it outlived, so it
   * WOULD fire -- distilling a conversation consisting only of the system
   * prompt, and replacing it with a seed announcing a summary of earlier
   * messages that were never in front of the model.
   *
   * The post-compaction seed pair (`[system, seedUser]`) is length 2 and
   * still qualifies, which is the case that must keep working.
   */
  private readonly restoredAtActivation: boolean;

  constructor(deps: AgentLoopDeps) {
    this.deps = deps;
    this.retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.sleep = deps.sleep ?? defaultSleep;
    this.conversation = deps.restoredConversation ?? [{ role: 'system', content: deps.systemPrompt }];
    this.restoredAtActivation = (deps.restoredConversation?.length ?? 0) > 1;
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

    const usage = this.resolveRestoreBoundaryUsage();
    this.emitContextUsageIfKnown(usage);

    const windowTokens = this.deps.compaction.contextWindowTokens;
    if (windowTokens === undefined) return;
    if (!this.shouldAutoCompact()) return;

    if (usage.promptTokens <= FULL_DISTILL_MAX_RATIO * windowTokens) {
      await this.compact('auto');
      return;
    }
    await this.compact('auto', {
      budgetTokens: Math.floor(PARTIAL_DISTILL_INPUT_RATIO * windowTokens),
    });
  }

  /**
   * The number the restore-boundary check is decided by (`S` in
   * docs/design/embedded-agent-worker.md "Compaction at the restore
   * boundary") -- the LARGER of the persisted reading and the estimate of the
   * reconstructed conversation.
   *
   * Both are lower bounds on the request the provider will actually price,
   * and for different reasons, which is why the larger is taken rather than
   * either being preferred outright:
   *
   * - The **reading** measures a real request, tool schemas included, but
   *   measures the conversation as it stood when it was published. Messages
   *   appended after it are not in it.
   * - The **estimate** covers every message present now, but sums `.content`
   *   only -- it omits the published tool schemas entirely, which is the
   *   systematic under-count this seeding exists to remove (measured: 1102
   *   against 6722 reported for the same request).
   *
   * Taking the maximum is therefore the tightest bound available without
   * attributing individual restored messages to a position in the log, which
   * would put a message-index correspondence on the wire for no gain: the
   * reading already carries the constant that dominates, and the estimate
   * already carries every late message's text.
   *
   * It cannot over-fire from a stale reading in the ordinary case, because
   * readings only grow within a compaction window and the server never seeds
   * from one taken before the last boundary.
   */
  private resolveRestoreBoundaryUsage(): TurnUsage {
    const estimate: TurnUsage = {
      promptTokens: estimateTokensFromChars(this.conversation),
      estimated: true,
    };
    const seed = this.deps.restoredUsage;
    // `<`, not `<=`: on a tie the seed wins. The two carry the same number
    // but not the same standing, and the estimate's `estimated: true` would
    // republish a provider-reported figure as one nobody reported -- the exact
    // inversion the flag is carried across the process boundary to prevent.
    if (seed === undefined || seed.promptTokens < estimate.promptTokens) return estimate;
    return { promptTokens: seed.promptTokens, estimated: seed.estimated };
  }

  /**
   * Run one user turn, then settle Compaction at the turn boundary. The two
   * are one call deliberately: `main.ts` holds `turnActive` for the whole
   * returned promise, so no user message can interleave between the turn
   * ending and the compaction that follows it.
   */
  async runTurn(id: string, text: string, attachments?: EmbeddedAgentAttachment[]): Promise<void> {
    const ending = await this.runUserTurn(id, text, attachments);
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

  private async runUserTurn(
    id: string,
    text: string,
    attachments?: EmbeddedAgentAttachment[],
  ): Promise<TurnEnding> {
    const turnId = id;
    const abort = new AbortController();
    this.currentAbort = abort;

    try {
      this.deps.emit({ v: 1, type: 'state', state: 'active' });
      const content = await buildUserMessageContent(
        text,
        attachments,
        this.deps.attachmentRoots ?? [],
        this.deps.supportsImages ?? false,
      );
      this.conversation.push({ role: 'user', content });

      let malformedReAsks = 0;
      // One escape per turn. A local, so it resets when the turn ends.
      let escapeUsed = false;
      // Last-attempt-wins: overwritten on every successful provider attempt
      // this turn, emitted once at the turn's actual conclusion (see Token
      // accounting -- "turn-scoped, last-attempt wins" in the design doc).
      let turnUsage: TurnUsage | undefined;

      for (let iteration = 0; iteration < this.deps.maxToolIterations; iteration++) {
        const outcome = await this.runProviderWithRetries(this.conversation, turnId, abort.signal);
        // Kind-only on purpose, not by omission: `runProviderWithRetries`
        // classifies an abort into `canceled` at the source whichever style
        // the adapter used, so a second `abort.signal.aborted` axis here would
        // be redundant -- and would re-scatter a convention that now has
        // exactly one writer.
        if (outcome.kind === 'canceled') {
          this.emitContextUsageIfKnown(turnUsage);
          this.emitTurnError(turnId, 'turn canceled');
          return 'canceled';
        }
        if (outcome.kind === 'error') {
          // THE ESCAPE. Placed here, at the top of an iteration, and the
          // position is load-bearing for two separate reasons.
          //
          // 1. It is BEFORE the turn's ending is decided, so "a turn that
          //    ended in error settles no compaction" stays true byte-for-byte
          //    -- there is no ending yet to contradict. A successful escape is
          //    invisible: no `turn-error` surfaces at all.
          //
          // 2. Every `tool_call` this loop issued already has its matching
          //    `tool` message by now (`fillPendingToolResponses` covers the
          //    early-exit paths). That is what makes the `context-compacted`
          //    marker written below a VALID RESTORE BOUNDARY -- see the
          //    invariant recorded at `replayWindow` in `restore.ts`. Moving
          //    this call into the tool loop would break that and the damage
          //    would surface on a later activation, arbitrarily far from here.
          //
          // `runProviderWithRetries` has already returned, so no request is in
          // flight and there is nothing to race.
          if (!escapeUsed && isContextOverflowError(outcome.status, outcome.detail)) {
            // Per turn, and reset with the turn: the cause of an overflow is
            // conversation size, so if the compaction worked the NEXT turn may
            // legitimately escape again. A service-level counter would be
            // wrong for that reason.
            escapeUsed = true;
            // Signal 3. The number is in hand HERE and nowhere later: a
            // successful escape emits no `turn-error`, so this is the only
            // moment the rejection's own stated limit can be attached to
            // anything the user will see.
            const escape = await this.escapeContextOverflow(
              turnId,
              abort.signal,
              extractProviderStatedLimit(outcome.status, outcome.detail),
            );
            if (escape === 'compacted') {
              // Retry exactly once. The provider is called with the live
              // `this.conversation`, so this re-reads the spliced array.
              continue;
            }
            if (escape === 'canceled') {
              // Ends like any other cancel. Reporting `'error'` here would
              // leave a `Compact` reservation booked, and the turn boundary
              // would then issue a manual compaction -- a provider request
              // made after the user cancelled.
              this.emitContextUsageIfKnown(turnUsage);
              this.emitTurnError(turnId, 'turn canceled');
              return 'canceled';
            }
            // The escape failed. It emits no `turn-error` of its own -- the
            // ORIGINAL overflow flows down the ordinary path below, so a turn
            // emits exactly one, never two.
          }
          this.emitContextUsageIfKnown(turnUsage);
          this.emitTurnError(
            turnId,
            this.annotateWindowDrift(outcome.message, outcome.status, outcome.detail),
          );
          return 'error';
        }
        turnUsage = outcome.usage;
        outcome.toolCalls = assignSyntheticToolCallIds(outcome.toolCalls, turnId, iteration);

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
        const outcome = await this.runProviderAttempt(messages, turnId, signal, opts);
        // The single writer of "an abort became a `canceled` outcome".
        // `ProviderAdapter` deliberately leaves the abort style unspecified:
        // `OpenAIChatAdapter` throws, which the catch below classifies, but an
        // adapter that instead ends its stream cleanly when the signal trips
        // returns an ordinary `ok` carrying whatever partial text had
        // accumulated. Converting here -- before any consumer sees the outcome
        // -- is what makes every caller's `kind === 'canceled'` check
        // sufficient whichever style the adapter used.
        if (signal.aborted && outcome.kind === 'ok') {
          return {
            kind: 'canceled',
            ...(outcome.text !== '' ? { partialText: outcome.text } : {}),
          };
        }
        return outcome;
      } catch (err) {
        if (signal.aborted) {
          return { kind: 'canceled' };
        }
        // Non-retryable provider errors (4xx like 400/401/404) fail fast without
        // burning retries/backoff -- they will never succeed on retry.
        if (err instanceof ProviderError && !err.retryable) {
          return providerErrorOutcome(err);
        }
        if (attempt === MAX_PROVIDER_ATTEMPTS) {
          return err instanceof ProviderError
            ? providerErrorOutcome(err)
            : { kind: 'error', message: errorMessage(err) };
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
      ...(this.deps.reasoningEffort !== undefined ? { reasoningEffort: this.deps.reasoningEffort } : {}),
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
        ? {
            promptTokens: providerUsage.promptTokens,
            estimated: false,
            ...(detectClampedReading(
              { promptTokens: providerUsage.promptTokens, estimated: false },
              this.deps.compaction.contextWindowTokens,
              estimateTokensFromChars(messages),
            ) !== undefined
              ? { appearsClamped: true as const }
              : {}),
          }
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
  /**
   * The distillation itself: run the request, validate the reply, emit the
   * marker and replace the conversation. **It owns no `AbortController` and
   * emits no turn-level side effects** -- no `state`, no `idle`, no
   * `turn-error`. Whose signal it runs under is the caller's concern, and so
   * is what a failure means.
   *
   * That split is what lets a second caller exist. `compact()` is a turn
   * boundary and reports failure as `turn-error`; the mid-turn escape is
   * inside a turn that already has a controller and an error of its own, and
   * a `turn-error` from here would be the turn's second. A turn emits exactly
   * one.
   *
   * Private on purpose: it is a mechanism with two in-file callers, not an
   * API. `input` is already selected -- building it is policy and belongs to
   * the caller, because the two callers face oppositely-shaped conversations.
   *
   * The commit-point rule (#1403) survives this split and binds both halves:
   * below the marker emit there is no `await` before the splice completes.
   */
  private async runDistillation(
    source: 'auto' | 'manual',
    input: ChatMessage[],
    isPartial: boolean,
    turnId: string,
    signal: AbortSignal,
    /**
     * Signal 3: the provider's own stated input limit, when this distillation
     * is the mid-turn escape from a rejection that named one. Absent for the
     * turn-boundary caller, which has no rejection behind it.
     */
    providerStatedWindowTokens?: number,
  ): Promise<{ ok: true } | { ok: false; canceled: boolean; reason: string }> {
      const outcome = await this.runProviderWithRetries(input, turnId, signal, {
        emitDeltas: false,
      });
      // `|| signal.aborted` WAS load-bearing: before
      // `runProviderWithRetries` classified aborts at the source, a `canceled`
      // outcome only ever came from an adapter that THROWS on abort, so an
      // adapter that ends its stream cleanly returned an ordinary `ok`
      // carrying partial text -- which this branch is the only thing that
      // stopped from being spliced over the conversation as a finished summary.
      // It stays now that the source classification covers both styles,
      // because the splice it guards is destructive and unrecoverable, and a
      // redundant guard in front of that is cheap insurance.
      //
      // This check is CLASSIFICATION plus early-exit economy -- it is NOT the
      // commit boundary. The boundary is the one immediately before the
      // marker emit below; see the comment there.
      if (outcome.kind === 'canceled' || signal.aborted) {
        return { ok: false, canceled: true, reason: 'turn canceled' };
      }
      if (outcome.kind === 'error') {
        return { ok: false, canceled: false, reason: outcome.message };
      }
      // No tool calls are expected or handled for the distillation request;
      // if the provider returns any anyway, they are ignored entirely -- but a
      // tool-call-only (or empty/whitespace-only text) response has nothing
      // usable to replace the conversation's head with, so it is rejected as
      // a failure rather than silently replacing the conversation with an
      // empty or partial summary (preserve-on-failure).
      if (outcome.toolCalls.length > 0 || outcome.text.trim().length === 0) {
        return { ok: false, canceled: false, reason: 'provider returned no usable summary' };
      }

      // The distillation call's own usage -- reflects the (large,
      // pre-compaction) prompt size -- emitted before the replacement. See
      // "Compaction's own usage" in docs/design/embedded-agent-worker.md.
      this.emitContextUsageIfKnown(outcome.usage);

      // The partial caveat is prepended BEFORE the cap so it travels at the
      // head of the persisted `summary` string, where a later restore's
      // ordinary seed wording cannot drop it.
      const summaryText =
        !isPartial ? outcome.text : `${PARTIAL_DISTILL_CAVEAT_LINE} ${outcome.text}`;
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
      const seed = buildCompactionSeedMessages(newSystemPrompt, summary, isPartial ? 'partial' : 'full');
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
      //
      // `coverage` declares which of those two shapes this is, so consumers
      // (the seed builder above, and the transcript label) can say so rather
      // than let the under-report pass as if `preTokens` were the whole
      // pre-compaction size. `isPartial` is known unconditionally at this
      // call site -- unlike `preTokens`/`postTokens`, there is no "could not
      // determine" case, so this field is never optional-spread here.
      // === THE COMMIT POINT ===
      //
      // The last abort check in this method, and the boundary the whole
      // cancellation story is defined against. BEFORE it, cancellation is
      // always honoured and the conversation is never touched. AFTER it, no
      // `await` exists until the splice below has completed, so cancellation
      // has nothing left to act on -- the compaction has happened.
      //
      // It exists because the checks above are all upstream of
      // `reassembleSystemPrompt()`, which is itself an await: a cancel landing
      // during reassembly used to pass every guard and still emit the marker
      // and splice, making this method's stated invariant false in a
      // reachable window.
      //
      // RULE FOR FUTURE EDITS, which is the point of naming the boundary at
      // all: a new `await` may only be placed ABOVE this check. Between here
      // and the end of the splice the code must stay synchronous. Adding an
      // await below reopens exactly the window this check closed, and does so
      // invisibly -- `deps.emit` is typed to return void precisely so it
      // cannot yield.
      if (signal.aborted) {
        return { ok: false, canceled: true, reason: 'turn canceled' };
      }

      this.deps.emit({
        v: 1,
        type: 'context-compacted',
        source,
        summary,
        ...(outcome.usage !== undefined ? { preTokens: outcome.usage.promptTokens } : {}),
        postTokens,
        ...(providerStatedWindowTokens !== undefined ? { providerStatedWindowTokens } : {}),
        coverage: isPartial ? 'partial' : 'full',
      });

      this.conversation.splice(0, this.conversation.length, ...seed);

      this.emitContextUsageIfKnown({ promptTokens: postTokens, estimated: true });

    return { ok: true };
  }

  /**
   * One forced compaction in response to an OBSERVED over-window response,
   * run inside the live turn and under the turn's own signal.
   *
   * Partial is the definition here, not a fallback. The `F` ceiling exists to
   * PREDICT that a whole-conversation distillation would itself overflow; this
   * path is triggered by the OBSERVATION of exactly that overflow, and
   * observation supersedes prediction. Attempting whole would reproduce the
   * error it is responding to, at any ratio.
   *
   * Owning no controller is what keeps a cancel working: it runs on the
   * signal the turn already installed, so `cancel()` during an escape
   * interrupts the distillation and the turn ends `canceled`. Opening its own
   * would null `currentAbort` on the way out and leave the turn uncancellable.
   *
   * Reports which of three things happened, because the caller acts
   * differently on each. It is deliberately no finer than that: the inert
   * case, a failed prompt load and an unusable input are all `'failed'`,
   * since all three have the same observable consequence -- the original
   * overflow flows down the ordinary path. A fourth value would be a
   * distinction no caller reads.
   *
   * `'canceled'` exists because it is NOT the same as failing. A turn that
   * ends `'error'` keeps a `Compact` reservation booked earlier in the turn,
   * and the boundary then runs a manual compaction -- a new provider request
   * issued after the user cancelled. The classification is made at the source
   * (`runDistillation` sets it) and read here; this method does not consult
   * the abort signal itself, which would re-scatter a convention that has
   * exactly one writer.
   */
  private async escapeContextOverflow(
    turnId: string,
    signal: AbortSignal,
    providerStatedWindowTokens?: number,
  ): Promise<'compacted' | 'canceled' | 'failed'> {
    const windowTokens = this.deps.compaction.contextWindowTokens;
    // Inert when the window is not declared: with no `W` there is no budget to
    // shrink toward, and no behaviour change is the correct outcome.
    if (windowTokens === undefined) return 'failed';

    let compactionPromptText: string;
    try {
      compactionPromptText = await this.deps.loadCompactionPrompt();
    } catch {
      return 'failed';
    }

    const promptMessage: ChatMessage = { role: 'user', content: compactionPromptText };
    const input = buildShrunkDistillationInput(
      this.conversation,
      promptMessage,
      Math.floor(PARTIAL_DISTILL_INPUT_RATIO * windowTokens),
    );
    // Nothing usable to distill. Failing honestly beats appearing to fire and
    // changing nothing.
    if (input === null) return 'failed';

    const result = await this.runDistillation(
      'auto',
      input,
      true,
      turnId,
      signal,
      providerStatedWindowTokens,
    );
    if (result.ok) return 'compacted';
    return result.canceled ? 'canceled' : 'failed';
  }

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
        // narrowed. Everything downstream is the distillation core unchanged.
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

      const result = await this.runDistillation(
        source,
        messages,
        partial !== undefined,
        turnId,
        abort.signal,
      );
      if (!result.ok) {
        this.emitTurnError(turnId, `Context compaction failed: ${result.reason}`);
        return;
      }

      this.emitIdle();
    } finally {
      this.currentAbort = null;
    }
  }


  /**
   * Appends the declared-versus-stated contradiction to an overflow's message,
   * when the provider named its real limit and it disagrees with the operator's
   * declaration.
   *
   * Only over-declaration is reported. Under-declaration compacts early -- it
   * costs fidelity and wedges nothing -- so naming it would spend an operator's
   * attention on the harmless direction and dilute the message that matters.
   *
   * The message is display-only prose that no layer parses back, which is what
   * makes weaving a sentence into it legitimate here.
   */
  private annotateWindowDrift(
    message: string,
    status: number | undefined,
    detail: ProviderErrorDetail | undefined,
  ): string {
    const declared = this.deps.compaction.contextWindowTokens;
    if (declared === undefined) return message;

    const stated = extractProviderStatedLimit(status, detail);
    // No number extracted is the ordinary outcome for every signature without a
    // measured capture pattern; it must read as "nothing to say", never as a
    // reason to guess one from the prose.
    if (stated === undefined || declared <= stated) return message;

    // Joined with a dash rather than a blank line: the transcript renders this
    // message as plain text with no `whitespace-pre-wrap`, so a newline would
    // collapse to a space and the paragraph break would exist only in the
    // source. Changing that surface's rendering to suit one string is not this
    // change's business.
    return (
      `${message} — This agent declares a context window of ` +
      `${declared.toLocaleString('en-US')} tokens, but the provider states its ` +
      `real input limit is ${stated.toLocaleString('en-US')}. An over-declared ` +
      `window makes every usage ratio optimistic, so automatic compaction fires ` +
      `later than intended, or not at all. Consider correcting the agent ` +
      `definition's context window.`
    );
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
      ...(usage.appearsClamped === true ? { appearsClamped: true as const } : {}),
    });
  }
}
