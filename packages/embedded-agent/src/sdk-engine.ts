/**
 * The claude-sdk engine (docs/design/embedded-agent-sdk-engine.md): hosts a
 * Claude Agent SDK session inside the same subprocess harness the
 * openai-api engine (agent-loop.ts) runs in, mapping the SDK's own message
 * stream onto the SAME NDJSON event vocabulary the native engine emits (see
 * that document's Appendix A for the authoritative mapping table this file
 * implements).
 *
 * `query()` is called EXACTLY ONCE, at construction: one live SDK session per
 * engine instance, for the instance's whole life. (Phase 2 also called it on
 * every context-handoff reseed; handoff was retired by #1401, and with it the
 * only reason this engine ever replaced a live session.)
 * Turns within one session are pushed onto a live
 * `AsyncIterable<SDKUserMessage>` (`UserMessageQueue`) that the SDK reads
 * from -- this is the SDK's own streaming-input mechanism for a multi-turn
 * session on one `Query`, verified live against SDK 2.1.233 (see the design
 * doc and #1333's task notes).
 */

import {
  createSdkMcpServer,
  query,
  tool,
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
import {
  COMPACT_TOOL_DESCRIPTION,
  COMPACT_TOOL_NAME,
  COMPACT_TOOL_SCHEDULED_RESULT,
} from './compact-tool.js';
import type { Engine } from './engine-types.js';

type SystemInitMessage = Extract<SDKMessage, { type: 'system'; subtype: 'init' }>;
type CompactBoundaryMessage = Extract<SDKMessage, { type: 'system'; subtype: 'compact_boundary' }>;
type ResultMessage = Extract<SDKMessage, { type: 'result' }>;
type ResultErrorMessage = Exclude<ResultMessage, { subtype: 'success' }>;
type StreamEvent = Extract<SDKMessage, { type: 'stream_event' }>['event'];
type AssistantMessagePayload = Extract<SDKMessage, { type: 'assistant' }>['message'];
type UserMessagePayload = Extract<SDKMessage, { type: 'user' }>['message'];
type ToolResultEvent = Extract<EmbeddedAgentEvent, { type: 'tool-result' }>;

/**
 * H2 (docs/design/embedded-agent-sdk-engine.md §5): calling `getContextUsage()`
 * immediately after a turn's `result` can throw "ProcessTransport is not
 * ready for writing" -- an encoded workaround for empirically observed
 * behavior, NOT a documented SDK contract. Retry-with-settle, not a bare
 * sleep: the budget below (5 settle gaps at 500ms = 2500ms across 6
 * attempts) comfortably exceeds both the originally observed settle window
 * and the AC's "at least 3 attempts spanning at least 2s total" floor.
 * Re-verify this constant pair on every SDK upgrade -- the SDK-bump
 * tracking issue's checklist carries this obligation. §5 is the canonical
 * source for this hazard's CURRENT epistemic status; do not infer it from
 * this comment.
 */
const CONTEXT_USAGE_SETTLE_DELAY_MS = 500;
const CONTEXT_USAGE_MAX_ATTEMPTS = 6;

/**
 * PS1 tripwire (docs/design/embedded-agent-sdk-engine.md §5): a drop of more
 * than this ratio between two consecutive context-usage polls is logged as an
 * anomaly.
 *
 * Its ROLE changed when compaction became a supported mode. The primary
 * detector of a compaction is now the SDK's own `compact_boundary` message,
 * which probe #1400 confirmed reaches the query iterator for both manual and
 * automatic firings. This ratio is the secondary detector, and it watches for
 * exactly one thing: a large drop with NO accompanying boundary. That is a
 * genuine anomaly in either mode, which is why the tripwire survives the
 * toggle being ON rather than being deleted with it.
 *
 * **The constant is configuration-relative, not universal.** What it measures
 * is `getContextUsage().totalTokens`, which includes a baseline of system
 * prompt plus tool definitions (~21.5k in the probe) that compaction does not
 * touch. Sensitivity therefore depends on the conversation-to-baseline ratio,
 * and the baseline itself varies with the definition's `instructions[]` and
 * tool set. Measured: near the auto-fire threshold a real compaction dropped
 * totalTokens by 74.9% (101588 -> 25544), comfortably over this bar; a manual
 * compaction of a small conversation dropped it by 2% (25308 -> 24792) and
 * does not trip it at all. The second case is harmless precisely because the
 * boundary event, not this ratio, is what surfaces a compaction.
 */
const MATERIAL_DROP_RATIO = 0.2;

/**
 * Name of the in-process SDK MCP server that serves the `Compact` tool. Short
 * on purpose: the SDK namespaces every MCP tool, so this string is visible to
 * the model and in the transcript as `mcp__console__Compact`.
 */
const COMPACT_TOOL_SERVER_NAME = 'console';
/** The tool's namespaced, model-visible name on this engine. */
export const SDK_COMPACT_TOOL_NAME = `mcp__${COMPACT_TOOL_SERVER_NAME}__${COMPACT_TOOL_NAME}`;
/**
 * The user message the `Compact` tool enqueues. Probe #1400 P2 confirmed the
 * SDK admits `/compact` pushed as an ordinary streaming-input user message and
 * answers with a `compact_boundary` on the query iterator.
 *
 * A conversation too short to compact is answered with an ordinary assistant
 * refusal ("Not enough messages to compact.") and NO boundary. That is a
 * result, not a failure: the refusal is visible in the transcript where the
 * user can read it, and treating a missing boundary as "the command does not
 * exist" would be exactly the wrong inference.
 */
const COMPACT_SLASH_COMMAND = '/compact';

/**
 * Builds the `Compact` tool definition for the in-process SDK MCP server.
 *
 * A named factory rather than an inline literal so the handler's contract --
 * "reserve, then answer with the same wording the openai-api engine uses" --
 * is directly exercisable in a test without reaching into the SDK's own
 * server internals to find the registered handler.
 */
export function createSdkCompactTool(onReserve: () => void) {
  return tool(COMPACT_TOOL_NAME, COMPACT_TOOL_DESCRIPTION, {}, async () => {
    onReserve();
    return { content: [{ type: 'text' as const, text: COMPACT_TOOL_SCHEDULED_RESULT }] };
  });
}

/**
 * Streaming-input queue backing `query()`'s `prompt: AsyncIterable<SDKUserMessage>`.
 * A pushed message is delivered to the next waiting `stream()` consumer
 * immediately; otherwise it buffers until the consumer catches up. `close()`
 * signals end-of-stream once any already-queued items have drained -- unused
 * (the live `Query` runs until `dispose()`), kept for shutdown-path
 * completeness.
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
  /**
   * Compaction: the WORKER's auto-compaction toggle, composed into the SDK's
   * own `autoCompactEnabled` setting. Probe #1400 P1a confirmed the setting
   * both arrives and follows in all four directions, which is what let this
   * ship as a live toggle rather than an at-next-activation one.
   */
  autoCompaction: boolean;
  /**
   * Transcript Restore, R1: the SDK session id to resume, or absent for a
   * fresh session. Comes from `init.resume.sdkSessionId` and NOWHERE else
   * -- the re-scoped init pin (docs/design/embedded-agent-sdk-engine.md
   * Appendix A) forbids this engine deriving a resume id of its own, so
   * there is deliberately no `listSessions()` call, no transcript scan, and
   * no memory of an earlier query's id anywhere in this file.
   */
  resume?: string;
  /** DI seam for tests; defaults to the real SDK `query` function. */
  queryFn?: typeof query;
  /** DI seam for tests: the H2 retry-with-settle delay. Defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

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
  private readonly queue = new UserMessageQueue();
  private readonly query: Query;

  private currentTurnId: string | null = null;
  private iterationText = '';
  private currentTurnDeferred: { resolve: () => void } | null = null;
  private dead = false;

  /**
   * Transcript Restore, R1: has this query ever reported a `system:init`?
   *
   * The whole of the refused-resume detector (PS6). A query that was asked
   * to resume and reaches a terminal error without this ever having been
   * set did not merely fail a turn -- the session never started, because
   * the SDK could not find what it was asked to resume. Set once and never
   * cleared: one query per engine, so "ever" is the right tense.
   */
  private sawSystemInit = false;
  /** R1: a refused resume has already been reported; report it once. */
  private resumeFailureReported = false;

  /** S2: previous poll's usable totalTokens, for the PS1 material-drop
   * tripwire. `null` = no baseline yet. */
  private previousTotalTokens: number | null = null;

  /** Compaction: the worker's auto toggle, mirrored into the SDK's settings. */
  private autoCompaction: boolean;
  /**
   * Compaction: a `compact_boundary` observed during the current turn, and
   * the `compact_summary` the `PostCompact` hook delivered for it.
   *
   * Both are buffered and the marker is emitted once, at the turn's `result`.
   * The two signals arrive on INDEPENDENT paths -- the boundary on the query
   * iterator, the summary through the hook callback -- and their relative
   * order is not part of any contract we have measured. Emitting on whichever
   * arrives first would drop the summary in one of the two orderings; the
   * turn's `result` is the first moment both have definitely landed. This is
   * the same buffer-and-flush shape `pendingToolResults` uses for the
   * tool-call/tool-result ordering race, for the same reason.
   */
  private pendingCompactBoundary: CompactBoundaryMessage['compact_metadata'] | null = null;
  private pendingCompactSummary: string | null = null;
  /** Compaction: a `/compact` booked by the tool, sent at the turn boundary. */
  private pendingCompactCommand = false;

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
    this.autoCompaction = deps.autoCompaction;

    // The ONLY production call site for the SDK's query() function -- both
    // the DI seam Pin 1(a) exercises and the grep-containment target Pin 1(b)
    // verifies (see __tests__/sdk-engine.test.ts). Phase 2's `reseed` was the
    // second; it went with handoff (#1401), so containment is now exact.
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
    void this.consumeLoop(this.query);
    this.deps.emit({ v: 1, type: 'ready' });
  }

  /**
   * Builds the `query()` Options battery. One call site now that `reseed` is
   * gone, but kept as a named builder: every Phase 1 pin (no `resume`,
   * allowlist `tools`, `spawnClaudeCodeProcess`, `settingSources: []`, no
   * `apiKey`) is asserted against its output, and a second hand-rolled
   * options object anywhere is the drift vector this exists to kill.
   */
  private buildOptions(systemPromptAppend: string | undefined): Options {
    return {
      executable: 'bun',
      cwd: this.deps.cwd,
      model: this.deps.model,
      // `Compact` is appended to the allowlist here rather than being a
      // member of `enabledToolNames`: it is a self-management tool, outside
      // the capability registry `enabledTools` configures, so no
      // representable definition can remove it (see compact-tool.ts).
      tools: [...this.enabledToolNames, SDK_COMPACT_TOOL_NAME],
      mcpServers: {
        'agent-console': {
          type: 'http',
          url: this.deps.mcp.baseUrl,
          headers: { Authorization: `Bearer ${this.deps.mcp.token}` },
          alwaysLoad: true,
        },
        // Compaction's `Compact` tool, served IN THIS PROCESS -- the handler
        // acts on state that lives here, and the server has no part in it
        // (docs/design/embedded-agent-worker.md § The `Compact` tool). The
        // SDK namespaces it, so the model sees `mcp__console__Compact` while
        // the openai-api engine's model sees plain `Compact`; the contract
        // (no parameters, reservation semantics, result wording) is identical.
        [COMPACT_TOOL_SERVER_NAME]: createSdkMcpServer({
          name: COMPACT_TOOL_SERVER_NAME,
          tools: [createSdkCompactTool(() => this.reserveCompaction())],
        }),
      },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      settingSources: [],
      // Compaction: the SDK's own auto-compaction IS this engine's automatic
      // compaction; the worker's toggle drives it directly rather than
      // through any machinery of ours.
      settings: { autoCompactEnabled: this.autoCompaction },
      // The `PostCompact` hook is the only path that carries the summary
      // text; the `compact_boundary` message on the iterator carries the
      // token counts but not the words. Both are needed for one marker --
      // see `pendingCompactBoundary`.
      hooks: {
        PostCompact: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name === 'PostCompact') {
                  this.pendingCompactSummary = input.compact_summary;
                }
                return { continue: true };
              },
            ],
          },
        ],
      },
      spawnClaudeCodeProcess,
      // Transcript Restore, R1: present iff the deps carried one. The
      // re-scoped Phase 1 pin (Appendix A's init row) is exactly this
      // biconditional -- `resume` appears in the options when it came from
      // deps, and never otherwise.
      ...(this.deps.resume !== undefined ? { resume: this.deps.resume } : {}),
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

  /**
   * Compaction: reflect a change to the worker's auto-compaction toggle into
   * the live SDK session.
   *
   * Applied mid-session rather than at the next activation because probe
   * #1400 P1a measured `applyFlagSettings` actually taking effect: writing
   * `false` then reading back reported `false`, writing `true` reported
   * `true`, and construction in either state agreed. The local field is
   * updated first so a later reconstruction composes the current value even
   * if the live write fails.
   *
   * The write is best-effort: a failure here leaves the durable value (which
   * the server has already persisted) to take effect at the next activation,
   * which is strictly better than throwing into a UI toggle's callback.
   */
  setAutoCompaction(enabled: boolean): void {
    this.autoCompaction = enabled;
    if (this.dead) return;
    void this.query.applyFlagSettings({ autoCompactEnabled: enabled }).catch((err: unknown) => {
      console.warn(
        `[sdk-engine] failed to apply autoCompactEnabled=${enabled} to the live session; ` +
          `it will take effect at the next activation: ${errorMessage(err)}`,
      );
    });
  }

  cancel(): void {
    // Compaction: a `Compact` booked during the turn being canceled is
    // discarded. Cancel means "stop what you were doing", and the tool call
    // was part of what was being done.
    this.pendingCompactCommand = false;
    if (this.dead) return;
    void this.query.interrupt().catch(() => {
      // Best-effort: the pending turn's eventual settlement happens via the
      // `result` message the interrupt triggers (or, on transport failure,
      // via the consumer loop's fatal path) -- nothing further to do here.
    });
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
    this.pendingCompactCommand = false;
    try {
      this.query.close();
    } catch {
      // Already closed / never fully started -- nothing more to release.
    }
  }

  /**
   * Consumes the one live query's message stream for the engine's lifetime.
   *
   * Phase 2 carried a per-query generation counter here, because a handoff
   * reseed replaced the live query and made the old loop's stream end
   * cleanly -- indistinguishable, without the counter, from the process
   * having died. With handoff retired (#1401) there is exactly one query per
   * engine and nothing can supersede it, so the guard degenerates to the
   * Phase 1 shape: a clean end is always unexpected unless we caused it.
   */
  private async consumeLoop(activeQuery: Query): Promise<void> {
    try {
      for await (const message of activeQuery) {
        await this.handleMessage(message);
        if (this.dead) break;
      }
      // The `for await` loop exited WITHOUT throwing -- the SDK's message
      // stream ended cleanly. Outside of a deliberate `dispose()` (which
      // already set `this.dead = true` before triggering this), this is
      // unexpected: the child `claude` process exited, or the SDK ended the
      // stream, with no `result` message ever settling the pending turn.
      // Treat it exactly like the throwing case below -- `handleFatal`'s own
      // `if (this.dead) return;` guard makes this a no-op on the deliberate
      // `dispose()` path.
      this.handleFatal('SDK message stream ended unexpectedly');
    } catch (err) {
      // R1: the refused-resume path reaches here too -- the SDK's iterator
      // throws right after the error `result`. Reporting is idempotent, so
      // whichever arrives first wins and the other is a no-op; this arm
      // exists because a resume can be refused with no turn in flight at
      // all (nothing pushed a prompt), in which case there is no `result`
      // for `handleResult` to see.
      this.reportRefusedResume();
      this.handleFatal(`SDK transport error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleMessage(message: SDKMessage): Promise<void> {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') this.handleSystemInit(message);
        else if (message.subtype === 'compact_boundary') this.handleCompactBoundary(message);
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
   * session id, should one ever be re-established -- last-write-wins is the
   * contract; see
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
    // R1: the positive half of the resume detector. Recorded BEFORE the
    // emit so no early return below can leave it unset on a session that
    // demonstrably started.
    this.sawSystemInit = true;
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

  /**
   * Compaction: the SDK compacted its own conversation. Buffered rather than
   * emitted here -- see `pendingCompactBoundary` for why both this and the
   * `PostCompact` hook's summary have to land before the marker goes out.
   */
  private handleCompactBoundary(message: CompactBoundaryMessage): void {
    this.pendingCompactBoundary = message.compact_metadata;
  }

  /**
   * Emits the compaction boundary marker, if one is buffered. Called at the
   * turn's terminal `result`, the first point at which both the boundary and
   * the hook's summary have definitely arrived.
   *
   * `post_tokens` is optional on the SDK's own metadata, so the marker
   * carries the pair only when both numbers are real -- a compaction that
   * cannot report its severity renders the plain marker rather than a
   * fabricated number (see the event's doc comment in shared).
   */
  private flushCompactionBoundary(): void {
    const metadata = this.pendingCompactBoundary;
    const summary = this.pendingCompactSummary;
    this.pendingCompactBoundary = null;
    this.pendingCompactSummary = null;
    if (!metadata) return;

    this.deps.emit({
      v: 1,
      type: 'context-compacted',
      source: metadata.trigger,
      ...(summary !== null ? { summary } : {}),
      ...(metadata.post_tokens !== undefined
        ? { preTokens: metadata.pre_tokens, postTokens: metadata.post_tokens }
        : {}),
    });
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
   * Tool calls are NOT buffered here -- they
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
   * rather than buffered until `message_stop` -- this may arrive before, or
   * for a fast tool even after, the iteration's own `assistant-message`
   * event.
   *
   * **That ordering is NOT a harmless nuance, and this comment used to say it
   * was.** The premise was that downstream consumers only render. Transcript
   * restore's replay is structural, not rendering: it rebuilds a
   * provider-shaped conversation and read the order as meaningful, so every
   * turn opening with a tool call failed reconstruction and fell to the
   * destructive reset. The reader now accepts any of the three interleavings
   * this race produces and folds them into one assistant turn. The emission
   * order here is deliberately unchanged -- it is what the row's own earlier
   * correction trail chose, and changing it would not repair a log already
   * written -- but a future consumer must not re-derive the retired premise
   * from this site. See `embedded-agent-sdk-engine.md` Appendix A's
   * `tool-call` row.
   *
   * Immediate emission is also the guard's flush trigger: any
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
   * flushed here anyway (loudly logged) rather than dropped. Then: flushes
   * any compaction boundary observed during the turn, polls context usage
   * (S1), and -- unless a booked `Compact` is drained here, which holds the
   * turn open until that injected command's own result arrives -- emits
   * `state: idle` and settles the pending turn. */
  private async handleResult(message: ResultMessage): Promise<void> {
    const turnId = this.requireTurnId();
    this.flushOrphanedToolResults(turnId);

    // Emitted BEFORE the usage poll so the transcript reads in causal order:
    // the boundary marker, then the reading that reflects the post-compaction
    // size. The poll's own tripwire also consults `pendingCompactBoundary`,
    // which is why the flush cannot simply move to the end of this method --
    // see `checkForMaterialDrop`.
    const compacted = this.pendingCompactBoundary !== null;
    this.flushCompactionBoundary();

    await this.pollContextUsage({ compacted });
    if (this.dead) {
      // pollContextUsage's H2-exhaustion path already emitted `fatal`,
      // disposed the query, and settled the pending turn -- do not also
      // emit a spurious turn-error/state:idle on top of it.
      return;
    }
    if (message.subtype !== 'success') {
      // R1: a refused resume surfaces here first, as a non-success result,
      // and is distinguished from every other non-success result
      // structurally -- see `reportRefusedResume`.
      const refusedResume = this.reportRefusedResume();
      this.deps.emit({
        v: 1,
        type: 'turn-error',
        turnId,
        message: refusedResume ?? this.buildTurnErrorMessage(message),
      });
    }
    // Compaction: a `Compact` booked during this turn runs as PART of it --
    // the turn is not over until the injected `/compact` reaches its own
    // terminal `result`. Deferring `idle`/settle here is what turns the
    // attribution contract below into a structural guarantee rather than an
    // assumption: `main.ts` keeps `turnActive` set for as long as `runTurn`
    // is unsettled, so no `user-message` can start a turn that would reassign
    // `currentTurnId` out from under the injected one. This mirrors the
    // openai-api engine, where `runUserTurn` and
    // `settleCompactionAtTurnBoundary` are one promise for the same reason --
    // the asymmetry this replaces was an omission, not a decision. On the
    // second pass (the `/compact`'s own result) the flag is already cleared,
    // so this falls through and settles exactly once.
    if (this.pendingCompactCommand && this.drainPendingCompactCommand()) {
      return; // turn held open; the /compact's own result settles it
    }
    this.deps.emit({ v: 1, type: 'state', state: 'idle' });
    this.settlePendingTurn();
  }

  /**
   * Compaction: book a `/compact` for the end of the current turn. The
   * `Compact` tool's handler is this method's only caller -- public because
   * that handler is constructed outside the class (`createSdkCompactTool`),
   * and because "the tool's entry point" is a real part of this engine's
   * surface rather than an incidental internal.
   */
  reserveCompaction(): void {
    this.pendingCompactCommand = true;
  }

  /**
   * Compaction: send the `/compact` a `Compact` tool call booked during the
   * turn that just ended.
   *
   * Sent at the turn boundary, never mid-turn, for the same reason the
   * openai-api engine reserves rather than compacts: the tool call happens
   * inside a turn, and compaction must not interleave with one. The
   * reservation is discarded on cancel and on shutdown -- both go through
   * paths that clear it -- so "the user stopped what the agent was doing"
   * also stops the compaction the agent had booked while doing it.
   *
   * This pushes an ordinary user message onto the SDK's own input queue. It
   * deliberately does NOT go through `runTurn`, so no server-side
   * `user-message` echo is appended to the persisted transcript: that echo
   * exists to record a real human or API-caller message, and a synthetic
   * `/compact` is neither. A fake user row would misattribute the action.
   *
   * **The injected turn's events carry the RESERVING turn's `turnId`, by
   * decision -- and structurally, not by assumption.** `handleResult` defers
   * `state: idle` and the turn's settlement until this injected command
   * reaches its own terminal `result`, which keeps `main.ts`'s `turnActive`
   * set across the whole compaction. A `user-message` arriving mid-compaction
   * is therefore refused rather than started, so nothing can reassign
   * `currentTurnId` while these events are in flight. (Before that deferral
   * existed, the attribution below held only for as long as no one sent a
   * message during compaction -- and emitting `state: idle` first actively
   * invited exactly that.) Not going through `runTurn` means `currentTurnId`
   * is never reassigned, so everything the SDK emits in response to this `/compact`
   * -- deltas, the assistant message, the `result` -- is attributed to the
   * turn in which the agent called `Compact`. Read as a contract rather than
   * as a leftover: the compaction was requested during that turn, and its
   * acknowledgement belongs to it. On the client this appends to that turn's
   * assistant content, which is what a user sees as "I asked, and it
   * answered". This attribution is persisted in the transcript forever, so
   * it is wire semantics, not an implementation detail.
   *
   * **Why NOT mint a fresh turnId here** -- the change a future reader is
   * most likely to make, thinking the missing id is an oversight: a fresh id
   * would produce an assistant bubble belonging to no user message at all,
   * because the injected `/compact` deliberately has no `user-message` row
   * (see above). Trading a defensible attribution for an orphaned one is a
   * regression, not a fix. Pinned by a test.
   */
  private drainPendingCompactCommand(): boolean {
    if (!this.pendingCompactCommand) return false;
    this.pendingCompactCommand = false;
    // Nothing was queued, so nothing will produce the `result` the caller
    // would be waiting for -- report false so it settles the turn instead of
    // holding it open forever.
    if (this.dead) return false;
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: COMPACT_SLASH_COMMAND },
      parent_tool_use_id: null,
    });
    return true;
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
  private async pollContextUsage(opts: { compacted?: boolean } = {}): Promise<void> {
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
      this.emitContextUsageIfUsable(response, opts.compacted === true);
      return;
    }
  }

  private emitContextUsageIfUsable(
    response: SDKControlGetContextUsageResponse,
    compacted: boolean,
  ): void {
    const totalTokens = response?.totalTokens;
    if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens)) {
      console.warn(
        '[sdk-engine] getContextUsage() resolved without a usable totalTokens field; skipping context-usage emit',
      );
      return;
    }
    this.checkForMaterialDrop(totalTokens, compacted);
    this.deps.emit({ v: 1, type: 'context-usage', promptTokens: totalTokens, estimated: false });
    this.previousTotalTokens = totalTokens;
  }

  /**
   * S2's PS1 tripwire, made mode-aware. Four quadrants, and only two of them
   * warn:
   *
   * - toggle OFF, material drop, no boundary -> WARN. The original PS1
   *   violation: the SDK compacted despite `autoCompactEnabled: false`.
   * - toggle ON, material drop, boundary observed -> silent. This is the
   *   feature working; the boundary marker is what tells the user.
   * - toggle ON, material drop, NO boundary -> WARN. An unexplained
   *   shrinkage is a genuine anomaly regardless of mode, and this quadrant
   *   is the whole reason the tripwire is not simply deleted when the toggle
   *   is on.
   * - no material drop -> silent, in either mode.
   *
   * See `MATERIAL_DROP_RATIO` for why the ratio is configuration-relative
   * and why the boundary event, not this check, is the primary detector.
   */
  private checkForMaterialDrop(totalTokens: number, compacted: boolean): void {
    if (compacted) return;
    if (
      this.previousTotalTokens !== null &&
      totalTokens < this.previousTotalTokens * (1 - MATERIAL_DROP_RATIO)
    ) {
      console.warn(
        `[sdk-engine] PS1 tripwire: totalTokens dropped from ${this.previousTotalTokens} to ${totalTokens} ` +
          `(>${MATERIAL_DROP_RATIO * 100}% drop) with no accompanying compact_boundary ` +
          `(autoCompactEnabled=${this.autoCompaction}) -- see docs/design/embedded-agent-sdk-engine.md §5 PS1`,
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
  /**
   * Transcript Restore, R1: report a resume the SDK refused, if that is what
   * just happened. Returns the human-readable turn-error message when it
   * fired, or `null` when this is an ordinary failure.
   *
   * **The condition is causal, not textual.** `resume` was requested and no
   * `system:init` has EVER arrived on this query, so the session never
   * started. Neither of the two obvious alternatives works: the result
   * subtype is `error_during_execution`, which is also what an ordinary
   * `interrupt()` produces, and the SDK's error wording ("No conversation
   * found with session ID: ...") is undocumented CLI text free to change on
   * any bump. What separates a cancel from a refused resume is that a
   * cancel always has a `system:init` behind it -- a turn was running -- and
   * a refused resume never does.
   *
   * Rests on PS6 (docs/design/embedded-agent-sdk-engine.md §5), which is on
   * the SDK-bump re-verification list: if a future SDK emits a `system:init`
   * before failing a resume, this returns `null` for every refused resume
   * and the failure becomes silent. That is the dangerous direction, which
   * is why the premise is named rather than assumed.
   *
   * Emits at most once. The failure is observable from two places (the error
   * `result`, and the throw the iterator raises immediately after), and the
   * server acts on the event, so a second copy would drive a second recovery.
   */
  private reportRefusedResume(): string | null {
    const requested = this.deps.resume;
    if (requested === undefined || this.sawSystemInit || this.resumeFailureReported) return null;
    this.resumeFailureReported = true;
    this.deps.emit({ v: 1, type: 'sdk-resume-failed', requestedSdkSessionId: requested, reason: 'refused' });
    return 'Could not resume the previous session; this worker is continuing with a fresh one. The conversation above is a record of what was said, not something this agent now remembers. Please send your message again.';
  }

  private handleFatal(message: string): void {
    if (this.dead) return;
    this.dead = true;
    this.deps.emit({ v: 1, type: 'fatal', message });
    this.dispose();
    this.settlePendingTurn();
  }
}
