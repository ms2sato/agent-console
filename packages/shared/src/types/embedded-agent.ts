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

export interface EmbeddedAgentDefinition {
  id: string;                 // uuid
  name: string;               // display name, e.g. "Ollama qwen3:32b"
  description?: string;
  provider: {
    baseUrl: string;          // OpenAI-compatible root, e.g. "http://localhost:11434/v1"
    model: string;            // model id passed in the chat.completions request
    apiKeyRef?: string;       // name of a key in the server-side key store; absent = no auth (local LLMs)
  };
  systemPrompt?: string;      // prepended to every conversation
  maxToolIterations?: number; // per user turn; default 25
  // undefined = default read-only set (Read/Glob/Grep), [] = all builtin tools off, explicit array = exact set
  enabledTools?: EmbeddedAgentToolName[];
  // opt-in explicit instruction-file list, each entry resolved relative to the
  // session's locationPath via resolveConfinedPath before being read into the
  // system prompt — see docs/design/embedded-agent-worker.md "AGENTS.md loader"
  instructions?: string[];
  contextWindowTokens?: number;  // Context Handoff (Phase A); operator-declared model context window, denominator for the usage ratio
  handoff?: { softRatio?: number; hardRatio?: number; auto?: boolean }; // Context Handoff (Phase A); auto is accepted/persisted but NOT read until Phase B
  createdBy: string;          // users.id of the creator (same UUID space as session.createdBy)
  createdAt: string;
  updatedAt: string;
}

/**
 * Commands the server writes to the subprocess stdin (one single-line JSON per
 * line, all carrying `v: 1`). The first command MUST be `init`; the loop exits
 * with code 2 if the first parsed line is not a valid `init`.
 */
export type EmbeddedAgentCommand =
  | {
      v: 1;
      type: 'init';
      mcp: { baseUrl: string; token: string };
      provider: { baseUrl: string; model: string; apiKey?: string };
      context: { sessionId: string; workerId: string; repositoryId?: string; cwd: string };
      systemPrompt?: string;
      // undefined = apply the loop's own default tool set, [] = no builtin tools, explicit array = exact set
      enabledTools?: EmbeddedAgentToolName[];
      instructions?: string[];
      maxToolIterations: number;
      restoredConversation?: EmbeddedAgentRestoredMessage[]; // Transcript Restore (#1123); absent = fresh conversation (today's v1 behavior)
    }
  | { v: 1; type: 'user-message'; id: string; text: string }
  | { v: 1; type: 'cancel' }
  | { v: 1; type: 'handoff' }  // Context Handoff (Phase A); manual trigger
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
  | { v: 1; type: 'context-usage'; promptTokens: number; estimated: boolean }  // Context Handoff (Phase A); emitted after every turn/handoff attempt that produced a usable value
  | { v: 1; type: 'context-handoff'; distillation: string };  // Context Handoff (Phase A); persisted marker, emitted immediately before the atomic conversation reset

/**
 * Events the SERVER (not the loop) appends into the persisted stream so the
 * on-disk log is the complete transcript: the user message it forwarded to
 * stdin, and the row it writes when the subprocess exits. Clients that parsed
 * only `EmbeddedAgentEvent` would silently drop every user message and exit row
 * from replayed history.
 */
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
    }
  | { v: 1; type: 'exited'; code: number | null };

/**
 * What actually lives in the worker output file and is replayed to clients.
 * The client parses persisted/replayed history with THIS union, never the
 * loop-only `EmbeddedAgentEvent` union.
 */
export type EmbeddedAgentStreamEvent = EmbeddedAgentEvent | EmbeddedAgentServerEvent;
