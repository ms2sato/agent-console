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

import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';

import type { PtyNotificationKind } from './system-events.js';
import type { ExitReason } from './worker.js';

/**
 * Builtin subprocess-local tool names, as a hand-written union type.
 *
 * This type intentionally has NO import from schemas/embedded-agent.ts:
 * packages/shared/src/types must never import packages/shared/src/schemas
 * (`.dependency-cruiser.cjs`'s `shared-no-types-import-schemas` rule forbids
 * the edge, and treats a type-only import exactly the same as a value
 * import -- verified directly: adding a throwaway `import type` from
 * schemas/embedded-agent.ts here trips the same depcruise error a value
 * import would).
 *
 * The RUNTIME source of truth -- `EMBEDDED_AGENT_TOOL_NAMES` (the SINGLE
 * WRITER of the tool-name literals) and `DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS`
 * -- lives in schemas/embedded-agent.ts instead, so `SCHEMA_VERSION`'s
 * content hash (over packages/shared/src/schemas/*.ts) tracks the wire
 * vocabulary; a constant living here would be invisible to that hash even
 * though it widens what the wire schema accepts. This type is pinned
 * bidirectionally against that schema's picklist -- see the pin in
 * schemas/embedded-agent.ts for what happens if the two literal lists drift.
 *
 * `Bash`'s implementation ships in FF-1b (packages/embedded-agent/src/tools/bash.ts);
 * `Write`/`Edit`'s implementations ship in FF-1c
 * (packages/embedded-agent/src/tools/write.ts, edit.ts). All three stay OFF by
 * default — see DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS in schemas/embedded-agent.ts.
 *
 * `TodoWrite` is a planning/task-list tool: it lets the agent
 * publish a live task list to the user rather than acting on the filesystem
 * or a shell, so it stays ON by default alongside the read-only set. On
 * `claude-sdk` it is the SDK's own native builtin (enabled just by appearing
 * in the allowlist passed to `query()`); on `openai-api` it is implemented in
 * packages/embedded-agent/src/tools/todo-write.ts.
 */
export type EmbeddedAgentToolName = 'Read' | 'Glob' | 'Grep' | 'Bash' | 'Write' | 'Edit' | 'TodoWrite';

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
  context: {
    sessionId: string;
    workerId: string;
    repositoryId?: string;
    cwd: string;
    /**
     * Additional confinement roots (besides `cwd`) that the subprocess's
     * builtin `Read` tool may open. Absent/empty = no extra roots (today's
     * behavior, unchanged). This exists so `openai-api`'s own `Read` tool
     * (confined to `cwd` via `resolveConfinedPath`) can reach message
     * attachments saved to a shared per-OS-user upload directory outside the
     * session's worktree. `claude-sdk`'s native `Read` tool ignores this
     * field -- it is not ours to confine, and a live probe confirmed it can
     * already open files outside `cwd` under our production
     * `permissionMode`.
     */
    attachmentRoots?: string[];
  };
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
/**
 * The newest authoritative context reading found in a restored worker's
 * persisted log, carried on the `init` command so the
 * subprocess's restore-boundary compaction check can be decided by a
 * MEASUREMENT rather than by re-estimating the reconstructed text.
 *
 * Why it exists: `estimateTokensFromChars` sums message `.content` only,
 * while the request a provider actually prices also carries every published
 * tool schema. That makes the estimate systematically low by roughly a fixed
 * per-worker constant -- measured on a real instance at 1102 estimated
 * against 6722 reported for the same request. Against a small declared
 * window that constant is the dominant term, and a conversation that would
 * overflow can sit below the threshold and compact nothing.
 *
 * `estimated` is the reading's OWN honesty, carried forward unchanged: a
 * provider that never sends `usage` leaves the loop falling back to the
 * estimator, and a reading born that way must not arrive here claiming to be
 * a measurement.
 */
export interface EmbeddedAgentRestoredUsage {
  promptTokens: number;
  estimated: boolean;
}

export type EmbeddedAgentCommand =
  | (EmbeddedAgentInitCommandBase & {
      engine: 'openai-api';
      /**
       * `reasoningEffort` (agent-surface.md Ruling 3, #1554): the resolved
       * worker-override-beats-definition-default value, or absent when no
       * override is set for this worker. Pass-through to the provider's
       * chat.completions request body `reasoning_effort` field
       * (`openai-chat-adapter.ts`) -- no local value validation at this
       * layer; not every OpenAI-compatible provider honors it, the provider
       * is the authority (see `EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES`
       * for the capability declaration).
       */
      provider: { baseUrl: string; model: string; apiKey?: string; reasoningEffort?: string };
      /**
       * Transcript Restore: the newest authoritative context reading from
       * the persisted log, seeding the restore-boundary compaction check.
       * See docs/design/embedded-agent-worker.md "Seed extraction". Absent when the worker never completed a turn (and
       * never compacted), which is a legitimate state -- the subprocess then
       * falls back to the estimator, bias and all.
       *
       * Lives on the `openai-api` arm rather than the shared base for the
       * same reason `resume` lives on the other one: `claude-sdk` carries
       * its own context state through the SDK resume and computes no ratio
       * of its own, so an init for that engine carrying a seed is not a
       * thing that should be representable.
       */
      restoredUsage?: EmbeddedAgentRestoredUsage;
    })
  | (EmbeddedAgentInitCommandBase & {
      engine: 'claude-sdk';
      // No apiKey -- absent by construction, not merely optional (§3.2).
      /**
       * `effort` (agent-surface.md Ruling 3, #1554): the resolved
       * worker-override value, or absent when no override is set. Named
       * `effort`, NOT `reasoningEffort` like the `openai-api` arm above --
       * mirrors the SDK's own `Options.effort` field name (one wire field
       * per parameter, semantics/naming per-engine; see the terminal-agent
       * precedent, `InternalAgentWorker.reasoningEffort` populating the
       * `{{ effort... }}` template variable). Values are a closed domain
       * (`EFFORT_LEVELS`); consumed at `sdk-engine.ts`'s `buildOptions()`.
       */
      provider: { model: string; effort?: EffortLevel };
      /**
       * Transcript Restore, R1: resume THIS SDK session instead of starting
       * a fresh one. Present only on a re-activation whose worker carries a
       * persisted `sdkSessionId` that the server's `getSessionInfo`
       * pre-flight found; absent on a first-ever activation, on a worker
       * with no id yet, and whenever the pre-flight came back empty.
       *
       * Lives on the `claude-sdk` arm rather than the shared base because
       * the other engine has no concept of it -- an `openai-api` init
       * carrying a `resume` is not a thing that should be representable.
       *
       * The engine has NO other source for a resume id (Appendix A's
       * re-scoped init pin): not `listSessions()`, not a scan of the SDK's
       * on-disk transcripts, not a value remembered from an earlier query.
       * It comes from the `workers` row through this field, or the session
       * is fresh.
       */
      resume?: { sdkSessionId: string };
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
 * Why a `sdk-resume-failed` could not resume. SINGLE WRITER of these literals
 * -- the valibot picklist and every branch that reads the reason derive from
 * this constant rather than restating it, so a new reason cannot reach the
 * type without also reaching the wire schema.
 *
 * - `not-found`: the activation-time pre-flight RAN and the SDK reported that
 *   it could not find the session. **Not proof that the session is absent**
 *   -- on SDK `0.3.238` the store swallows read errors, so an EACCES, an
 *   EISDIR, or a malformed transcript all arrive here too (measured; see
 *   PS7's table in docs/design/embedded-agent-sdk-engine.md). It is a
 *   statement about one moment's read, which is exactly why the persisted id
 *   is kept for the next activation to try again. No resume was attempted
 *   and no turn was lost; the engine started fresh.
 * - `lookup-failed`: the pre-flight could not run at all -- the lookup itself
 *   raised. Not a verdict about the session either. Currently unreachable for
 *   the same measured reason `not-found` is over-broad: the SDK returns
 *   rather than throws. Kept as the shape for a version that propagates the
 *   error.
 * - `refused`: a resume WAS attempted and the SDK rejected it, which costs
 *   the turn that was in flight and leaves the query dead inside a live
 *   harness -- the server has to replace the incarnation, and a `turn-error`
 *   telling the user to resend is emitted alongside this event.
 *
 * **Only `refused` clears the persisted `sdkSessionId`.** The id was offered
 * and rejected, and re-offering it repeats the damage; the other two decided
 * before a resume was ever sent, so re-checking costs one pre-flight and no
 * turn. What clears a kept id is the fresh session superseding it at its
 * first `sdk-session-id` -- the right authority, because once the user has
 * spoken to the fresh session that session is the conversation.
 *
 * One event with a reason rather than three events: the reasons share a
 * subject (this id did not resume) and differ only in what the server does
 * next.
 */
export const SDK_RESUME_FAILURE_REASONS = ['not-found', 'lookup-failed', 'refused'] as const;

export type SdkResumeFailureReason = (typeof SDK_RESUME_FAILURE_REASONS)[number];

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
  /**
   * Compaction; emitted after every turn/compaction attempt that produced a
   * usable value.
   *
   * `appearsClamped` is window-declaration drift, signal 2: OUR inference,
   * from a measured signature, that this reading is the provider's own input
   * cap rather than the conversation's size. It carries no number on purpose
   * -- the inferred cap IS `promptTokens`, and a second copy of one value on
   * one reading is two things that can disagree. Contrast
   * `context-compacted`'s `providerStatedWindowTokens`, which is THEIR
   * number; two independent facts must not share one name.
   *
   * Three-valued by absence, and there is deliberately no `false`: missing
   * means "not inferred, OR a row written before this field existed", and no
   * consumer needs to assert that a reading was checked and found honest.
   * Test presence explicitly; never the event's truthiness.
   *
   * Old-client behaviour: these schemas are strict, so a bundle that predates
   * this field rejects the whole row rather than dropping the field -- which
   * is handled, not a gap. See `packages/shared/src/schemas/index.ts`'s header
   * for the standing ruling (reload heals the ordinary path; the degraded path
   * drops under the schema-version banner's declaration).
   */
  | { v: 1; type: 'context-usage'; promptTokens: number; estimated: boolean; appearsClamped?: true }
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
   *
   * `preTokens` measures the distillation's INPUT, not the whole
   * pre-compaction conversation. For a FULL compaction those are the same
   * number, so this distinction is invisible. For a PARTIAL one (`coverage
   * === 'partial'`) the input is a narrowed tail suffix, so `preTokens` is
   * the suffix's size and under-reports the true before-size -- and it does
   * so exactly in the case that discarded the most, since a smaller input is
   * what a partial distillation feeds the provider. This is deliberate, not
   * a bug to fix by fabricating a whole-conversation estimate: `preTokens`
   * is the only REAL count available at emit time, and an estimate over the
   * full conversation would report smaller still (see
   * docs/design/embedded-agent-worker.md's "Measured: `E` under-counts"
   * note) besides mixing a measurement and a guess in one field. No
   * whole-conversation-size field is added for this reason -- see
   * `coverage` below for how the divergence is declared instead.
   */
  | {
      v: 1;
      type: 'context-compacted';
      source: 'auto' | 'manual';
      summary?: string;
      preTokens?: number;
      postTokens?: number;
      /**
       * Window-declaration drift, signal 3: the input limit the PROVIDER
       * named, when this compaction was forced by an over-window rejection
       * that stated one. Their number, extracted from a measured signature --
       * contrast `context-usage`'s `appearsClamped`, which is our own
       * judgement and therefore carries no number at all.
       *
       * Absent whenever no number was extracted, which is the ordinary case:
       * every rule upstream fails toward saying nothing rather than toward a
       * guess, because the consumer of this number tells an operator their
       * configuration is wrong.
       *
       * Old-client behaviour: strict schemas reject the whole row rather than
       * dropping an unknown field. See `packages/shared/src/schemas/index.ts`'s
       * header -- the ordinary path heals via the schema-version reload, and
       * the degraded path drops under the banner's declaration.
       */
      providerStatedWindowTokens?: number;
      /**
       * Whether the distillation summarised the WHOLE conversation
       * (`'full'`) or only a recent tail suffix of a longer one
       * (`'partial'`) -- a fact the marker previously had no way to state,
       * which left both the restore seed's totality claim and the
       * transcript's before-size display unable to distinguish the two
       * shapes.
       *
       * Three-valued by ABSENCE, and there is deliberately no third literal
       * for it: missing means UNKNOWN -- a row written before this field
       * existed -- and NEVER means `'full'`. No consumer may treat absence
       * as a totality claim: `buildCompactionSeedMessages` (embedded-agent)
       * and the transcript boundary label (client) both branch on all three
       * states explicitly rather than defaulting an absent value to
       * `'full'`.
       *
       * Old-client behaviour: strict schemas reject the whole row rather
       * than dropping an unknown field. See
       * `packages/shared/src/schemas/index.ts`'s header -- the ordinary path
       * heals via the schema-version reload, and the degraded path drops
       * under the banner's declaration.
       */
      coverage?: 'full' | 'partial';
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
  | { v: 1; type: 'sdk-session-id'; sdkSessionId: string }
  /**
   * Transcript Restore, R1: the engine was asked to `resume` a session and
   * the SDK refused it. The MACHINE-readable half of the failure -- the
   * human-readable half is the `turn-error` emitted alongside it, which
   * names the cause and tells the user their message needs resending.
   * Deliberately not one event doing both jobs: the server must never have
   * to string-match a `turn-error` message to decide what happened.
   *
   * Detection is structural, not textual (PS6,
   * docs/design/embedded-agent-sdk-engine.md §5): the query reached a
   * terminal error without ever having reported a `system:init`. It cannot
   * key on the result subtype -- `error_during_execution` is also what an
   * ordinary `interrupt()` produces -- nor on the SDK's error wording,
   * which is undocumented. What separates the two is causal: a cancel
   * always has a `system:init` behind it, because a turn was running; a
   * failed resume never does, because the session never started.
   *
   * `requestedSdkSessionId` is the id that failed, echoed so the server can
   * confirm it is clearing the id it actually asked for rather than one
   * that changed underneath it.
   */
  | {
      v: 1;
      type: 'sdk-resume-failed';
      requestedSdkSessionId: string;
      /** See {@link SdkResumeFailureReason}. */
      reason: SdkResumeFailureReason;
    };

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
  /**
   * Transcript Restore, R1 (the local half of #1273): the turn that was in
   * flight when this worker's previous incarnation died never reached a
   * terminal event. Appended at activation, immediately after the replay
   * that detected it, and rendered as a marker row so a conversation cut
   * off mid-turn says so instead of ending in silence.
   *
   * Detection (single writer:
   * docs/design/embedded-agent-sdk-engine.md Appendix A.3) is a
   * `user-message` with neither `state: 'idle'` nor `turn-error` after it.
   * `exited` is deliberately NOT terminal for this purpose.
   *
   * Server-authored, and deliberately NOT a synthesized `turn-error`: A.3's
   * rule is that the server does not forge engine-authored events. No
   * engine reported an error here, and inventing one would be a claim about
   * what the model did. This event states only what the server observed
   * about its own transcript.
   *
   * `turnId` is the unanswered `user-message`'s own `id`, so the client can
   * attach the marker to that turn rather than guessing from position.
   */
  | { v: 1; type: 'turn-interrupted'; turnId: string }
  /**
   * The server observed this incarnation's subprocess exit.
   *
   * `reason` is THREE-VALUED and its absence is a fourth state, so read it
   * with an equality test and nothing else:
   *
   * - The server stamps `reason` on every `exited` row it appends, so a live
   *   server always writes one of the three {@link ExitReason} values.
   * - **Absent means the row predates this field** -- a persisted transcript
   *   written by an older server. An absent `reason` must render exactly as
   *   it always did, which is why the field is optional rather than
   *   defaulted.
   * - Consumers therefore test `reason === 'evicted'`, NEVER `!reason` or a
   *   truthiness check: `!reason` folds a historical row in with a live
   *   eviction, and truthiness folds `managed` in with `evicted`.
   * - This is the single identifier for "this exit was an idle eviction".
   *   There is deliberately no parallel boolean to drift against it.
   */
  | {
      v: 1;
      type: 'exited';
      code: number | null;
      reason?: ExitReason;
      /**
       * A bounded tail of this incarnation's stderr, present ONLY when
       * `reason === 'unexpected'` and the subprocess wrote non-empty stderr.
       * Never present for `'managed'` or `'evicted'` exits -- a routine
       * deactivate or eviction should never carry leftover stderr as if it
       * explained anything. Absent means absent, never `''`; consumers test
       * `stderrTail !== undefined`, mirroring how `reason` is handled above.
       * Holds the last STDERR_TAIL_CAP characters (UTF-16 code units, not
       * bytes and not an overall wire-size bound -- JSON-escaping can inflate
       * the serialized size past a simple UTF-8 multiplier) -- see
       * embedded-agent-worker-service.ts.
       */
      stderrTail?: string;
    }
  /**
   * Transcript Restore, R2 (#1447 stage 4): a restore attempt failed to
   * reconstruct the persisted transcript (`RestoreReconstructionError` or
   * any other reconstruction failure). Appended to the SAME live stream in
   * place of R1's fallback reset -- every byte before it is retained for
   * DISPLAY, but the walk-back assembler and `reconstructConversation` must
   * never read past it: the NEXT restore's memory begins here, empty. This
   * is what turns a single corrupt region into a one-time loss instead of a
   * permanent restore-failure loop.
   *
   * A reconstruction BOUNDARY, the same class as `context-compacted` --
   * see `restore.ts`'s `BOUNDARY_EVENT_TYPES`. Deliberately NOT a
   * notification-field `user-message` row (#1351's class): that form is
   * restore-TRANSPARENT by design, and this marker must be the opposite of
   * transparent -- reconstruction must STOP here, never read through it.
   * Contrast with {@link EmbeddedAgentServerEvent}'s
   * `'restore-failure-declaration'` member below, which is transparent by
   * the same design decision, for the opposite reason: it declares an
   * asymmetry reconstruction must IGNORE, not a discard it must respect.
   *
   * Deliberately carries NO `summary` field, unlike `context-compacted`:
   * there is no summary to carry forward here -- memory starts from
   * nothing, not from a compaction's distillation of what came before. Its
   * absence is what makes the reconstruction caller's choice of seed
   * builder a compile-time distinction rather than a review convention --
   * see `conversation-seed.ts`'s `buildRestoreFailureSeedMessages`, and
   * `restore.ts`'s `boundarySummary` (never called for this member; the
   * caller branches before reaching it).
   */
  | { v: 1; type: 'restore-failure-boundary' }
  /**
   * Transcript Restore, R6 (#1447 stage 4): written into the
   * FRESH (post-reset) live file when R1's fallback reset runs for a
   * `claude-sdk` worker whose `sdkSessionId` survives the reset -- the SDK's
   * own session store still remembers the discarded conversation even
   * though the display no longer can. Declares that asymmetry so it
   * outlives the incarnation that discovered it: the incarnation-scoped
   * `restore-info` failure form (`sdkResumed`) is gone the moment that
   * incarnation's connections detach, but the SDK's memory persists, so the
   * declaration must too.
   *
   * `openai-api` fallback resets write no such row -- reconstruction IS
   * that engine's memory, so a Loss there is already symmetric and already
   * declared by the failure form. Only `claude-sdk` has a second store that
   * can outlive the display.
   *
   * Restore-TRANSPARENT (#1351's class), the OPPOSITE of
   * `'restore-failure-boundary'` above and deliberately so: that member
   * declares a discard reconstruction must RESPECT (stop there); this one
   * declares an asymmetry reconstruction must IGNORE (keep replaying
   * through it as ordinary noise -- see `restore.ts`'s `replayWindow`
   * Noise case group). It must never alter window semantics.
   */
  | { v: 1; type: 'restore-failure-declaration' };

/**
 * What actually lives in the worker output file and is replayed to clients.
 * The client parses persisted/replayed history with THIS union, never the
 * loop-only `EmbeddedAgentEvent` union.
 */
export type EmbeddedAgentStreamEvent = EmbeddedAgentEvent | EmbeddedAgentServerEvent;
