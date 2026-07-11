# In-Process Agent System (Direction)

**Status:** Proposed / Direction note. This document captures a design direction, not an accepted implementation plan. It records *why* the option is coherent with the current architecture and *what* the major pieces would be, so a later design/implementation PR can build on a shared understanding.

## Summary

Today every agent in Agent Console is a **terminal program** (Claude Code, Aider, etc.) launched as a PTY-backed [AgentWorker](session-worker-design.md#worker-types-current--future). Because that program runs in a **separate OS process**, the only way for it to operate the application (create sessions, delegate worktrees, run processes, ...) is through an inter-process channel. That channel is the built-in **MCP server** (`packages/server/src/mcp/mcp-server.ts`).

This note proposes offering, **as an option alongside the terminal model**, an *in-process* agent: a server-side agent loop that talks to an LLM over an HTTP API and whose tool handlers call the service layer **directly**, with no MCP hop. The immediate target is broad model freedom -- OpenAI-compatible endpoints and, especially, **local LLMs**.

The two models are complementary, not a replacement: the terminal worker keeps its first-class seat for subscription-billed Claude Code; the in-process worker maximizes model freedom for API- and locally-served models.

## Background: how the app is operated today

The service layer is the common core. Both the MCP tools and the REST/WebSocket routes call into the **same** singleton service instances held in `AppContext` (`packages/server/src/app-context.ts`), and in several cases the exact same service functions:

```
  MCP tools        (mcp/mcp-server.ts)  --,
  REST routes      (routes/*.ts)        --+--> Service layer (services/*.ts)
  WebSocket        (websocket/)         --'     SessionManager / WorktreeService /
                                                 createWorktreeWithSession /
                                                 deleteWorktree / InteractiveProcessManager /
                                                 TimerManager / AnnotationService / ...
                                                 (single instances in AppContext)
```

For example, MCP `delegate_to_worktree` and `POST /api/repositories/:id/worktrees` both call the same `createWorktreeWithSession(...)`; MCP `close_session` and `DELETE /api/sessions/:id` both call `sessionManager.deleteSession(...)`. The MCP handlers add no business logic; they are a thin adapter over the shared core (they resolve the acting user from `session.createdBy` where a REST handler would use the authenticated request user, then converge on the identical service call).

## The core insight: MCP is a consequence of the process boundary

There are two independent process boundaries, and only one of them forces MCP:

```
  [Boundary A]  Agent  <->  server internal functions
  [Boundary B]  React UI (browser)  <->  server
```

- **Boundary A** -- today the agent is a PTY subprocess, so this boundary is crossed by a separate process. Crossing it requires IPC, and MCP is that IPC. This is the boundary the proposal changes.
- **Boundary B** -- the browser is always a separate process from the server, so the UI always talks over REST/WebSocket regardless of anything else. This boundary does **not** change.

Therefore MCP is not a free-standing choice; it is the necessary result of running the agent as a terminal program (a separate process). Remove the terminal nature of the agent -- run the agent *inside* the server process -- and Boundary A collapses: an in-process tool handler can call `appContext.sessionManager.xxx()` directly, and MCP is no longer needed for that agent.

## Proposal: an in-process agent as a new Worker type

The [Worker](session-worker-design.md#worker-types-current--future) abstraction already anticipates non-PTY workers (GitDiffWorker has `Has PTY: No`). The in-process agent slots in as a **new Worker type** rather than a product-level rewrite:

- Session / Worker lifecycle and the worker WebSocket channel (`/ws/session/:sessionId/worker/:workerId`) are reused unchanged.
- The difference is the worker's internals: instead of spawning a PTY, the server runs an agent loop and streams **structured events** to the client.
- Terminal AgentWorker and in-process agent worker coexist. This is an added option, not a removal of the terminal model.

### Agent loop and tool execution

The in-process loop implements the LLM tool-use cycle server-side: send messages + tool definitions to the model, receive text and tool calls, execute each tool, feed results back, repeat. Each tool handler calls the service layer directly (the same functions the MCP handlers wrap). No MCP, no IPC for Boundary A.

## Provider strategy: OpenAI API format first

Targeting the OpenAI Chat Completions request/response shape first is the highest-leverage starting point, because it is the de-facto lingua franca that many providers expose a compatible endpoint for: OpenAI, Azure OpenAI, OpenRouter, Groq, Together, Fireworks, DeepSeek, and local runtimes (Ollama, llama.cpp, vLLM, LM Studio). Tool/function calling is part of that same format, which is exactly what tool execution needs.

Design the boundary as a **provider adapter interface** so OpenAI-format is simply the first implementation:

```
  interface ProviderAdapter {
    // send messages + tools, receive a stream of text and tool-call events
    run(messages, tools, opts): AsyncIterable<TextDelta | ToolCall>
  }
```

Honest caveats to design around, not gloss over:

1. **Tool-calling fidelity varies across "OpenAI-compatible" providers.** Plain text generation is broadly consistent, but function-calling behavior, parallel tool calls, streaming of tool calls, and JSON-schema adherence differ by provider and model. "OpenAI format" guarantees text reach, not reliable tool-use reach.
2. **Anthropic / Claude is not OpenAI-native.** Its Messages API and `tool_use` blocks are a different shape. This is acceptable here (see the positioning section): subscription Claude belongs to the terminal worker, so an in-process Anthropic adapter is optional and low priority.

### Local LLMs are the prime target

Local models (via an OpenAI-compatible endpoint) have the fewest constraints: no subscription, no per-token billing, no rate limits, offline capable, privacy-contained, and any open-weights model. The constraint hierarchy inverts cleanly -- terminal/subscription is the most tightly coupled path, local in-process is the least. All of it is reached through the single OpenAI-format adapter.

## Reuse the tool definitions across MCP and in-process

Today the tool schemas are declared inline against the MCP SDK inside `mcp-server.ts` (`mcpServer.tool(name, description, zodSchema, handler)`). The in-process loop needs the same set of operations. To avoid duplicating tool definitions, extract a **provider-neutral tool registry** -- a list of `{ name, description, schema, handler }` where each handler calls the service layer -- and consume it from both sides:

```
                  ,-- MCP adapter        --> external terminal agent (Claude Code)
  tool registry --+
  (single source) '-- in-process loop    --> OpenAI-format models (option)
       |
       '--> every handler calls appContext.* (the shared core)
```

This keeps the "service layer is the common core, adapters are thin" property that already holds for MCP + REST/WS, and honors the project's no-duplication rule.

### A tool-call normalization layer

Because local/open models have the weakest tool-calling reliability and this app's value depends on the agent calling tools correctly, the in-process loop should own a normalization layer between the provider adapter and the tool registry:

- Validate tool-call arguments against the schema and retry on malformed output.
- Where the runtime supports it, use constrained decoding / grammar (for example llama.cpp or vLLM structured output) to force schema-valid arguments.
- Provide a text-parse fallback for models without native tool-calling.

This is the one place the design must actively invest; it is what makes "any model" hold up rather than degrade.

## UI: a structured worker view alongside the terminal

The client renders a worker by the shape of what flows over its WebSocket channel:

| | Terminal AgentWorker (today) | In-process agent worker (proposed) |
|---|---|---|
| Agent output | raw terminal bytes (ANSI) | structured events (text / tool call / tool result) |
| Client render | xterm.js terminal emulation | chat / structured view (messages, tool-call cards) |
| Transport payload | PTY stdout stream | streamed agent events |

The plumbing (session/worker model, worker WebSocket) is shared; only the payload type and the rendering component differ. The "dedicated React UI" is a consequence of the payload changing from terminal bytes to structured events, **not** of the UI calling internal functions directly (Boundary B is unchanged; the browser still goes over the wire).

## Positioning vs Claude and the subscription model

Claude being second-class on the in-process path is expected and is a clean division of labor, not a defect:

- Anthropic's flat-rate subscription (Pro / Max) is usable **only through Claude Code** (the agent/CLI), while raw API access is separately metered per token. The in-process path is an API-billed world, so subscription Claude has no advantage there.
- Consequently the two worker types map onto two access/billing models:

| | Terminal Worker (today) | In-process Worker (proposed) |
|---|---|---|
| Primary models | Claude via subscription (flat rate) | OpenAI-format API + local models |
| Path | Claude Code + MCP | in-process loop + direct API |
| Claude's standing | first-class (best value on flat rate) | works only if API-billed; low priority |

So there is no need to force Claude to be first-class in-process: subscription Claude keeps its first-class seat on the terminal worker, and the in-process Anthropic adapter can be an optional add-on for users who want to spend API credits inside the unified in-process UI. Net effect: the terminal worker (best-in-class Claude) and the in-process worker (maximum model freedom) coexist and cover each other's weak spots.

## Trade-offs

- **Gain:** direct in-process function calls for the built-in agent, no MCP/IPC layer on Boundary A, structured events enabling a richer UI, and broad model freedom (API + local) through one adapter.
- **Cost:** the in-process path reimplements the agent loop and does not inherit Claude Code's built-in capabilities (its own file editing, shell, context management, hooks, skills). The terminal model's strength -- running *any* terminal-based agent unmodified -- is exactly what the in-process model gives up in exchange for direct integration. Offering both as options is what preserves both strengths.

## Non-goals

- Removing or deprecating the terminal AgentWorker or the MCP server. Both remain the primary path.
- Committing to specific providers, model lists, or a concrete schema for the structured event payload. Those belong to a follow-up design PR.

## Rough sequencing (for a later plan)

1. Extract the provider-neutral tool registry without breaking the MCP adapter.
2. Define the provider adapter interface and implement the OpenAI-format adapter plus the tool-call normalization layer (built with local LLMs in mind).
3. Add the in-process agent worker type to the Worker union and SessionManager.
4. Add the structured worker view in the client alongside xterm.

## Cross-references

- [Session & Worker Design](session-worker-design.md) -- Worker type union and the non-PTY worker precedent.
- [Custom Agent Registration Design](custom-agent-design.md) -- the existing **terminal-based** custom-agent path (template + PTY spawn). The in-process agent is a distinct execution model, not a variant of that template mechanism.
- [WebSocket Protocol](websocket-protocol.md) -- the worker channel the structured view would reuse.
- MCP server implementation: `packages/server/src/mcp/mcp-server.ts`.
- Shared service core: `packages/server/src/app-context.ts`, `packages/server/src/services/`.
