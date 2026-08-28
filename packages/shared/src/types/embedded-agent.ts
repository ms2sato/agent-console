/**
 * Embedded agent definitions and the stdio protocol between the server and the
 * embedded-agent subprocess.
 *
 * An `EmbeddedAgentDefinition` configures an agent that owns its LLM loop
 * (OpenAI-compatible provider + model), distinct from an `AgentDefinition`
 * which describes how to launch a terminal program. The two registries are
 * deliberately separate: their configuration shapes are disjoint and their id
 * namespaces must not be confused.
 *
 * See docs/design/embedded-agent-worker.md Part II for the normative spec.
 */

import type { PtyNotificationKind } from './system-events.js';

/**
 * Builtin subprocess-local tool names. This is the SINGLE WRITER of builtin
 * tool-name literals in the repo — every other usage must reference this
 * constant or the derived `EmbeddedAgentToolName` type, not a hardcoded list.
 *
 * `Bash`'s implementation ships in FF-1b (packages/embedded-agent/src/tools/bash.ts);
 * `Write`/`Edit`'s implementations ship in FF-1c
 * (packages/embedded-agent/src/tools/write.ts, edit.ts). All three stay OFF by
 * default — see DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS below.
 */
export const EMBEDDED_AGENT_TOOL_NAMES = ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit'] as const;
export type EmbeddedAgentToolName = (typeof EMBEDDED_AGENT_TOOL_NAMES)[number];

/**
 * Wire-shape for one tool call inside a restored assistant message.
 * Structurally identical to embedded-agent's own internal `ToolCall`
 * (packages/embedded-agent/src/providers/types.ts) -- duplicated here
 * because the wire-protocol type boundary (shared) must not depend on a
 * provider-internal package (embedded-agent depends on shared, never the
 * reverse).
 */
export interface EmbeddedAgentRestoredToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * Wire-shape for the `init` command's `restoredConversation` field
 * (Transcript Restore, #1123). Structurally identical to embedded-agent's
 * internal `ChatMessage` union -- see EmbeddedAgentRestoredToolCall doc.
 */
export type EmbeddedAgentRestoredMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: EmbeddedAgentRestoredToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * Default when a definition's `enabledTools` is absent: read-only tools ON, Bash OFF.
 *
 * Note that a definition that has ever been through the Add/Edit form persists
 * `enabledTools` as an explicit array (never leaves it `undefined`) — so a
 * change to this default does NOT propagate to already-edited definitions.
 * Only definitions that have never been saved through the form (still
 * `undefined` at the DB level) pick up a change here.
 */
export const DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS: readonly EmbeddedAgentToolName[] = [
  'Read',
  'Glob',
  'Grep',
];

/**
 * Ratio of `contextWindowTokens` at which the `openai-api` engine compacts
 * automatically, when a definition leaves `compaction.threshold` unset.
 *
 * The 15% of the window this leaves unused is not slack for its own sake: the
 * distillation is itself a provider request made against the still-uncompacted
 * conversation, so it needs room to run. A threshold at 1.0 would make the
 * request that is supposed to relieve the pressure the one that overflows.
 *
 * Lives in shared because two independent consumers read it: the loop (the
 * fire decision) and the client (the usage bar's colour bands escalate
 * against the same number the engine acts on).
 */
export const DEFAULT_COMPACTION_THRESHOLD = 0.85;

/**
 * Fields shared by both engine arms of {@link EmbeddedAgentDefinition}. See
 * docs/design/embedded-agent-sdk-engine.md §3.1 "Engine selection: a
 * structural discriminant, never inference" — the discriminant lives on the
 * definition, and each arm's `provider` shape is intentionally different
 * (the `claude-sdk` arm carries no `baseUrl`/`apiKeyRef`: §3.2 "no provider
 * secret crosses the server at all" in that engine).
 */
interface EmbeddedAgentDefinitionBase {
  id: string;                 // uuid
  name: string;               // display name, e.g. "Ollama qwen3:32b"
  description?: string;
  systemPrompt?: string;      // prepended to every conversation
  maxToolIterations?: number; // per user turn; default 25
  // undefined = default read-only set (Read/Glob/Grep), [] = all builtin tools off, explicit array = exact set
  enabledTools?: EmbeddedAgentToolName[];
  // opt-in explicit instruction-file list, each entry resolved relative to the
  // session's locationPath via resolveConfinedPath before being read into the
  // system prompt — see docs/design/embedded-agent-worker.md "AGENTS.md loader"
  instructions?: string[];
  contextWindowTokens?: number;  // Compaction; operator-declared model context window, denominator for the usage ratio
  compaction?: { threshold?: number }; // Compaction; the openai-api engine's auto-fire ratio, default DEFAULT_COMPACTION_THRESHOLD
  isBuiltIn: boolean;          // mirrors AgentDefinition.isBuiltIn (types/agent.ts); true only for the claude-sdk builtin (Phase 1) -- see services/embedded-agents/claude-sdk-builtin.ts
  createdBy: string;          // users.id of the creator (same UUID space as session.createdBy)
  createdAt: string;
  updatedAt: string;
}

/**
 * Definition of an agent that owns its own LLM loop. Discriminated on
 * `engine` (docs/design/embedded-agent-sdk-engine.md §3.1): `openai-api` is
 * the existing OpenAI-compatible custom loop (`agent-loop.ts` +
 * `providers/` + `tools/` + `mcp.ts`); `claude-sdk` hosts a Claude Agent SDK
 * session in the same subprocess harness. User-facing creation via the REST
 * route always produces an `openai-api` definition (hardcoded server-side,
 * `EmbeddedAgentManager.createEmbeddedAgent`) -- the `claude-sdk` engine is
 * registered as a builtin only in Phase 1, never user-created.
 */
export type EmbeddedAgentDefinition =
  | (EmbeddedAgentDefinitionBase & {
      engine: 'openai-api';
      provider: {
        baseUrl: string;       // OpenAI-compatible root, e.g. "http://localhost:11434/v1"
        model: string;         // model id passed in the chat.completions request
        apiKeyRef?: string;    // name of a key in the server-side key store; absent = no auth (local LLMs)
      };
    })
  | (EmbeddedAgentDefinitionBase & {
      engine: 'claude-sdk';
      // No baseUrl, no apiKeyRef -- the SDK subprocess runs as the executing
      // OS user and uses that user's own claude authentication; no provider
      // secret ever crosses the server (§3.2).
      provider: { model: string };
    });

/**
 * Fields shared by both engine arms of the `init` command. Mirrors
 * {@link EmbeddedAgentDefinition}'s base/engine-arm split -- see
 * docs/design/embedded-agent-sdk-engine.md §3.1.
 */
type EmbeddedAgentInitCommandBase = {
  v: 1;
  type: 'init';
  mcp: { baseUrl: string; token: string };
  context: { sessionId: string; workerId: string; repositoryId?: string; cwd: string };
  systemPrompt?: string;
  // undefined = apply the loop's own default tool set, [] = no builtin tools, explicit array = exact set
  enabledTools?: EmbeddedAgentToolName[];
  instructions?: string[];
  maxToolIterations: number;
  restoredConversation?: EmbeddedAgentRestoredMessage[]; // Transcript Restore (#1123); absent = fresh conversation (today's v1 behavior)
  /**
   * Compaction's activation-time configuration. `auto` is the WORKER's
   * toggle (`EmbeddedAgentWorker.autoCompaction`), not a definition field --
   * the decision belongs to the conversation in front of the user. The other
   * two come from the definition and are only meaningful to `openai-api`,
   * which computes the ratio itself; `claude-sdk` hands `auto` to the SDK
   * and lets it decide when.
   *
   * `contextWindowTokens` absent means `openai-api` auto compaction can
   * never fire: no denominator, therefore no ratio. That is a deliberate
   * structural gate, not a defaulted guess at the model's window.
   */
  compaction: { auto: boolean; contextWindowTokens?: number; threshold?: number };
};

/**
 * Commands the server writes to the subprocess stdin (one single-line JSON per
 * line, all carrying `v: 1`). The first command MUST be `init`; the loop exits
 * with code 2 if the first parsed line is not a valid `init`.
 */
export type EmbeddedAgentCommand =
  | (EmbeddedAgentInitCommandBase & {
      engine: 'openai-api';
      provider: { baseUrl: string; model: string; apiKey?: string };
    })
  | (EmbeddedAgentInitCommandBase & {
      engine: 'claude-sdk';
      // No apiKey -- absent by construction, not merely optional (§3.2).
      provider: { model: string };
    })
  | { v: 1; type: 'user-message'; id: string; text: string }
  | { v: 1; type: 'cancel' }
  /**
   * Compaction: the worker's auto-compaction toggle was changed while the
   * subprocess was running. Sent so the change applies without waiting for
   * the next activation. Not persisted (no command is), and idempotent --
   * re-sending the current value is a no-op.
   */
  | { v: 1; type: 'set-auto-compaction'; enabled: boolean }
  | { v: 1; type: 'shutdown' };

/**
 * Events the subprocess writes to stdout (one single-line JSON per line). These
 * are authored by the loop itself; the server parses them with the narrow
 * schema at the process boundary.
 */
export type EmbeddedAgentEvent =
  | { v: 1; type: 'ready' }
  | { v: 1; type: 'state'; state: 'active' | 'idle' }
  | { v: 1; type: 'assistant-delta'; turnId: string; text: string }
  | { v: 1; type: 'assistant-thinking-delta'; turnId: string; text: string }  // streamed reasoning/thinking chunk, no terminal counterpart — see turn-cycle doc
  | { v: 1; type: 'assistant-message'; turnId: string; text: string }
  | { v: 1; type: 'tool-call'; turnId: string; callId: string; name: string; args: unknown }
  | { v: 1; type: 'tool-result'; turnId: string; callId: string; ok: boolean; result: string }
  | { v: 1; type: 'turn-error'; turnId: string; message: string }
  | { v: 1; type: 'fatal'; message: string }
  | { v: 1; type: 'context-usage'; promptTokens: number; estimated: boolean }  // Compaction; emitted after every turn/compaction attempt that produced a usable value
  /**
   * Compaction's persisted boundary marker -- "one line marking the
   * compaction boundary appears in the transcript". Emitted immediately
   * before the atomic conversation replacement on `openai-api`, and on the
   * SDK's own `compact_boundary` for `claude-sdk`.
   *
   * `summary` is OPTIONAL because the two engines differ in what they can
   * offer: `openai-api` always has one (it authored the distillation),
   * while `claude-sdk` only has one if the SDK exposes it. A missing
   * summary renders as a plain boundary line, never as an error.
   *
   * `preTokens`/`postTokens` are how much context the compaction consumed
   * and produced. They exist because SDK-side compaction fidelity was
   * measured NON-DETERMINISTIC (see docs/design/embedded-agent-worker.md
   * § Compaction, "Summary fidelity"): the chosen response to that is to
   * make each compaction's aggressiveness VISIBLE rather than to build
   * machinery that tries to prevent it. A 102k -> 2.7k boundary reports its
   * own severity to the user. Both are optional for the same reason
   * `summary` is -- an engine that cannot supply them renders the plain
   * marker instead of a fabricated number.
   */
  | {
      v: 1;
      type: 'context-compacted';
      source: 'auto' | 'manual';
      summary?: string;
      preTokens?: number;
      postTokens?: number;
    }
  /**
   * RETIRED (Context Handoff, #1122): no engine emits this any more --
   * `context-compacted` above replaced it in #1401.
   *
   * The member is deliberately RETAINED, along with its runtime schema, its
   * restore-boundary handling, and the client's render path. Persisted
   * transcripts written before the swap contain these rows; removing the
   * type would break replay at the PARSE step, before rendering is even
   * reached. Emission is retired; parse and render are legacy-only.
   */
  | { v: 1; type: 'context-handoff'; distillation: string }
  /**
   * SDK engine only; native engine never emits this. Emitted on activation
   * and on every SDK-session replacement — the worker's CURRENT SDK session
   * id is X, last-write-wins. (Phase 2's context-handoff reseed was the only
   * replacement that ever happened; #1401 retired it, so today the id is
   * emitted once per activation. The event stays a dedicated one rather than
   * a `ready` field because a future re-session — idle eviction's `resume`,
   * #1336 — would replace it again.)
   * See docs/design/embedded-agent-sdk-engine.md §4 "Process lifetime" row.
   *
   * IMPORTANT: because `ready` is decoupled from the SDK's own
   * `system:init` handshake (a live probe against SDK 2.1.233 found
   * `system:init` does not arrive until the first prompt is yielded — see
   * that same design doc's Appendix A.2 `ready` row), this event is NOT
   * emitted at activation time; it arrives only once the first turn's
   * `system:init` lands. A freshly-activated worker legitimately has no
   * `sdk-session-id` yet — a missing/null `sdkSessionId` on a
   * freshly-activated worker is a LEGITIMATE "no session to resume yet"
   * state, never a fault condition. Any persistence-layer reader or future
   * consumer (e.g. Phase E's resume logic) must treat its absence
   * accordingly, not as an error.
   */
  | { v: 1; type: 'sdk-session-id'; sdkSessionId: string };

/**
 * Events the SERVER (not the loop) appends into the persisted stream so the
 * on-disk log is the complete transcript: the user message it forwarded to
 * stdin, and the row it writes when the subprocess exits. Clients that parsed
 * only `EmbeddedAgentEvent` would silently drop every user message and exit row
 * from replayed history.
 */
/**
 * Marker payload for a system-originated internal notification delivered as
 * a `user-message` server event. `kind`/`summary` derive
 * solely from the {@link PtyNotificationKind}-shaped params the notification
 * was composed from -- never from any reply-instructions suffix appended to
 * the delivered/persisted text (see
 * SessionManager.sendEmbeddedAgentSystemNotification).
 */
export interface EmbeddedAgentServerNotification {
  kind: PtyNotificationKind;
  summary?: string;
}

export type EmbeddedAgentServerEvent =
  | {
      v: 1;
      type: 'user-message';
      id: string;
      text: string;
      // Client-generated correlation id, echoed verbatim when the client
      // supplied one on the originating `embedded-user-message`. Separate
      // from the server-assigned `id` (which feeds the client entry key,
      // `user-${id}`) so a client-supplied value can never collide with or
      // pollute that key -- see docs/design/embedded-agent-worker.md. Absent
      // for server-originated sends (e.g. the initial prompt delivery),
      // which have no client to correlate with.
      clientMessageId?: string;
      // Present iff this user-message is a system-originated internal
      // notification (e.g. delivered via
      // SessionManager.sendEmbeddedAgentSystemNotification) rather than a
      // real human/API-caller message. This presence check IS the
      // discriminator -- there is no separate `origin` field that could
      // disagree with it.
      notification?: EmbeddedAgentServerNotification;
    }
  | { v: 1; type: 'exited'; code: number | null };

/**
 * What actually lives in the worker output file and is replayed to clients.
 * The client parses persisted/replayed history with THIS union, never the
 * loop-only `EmbeddedAgentEvent` union.
 */
export type EmbeddedAgentStreamEvent = EmbeddedAgentEvent | EmbeddedAgentServerEvent;
