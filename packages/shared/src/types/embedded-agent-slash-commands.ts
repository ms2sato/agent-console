import type { EmbeddedAgentEngine } from './embedded-agent.js';

/**
 * Per-engine slash-command table (#1572). SINGLE WRITER of which
 * slash commands the composer offers for completion, per engine, and of
 * how each one is handled once sent -- the client's completion source and
 * the server's `sendUserMessage` interception (see
 * `embedded-agent-worker-service.ts`) both read this table rather than
 * re-deriving it.
 *
 * A slash command is offered ONLY when the engine actually honours it.
 * Offering a command the engine ignores would let it reach the model as
 * ordinary prose -- silently wrong, and indistinguishable from a typo to
 * the user. See docs/design/embedded-agent-worker.md's "Slash commands"
 * section for the contract this table backs, and
 * docs/design/embedded-agent-sdk-engine.md §4 for the `claude-sdk` probe
 * this file's `claude-sdk` content is measured from (#1572's own probe,
 * not assumed from the SDK's own advertised `slash_commands` list -- that
 * list only corroborates it; see the per-entry notes below).
 */
export interface EmbeddedAgentSlashCommand {
  /** Includes the leading slash, e.g. '/compact'. */
  name: string;
  /** Short, user-facing description shown in the completion list. */
  description: string;
  /**
   * `'engine'`: forwarded as an ordinary user-turn string; the engine
   * itself recognizes and interprets it (the SDK's own built-in slash
   * commands, for `claude-sdk`).
   *
   * `'console'`: the SERVER intercepts it before it reaches the engine as
   * prose, and maps it to an existing console operation instead (e.g.
   * `openai-api`'s manual compaction, which that engine has no slash-
   * command parser of its own to honour). Every `console`-handled entry
   * across this whole table must have a corresponding handler -- mechanically
   * pinned by `embedded-agent-worker-service.test.ts` (the handler map lives
   * server-side, since interception is server-side, per this table's
   * (#1572) "single writer" ruling).
   */
  handledBy: 'engine' | 'console';
}

/**
 * `claude-sdk`: measured empirically against a real conversation
 * (#1572's own probe; `claude --version` 2.1.259 / SDK-reported
 * `system:init.claude_code_version` 2.1.238 -- the two differ on this host,
 * per #1575; `@anthropic-ai/claude-agent-sdk` 0.3.238).
 *
 * - `/compact`: honoured. On a real conversation, a genuine distillation
 *   turn produces the SDK's own `compact_boundary`, mapped to our
 *   `context-compacted` event (pre-existing; Probe #1400 P2). On an
 *   empty/short conversation the SDK declines with a SYNTHETIC reply
 *   (`model: "<synthetic>"`, no real API call, and -- until sdk-engine.ts's
 *   `handleAssistantMessage` fallback -- no `stream_event` at all, which
 *   used to mean the decline was silently dropped; see that file's
 *   `COMPACT_SLASH_COMMAND` doc comment).
 * - `/cost`: honoured. A synthetic real usage report; it is an alias of
 *   `/usage` (confirmed via `system:init.slash_commands`, which lists
 *   `usage` but not `cost`).
 * - `/context`: honoured. A synthetic context-usage report -- redundant
 *   with the client's own context-usage bar, but harmless to forward.
 *
 * Two SDK-recognized slash commands are DELIBERATELY EXCLUDED, so a future
 * reader does not re-add them just because `system:init.slash_commands`
 * lists them:
 *
 * - `/clear`: the SDK honours it (a top-level `conversation_reset` message,
 *   resetting the SDK's OWN conversation state), but our persisted
 *   transcript has no matching reset -- the SDK's memory would silently
 *   diverge from what the console displays, with nothing declared. Offering
 *   it would invite exactly that divergence. `sdk-engine.ts` now maps an
 *   observed `conversation_reset` to a `turn-error` declaring the
 *   divergence, for the case where a user types `/clear` anyway (this
 *   engine forwards ANY text unconditionally -- there is no console-side
 *   gate).
 * - `/model <name>`: the SDK honours it, but only for the current session
 *   (a synthetic "session-only" reply) -- it does NOT persist, which
 *   conflicts with agent-surface.md Ruling 3's worker-persisted-override
 *   contract (a later eviction/restart would silently revert it). Model
 *   persistence is tracked separately (#1521 Phase 3); the unknown-slash
 *   notice on the frontend covers a user who types `/model` anyway.
 *
 * `openai-api`: `agent-loop.ts` does no slash-command parsing of its own --
 * every candidate would otherwise reach the model as ordinary prose. The
 * one entry here (`/compact`) is `console`-handled: the server intercepts
 * it and calls `Engine.compactNow()` (`AgentLoop.compactNow`) directly,
 * never forwarding the literal text.
 */
export const EMBEDDED_AGENT_SLASH_COMMANDS: Record<EmbeddedAgentEngine, readonly EmbeddedAgentSlashCommand[]> = {
  'claude-sdk': [
    { name: '/compact', description: 'Compact this conversation now', handledBy: 'engine' },
    { name: '/cost', description: 'Show current usage', handledBy: 'engine' },
    { name: '/context', description: 'Show context window usage', handledBy: 'engine' },
  ],
  'openai-api': [{ name: '/compact', description: 'Compact this conversation now', handledBy: 'console' }],
} as const;
