# Agent-Owned-Loop Worker (Direction)

**Status:** Proposed / Direction note. This document captures a design direction, not an accepted implementation plan. It records *why* the option is coherent with the current architecture and *what* the major pieces would be, so a later design/implementation PR can build on a shared understanding.

**Candidate decided:** among the three implementation shapes compared in [Design Decisions](#design-decisions), **candidate (b) — a per-user subprocess loop** — is the chosen direction for v1. This proposal was originally framed as an "in-process agent" (a loop running inside the server process — candidate (a)); the comparison showed that most of the claimed benefits come from *owning the loop*, not from being in-process, and the document was renamed accordingly. Where "in-process" still appears below, it refers specifically to candidate (a).

## Summary

Today every agent in Agent Console is a **terminal program** (Claude Code, Aider, etc.) launched as a PTY-backed [AgentWorker](session-worker-design.md#worker-types-current--future). Because that program runs in a **separate OS process**, the only way for it to operate the application (create sessions, delegate worktrees, run processes, ...) is through an inter-process channel. That channel is the built-in **MCP server** (`packages/server/src/mcp/mcp-server.ts`).

This note proposes offering, **as an option alongside the terminal model**, an agent that owns its LLM loop: instead of a fixed terminal program driven over MCP, our own loop talks to an LLM over an HTTP API and emits structured events. As compared in [Design Decisions](#design-decisions), the chosen implementation shape -- **candidate (b), a per-user subprocess loop** -- still calls the existing MCP server for app-operation tools; what changes is who writes the loop and what it emits, not whether a process boundary is crossed. The immediate target is broad model freedom -- OpenAI-compatible endpoints and, especially, **local LLMs**.

The two models are complementary, not a replacement: the terminal worker keeps its first-class seat for subscription-billed Claude Code; the agent-owned-loop worker maximizes model freedom for API- and locally-served models.

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

For example, MCP `close_session` and `DELETE /api/sessions/:id` both call `sessionManager.deleteSession(...)` — a genuinely thin adapter (it resolves the acting user from `session.createdBy` where a REST handler would use the authenticated request user, then converges on the identical service call).

Not every handler is this thin, though. MCP `delegate_to_worktree` layers roughly ten MCP-only orchestration steps in front of the one call that actually does the work (`createWorktreeWithSession`): parent-session-id XOR resolution, callback-prompt construction, agent-name resolution, branch-name suggestion with fallback, `SSH_AUTH_SOCK` derivation, and deletion rollback on partial failure. Extracting that orchestration into the shared core is a bounded, medium-cost task — and it benefits every candidate compared in [Design Decisions](#design-decisions), not just an in-process one.

## The core insight: MCP is a consequence of the process boundary

There are two independent process boundaries, and only one of them forces MCP:

```
  [Boundary A]  Agent  <->  server internal functions
  [Boundary B]  React UI (browser)  <->  server
```

- **Boundary A** -- today the agent is a PTY subprocess, so this boundary is crossed by a separate process. Crossing it requires IPC, and MCP is that IPC. This is the boundary the proposal changes.
- **Boundary B** -- the browser is always a separate process from the server, so the UI always talks over REST/WebSocket regardless of anything else. This boundary does **not** change.

Therefore MCP is not a free-standing choice; it is the necessary result of running the agent as a terminal program (a separate process). Remove the terminal nature of the agent -- run the agent *inside* the server process -- and Boundary A collapses: an in-process tool handler can call `appContext.sessionManager.xxx()` directly, and MCP is no longer needed for that agent.

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
2. **Restart-resume (conversation survives a server restart) is DEFERRED to a post-v1 fast-follow.** Under (b), a server restart already kills and re-spawns the worker process exactly like today's PTY-backed terminal workers do -- so "no resume in v1" is *parity* with the existing model, not a regression. (It would have been a hard requirement under (a), whose entire loop state lives in server memory.) v1 ships the agent-owned-loop UX (structured events, provider freedom) without transcript persistence; persisting the conversation transcript across the hard mid-turn / mid-tool-call restore case becomes an explicit fast-follow.

**Worker-type behavior inconsistency to surface in v1 (docs + UI).** Today's terminal AgentWorker resumes its conversation across a restart by re-invoking the underlying CLI with its continue flag (e.g. Claude Code's `-c`; see `session-worker-design.md`'s `agentId` note). The new agent-owned-loop worker type has no equivalent in v1 -- a restart starts a fresh conversation. This inconsistency between worker types must be stated plainly in the v1 design doc and in the UI (e.g. a visible "conversation resets on restart" indicator for this worker type), not left implicit.

## Proposal: an agent-owned-loop worker (candidate (b))

The [Worker](session-worker-design.md#worker-types-current--future) abstraction already includes a non-PTY worker in production: `GitDiffWorker` (`packages/shared/src/types/worker.ts:18-23`), which has no PTY and instead exposes a diff payload directly. (`session-worker-design.md`'s type table is stale and still lists this as a future-only `DiffWorker`; the code is ahead of that doc.) The agent-owned-loop worker slots in as a **new Worker type** the same way, rather than a product-level rewrite:

- Session / Worker lifecycle -- including the pid/`serverPid`/orphan-recovery machinery that survives a server restart -- is reused as-is, per [Design Decisions](#design-decisions).
- The worker WebSocket channel (`/ws/session/:sessionId/worker/:workerId`) is reused as the transport, but not the terminal-specific framing on top of it -- see [UI: a structured worker view alongside the terminal](#ui-a-structured-worker-view-alongside-the-terminal) for the schema cost.
- Instead of spawning a PTY running an external terminal program, the server spawns (via `spawnAsUser`) our own loop process, which streams **structured events** over stdout to the client.
- Terminal AgentWorker and the agent-owned-loop worker coexist. This is an added option, not a removal of the terminal model.

### Agent loop and tool execution

The loop implements the LLM tool-use cycle inside its own subprocess: send messages + tool definitions to the model, receive text and tool calls, execute each tool, feed results back, repeat. Tool execution calls the existing **MCP server**, the same channel today's terminal agents use -- not a direct service-layer call (that shape belongs to candidate (a), not the chosen (b); see [Design Decisions](#design-decisions)). MCP reuse here is contingent on Issue #878 landing first, since (b) inherits MCP's current self-asserted caller identity.

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
2. **Anthropic / Claude is not OpenAI-native.** Its Messages API and `tool_use` blocks are a different shape. This is acceptable here (see the positioning section): subscription Claude belongs to the terminal worker, so an Anthropic adapter for the agent-owned loop is optional and low priority.

### Local LLMs are the prime target

Local models (via an OpenAI-compatible endpoint) have the fewest *cost and access* constraints: no subscription, no per-token billing, no rate limits, offline capable, privacy-contained, and any open-weights model. That does not extend to tool-calling reliability -- as caveat 1 above states and the normalization-layer section below elaborates, local/open models are typically the *weakest* on function-calling fidelity, which is the opposite end of the constraint spectrum. The design has to actively invest in the normalization layer specifically because the cheapest, most accessible models are also the least reliable tool callers. All of it is reached through the single OpenAI-format adapter.

## Tool execution: reuse MCP as-is

Under candidate (b), the agent-owned loop calls the **existing MCP server** for app-operation tools -- the same `mcpServer.tool(name, description, zodSchema, handler)` registrations today's terminal agents (Claude Code) already use. There is no second, direct-call path to build or keep in sync: unlike candidate (a), (b) does not need a provider-neutral tool registry to avoid duplicating schemas, because there is only ever one caller shape (MCP) regardless of which OS process is calling it.

```
  MCP tool registry (mcp-server.ts, unchanged)
       |
       +-- external terminal agent (Claude Code)   [today]
       '-- agent-owned loop subprocess (candidate b) [proposed]
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

| | Terminal AgentWorker (today) | Agent-owned-loop worker (proposed, candidate b) |
|---|---|---|
| Agent output | raw terminal bytes (ANSI) | structured events (text / tool call / tool result) |
| Client render | xterm.js terminal emulation | chat / structured view (messages, tool-call cards) |
| Transport payload | PTY stdout stream | streamed agent events |

The worker WebSocket channel itself is shared as a transport, but the terminal-specific framing built on top of it -- absolute byte offsets, epochs, gzip segments, resize, history-range -- is PTY-only and does not apply here. A new `worker.type`-branched message schema is needed for the structured payload, the same way `GitDiffWorker` already plugs its own schema into the same worker WS via a `worker.type` branch (`packages/shared/src/types/git-diff.ts:201-223`, `routes.ts:723-745`). That is a real, bounded cost, not a "reused unchanged" given -- only the underlying transport and the session/worker lifecycle are unchanged; the message schema on top of it is new. The "dedicated React UI" is a consequence of the payload changing from terminal bytes to structured events, **not** of the UI calling internal functions directly (Boundary B is unchanged; the browser still goes over the wire).

## Positioning vs Claude and the subscription model

Claude being second-class on the agent-owned-loop path is expected and is a clean division of labor, not a defect:

- Anthropic's flat-rate subscription (Pro / Max) is usable **only through Claude Code** (the agent/CLI), while raw API access is separately metered per token. The agent-owned-loop path is an API-billed world, so subscription Claude has no advantage there.
- Consequently the two worker types map onto two access/billing models:

| | Terminal Worker (today) | Agent-owned-loop Worker (proposed) |
|---|---|---|
| Primary models | Claude via subscription (flat rate) | OpenAI-format API + local models |
| Path | Claude Code + MCP | own loop (per-user subprocess) + MCP + direct LLM API |
| Claude's standing | first-class (best value on flat rate) | works only if API-billed; low priority |

So there is no need to force Claude to be first-class on the agent-owned-loop path: subscription Claude keeps its first-class seat on the terminal worker, and an agent-owned-loop Anthropic adapter can be an optional add-on for users who want to spend API credits inside the unified structured-event UI. Net effect: the terminal worker (best-in-class Claude) and the agent-owned-loop worker (maximum model freedom) coexist and cover each other's weak spots.

## Trade-offs

- **Gain:** structured events enabling a richer UI, broad model freedom (API + local) through one adapter, and -- because candidate (b) reuses the existing worker pid/orphan-recovery machinery and `spawnAsUser` elevation -- no new restart-durability or multi-user-elevation plumbing.
- **Cost:** the loop reimplements the agent cycle and does not inherit Claude Code's built-in capabilities (its own file editing, shell, context management, hooks, skills). The terminal model's strength -- running *any* terminal-based agent unmodified -- is exactly what the agent-owned-loop model gives up in exchange for a structured, provider-flexible UI. Offering both as options is what preserves both strengths. Unlike an earlier framing of this proposal, the chosen candidate does **not** remove the MCP/IPC hop on Boundary A -- see [Design Decisions](#design-decisions) for why that trade was made deliberately in favor of restart durability and elevation reuse.

## Non-goals

- Removing or deprecating the terminal AgentWorker or the MCP server. Both remain the primary path, and the chosen candidate actively depends on MCP rather than replacing it.
- Committing to specific providers, model lists, or a concrete schema for the structured event payload. Those belong to a follow-up design PR.
- Conversation continuity across a server restart (transcript persistence) in v1. Explicitly deferred to a post-v1 fast-follow -- see [Design Decisions](#design-decisions).

## Multi-user identity & privilege

Candidate (b) is spawned via `spawnAsUser` (`packages/server/src/services/privilege-elevation.ts:450-512`) as the requesting OS user -- the same durable, caller-lifecycle-owned primitive already backing `run_process` / `InteractiveProcessManager`. `shouldElevateForUser` (`privilege-elevation.ts:178-189`) transparently bypasses elevation in single-user / same-user deployments, so this design does not introduce a new multi-user-specific code path; it reuses the existing elevation boundary as-is. This is a structural reason (b) was chosen over (a): (a) runs as the server's own OS user and would need `requestUsername` threaded through every direct service call it makes, which is new plumbing with real regression risk against the multi-user work already invested in the elevation primitives. (b) needs none of that.

Two consumer obligations follow from adopting `spawnAsUser`, per [`elevation-helpers.md`](../../.claude/rules/elevation-helpers.md):

- **Stdin.** `spawnAsUser` always pipes stdin (`stdin: 'pipe'`). The worker that owns the loop subprocess must actively manage it -- keep it open only while genuinely feeding the loop (prompts / follow-up instructions), the same discipline `ConditionalWakeupManager`'s `spawnAsUser` migration required (Issue #886 / PR #889). A fire-and-forget spawn that never closes or writes stdin risks the same silent-hang failure mode documented there.
- **Stdout/stderr draining.** The loop's structured events are its stdout payload and must be actively consumed by the worker, not left to buffer.

**MCP identity dependency.** Because (b) reuses MCP for tool execution (see [Proposal](#proposal-an-agent-owned-loop-worker-candidate-b)), it also reinherits MCP's current caller-identity gap: `fromSessionId` / `sessionId` / `repositoryId` are free tool arguments that server-side handlers check for existence only, not ownership (`mcp-server.ts:476-490`). A per-user subprocess spawned under the correct OS user does not, by itself, prevent a buggy or adversarial loop from asserting a different session's identity to the MCP server -- OS-level user isolation and MCP-level session-identity verification are separate guarantees. This is exactly why [Design Decisions](#design-decisions) brings **Issue #878 into scope** for this direction rather than treating it as a nice-to-have: (b) is not safe to ship for multi-user deployments until #878 closes that gap.

### Follow-up design axis: MCP reachability and credential propagation

Choosing (b) introduces one design axis that (a) would not have had: everything the loop subprocess needs must cross an OS-user boundary at spawn time.

- **Reaching the MCP server** is the already-solved half. The MCP server is Streamable HTTP (`/mcp` route, `mcp-server.ts:1570`), and today's terminal agents already receive `AGENT_CONSOLE_BASE_URL` / `AGENT_CONSOLE_SESSION_ID` / `AGENT_CONSOLE_WORKER_ID` injected at PTY spawn (`AgentConsoleContext`, `packages/server/src/services/user-mode.ts`). The loop subprocess reuses the same injection mechanism and connects over HTTP; no new channel is needed.
- **LLM provider credentials** are the genuinely new half. A terminal agent brings its own credentials (e.g. Claude Code's auth lives in the OS user's home directory); the agent-owned loop instead needs a provider API key that the *server* holds, delivered into a process running as a *different* OS user. Under elevation, `buildSpawnArgs` embeds `opts.env` into the inner shell command, so a naive env pass-through would expose the key in the process argv (visible via `ps`); and the existing `getCleanChildProcessEnv` discipline exists precisely because env propagation across this boundary is a known leak surface. The concrete mechanism (write a user-owned config file at spawn, have the loop fetch the key over an authenticated local call, or an argv-safe env path) and the key-ownership model (per-user keys vs a server-wide key) are **follow-up design PR scope** -- this note only fixes the constraint: provider secrets must not appear in argv / process listings, and must not be readable by other non-privileged OS users.

If the implementation phase introduces further OS-level assumptions beyond `spawnAsUser` (login-shell PATH, sudoers config, file-ownership on the loop's working directory), the real-machine smoke-test discipline in [`os-environment-coupling.md`](../../.claude/rules/os-environment-coupling.md) applies, same as any other OS-coupled code in this codebase.

## Other open design axes for v1

Two more consequences of choosing a non-PTY worker that the v1 design must resolve (named here so they are not rediscovered mid-implementation):

### Activity state without a PTY

Today `AgentActivityState` is derived entirely by *parsing PTY output bytes* -- the `ActivityDetector` matches agent-defined regex patterns against the byte stream -- and `activated` literally means "the worker has a live PTY" (`pty !== null`). Neither definition applies to a worker with no PTY. The relationship inverts: the loop *knows* authoritatively when it is waiting on the LLM, executing a tool, or idle, so instead of the server inferring activity from output, the loop **emits activity state as part of its structured event stream** and the server records it. The v1 design must define: how today's activity states map onto loop-emitted states, which structured event carries state transitions, and what `activated` means for this worker type (e.g. "loop subprocess alive").

### The Agent concept forks

Today an `AgentDefinition` describes *how to launch a terminal program*: a command template, activity-detection patterns, continue args (e.g. `-c`). An agent-owned-loop agent is configured by entirely different data: provider endpoint, model, credential reference, and optionally a system prompt / tool policy. These are disjoint shapes, not variants of one template. The v1 design must decide whether `AgentDefinition` becomes a discriminated union (terminal-agent vs loop-agent), or the loop agents live in a separate registry -- and how session/worker creation UI selects between the two kinds.

## Rough sequencing (for a later plan)

1. Bring Issue #878 (verified MCP caller identity) to closure -- a prerequisite for (b), not an optional hardening step.
2. Define the provider adapter interface and implement the OpenAI-format adapter plus the tool-call normalization layer (built with local LLMs in mind).
3. Add the agent-owned-loop worker type (candidate b) to the Worker union and SessionManager, wired through `spawnAsUser` and the existing pid/orphan-recovery path.
4. Define the structured-event message schema for the worker WebSocket channel (new `worker.type` branch, per the `GitDiffWorker` precedent) and add the corresponding structured worker view in the client alongside xterm.

## Cross-references

- [Session & Worker Design](session-worker-design.md) -- Worker type union and the non-PTY worker precedent (note: its type table is stale on `DiffWorker`; see [Proposal](#proposal-an-agent-owned-loop-worker-candidate-b) for the current code citation).
- [Custom Agent Registration Design](custom-agent-design.md) -- the existing **terminal-based** custom-agent path (template + PTY spawn). The agent-owned-loop worker is a distinct execution model, not a variant of that template mechanism.
- [WebSocket Protocol](websocket-protocol.md) -- the worker channel transport the structured view would reuse; the message schema on top of it is new.
- [`elevation-helpers.md`](../../.claude/rules/elevation-helpers.md) -- the `spawnAsUser` contract and consumer obligations this design depends on.
- [`os-environment-coupling.md`](../../.claude/rules/os-environment-coupling.md) -- real-machine smoke-test discipline for any further OS-level assumptions introduced during implementation.
- MCP server implementation: `packages/server/src/mcp/mcp-server.ts`.
- Elevation primitives: `packages/server/src/services/privilege-elevation.ts`.
- Shared service core: `packages/server/src/app-context.ts`, `packages/server/src/services/`.
