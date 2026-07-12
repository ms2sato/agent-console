# Embedded Agent Worker

**Status:** Accepted direction + v1 design specification. Part I (through "Multi-user identity & privilege") records the direction and *why* it is coherent with the current architecture. Part II ([v1 Design Specification](#v1-design-specification)) is the implementation-grade spec: an implementation agent should be able to execute it without re-deriving decisions. Per the project rule "Design Documents as Specification", Part II is the spec the implementation must match.

**Candidate decided:** among the three implementation shapes compared in [Design Decisions](#design-decisions), **candidate (b) — a per-user subprocess loop** — is the chosen direction for v1. This proposal was originally framed as an "in-process agent" (a loop running inside the server process — candidate (a)); the comparison showed that most of the claimed benefits come from *owning the loop*, not from being in-process. Where "in-process" still appears below, it refers specifically to candidate (a).

**Naming:** "embedded agent" follows the established *embedded database* convention (SQLite vs a database server; WebView vs an external browser): a capability the application runs **within itself, purpose-built**, instead of delegating to an external program or server. Former working names, kept as glossary aliases for searchability: *in-process agent* (superseded — the chosen shape is a subprocess) and *agent-owned-loop worker / loop-agent* (dropped — "loop" invited unrelated associations). "Own the loop" survives below as the *rationale* language for why this worker type exists.

## Summary

Today every agent in Agent Console is a **terminal program** (Claude Code, Aider, etc.) launched as a PTY-backed [AgentWorker](session-worker-design.md#worker-types-current--future). Because that program runs in a **separate OS process**, the only way for it to operate the application (create sessions, delegate worktrees, run processes, ...) is through an inter-process channel. That channel is the built-in **MCP server** (`packages/server/src/mcp/mcp-server.ts`).

This note proposes offering, **as an option alongside the terminal model**, an agent that owns its LLM loop: instead of a fixed terminal program driven over MCP, our own loop talks to an LLM over an HTTP API and emits structured events. As compared in [Design Decisions](#design-decisions), the chosen implementation shape -- **candidate (b), a per-user subprocess loop** -- still calls the existing MCP server for app-operation tools; what changes is who writes the loop and what it emits, not whether a process boundary is crossed. The immediate target is broad model freedom -- OpenAI-compatible endpoints and, especially, **local LLMs**.

The two models are complementary, not a replacement: the terminal worker keeps its first-class seat for subscription-billed Claude Code; the embedded agent worker maximizes model freedom for API- and locally-served models.

## Background: how the app is operated today

The service layer is the common core. Both the MCP tools and the REST/WebSocket routes call into the **same** singleton service instances held in `AppContext` (`packages/server/src/app-context.ts`), and in several cases the exact same service functions:

```text
  MCP tools        (mcp/mcp-server.ts)  --,
  REST routes      (routes/*.ts)        --+--> Service layer (services/*.ts)
  WebSocket        (websocket/)         --'     SessionManager / WorktreeService /
                                                 createWorktreeWithSession /
                                                 deleteWorktree / InteractiveProcessManager /
                                                 TimerManager / AnnotationService / ...
                                                 (single instances in AppContext)
```

For example, MCP `close_session` and `DELETE /api/sessions/:id` both call `sessionManager.deleteSession(...)` — a genuinely thin adapter (it resolves the acting user from `session.createdBy` where a REST handler would use the authenticated request user, then converges on the identical service call).

Not every handler is this thin, though. MCP `delegate_to_worktree` layers roughly ten MCP-only orchestration steps in front of the one call that actually does the work (`createWorktreeWithSession`): parent-session-id XOR resolution, callback-prompt construction, agent-name resolution, branch-name suggestion with fallback, `SSH_AUTH_SOCK` derivation, and deletion rollback on partial failure. Extracting that orchestration into the shared core is a bounded, medium-cost task — and it benefits every candidate compared in [Design Decisions](#design-decisions), not just an in-process one.

## The core insight: MCP is a consequence of the process boundary

There are two independent process boundaries, and only one of them forces MCP:

```text
  [Boundary A]  Agent  <->  server internal functions
  [Boundary B]  React UI (browser)  <->  server
```

- **Boundary A** -- today the agent is a PTY subprocess, so this boundary is crossed by a separate process. Crossing it requires IPC, and MCP is that IPC. This is the boundary the proposal changes.
- **Boundary B** -- the browser is always a separate process from the server, so the UI always talks over REST/WebSocket regardless of anything else. This boundary does **not** change.

Therefore MCP is not a free-standing choice: running the agent as a terminal program (a separate process) makes *some* IPC mechanism necessary, and MCP is the mechanism this app uses to cross that boundary. Remove the terminal nature of the agent -- run the agent *inside* the server process -- and Boundary A collapses: an in-process tool handler can call `appContext.sessionManager.xxx()` directly, and no IPC (MCP or otherwise) is needed for that agent.

**This is candidate (a)'s value proposition specifically, not a property of "owning the loop" in general.** A custom-built loop can also run as its own OS process (candidate (b)) and still keep Boundary A crossed by MCP -- what it gains over today's terminal model is not IPC removal but *control of the event format* (structured events instead of ANSI terminal bytes) and *freedom of LLM provider* (it is our code, not a fixed terminal program). See [Design Decisions](#design-decisions) for why (b), not (a), was chosen.

## Design Decisions

Three implementation shapes were compared for "an agent that owns its LLM loop":

- **(a) in-process loop** -- runs inside the server process; tool handlers call the service layer directly. This is the shape the last paragraph of "The core insight" describes and the one that collapses Boundary A.
- **(b) per-user subprocess loop** -- a loop we write ourselves, spawned as its own OS process **as the requesting OS user**, streaming structured events over stdout to the server; app-operation tools go through the existing MCP server, same as today's terminal agents. **Chosen candidate.**
- **(c) drive an existing headless harness/SDK** -- reuse a third-party agent harness's headless mode instead of writing our own loop.

| Axis | (a) In-process loop | (b) Per-user subprocess loop (chosen) | (c) Existing headless harness |
|---|---|---|---|
| Process boundary (Boundary A) | Collapses -- direct service-layer calls, no MCP | Stays crossed -- a separate OS process; tool calls flow through MCP, as today | Stays crossed -- an external harness process |
| Restart durability | Regression -- the in-memory loop vanishes on server restart; does not reuse the existing worker pid/orphan machinery | Reuses the existing worker record and `pid`/`serverPid`/orphan-recovery path (`killOrphanWorkers`, `session-initialization-service.ts:355+`) as-is, the same way terminal workers do today | Depends on the harness; not evaluated |
| Caller identity integrity | Only candidate that can verify identity structurally, since calls happen directly inside the acting session's server-side context rather than through a self-asserted MCP arg | Reinherits MCP's self-asserted-identity gap (`fromSessionId`/`sessionId`/`repositoryId` are free tool args, checked for existence only -- `mcp-server.ts:476-490`) unless Issue #878 lands first | Same MCP-reuse gap as (b) |
| Multi-user elevation | Runs as the server's OS user; would need `requestUsername` threaded through every direct service call -- new plumbing, real regression risk | Spawns via `spawnAsUser` as the requesting OS user (`packages/server/src/services/privilege-elevation.ts:450-512`), the same primitive already backing `run_process` -- no new elevation plumbing | Same subprocess-elevation shape as (b), harness-dependent |
| Tool definitions | Needs a provider-neutral registry extraction so the direct-call path and MCP don't duplicate schemas | Reuses the MCP tool registry as-is -- no dual-path extraction required for tool execution itself | Depends on the harness's own tool-calling mechanism |
| Persisted-worker blast radius | Needs a new pid-less persisted `Worker` variant (precedented by `PersistedGitDiffWorker`) | Reuses the existing pid-based persisted-worker path -- smaller delta | Not evaluated |

**Decision: (b), per-user subprocess loop.** (b) wins the two hardest infrastructure axes (restart durability, multi-user elevation) without new plumbing, by reusing exactly the mechanisms the terminal AgentWorker already relies on. (a)'s only structural edge -- identity integrity -- is closed by bringing Issue #878 into scope, which removes (a)'s one advantage and leaves (b) ahead on every axis.

Two decisions were made alongside the candidate choice:

1. **Issue #878 (verified MCP caller identity) is IN SCOPE for this direction, not deferred.** This is what tips the comparison to (b): once #878 closes the self-asserted-identity gap, (b) can reuse MCP for app-operation tools with the same identity guarantees (a) would have had to build from scratch. See [Multi-user identity & privilege](#multi-user-identity--privilege).
2. **Restart-resume (conversation survives a server restart) is DEFERRED to a post-v1 fast-follow.** Under (b), a server restart already kills and re-spawns the worker process exactly like today's PTY-backed terminal workers do -- so "no resume in v1" is *parity* with the existing model, not a regression. (It would have been a hard requirement under (a), whose entire loop state lives in server memory.) v1 ships the embedded-agent UX (structured events, provider freedom) without transcript persistence; persisting the conversation transcript across the hard mid-turn / mid-tool-call restore case becomes an explicit fast-follow.

**Worker-type behavior inconsistency to surface in v1 (docs + UI).** Today's terminal AgentWorker resumes its conversation across a restart by re-invoking the underlying CLI with its continue flag (e.g. Claude Code's `-c`; see `session-worker-design.md`'s `agentId` note). The new embedded agent worker type has no equivalent in v1 -- a restart starts a fresh conversation. This inconsistency between worker types must be stated plainly in the v1 design doc and in the UI (e.g. a visible "conversation resets on restart" indicator for this worker type), not left implicit.

## Proposal: an embedded agent worker (candidate (b))

The [Worker](session-worker-design.md#worker-types-current--future) abstraction already includes a non-PTY worker in production: `GitDiffWorker` (`packages/shared/src/types/worker.ts:18-23`), which has no PTY and instead exposes a diff payload directly. The embedded agent worker slots in as a **new Worker type** the same way, rather than a product-level rewrite:

- Session / Worker lifecycle -- including the pid/`serverPid`/orphan-recovery machinery that survives a server restart -- is reused as-is, per [Design Decisions](#design-decisions).
- The worker WebSocket channel (`/ws/session/:sessionId/worker/:workerId`) is reused as the transport. The byte-offset / epoch / output-file history machinery layered on it turns out to be content-agnostic and is reused too (Part II, [WebSocket & client protocol](#websocket--client-protocol)); only the *terminal semantics* (ANSI rendering, resize, raw keystroke input) do not apply.
- Instead of spawning a PTY running an external terminal program, the server spawns (via `spawnAsUser`) our own loop process, which streams **structured events** over stdout to the client.
- Terminal AgentWorker and the embedded agent worker coexist. This is an added option, not a removal of the terminal model.

### Agent loop and tool execution

The loop implements the LLM tool-use cycle inside its own subprocess: send messages + tool definitions to the model, receive text and tool calls, execute each tool, feed results back, repeat. Tool execution calls the existing **MCP server**, the same channel today's terminal agents use -- not a direct service-layer call (that shape belongs to candidate (a), not the chosen (b); see [Design Decisions](#design-decisions)). MCP reuse here is contingent on Issue #878 landing first, since (b) inherits MCP's current self-asserted caller identity.

## Provider strategy: OpenAI API format first

Targeting the OpenAI Chat Completions request/response shape first is the highest-leverage starting point, because it is the de-facto lingua franca that many providers expose a compatible endpoint for: OpenAI, Azure OpenAI, OpenRouter, Groq, Together, Fireworks, DeepSeek, and local runtimes (Ollama, llama.cpp, vLLM, LM Studio). Tool/function calling is part of that same format, which is exactly what tool execution needs.

Design the boundary as a **provider adapter interface** so OpenAI-format is simply the first implementation:

```ts
  interface ProviderAdapter {
    // send messages + tools, receive a stream of text and tool-call events
    run(messages, tools, opts): AsyncIterable<TextDelta | ToolCall>
  }
```

Honest caveats to design around, not gloss over:

1. **Tool-calling fidelity varies across "OpenAI-compatible" providers.** Plain text generation is broadly consistent, but function-calling behavior, parallel tool calls, streaming of tool calls, and JSON-schema adherence differ by provider and model. "OpenAI format" guarantees text reach, not reliable tool-use reach.
2. **Anthropic / Claude is not OpenAI-native.** Its Messages API and `tool_use` blocks are a different shape. This is acceptable here (see the positioning section): subscription Claude belongs to the terminal worker, so an Anthropic adapter for the embedded agent is optional and low priority.

### Local LLMs are the prime target

Local models (via an OpenAI-compatible endpoint) have the fewest *cost and access* constraints: no subscription, no per-token billing, no rate limits, offline capable, privacy-contained, and any open-weights model. That does not extend to tool-calling reliability -- as caveat 1 above states and the normalization-layer section below elaborates, local/open models are typically the *weakest* on function-calling fidelity, which is the opposite end of the constraint spectrum. The design has to actively invest in the normalization layer specifically because the cheapest, most accessible models are also the least reliable tool callers. All of it is reached through the single OpenAI-format adapter.

## Tool execution: reuse MCP as-is

Under candidate (b), the embedded agent calls the **existing MCP server** for app-operation tools -- the same `mcpServer.tool(name, description, zodSchema, handler)` registrations today's terminal agents (Claude Code) already use. There is no second, direct-call path to build or keep in sync: unlike candidate (a), (b) does not need a provider-neutral tool registry to avoid duplicating schemas, because there is only ever one caller shape (MCP) regardless of which OS process is calling it.

```text
  MCP tool registry (mcp-server.ts, unchanged)
       |
       +-- external terminal agent (Claude Code)   [today]
       '-- embedded agent subprocess (candidate b) [proposed]
```

The `delegate_to_worktree` orchestration-extraction work noted under [Background](#background-how-the-app-is-operated-today) is still worth doing -- it reduces duplicated logic and benefits every MCP caller -- but it is independent of this proposal, not a prerequisite this design introduces.

### A tool-call normalization layer

Because local/open models have the weakest tool-calling reliability and this app's value depends on the agent calling tools correctly, the loop should own a normalization layer between the provider adapter and MCP tool execution:

- Validate tool-call arguments against the schema and retry on malformed output.
- Where the runtime supports it, use constrained decoding / grammar (for example llama.cpp or vLLM structured output) to force schema-valid arguments.
- Provide a text-parse fallback for models without native tool-calling.

This is the one place the design must actively invest; it is what makes "any model" hold up rather than degrade.

## UI: a structured worker view alongside the terminal

The client renders a worker by the shape of what flows over its WebSocket channel:

| | Terminal AgentWorker (today) | Embedded agent worker (proposed, candidate b) |
|---|---|---|
| Agent output | raw terminal bytes (ANSI) | structured events (text / tool call / tool result) |
| Client render | xterm.js terminal emulation | chat / structured view (messages, tool-call cards) |
| Transport payload | PTY stdout stream | streamed agent events |

The worker WebSocket channel is shared as a transport, and -- a finding that sharpened during the v1 design -- most of the framing on top of it is shared too. The absolute-byte-offset / epoch / gzip-segment / history-range machinery is **content-agnostic**: it streams and replays an append-only byte log without caring whether the bytes are ANSI terminal output or newline-delimited JSON events. Part II reuses it wholesale, which is what gives the chat view reconnect/history replay for free. What is genuinely PTY-only is the terminal *semantics*: ANSI rendering, `resize`, and raw keystroke `input`. Those are replaced by a small set of new `worker.type`-branched client message types (the same extension pattern `GitDiffWorker` already uses -- `packages/shared/src/types/git-diff.ts:201-223`, `routes.ts:723-745`). The "dedicated React UI" is a consequence of the payload changing from terminal bytes to structured events, **not** of the UI calling internal functions directly (Boundary B is unchanged; the browser still goes over the wire).

## Positioning vs Claude and the subscription model

Claude being second-class on the embedded-agent path is expected and is a clean division of labor, not a defect:

- Anthropic's flat-rate subscription (Pro / Max) is usable **only through Claude Code** (the agent/CLI), while raw API access is separately metered per token. The embedded-agent path is an API-billed world, so subscription Claude has no advantage there.
- Consequently the two worker types map onto two access/billing models:

| | Terminal Worker (today) | Embedded Agent Worker (proposed) |
|---|---|---|
| Primary models | Claude via subscription (flat rate) | OpenAI-format API + local models |
| Path | Claude Code + MCP | own loop (per-user subprocess) + MCP + direct LLM API |
| Claude's standing | first-class (best value on flat rate) | works only if API-billed; low priority |

So there is no need to force Claude to be first-class on the embedded-agent path: subscription Claude keeps its first-class seat on the terminal worker, and an embedded-agent Anthropic adapter can be an optional add-on for users who want to spend API credits inside the unified structured-event UI. Net effect: the terminal worker (best-in-class Claude) and the embedded agent worker (maximum model freedom) coexist and cover each other's weak spots.

## Trade-offs

- **Gain:** structured events enabling a richer UI, broad model freedom (API + local) through one adapter, and -- because candidate (b) reuses the existing worker pid/orphan-recovery machinery and `spawnAsUser` elevation -- no new restart-durability or multi-user-elevation plumbing.
- **Cost:** the loop reimplements the agent cycle and does not inherit Claude Code's built-in capabilities (its own file editing, shell, context management, hooks, skills). The terminal model's strength -- running *any* terminal-based agent unmodified -- is exactly what the embedded-agent model gives up in exchange for a structured, provider-flexible UI. Offering both as options is what preserves both strengths. Unlike an earlier framing of this proposal, the chosen candidate does **not** remove the MCP/IPC hop on Boundary A -- see [Design Decisions](#design-decisions) for why that trade was made deliberately in favor of restart durability and elevation reuse.

## Non-goals

- Removing or deprecating the terminal AgentWorker or the MCP server. Both remain the primary path, and the chosen candidate actively depends on MCP rather than replacing it.
- Conversation continuity across a server restart (transcript persistence / resume) in v1. Explicitly deferred to a post-v1 fast-follow -- see [Design Decisions](#design-decisions) and [Post-v1 fast-follows](#post-v1-fast-follows).
- Supporting models without native tool-calling in v1 (text-parse fallback / constrained decoding are post-v1; see [Provider adapter](#provider-adapter--tool-call-normalization)).
- Making Claude first-class on this path (see Positioning above).

## Multi-user identity & privilege

Candidate (b) is spawned via `spawnAsUser` (`packages/server/src/services/privilege-elevation.ts:450-512`) as the requesting OS user -- the same durable, caller-lifecycle-owned primitive already backing `run_process` / `InteractiveProcessManager`. `shouldElevateForUser` (`privilege-elevation.ts:178-189`) transparently bypasses elevation in single-user / same-user deployments, so this design does not introduce a new multi-user-specific code path; it reuses the existing elevation boundary as-is. This is a structural reason (b) was chosen over (a): (a) runs as the server's own OS user and would need `requestUsername` threaded through every direct service call it makes, which is new plumbing with real regression risk against the multi-user work already invested in the elevation primitives. (b) needs none of that.

Two consumer obligations follow from adopting `spawnAsUser`, per [`elevation-helpers.md`](../../.claude/rules/elevation-helpers.md):

- **Stdin.** `spawnAsUser` always pipes stdin (`stdin: 'pipe'`). The worker that owns the agent subprocess must actively manage it -- keep it open only while genuinely feeding the loop (prompts / follow-up instructions), the same discipline `ConditionalWakeupManager`'s `spawnAsUser` migration required (Issue #886 / PR #889). A fire-and-forget spawn that never closes or writes stdin risks the same silent-hang failure mode documented there.
- **Stdout/stderr draining.** The loop's structured events are its stdout payload and must be actively consumed by the worker, not left to buffer.

**MCP identity dependency.** Because (b) reuses MCP for tool execution (see [Proposal](#proposal-an-embedded-agent-worker-candidate-b)), it also reinherits MCP's current caller-identity gap: `fromSessionId` / `sessionId` / `repositoryId` are free tool arguments that server-side handlers check for existence only, not ownership (`mcp-server.ts:476-490`). A per-user subprocess spawned under the correct OS user does not, by itself, prevent a buggy or adversarial loop from asserting a different session's identity to the MCP server -- OS-level user isolation and MCP-level session-identity verification are separate guarantees. This is exactly why [Design Decisions](#design-decisions) brings **Issue #878 into scope** for this direction rather than treating it as a nice-to-have: (b) is not safe to ship for multi-user deployments until #878 closes that gap.

### Follow-up design axis: MCP reachability and credential propagation

Choosing (b) introduces one design axis that (a) would not have had: everything the agent subprocess needs must cross an OS-user boundary at spawn time.

- **Reaching the MCP server** is the already-solved half. The MCP server is Streamable HTTP (`/mcp` route, `mcp-server.ts:1570`), and today's terminal agents already receive `AGENT_CONSOLE_BASE_URL` / `AGENT_CONSOLE_SESSION_ID` / `AGENT_CONSOLE_WORKER_ID` injected at PTY spawn (`AgentConsoleContext`, `packages/server/src/services/user-mode.ts`). The agent subprocess reuses the same injection mechanism and connects over HTTP; no new channel is needed.
- **LLM provider credentials** are the genuinely new half. A terminal agent brings its own credentials (e.g. Claude Code's auth lives in the OS user's home directory); the embedded agent instead needs a provider API key that the *server* holds, delivered into a process running as a *different* OS user. Under elevation, `buildSpawnArgs` embeds `opts.env` into the inner shell command, so a naive env pass-through would expose the key in the process argv (visible via `ps`); and the existing `getCleanChildProcessEnv` discipline exists precisely because env propagation across this boundary is a known leak surface. The binding constraint: provider secrets must not appear in argv / process listings, and must not be readable by other non-privileged OS users. **Resolved in Part II** ([Credentials](#credentials-provider-keys--the-init-handshake)): secrets flow over the already-piped stdin as the first protocol message, touching neither argv nor env.

If the implementation phase introduces further OS-level assumptions beyond `spawnAsUser` (login-shell PATH, sudoers config, file-ownership on the loop's working directory), the real-machine smoke-test discipline in [`os-environment-coupling.md`](../../.claude/rules/os-environment-coupling.md) applies, same as any other OS-coupled code in this codebase.

## Other open design axes for v1

Two more consequences of choosing a non-PTY worker, both **resolved in Part II** (kept here because the rationale explains *why* each needed deciding):

### Activity state without a PTY

Today `AgentActivityState` is derived entirely by *parsing PTY output bytes* -- the `ActivityDetector` matches agent-defined regex patterns against the byte stream -- and `activated` literally means "the worker has a live PTY" (`pty !== null`, `worker-manager.ts:712`). Neither definition applies to a worker with no PTY. The relationship inverts: the loop *knows* authoritatively when it is waiting on the LLM, executing a tool, or idle, so instead of the server inferring activity from output, the loop **emits activity state as part of its structured event stream** and the server records it. Resolution: [Activity state & `activated` semantics](#activity-state--activated-semantics).

### The Agent concept forks

Today an `AgentDefinition` describes *how to launch a terminal program*: a command template, activity-detection patterns, continue args (e.g. `-c`). An embedded-agent agent is configured by entirely different data: provider endpoint, model, credential reference, and optionally a system prompt / tool policy. These are disjoint shapes, not variants of one template. Resolution: a separate `EmbeddedAgentDefinition` registry, not a discriminated-union extension of `AgentDefinition` -- see [Embedded agent registry](#embedded-agent-registry-embeddedagentdefinition). Presentation note: the registries stay separate, but the UI presents both kinds through a single unified "agent" entry point (owner requirement, 2026-07-11) — see the UI section in Part II.

---

# v1 Design Specification

Everything below is normative for the v1 implementation. File and line citations refer to the codebase at the time of writing; treat them as starting points and re-verify line numbers before editing.

## Scope

**In scope for v1:**

- New worker type `embedded-agent` (`EmbeddedAgentWorker`) coexisting with `agent` / `terminal` / `git-diff`.
- A `EmbeddedAgentDefinition` registry (separate from `AgentDefinition`) with REST CRUD and minimal UI.
- The agent subprocess (`packages/embedded-agent`): OpenAI-format provider adapter, MCP tool execution, NDJSON event protocol over stdio.
- Issue #878 phase 1: per-worker MCP bearer token, verification middleware, ownership checks — default `warn` in single-user mode; `enforce` (fail closed) is the multi-user default (Phase 4, landed).
- Chat UI (`EmbeddedAgentWorkerView`) with history replay on reconnect.
- Single-user mode fully supported; multi-user elevated spawn implemented behind the existing `shouldElevateForUser` gate. Multi-user support is declared only at Phase 4, which requires the real-machine smoke test AND terminal-agent token delivery (multi-user runs `enforce`, so every agent path must carry a token there).

**Out of scope for v1** (see [Post-v1 fast-follows](#post-v1-fast-follows)): transcript persistence across server restart, `asking` activity state, non-native tool-calling fallbacks, per-user provider keys / key-management UI, single-user tokenless enforcement (single-user default stays `warn`), inbound `send_session_message` to embedded-agent workers, Anthropic adapter.

## Naming and shared types

Worker type literal: **`'embedded-agent'`**. Interface prefix: **`EmbeddedAgent`**.

`packages/shared/src/types/worker.ts` — add:

```ts
export interface EmbeddedAgentWorker extends WorkerBase {
  type: 'embedded-agent';
  /** References EmbeddedAgentDefinition.id (NOT AgentDefinition.id). */
  embeddedAgentId: string;
  /** Whether the agent subprocess is running (false after server restart until reactivated). */
  activated: boolean;
}

export type Worker = AgentWorker | TerminalWorker | GitDiffWorker | EmbeddedAgentWorker;
```

`AgentActivityState` (`worker.ts:26-30`) is reused unchanged; v1 loop workers only ever report `'active' | 'idle'` (plus initial `'unknown'`).

**Wire schema (CLAUDE.md Q10 — mandatory same-PR):** `packages/shared/src/schemas/app-server-message.ts` — add next to `GitDiffWorkerSchema` (`:31-35`) and register in the union (`:37`):

```ts
const EmbeddedAgentWorkerSchema = v.strictObject({
  ...WorkerBaseSchema.entries,
  type: v.literal('embedded-agent'),
  embeddedAgentId: v.string(),
  activated: v.boolean(),
});
export const WorkerSchema = v.union([
  AgentWorkerSchema, TerminalWorkerSchema, GitDiffWorkerSchema, EmbeddedAgentWorkerSchema,
]);
```

An integration test in `packages/integration/src/` MUST exercise the full wire path (server populates -> WS serialize -> valibot parse -> client shape); frontend mock-factory tests do not count (Q10, lesson PR #926).

Creation params: `packages/shared/src/schemas/worker.ts` — add `CreateEmbeddedAgentWorkerParamsSchema` (`name?`, `type: v.literal('embedded-agent')`, `embeddedAgentId: v.string()`) and include it in the `CreateWorkerParams` union (`:62-65`). Extend `CreateWorkerRequestSchema` (`:45`, currently terminal-only) to `v.union([CreateTerminalWorkerParamsSchema, CreateEmbeddedAgentWorkerParamsSchema])` so clients can add a embedded-agent worker to an existing session over REST.

## Embedded agent registry (EmbeddedAgentDefinition)

**Decision: separate type, separate table, separate manager — NOT a discriminated-union extension of `AgentDefinition`.** Rationale: `AgentDefinition.commandTemplate` is required and threaded through spawn, capability computation (`packages/shared/src/types/agent.ts:103-115`), templates, and the agents UI; a union would make it optional and force guards at every existing call site. A separate registry disturbs nothing and keeps the id namespaces distinct (`EmbeddedAgentWorker.embeddedAgentId` cannot be confused with `AgentWorker.agentId`). Revisit unification only if the two registries grow convergent features.

`packages/shared/src/types/embedded-agent.ts` (new):

```ts
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
```

**Ownership.** Definitions select provider endpoints, prompts, and key references, so mutation is not free-for-all: in multi-user mode, `PATCH` / `DELETE` require the authenticated request user (`authMiddleware`'s `authUser.id`) to equal `createdBy`; `GET` / list / worker-creation use are shared (definitions are server-wide resources). In single-user mode the check is trivially satisfied (sole user). `createdBy` is set server-side from the authenticated user at `POST` time, never from the request body.

Plus a valibot schema in `packages/shared/src/schemas/embedded-agent.ts` (strictObject; `baseUrl` validated with `v.pipe(v.string(), v.url())`).

**DB:** new table `embedded_agents` (columns mirroring the type incl. `created_by`; `provider_*` flattened: `provider_base_url`, `provider_model`, `provider_api_key_ref`). New migration `migrateToV<next>` in `packages/server/src/database/connection.ts` (check the current max `user_version` in `runMigrations`, `connection.ts:226-315`, and take the next number; v21 was the latest at the time of writing).

**Server:** `packages/server/src/services/embedded-agent-manager.ts`, modeled on `AgentManager` (`agent-manager.ts:25-106`): in-memory `Map` + SQLite repository, CRUD methods, lifecycle callbacks broadcasting `embedded-agent-created/updated/deleted` app messages. No built-in definition (unlike `AgentManager` there is no default; the registry starts empty and the UI prompts the user to create one).

**REST:** `packages/server/src/routes/embedded-agents.ts` — `GET /api/embedded-agents`, `POST`, `PATCH /:id`, `DELETE /:id`, guarded by the existing `authMiddleware` chain (mounted under `/api`, `packages/server/src/routes/api.ts:41`).

## Persistence and DB changes (workers table)

`packages/server/src/database/schema.ts` `WorkersTable` (`:79-98`):

- `type` union gains `'embedded-agent'` (`:85`).
- New nullable column `embedded_agent_id: string | null` (do NOT reuse `agent_id` — different registry namespace).
- `pid` column (`:92-93`) is REUSED: the agent subprocess pid, `null` when not activated. This is what plugs embedded-agent workers into orphan reaping unchanged.

Same migration as above adds the column. Update `VALID_WORKER_TYPES` (`mappers.ts:169`) and add branches:

| Site | File | Change |
|---|---|---|
| `toWorkerRow` | `packages/server/src/database/mappers.ts:129-164` | embedded-agent branch: `pid` from worker, `embedded_agent_id`, `agent_id: null`, `base_commit: null` |
| `toPersistedWorker` (DB->persisted) | `mappers.ts:179-222` | embedded-agent branch; throw `DataIntegrityError` if `embedded_agent_id` is null |
| `PersistedWorker` union | `packages/server/src/services/persistence-service.ts:49-71` | add `PersistedEmbeddedAgentWorker { type: 'embedded-agent'; embeddedAgentId: string; pid: number \| null }` |
| `toPublicWorker` | `packages/server/src/services/worker-manager.ts:707-724` | embedded-agent branch: `activated: worker.subprocess !== null` |
| `toPersistedWorker` (memory->persisted) | `worker-manager.ts:729-746` | embedded-agent branch: `pid: worker.subprocess?.pid ?? null` |
| `restoreWorkers` | `worker-manager.ts:667-697` | embedded-agent branch: rebuild internal worker with `subprocess: null`, fresh `connectionCallbacks` |

`killOrphanWorkers` (`session-initialization-service.ts:355-381`) needs **no change**: it skips `git-diff` and null pids and SIGTERMs everything else — a persisted embedded-agent worker with a live pid is reaped exactly like a PTY worker.

## Internal worker shape

`packages/server/src/services/worker-types.ts` — add alongside `InternalGitDiffWorker` (`:86-90`):

```ts
export interface InternalEmbeddedAgentWorker extends InternalWorkerBase {
  type: 'embedded-agent';
  embeddedAgentId: string;
  /** Live subprocess handle; null = not activated (mirrors InternalPtyWorkerBase.pty). */
  subprocess: Subprocess<'pipe', 'pipe', 'pipe'> | null;
  /** stdin sink for protocol commands; null when subprocess is null. */
  stdin: FileSink | null;
  activityState: AgentActivityState;
  /** File-absolute byte offset of the NDJSON event log (same semantics as InternalPtyWorkerBase.outputOffset). */
  outputOffset: number;
  /** Incarnation id, same semantics as InternalPtyWorkerBase.epoch (worker-types.ts:54-57). */
  epoch: number;
  connectionCallbacks: Map<string, WorkerCallbacks>;
}
```

It deliberately does NOT extend `InternalPtyWorkerBase` (no `pty`, no ActivityDetector, no output *buffer* debouncing unless profiling demands it), but mirrors the four stream fields (`outputOffset`, `epoch`, `connectionCallbacks`, live-handle-or-null) so the WS plumbing can treat "PTY worker or embedded-agent worker" uniformly where it only needs those fields. `InternalPtyWorker` (`worker-types.ts:95`) stays PTY-only; add a type guard `isStreamWorker(w): w is InternalPtyWorker | InternalEmbeddedAgentWorker` where the WS layer needs the shared shape.

## The agent subprocess (`packages/embedded-agent`)

New Bun workspace package. Depends on `packages/shared` (event types) and `@modelcontextprotocol/sdk` (MCP client). Entry: `packages/embedded-agent/src/main.ts`.

**Spawn command:** `bun <absolute path to packages/embedded-agent/src/main.ts>`, resolved by the server relative to its own install root (compute once, e.g. from `import.meta.dir`; do not rely on cwd). `cwd` = the session's `locationPath`. Under elevation this requires (1) the install tree readable by the target user (already the shared-group model used for repositories) and (2) `bun` on the target user's login-shell PATH. Both are OS-coupled assumptions -> the smoke test in [Testing](#testing-plan) is mandatory before multi-user support is claimed (`os-environment-coupling.md`).

**Process contract:**

- stdin: NDJSON commands (server -> loop). First message MUST be `init`; the loop exits with code 2 if the first parsed line is not a valid `init`.
- stdout: NDJSON events (loop -> server). Nothing else is ever written to stdout (all diagnostics go to stderr).
- stderr: human-readable logs; the server forwards them to its logger at debug level (size-capped).
- Exit: on `shutdown` command or stdin EOF, finish the current write and exit 0. Exit 1 = fatal error (after emitting a `fatal` event if possible). Exit 2 = protocol misuse.
- The server keeps stdin OPEN for the lifetime of the process (this is a *feeding* `spawnAsUser` consumer, so the `stdin.end()` obligation for fire-and-forget consumers in `elevation-helpers.md` does not apply; the drain obligation does, and is satisfied by the event reader).

### Stdio protocol (v1)

All messages are single-line JSON with `v: 1`. This protocol assumes same-deployment version parity: the server and the loop ship from the same build, so a version-skew forward-compat scenario is out of v1 scope. Three distinct failure shapes on a received line, each handled identically in spirit on both sides but with side-specific consequences:

- **Unparseable line (not valid JSON).** Not a forward-compat case — it indicates a broken pipe or corrupted output, not a newer/older peer. On the loop's stdin side this is always fatal (exit 2, protocol misuse). On the server's stdout side this counts toward the 5-consecutive-failure kill threshold ([Error handling & edge cases](#error-handling--edge-cases)).
- **Parseable JSON with an unrecognized `type`.** This IS the forward-compat case (a genuinely newer/older message shape). Skip + log on BOTH sides; this does NOT count toward the server's 5-consecutive-failure counter, and does not disturb the loop's post-init command loop.
- **Parseable JSON with a known `type` that fails that type's own schema** (e.g. an `init` missing a required field). Same-deployment version parity means this indicates corruption, not version skew — treated identically to an unparseable line: fatal (exit 2) on the loop's stdin side, and counted toward the 5-consecutive-failure counter on the server's stdout side.

The loop's init-first enforcement is a special case of the above: before `init` is accepted, ANY line that is not a valid `init` command (unparseable, unrecognized type, or known-type-but-invalid) exits 2 — forward-compat ignoring of unknown types only applies AFTER init.

Server -> agent (stdin):

```ts
type EmbeddedAgentCommand =
  | { v: 1; type: 'init';
      mcp: { baseUrl: string; token: string };            // Streamable HTTP endpoint + bearer token (#878)
      provider: { baseUrl: string; model: string; apiKey?: string };
      context: { sessionId: string; workerId: string; repositoryId?: string; cwd: string };
      systemPrompt?: string;
      maxToolIterations: number }
  | { v: 1; type: 'user-message'; id: string; text: string } // id minted by server, echoed in events
  | { v: 1; type: 'cancel' }                                 // abort the in-flight turn (AbortController)
  | { v: 1; type: 'shutdown' };
```

Agent -> server (stdout):

```ts
type EmbeddedAgentEvent =
  | { v: 1; type: 'ready' }                                          // init accepted, MCP tools listed
  | { v: 1; type: 'state'; state: 'active' | 'idle' }                // authoritative activity
  | { v: 1; type: 'assistant-delta'; turnId: string; text: string }  // streamed text chunk
  | { v: 1; type: 'assistant-message'; turnId: string; text: string }// final full text of one assistant message
  | { v: 1; type: 'tool-call'; turnId: string; callId: string; name: string; args: unknown }
  | { v: 1; type: 'tool-result'; turnId: string; callId: string; ok: boolean; result: string } // result truncated to 16 KiB
  | { v: 1; type: 'turn-error'; turnId: string; message: string }    // turn aborted (provider error, iteration cap, cancel)
  | { v: 1; type: 'fatal'; message: string };                        // loop is about to exit(1)
```

Two further event kinds are written into the persisted stream by the SERVER, not the loop, so that the on-disk log is the complete transcript. The **replay/persistence union includes them** — clients that parsed only `EmbeddedAgentEvent` would silently drop every user message and exit row from replayed history:

```ts
type EmbeddedAgentServerEvent =
  | { v: 1; type: 'user-message'; id: string; text: string }  // appended when forwarding to stdin
  | { v: 1; type: 'exited'; code: number | null };            // appended when subprocess.exited resolves

/** What actually lives in the worker output file and is replayed to clients. */
export type EmbeddedAgentStreamEvent = EmbeddedAgentEvent | EmbeddedAgentServerEvent;
```

All three types live in `packages/shared/src/types/embedded-agent.ts` with valibot schemas in `packages/shared/src/schemas/embedded-agent.ts`. The loop parses commands and the server parses loop stdout with the narrower schemas (system-boundary validation); **the client parses persisted/replayed history with the `EmbeddedAgentStreamEvent` schema**, never the loop-only union.

### The loop's turn cycle

On `user-message`: emit `state: active`; append the message to the in-memory conversation; then repeat up to `maxToolIterations` times: call the provider (streaming); emit `assistant-delta`s and a final `assistant-message` (text truncated at 256 KiB, UTF-8-safe, using the same truncation helper as `tool-result` — this guards against colliding with the server's 1 MiB oversized-line kill on a healthy long response); if the response contains tool calls, for each call emit `tool-call` (`args`' serialized form truncated at 256 KiB with the same guard), execute it via the MCP client, emit `tool-result`, append results to the conversation, and continue; otherwise the turn is complete. Emit `state: idle`. On provider error after 2 retries (exponential backoff, honoring 429 `retry-after`), or on hitting the iteration cap, emit `turn-error` then `state: idle` — the conversation stays usable for the next user message.

**Mid-turn abort repair (mandatory).** Both abort paths — `cancel` and hitting the re-ask cap — can fire while one or more tool calls from the current assistant turn have not yet received a matching tool-role response. Before emitting `turn-error` in either case, the loop pushes a synthetic tool-role message (e.g. `Error: canceled`) for every tool call in the current turn that has not yet been responded to. Without this, the `assistant` message's `tool_calls` array would carry unresponded `tool_call_id` entries into the next turn's request, which a strict OpenAI-compatible provider rejects with 400 — permanently wedging the worker. This is what makes the "conversation stays usable for the next user message" guarantee above actually hold across an aborted turn, not just a cleanly-completed one.

## Server-side management (`EmbeddedAgentWorkerService`)

New service `packages/server/src/services/embedded-agent-worker-service.ts`, combining `InteractiveProcessManager`'s subprocess mechanics (`interactive-process-manager.ts:127-190` — `spawnAsUser` call shape, concurrent stdout/stderr reads, exit observation ordered after stream completion) with the AgentWorker persistence/output model. Constructor takes `spawnAsUserFn: SpawnAsUserFn = spawnAsUser` for the test seam (the established DI pattern, `interactive-process-manager.ts:67-80`).

**Activation** (`activate(sessionId, workerId)`): the OS username is not a caller-supplied parameter — it is resolved internally from `session.createdBy` via `resolveSpawnUsername`, mirroring how the PTY activation paths resolve their own spawn username.

0. **Idempotent no-op** when the worker is already activated (`subprocess !== null`).
0.5. **Concurrency guard.** A synchronous in-flight-activation guard (checked and set before any `await`, mirroring `sendUserMessage`'s synchronous admission) ensures a second concurrent `activate()` call for the same worker awaits the SAME in-flight attempt instead of racing it — no duplicate spawn, no duplicate token mint, no lost handle. See the [Error handling & edge cases](#error-handling--edge-cases) row for the failure-mode this closes.
1. Resolve the `EmbeddedAgentDefinition` (fail the activation with a clear error if the id no longer resolves — unlike terminal agents there is no built-in fallback to substitute).
2. Load the provider key if `apiKeyRef` is set ([Credentials](#credentials-provider-keys--the-init-handshake)); fail activation if the ref is dangling.
3. Mint the MCP token ([MCP caller identity](#mcp-caller-identity-issue-878-phase-1)); fails activation with an explicit error when `session.createdBy` is absent (see the Error handling table).
4. Reset the output stream — mint a new epoch and truncate, exactly like `restartAgentWorker` does via `resetWorkerOutput` (`worker-manager.ts:411-433`, `worker-output-file.ts:1067-1108`). **Every activation is restart-semantics in v1** (fresh conversation); there is no revive path (contrast `activateAgentWorkerPty`'s `revived: true` epoch-preserving branch, `worker-manager.ts:322-338` — deliberately not used, per the restart-resume deferral).
5. `spawnAsUserFn({ username, command: 'bun <entryPath>', cwd: session.locationPath })`, store `subprocess`/`stdin` on the internal worker, write the `init` command as the first stdin line. **`entryPath` is resolved via the `@agent-console/embedded-agent` workspace package name**, not a relative path off the server's own source tree: `Bun.resolveSync('@agent-console/embedded-agent/package.json', import.meta.dir)` (package-manager-view resolution follows the installed workspace dependency edge — `packages/embedded-agent/package.json` has no `exports` map, so this is the resolvable subpath; an arbitrary `src/*` subpath is not) gives the package's directory, into which `src/main.ts` is joined. This resolves correctly under both the dev workspace layout and a bundled production deploy (`bun dist/index.js`, where `import.meta.dir` points into the bundle output and a relative source-tree path would silently fail) — the same pattern the server already uses to depend on `@agent-console/shared`. A source-relative fallback covers the local pre-`bun install` state.
6. Start the stdout reader: split into lines (carry partial-line remainder across chunks), parse each with the valibot event schema, then (a) append the raw line + `\n` to the worker output file via the existing content-agnostic append path (updating `outputOffset`), (b) fan out to `connectionCallbacks[].onData(line, offset, epoch)` — the same callback shape PTY workers use, and (c) side-channel `state` events into the activity flow below. Start the stderr reader (log-only).
7. Observe `subprocess.exited` (after stream completion, mirroring `interactive-process-manager.ts:151-166`): verify the exiting subprocess is still the CURRENTLY-recorded one for this worker before mutating any state (guards against a stale exit from a superseded activation attempt — see the concurrency guard in step 0.5); if current, append a server-authored `exited` event to the stream, set `subprocess = null`, revoke the MCP token, emit activity `idle`, and fire `onExit` callbacks (`'managed'` vs crash distinguished by whether a shutdown was requested).
7.5. **Post-mint failure unwind.** If any step after the token mint (step 3) throws — provider spawn failure, stdin write failure, output-reset failure — the minted token is revoked and any already-spawned subprocess is killed before the error propagates, so a failed activation never leaves an orphaned token or process behind.

**Deactivation / deletion**: send `shutdown` on stdin, grace 3 s, then SIGTERM, then the existing kill-timeout escalation pattern (`worker-manager.ts:775-850` precedent, `PTY_EXIT_TIMEOUT_MS`). Wire into `WorkerLifecycleManager.deleteWorker` (`worker-lifecycle-manager.ts:303-345`) as a third branch beside the PTY and git-diff branches; output cleanup reuses `cleanupWorkerOutput`.

**Session pause/resume**: treat like PTY agent workers — the pause path kills the subprocess; resume + next access re-activates with restart semantics (conversation resets; this is the documented v1 inconsistency).

**User message forwarding** (`sendUserMessage(sessionId, workerId, text)`): admission is a **synchronous check-and-set** on the internal worker — verify `subprocess !== null` and `turnActive === false`, then set `turnActive = true`, all before the first `await`. Only then: mint `id`, append the server-authored `user-message` event to the output stream (so replay ordering is stable), then write the command to stdin + flush. Because admission completes synchronously on the single JS thread, two concurrent WS clients cannot both observe an idle worker and double-admit; the loser gets the "turn in progress" rejection. `turnActive` clears on `state: idle` (turn complete or `turn-error`) and on subprocess exit.

## Activity state & `activated` semantics

- `activated` for a embedded-agent worker means `subprocess !== null` (`toPublicWorker` branch), the exact analogue of the PTY definition (`worker-manager.ts:712`).
- `AgentActivityState` is loop-emitted, not inferred: the service maps `state` events onto the same two broadcast surfaces PTY workers use — per-connection `WorkerServerMessage { type: 'activity', state }` (`packages/shared/src/types/session.ts:167`) and the app-wide `worker-activity` broadcast (`websocket/routes.ts:304-329`). No `ActivityDetector` is constructed for this worker type.
- v1 emits only `'active'` / `'idle'`; `'asking'` is post-v1 (the union in `worker.ts:26-30` is unchanged, so no schema work when it lands).
- Initial state after activation is `'idle'` (explicitly emitted, mirroring `worker-manager.ts:417-421`).

## WebSocket & client protocol

**Reuse decision:** the worker WS channel's byte-offset / epoch / history machinery is content-agnostic (it streams an append-only log; nothing in `output` / `history` / `history-range` messages assumes ANSI). Embedded-agent workers reuse it as-is, with NDJSON event lines as the byte content. This is what makes reconnect-with-history work in v1 without a second history mechanism: on reconnect the client requests history from its cached offset exactly like a terminal tab does, and parses the replayed bytes into events.

Server side (`packages/server/src/websocket/routes.ts`):

- `onOpen` (`:723-777`): add a `worker.type === 'embedded-agent'` branch before the PTY path. If `subprocess === null`, activate (restart semantics — the client's stale epoch is superseded and its cache cleared by the epoch mismatch, the standard mechanism). Attach `connectionCallbacks`, serve initial history — extract the history-serving code shared with the PTY path over the `isStreamWorker` shape instead of duplicating it (the four mirrored fields exist for exactly this).
- `onMessage` (`:792-858`): embedded-agent branch accepts two new client message types and rejects PTY messages (`input`, `resize`) with an error:

```ts
type EmbeddedAgentClientMessage =
  | { type: 'embedded-user-message'; text: string }   // -> EmbeddedAgentWorkerService.sendUserMessage
  | { type: 'embedded-cancel' };                      // -> forward { type: 'cancel' } to stdin
```

  `request-history` is shared with the PTY path (same semantics).
- `onClose` (`:685-697`): detach callbacks like the PTY path (the subprocess keeps running without viewers, like a PTY does).

Type/schema homes: add the client message types to `packages/shared/src/types/session.ts` beside the existing `WorkerClientMessage` types. Validate the same way the sibling `input` / `resize` / `request-history` message shapes already are: none of them have a valibot schema (`worker-handler.ts`'s `validateWorkerMessage` hand-validates them), so `embedded-user-message` / `embedded-cancel` follow the same sibling-consistent manual validation at the WS boundary in `routes.ts` -- `JSON.parse` once, a `switch` on `type`, a field-shape check (`typeof text === 'string'`), and a byte-length cap on `text` (rejected with a dedicated error code rather than forwarded oversized). This corrects an earlier version of this spec that called for a new valibot schema layer inconsistent with the existing sibling types.

Client side: `SessionPage.tsx` dispatch gains the `'embedded-agent'` case (`tab.workerType` union at `:42`, render branches at `:459` and `:504-505`, error-fallback label at `:49-56`). The transport layer reuses the existing PTY-worker client machinery for offset-resume / epoch-reset / history accumulation (locate it via the xterm data hook; `worker-websocket.ts` documents that git-diff is currently the only type routed through that particular module — the PTY transport lives with the terminal components). The rendering layer buffers received bytes, splits complete lines, parses each with the shared `EmbeddedAgentStreamEvent` valibot schema (skip-and-log on parse failure), and folds events into the chat view model.

## MCP tool surface: capability predicates, not per-type branches

The MCP server currently guards PTY-only tools with inline `worker.type === 'git-diff'` rejections at five sites (`mcp-server.ts:454-458`, `:461`, `:1041-1045`, `:~1138`, `:~1279-1283`). Those checks encode "not git-diff ⇒ PTY-backed" — an assumption every new non-PTY worker type would break, turning each addition into a five-site audit. **That is a pre-existing structural smell, and v1 must not double it.**

**Preparatory refactor (pure, no behavior change, its own PR):** introduce single-writer capability predicates in `packages/shared/src/types/worker.ts`:

```ts
/** Workers backed by a PTY: can receive injected input / [internal:*] notifications. */
export function isPtyBackedWorker(w: Worker): w is AgentWorker | TerminalWorker {
  return w.type === 'agent' || w.type === 'terminal';
}
/** Workers that can be the target of send_session_message in the current implementation. */
export function canReceiveSessionMessages(w: Worker): w is AgentWorker {
  return w.type === 'agent';
}
```

Replace the five inline checks with the matching predicate (positively phrased: `if (!isPtyBackedWorker(worker)) return errorResult('... requires a PTY-backed worker (agent/terminal)')`). The annotation tools' `type === 'git-diff'` *requirements* (`:1429-1437`, `:1498-1506`) stay as-is — those are genuinely git-diff-domain, not capability negations.

After the refactor, adding `embedded-agent` costs **zero changes at the guard sites**: the predicates already exclude it (v1 decision: embedded-agent workers reject PTY notifications, conditional wakeups, `run_process` attachment, and inbound `send_session_message` — the notification channels are PTY-injection-shaped and the message-injection path is PTY-shaped; routing these to loop workers as `user-message` events is a post-v1 item). When post-v1 extends a capability to embedded-agent, the change is one line in one predicate.

This mirrors the repo's existing disciplines: single-writer patterns (`COVERAGE_PATTERNS`, sentinel protocol #999), "enforce constraints through structure, not convention" (`design-principles.md`), and the two-PR-convergence extraction rule (`elevation-helpers.md`).

## MCP caller identity (Issue #878, phase 1)

The `/mcp` endpoint currently has **no authentication**: the MCP Hono app is mounted outside the `/api` router's `authMiddleware` chain (`packages/server/src/index.ts:132` vs `:156`; `routes/api.ts:41`), and tool handlers trust caller-supplied `sessionId` / `fromSessionId` / `parentSessionId` (existence checks only — `mcp-server.ts:476-490`, deferral comment `:954-956`). Every elevation-bearing tool follows the same trust chain: claimed session id → that session's `createdBy` → `resolveRequestUsername` (`resolve-spawn-username.ts:88-107`) → elevation. `AuthUser.id` and `session.createdBy` share the same `users.id` UUID space, so a verified caller identity is directly comparable to session ownership.

**Design: per-worker bearer token.**

- New module `packages/server/src/mcp/mcp-auth.ts`:

```ts
export interface McpCallerIdentity { sessionId: string; workerId: string; userId: string /* users.id */ }

export class McpTokenRegistry {
  mint(identity: McpCallerIdentity): string;   // 32 random bytes, hex; stored in Map<token, identity>
  verify(token: string): McpCallerIdentity | null;
  revokeByWorker(workerId: string): void;
}
```

  In-memory only: any live agent process was spawned by the live server (a server restart kills orphans and re-spawns workers with fresh tokens), so tokens never need to survive a restart; a stale token from a kill-escaped process is correctly rejected.
- `/mcp` route (`mcp-server.ts:1570`): read `Authorization: Bearer <token>`, resolve via the registry, and expose the identity to tool handlers through an `AsyncLocalStorage<McpCallerIdentity | null>` wrapped around `transport.handleRequest(c)` (the MCP SDK does not thread HTTP context into handlers; ALS is the seam).
- Enforcement helper used by tool handlers that accept a session-identity argument:

```ts
// mode from config: AGENT_CONSOLE_MCP_AUTH = 'off' | 'warn' | 'enforce'
// default: 'warn' single-user; 'enforce' multi-user (Phase 4, landed)
function checkCallerOwnsSession(caller: McpCallerIdentity | null, claimedSessionId: string, mode: Mode): ErrorResult | null
```

  Rules: (1) if a token WAS presented and the claimed session's `createdBy` differs from `caller.userId`, reject regardless of mode (a presented-but-mismatched identity is always an error, never a warning); (2) if no token was presented, `enforce` rejects, `warn` logs and proceeds (today's behavior); (3) `off` preserves today's behavior entirely. Apply at the elevation-bearing tools first (`delegate_to_worktree`, `remove_worktree`, `run_process`, `create_conditional_wakeup`) plus `send_session_message`'s `fromSessionId`.

  **Fail-closed consequence for multi-user (Phase 4, landed):** the multi-user default is now `enforce`, so tokenless calls to the wired tools are rejected there — a worker (embedded or terminal) cannot opt out of identity verification by simply omitting its token. This is what makes the #878 guarantee real rather than advisory; it also means multi-user deployments require every agent path to carry a token, which is why the flip was gated on terminal-agent token delivery landing first (see below) before multi-user support could be claimed. Before this flip, the default was `warn` in ALL modes: an `enforce` default was unsatisfiable while no token-delivery path existed (pre-flip it would have halted every agent's MCP calls in any multi-user deployment the moment it deployed), and asking operators to manually override to `warn` in the interim would have invited forgotten fail-open state after the override stopped being necessary. The flip was therefore guaranteed mechanically by Phase 4's acceptance criteria instead of left to deployment configuration — this history is retained here as context for why the default was staged rather than landed from Issue #878 phase 1. Single-user mode still stays `warn` (the gap is operationally moot there, per Issue #878). An explicit `AGENT_CONSOLE_MCP_AUTH=warn` override still works in multi-user mode (operator escape hatch); the server emits a one-line startup notice when running multi-user under that explicit override so the state is visible in logs.
- **Token delivery, embedded-agent:** inside the stdin `init` message — never argv, never env. Activation always delivers a token, so embedded-agent calls are verifiable from day one.
- **Token delivery, terminal agents (Phase 4, landed):** elevated spawns MUST NOT route the token through `buildElevationArgs` env embedding (it lands in the inner shell argv, world-readable via `/proc/<pid>/cmdline`), and MUST NOT inject it through the PTY input stream either — `pty.write`-injected bytes are echoed by the shell, persisted into the worker output file, and broadcast to every connected viewer (including shared sessions), so a token routed that way leaks into durable, multi-reader storage. Instead the server writes the token to a **user-owned 0600 token file** via `writeUserOwnedSecretFile` (`privilege-elevation.ts`, a strict-thin-wrapper sibling of the `makeUserOwnedTemplateSink` precedent at `worktree-service.ts:597-602`, forcing 0600 regardless of ambient umask) and passes only the file *path* via env (`AGENT_CONSOLE_MCP_TOKEN_FILE`) — a path is not a secret. The terminal agent's MCP client reading the file and attaching the header is verified only to the level of MECHANISM EXISTENCE: Claude Code's `headersHelper` config mechanism is confirmed present in the installed CLI binary, but the functional path (helper actually reads the file, header reaches `/mcp`) requires a real multi-user host running a real Claude Code process to verify — that is owner dogfood, tracked on the umbrella #1004 Completion checklist. Until that dogfood confirmation, an unwired terminal agent is fail-closed: its MCP calls are rejected under the multi-user `enforce` default, but the worker itself still starts and runs.
- Revocation: on worker exit/kill/delete and on embedded-agent deactivation; token files are deleted on the same events.

## Provider adapter & tool-call normalization

Lives in `packages/embedded-agent/src/providers/`.

```ts
export interface ProviderAdapter {
  run(req: {
    model: string;
    messages: ChatMessage[];          // OpenAI Chat Completions message shape, tool results included
    tools: ToolDefinition[];          // { name, description, parameters: JSONSchema }
    signal: AbortSignal;
  }): AsyncIterable<ProviderEvent>;   // { type:'text-delta', text } | { type:'tool-call', callId, name, argsJson } | { type:'done', finishReason }
}
```

v1 ships one implementation, `OpenAIChatAdapter`: `POST {baseUrl}/chat/completions` with `stream: true`, SSE parsing, tool-call deltas accumulated by index until complete, `Authorization: Bearer <apiKey>` only when a key is configured. Anthropic and others are post-v1 adapters behind the same interface.

**Timeouts (mandatory).** The adapter enforces two hard deadlines on every streaming request: an **idle-read timeout** (no bytes received for 60 s) and a **total-request ceiling** (10 min). Both abort the request through the same `AbortController` that serves `cancel` / `shutdown`, and flow into the normal retry-then-`turn-error` path — so a stuck provider can never leave a turn `active` indefinitely (which would also wedge `turnActive` admission). Local models can be slow; both values come from optional `EmbeddedAgentDefinition` overrides later if dogfood demands, but v1 hardcodes the defaults.

Tool definitions come from the MCP client's `listTools()` at init: MCP already publishes JSON-Schema `inputSchema` per tool, mapped 1:1 onto the OpenAI `parameters` field. The system prompt is assembled by the loop at init, in this order: (1) context preamble (session id, worker id, cwd — so the model passes correct identity arguments); (2) **repo conventions**: if `<cwd>/AGENTS.md` exists and is readable, its content in a clearly delimited block, truncated at 32 KiB with an explicit truncation notice. The loop already runs as the requesting OS user, so filesystem permissions are naturally correct in multi-user mode — no new elevation surface. (3) `EmbeddedAgentDefinition.systemPrompt` — operator configuration comes last so it wins on conflict. v1 reads `AGENTS.md` only, from the cwd root only; configurable filename sets (e.g. `CLAUDE.md`) and directory-tree merging are post-v1. Missing or unreadable file: skip with a stderr log line, never fatal. The file is re-read on each activation (consistent with restart semantics).

Normalization (v1 scope): parse `argsJson` with `JSON.parse` and require the result to be a plain JSON object (an empty string counts as `{}`) — this is a SHAPE check only; deep validation against the tool's `inputSchema` is deliberately delegated to the MCP server's own zod layer, not duplicated in the loop. On malformed arguments (parse failure or non-object shape), feed a synthetic tool-result error back to the model so it can self-correct, up to **2 re-asks per turn** (a single counter shared across every tool call within one user turn, not per individual call), then `turn-error`. Constrained decoding / grammar enforcement and the text-parse fallback for models without native tool calling are explicitly post-v1 — v1 requires native tool-calling support from the model.

## Credentials (provider keys & the init handshake)

- Key store: `<AGENT_CONSOLE_HOME>/provider-keys.json`, mode 0600, owned by the server user, shape `{ "<ref-name>": "<api-key>" }`. Follows the JWT-secret precedent (`user-mode.ts:243-244`). v1 management is manual editing (documented in the operator guide); a management UI/API is post-v1. Keys are server-wide in v1; per-user keys are post-v1.
- Delivery: `EmbeddedAgentDefinition.provider.apiKeyRef` → looked up at activation → placed in the `init` stdin message together with the MCP token. **Secrets therefore never appear in argv or env**, satisfying the constraint fixed in Part I (elevated spawns embed env into the inner shell argv — `buildSpawnArgs`, `privilege-elevation.ts:220-226` — which is exactly the channel this design avoids).
- A dangling `apiKeyRef` fails activation with an explicit error surfaced to the client (not a silent fallback to keyless).
- **Multi-user trust boundary (explicit).** A server-wide key delivered into a per-user subprocess is readable by that OS user — stdin delivery prevents *incidental* leaks (argv, env, other users), not exfiltration by the process's own user. v1 therefore treats provider keys as **shared with every user permitted to run embedded agents**; the definition-ownership rules above control who can *configure* agents, not who can read a key once a worker runs as them. Deployments that cannot accept this must not enable keyed providers in multi-user mode until per-user keys (post-v1) land — keyless local endpoints are unaffected. This statement goes in the multi-user setup guide verbatim (Phase 4).

## UI

- New `packages/client/src/components/workers/EmbeddedAgentWorkerView.tsx` (+ hook `useEmbeddedAgentWorker`), rendering: message list (user / assistant, streaming deltas appended live), tool-call cards (name + collapsed args, paired result by `callId`, error styling on `ok: false`), an input box (Enter sends `embedded-user-message`), a cancel button while `active`, and the standard activity indicator driven by the shared `activity` message.
- A persistent, non-dismissable note in the view: conversation resets when the worker or server restarts (the v1 worker-type inconsistency called out in [Design Decisions](#design-decisions)).
- `exited` events render as an inline system row with a Restart action (re-activation = fresh conversation).
- Dispatch: extend `SessionPage.tsx` (`:42`, `:459`, `:504-505`, error-fallback `:49-56`).
- Worker creation: adding a worker presents a **single unified "agent" entry point** covering both kinds: the picker lists terminal-agent definitions (`AgentDefinition`, existing agents registry) and embedded-agent definitions (`EmbeddedAgentDefinition`, `GET /api/embedded-agents`) in one list, each item carrying a kind badge (Terminal / Embedded). Selecting an item creates the matching worker type (`agent` + `agentId` vs `embedded-agent` + `embeddedAgentId`) — the user never chooses a "worker type" as a separate prior step; the kind is a property of the chosen agent. When the embedded registry is empty, the picker still lists terminal agents and shows a non-link empty-state note (management UI arrives in Phase 3.5). Embedded-agent workers are NOT auto-created with sessions (unlike the git-diff worker, `session-manager.ts:620-623`). Terminal-agent items in the picker are shown but **disabled** with an explanatory tooltip: `CreateWorkerRequestSchema` (`packages/shared/src/schemas/worker.ts`) does not accept `type: 'agent'` creation params over the client-facing `POST /api/sessions/:sessionId/workers` route -- a terminal `AgentWorker` has only ever been creatable at session-creation time, never added to an already-running session. Listing terminal items disabled (rather than omitting them) keeps the unified list matching this section's design while accurately reflecting the current REST surface; widening the schema to support it is out of this PR's scope.
- Management surface: the agents management UI presents both registries under one "Agents" umbrella (sections or badges distinguishing the kinds); CRUD stays per-registry — REST endpoints and the data model are unchanged. This unification is **presentation-only**, per the separate-registry decision in [Embedded agent registry](#embedded-agent-registry-embeddedagentdefinition).

## Error handling & edge cases

| Case | Behavior |
|---|---|
| Loop crashes (unexpected exit) | Server appends `exited { code }`, sets `subprocess = null` / `activated: false`, activity `idle`, revokes token. UI offers Restart. |
| Malformed NDJSON line from loop | Log + skip the line; after 5 consecutive parse failures, kill the subprocess (protocol integrity lost) and treat as crash. |
| Oversized events | Loop truncates `tool-result.result` to 16 KiB, and `assistant-message.text` / tool-call `args` to 256 KiB, before emitting (both UTF-8-safe, same truncation helper) — this keeps every well-formed event well clear of the server's 1 MiB line-kill; server rejects (kills on) single lines > 1 MiB as protocol violation regardless. |
| `cancel` while idle | No-op (loop ignores it). |
| `user-message` while a turn is active | v1: server rejects with an error to the client ("turn in progress"); queueing is post-v1. |
| Provider unreachable at first turn | Normal `turn-error` path; the worker stays activated (the loop is healthy; the provider is not). |
| `AGENTS.md` unreadable / oversized | Unreadable: skip + stderr log, never fatal. Oversized: truncate at 32 KiB and append a truncation-notice line inside the delimited block. |
| Dangling `embeddedAgentId` (definition deleted while worker exists) | Activation fails with explicit error; worker stays deactivated. Definition deletion warns when live workers reference it. |
| Dangling `embeddedAgentId` at worker creation | `createWorker` resolves the definition BEFORE initializing/persisting and rejects with 400; the worker name derives from the definition (parallel to agent workers). This complements (does not replace) the activation-time check above — a definition deleted after creation still fails activation. |
| Session without `createdBy` at token mint | Activation fails with an explicit error (mint would produce an identity that `checkCallerOwnsSession` false-rejects). Surfaced to the client, not a silent fallback to tokenless. |
| Concurrent `activate()` calls for the same worker | The second (and any further) concurrent call awaits the SAME in-flight activation as the first — no duplicate spawn, no duplicate token mint. A stale `exited` event from a superseded attempt (which cannot occur under the guard, but is defended anyway) is detected by identity check and does not mutate the current live subprocess's state. |
| Post-mint activation failure (any step after the MCP token mint throws — spawn, stdin write, output reset) | The minted token is revoked and any already-spawned subprocess is killed before the error propagates. No orphaned token or process from a failed activation. |
| `sendUserMessage` stdin write failure | The server-authored `user-message` event is appended to the persisted stream BEFORE the stdin write is attempted (so replay ordering is stable across the common case); if the write itself then fails, that appended row is a "phantom" — it is durable in the output history even though the loop never received the message. `sendUserMessage` returns an error to the caller in this case; `turnActive` is cleared so a retry is possible. This is an accepted v1 trade-off (favoring stable ordering over exactly-once delivery); the phantom row is visible to a user re-reading history as an apparently-unanswered message. |
| Mid-round abort (`cancel` or the re-ask cap exceeded while tool calls from the current turn are still unresponded) | Synthetic tool-role error messages are inserted for every unresponded `tool_call_id` before `turn-error` is emitted, keeping the conversation valid for the next turn (every `tool_calls` entry has a matching tool response). See [The loop's turn cycle](#the-loops-turn-cycle). |
| WS client disconnects | Callbacks detached; subprocess keeps running (parity with PTY workers). |
| Server restart | Orphan reaping SIGTERMs the loop via the persisted pid (`killOrphanWorkers`, unchanged); next access re-activates with a fresh epoch + conversation. |

## Testing plan

Per `test-trigger.md` placements (sibling `__tests__/`), TDD polarity discipline per `workflow.md`.

- **Unit — loop package** (`packages/embedded-agent/src/**/__tests__/`): SSE/stream parsing of the OpenAI adapter against a mocked `fetch`; tool-call delta accumulation; malformed-args re-ask (max 2) and iteration cap; NDJSON line splitting with partial-chunk carry; init-first protocol enforcement (exit 2); AGENTS.md prompt assembly (present / absent / unreadable / oversized-truncation; assembly order preamble -> AGENTS.md -> systemPrompt). Boundary values: empty tool list, empty assistant text, zero-length delta.
- **Unit — server** (`packages/server/src/**/__tests__/`): `McpTokenRegistry` (mint/verify/revoke; unknown token → null); `checkCallerOwnsSession` mode matrix (presented-mismatch always rejects; absent-token × warn/enforce/off); capability predicates; `EmbeddedAgentWorkerService` with injected `spawnAsUserFn` (activation argv shape incl. no-token-no-key-in-argv/env assertions — negative assertions mandatory; exit/crash paths; stdin `init` first-line; user-message append-before-forward ordering). Use command-discriminating responders when a test doubles `spawnAsUserFn` for multiple call shapes (memory: wrapper-consumer responder splitting).
- **Integration** (`packages/integration/src/`): the Q10 wire test — a session containing a `EmbeddedAgentWorker` serializes over the app WS and parses through `WorkerSchema` with `embeddedAgentId`/`activated` intact; plus a worker-WS test: connect, receive history bytes, parse NDJSON, reconnect with offset and receive only the tail.
- **E2E (shipping path, mandatory before "done")**: with a local stub OpenAI-compatible HTTP fixture (scripted responses incl. one tool call), drive the real flow — create a `EmbeddedAgentDefinition` via REST, add a embedded-agent worker, send a message from the UI/WS client, observe the tool call hit the real MCP server with the bearer token and the result render. A PTY-byte-probe-style shortcut does not count (`workflow.md` mechanism-probe rule).
- **Smoke (multi-user, before claiming multi-user support)**: `scripts/smoke/check-embedded-agent-elevation.ts`, importing the production spawn helper (never replicating argv), spawning as a real second user, asserting: loop starts (bun resolvable on the target user's login PATH), `init` handshake completes, and — negative assertions — the MCP token / provider key appear in neither `/proc/<pid>/cmdline` nor `/proc/<pid>/environ`. Exit codes 0/1/2 per `os-environment-coupling.md`; documented in the multi-user setup guide.

## Implementation plan (phases)

Each phase is a PR (or small PR series) with its own tests and green CI; later phases depend on earlier ones. Counts below set reviewer expectations, not scope escape hatches.

| Phase | Content | Key acceptance criteria |
|---|---|---|
| **0a** | Capability-predicate refactor (pure; predicates + replace 5 guard sites) | No behavior change; existing MCP tool tests pass unmodified; new predicate unit tests |
| **0b** | #878 phase 1: `McpTokenRegistry`, `/mcp` bearer parsing + ALS, `checkCallerOwnsSession` (default `warn` in all modes; the multi-user `enforce` flip is Phase 4), wired into the 4 elevation-bearing tools + `send_session_message` | Mode matrix unit-tested; presented-mismatch rejects; no token → unchanged behavior under the `warn` default; existing agents unaffected |
| **1** | Shared types + valibot schemas (worker union, embedded-agent types/events, client messages), DB migration (`workers.embedded_agent_id`, `embedded_agents` table), mappers, `EmbeddedAgentManager` registry + REST CRUD | Q10 integration wire test green; migration up-tested; `check-mirror-drift` untouched |
| **2** | `packages/embedded-agent` (adapter, normalization, MCP client, protocol, incl. AGENTS.md prompt assembly) + `EmbeddedAgentWorkerService` (spawn/init/tail/append/exit/orphan/pause) | Loop unit suite green; service unit suite incl. negative argv/env assertions; E2E with stub provider passes in single-user mode; `COVERAGE_PATTERNS` in `check-utils.js` extended with `packages/embedded-agent/src/**/*.ts` AND its two mirrors updated in the same PR (`test-trigger.md` table + YAML globs; `check-mirror-drift.js` green) |
| **3** | WS routes branch + client transport reuse + `EmbeddedAgentWorkerView` + unified agent-selection UI (both kinds, one entry point) + reset-on-restart indicator | Browser QA with true-path screenshots (feature-visible state, per `workflow.md` §5); reconnect history replay verified |
| **3.5** | EmbeddedAgentDefinition management UI: minimal create/edit/delete form + Agents-umbrella presentation of both registries (spec §UI Management surface). Depends on Phase 1 only; parallel with Phase 4. | Browser QA true-path: create an embedded definition via the form, see it in the unified picker, edit, delete-with-live-worker-warning |
| **4** | Multi-user: smoke script + setup-guide docs (incl. the shared-key trust statement); terminal-agent token-file delivery + agent-side header wiring verified (prerequisite for `enforce`); the multi-user default flip to `enforce` in `resolveMcpAuthMode`; `session-worker-design.md` Worker Types table row + glossary sync | Smoke green on the dogfood host asserting the effective mode is `enforce` with no `AGENT_CONSOLE_MCP_AUTH` set; unit test: `AUTH_MODE=multi-user` + unset env var resolves to `enforce`; terminal agents functional in multi-user; setup guide documents the default flip; docs updated in the same PR |

## Post-v1 fast-follows

1. **Transcript persistence / restart-resume** (the deferred Design Decision): persist conversation state so re-activation can restore instead of reset; must solve the mid-turn / mid-tool-call restore case.
2. `asking` activity state (loop-side heuristics or model-declared).
3. Inbound `send_session_message` → `user-message` routing for embedded-agent workers (extend `canReceiveSessionMessages`).
4. Non-native tool-calling: text-parse fallback, constrained decoding (llama.cpp / vLLM structured output).
5. Provider key management UI/API; per-user keys.
6. Single-user `enforce` default (retiring `warn`) once tokenless callers no longer exist anywhere.
7. Anthropic (and other) provider adapters.
8. Turn queueing while active.
9. Convention-file expansion: configurable filename set (e.g. `CLAUDE.md`), directory-tree `AGENTS.md` merging, re-read on file change (v1 reads `<cwd>/AGENTS.md` once per activation).

## Cross-references

- [Session & Worker Design](session-worker-design.md) -- Worker type union, the non-PTY worker precedent (`GitDiffWorker`), and the "Adding New Worker Types" extension steps this design follows.
- [Custom Agent Registration Design](custom-agent-design.md) -- the existing **terminal-based** custom-agent path (template + PTY spawn). The embedded agent worker is a distinct execution model, not a variant of that template mechanism.
- [WebSocket Protocol](websocket-protocol.md) -- the worker channel; embedded-agent reuses the byte-offset/epoch framing with NDJSON content (see [WebSocket & client protocol](#websocket--client-protocol)).
- [`elevation-helpers.md`](../../.claude/rules/elevation-helpers.md) -- the `spawnAsUser` contract and consumer obligations this design depends on.
- [`os-environment-coupling.md`](../../.claude/rules/os-environment-coupling.md) -- real-machine smoke-test discipline; the v1 smoke script is specified in [Testing plan](#testing-plan).
- Issue [#878](https://github.com/ms2sato/agent-console/issues/878) -- MCP caller identity; phase 1 designed in [MCP caller identity](#mcp-caller-identity-issue-878-phase-1).
- MCP server implementation: `packages/server/src/mcp/mcp-server.ts`.
- Elevation primitives: `packages/server/src/services/privilege-elevation.ts`.
- Subprocess-management precedent: `packages/server/src/services/interactive-process-manager.ts` (volatile by design; this design combines its mechanics with worker persistence).
- Output-file machinery reused as-is: `packages/server/src/lib/worker-output-file.ts`, `worker-output-manifest.ts`.
- Shared service core: `packages/server/src/app-context.ts`, `packages/server/src/services/`.
