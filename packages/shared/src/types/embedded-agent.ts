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
      maxToolIterations: number;
    }
  | { v: 1; type: 'user-message'; id: string; text: string }
  | { v: 1; type: 'cancel' }
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
  | { v: 1; type: 'assistant-message'; turnId: string; text: string }
  | { v: 1; type: 'tool-call'; turnId: string; callId: string; name: string; args: unknown }
  | { v: 1; type: 'tool-result'; turnId: string; callId: string; ok: boolean; result: string }
  | { v: 1; type: 'turn-error'; turnId: string; message: string }
  | { v: 1; type: 'fatal'; message: string };

/**
 * Events the SERVER (not the loop) appends into the persisted stream so the
 * on-disk log is the complete transcript: the user message it forwarded to
 * stdin, and the row it writes when the subprocess exits. Clients that parsed
 * only `EmbeddedAgentEvent` would silently drop every user message and exit row
 * from replayed history.
 */
export type EmbeddedAgentServerEvent =
  | { v: 1; type: 'user-message'; id: string; text: string }
  | { v: 1; type: 'exited'; code: number | null };

/**
 * What actually lives in the worker output file and is replayed to clients.
 * The client parses persisted/replayed history with THIS union, never the
 * loop-only `EmbeddedAgentEvent` union.
 */
export type EmbeddedAgentStreamEvent = EmbeddedAgentEvent | EmbeddedAgentServerEvent;
