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
2. **Restart-resume (conversation survives a server restart) is DEFERRED to a post-v1 fast-follow.** Under (b), a server restart already kills and re-spawns the worker process exactly like today's PTY-backed terminal workers do -- so "no resume in v1" is *parity* with the existing model, not a regression. (It would have been a hard requirement under (a), whose entire loop state lives in server memory.) v1 ships the embedded-agent UX (structured events, provider freedom) without transcript persistence; persisting the conversation transcript across the hard mid-turn / mid-tool-call restore case becomes an explicit fast-follow. **Update (Issue #1123, owner directive 2026-07-15):** this deferral has since been un-deferred as a formal policy change -- not a re-litigation of the reasoning above, which remains accurate design history for why v1 shipped without restore. See [Transcript Restore](#transcript-restore).

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
- **Cost:** the loop reimplements the agent cycle and does not inherit Claude Code's built-in capabilities (its own file editing, shell, context management, hooks, skills) wholesale. This gap is being closed progressively, not left permanent: fast-follow issues FF-1a/1b/1c ([Built-in tools](#built-in-tools-fast-follow)) add subprocess-local `Read`/`Glob`/`Grep`/`Bash`/`Write`/`Edit` tools matching Claude Code's own shapes, and FF-2 adds OS-level sandboxing on top. What remains a genuine, not-currently-scheduled gap is context management, hooks, and skills. The terminal model's strength -- running *any* terminal-based agent unmodified -- is exactly what the embedded-agent model gives up in exchange for a structured, provider-flexible UI. Offering both as options is what preserves both strengths. Unlike an earlier framing of this proposal, the chosen candidate does **not** remove the MCP/IPC hop on Boundary A -- see [Design Decisions](#design-decisions) for why that trade was made deliberately in favor of restart durability and elevation reuse.

## Non-goals

- Removing or deprecating the terminal AgentWorker or the MCP server. Both remain the primary path, and the chosen candidate actively depends on MCP rather than replacing it.
- Conversation continuity across a server restart (transcript persistence / resume) in v1. Explicitly deferred to a post-v1 fast-follow -- see [Design Decisions](#design-decisions) and [Post-v1 fast-follows](#post-v1-fast-follows).
- Supporting models without native tool-calling in v1 (text-parse fallback / constrained decoding are post-v1; see [Provider adapter](#provider-adapter--tool-call-normalization)).
- Making Claude first-class on this path (see Positioning above).
- OS-level sandboxing and MCP-surface per-caller tool filtering in FF-1a — [Built-in tools](#built-in-tools-fast-follow)'s path confinement is a process-boundary floor, not a sandbox; that hardening is FF-2's explicit scope, tracked separately.

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
- Issue #878 phase 1: per-worker MCP bearer token, verification middleware, ownership checks — default `warn` for every `AUTH_MODE`, including multi-user (Phase 4 briefly flipped multi-user to `enforce` fail-closed; reverted to `warn` in Sprint 2026-07-16, see Issue #1107).
- Chat UI (`EmbeddedAgentWorkerView`) with history replay on reconnect.
- Single-user mode fully supported; multi-user elevated spawn implemented behind the existing `shouldElevateForUser` gate. Multi-user support is declared only at Phase 4, which requires the real-machine smoke test AND terminal-agent token delivery.

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
  enabledTools?: EmbeddedAgentToolName[]; // FF-1a; undefined = default read-only set, [] = all builtin tools off — see Built-in tools
  instructions?: string[];    // opt-in instruction-file list, resolved relative to locationPath via resolveConfinedPath — see AGENTS.md loader
  contextWindowTokens?: number;  // Context Handoff (Phase A); operator-declared model context window, denominator for the usage ratio
  handoff?: { softRatio?: number; hardRatio?: number; auto?: boolean }; // Context Handoff (Phase A); auto is accepted/persisted but NOT read until Phase B
  createdBy: string;          // users.id of the creator (same UUID space as session.createdBy)
  createdAt: string;
  updatedAt: string;
}
```

**Ownership.** Definitions select provider endpoints, prompts, and key references, so mutation is not free-for-all: in multi-user mode, `PATCH` / `DELETE` require the authenticated request user (`authMiddleware`'s `authUser.id`) to equal `createdBy`; `GET` / list / worker-creation use are shared (definitions are server-wide resources). In single-user mode the check is trivially satisfied (sole user). `createdBy` is set server-side from the authenticated user at `POST` time, never from the request body.

Plus a valibot schema in `packages/shared/src/schemas/embedded-agent.ts` (strictObject; `baseUrl` validated with `v.pipe(v.string(), v.url())`).

**DB:** new table `embedded_agents` (columns mirroring the type incl. `created_by`; `provider_*` flattened: `provider_base_url`, `provider_model`, `provider_api_key_ref`). New migration `migrateToV<next>` in `packages/server/src/database/connection.ts` (check the current max `user_version` in `runMigrations`, `connection.ts:226-315`, and take the next number; v21 was the latest at the time of writing). The Context Handoff (Phase A) columns (`context_window_tokens`, `handoff_soft_ratio`, `handoff_hard_ratio`, `handoff_auto`) land in migration v27 — see [Context Handoff (Phase A)](#context-handoff-phase-a).

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
      maxToolIterations: number;
      enabledTools?: EmbeddedAgentToolName[]; // FF-1a; server forwards the definition's raw value unchanged, incl. undefined — the loop applies the undefined -> default rule itself (see Built-in tools)
      instructions?: string[] }               // opt-in instruction-file list, forwarded unchanged; the loop resolves + confines + loads them — see AGENTS.md loader
  | { v: 1; type: 'user-message'; id: string; text: string } // id minted by server, echoed in events
  | { v: 1; type: 'cancel' }                                 // abort the in-flight turn (AbortController)
  | { v: 1; type: 'handoff' }                                // Context Handoff (Phase A); manual trigger, see below
  | { v: 1; type: 'shutdown' };
```

Agent -> server (stdout):

```ts
type EmbeddedAgentEvent =
  | { v: 1; type: 'ready' }                                          // init accepted, MCP tools listed
  | { v: 1; type: 'state'; state: 'active' | 'idle' }                // authoritative activity
  | { v: 1; type: 'assistant-delta'; turnId: string; text: string }  // streamed text chunk
  | { v: 1; type: 'assistant-thinking-delta'; turnId: string; text: string } // streamed reasoning/thinking chunk, no terminal counterpart
  | { v: 1; type: 'assistant-message'; turnId: string; text: string }// final full text of one assistant message
  | { v: 1; type: 'tool-call'; turnId: string; callId: string; name: string; args: unknown }
  | { v: 1; type: 'tool-result'; turnId: string; callId: string; ok: boolean; result: string } // result truncated to 16 KiB
  | { v: 1; type: 'turn-error'; turnId: string; message: string }    // turn aborted (provider error, iteration cap, cancel, handoff failure)
  | { v: 1; type: 'fatal'; message: string }                         // loop is about to exit(1)
  | { v: 1; type: 'context-usage'; promptTokens: number; estimated: boolean } // Context Handoff (Phase A); emitted after every turn/handoff attempt that produced a usable value
  | { v: 1; type: 'context-handoff'; distillation: string };         // Context Handoff (Phase A); persisted marker, emitted immediately before the atomic conversation reset
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

On `user-message`: emit `state: active`; append the message to the in-memory conversation; then repeat up to `maxToolIterations` times: call the provider (streaming); emit `assistant-delta`s and a final `assistant-message` (text truncated at 256 KiB, UTF-8-safe, using the same truncation helper as `tool-result` — this guards against colliding with the server's 1 MiB oversized-line kill on a healthy long response); if the response contains tool calls, for each call emit `tool-call` (`args`' serialized form truncated at 256 KiB with the same guard), execute it via the MCP client, emit `tool-result`, append results to the conversation, and continue; otherwise the turn is complete. Emit `state: idle`. On provider error after 2 retries (exponential backoff, honoring 429 `retry-after`), or on hitting the iteration cap, emit `turn-error` then `state: idle` — the conversation stays usable for the next user message. When the provider streams reasoning/thinking content (`reasoning_content` deltas, see [Provider adapter & tool-call normalization](#provider-adapter--tool-call-normalization) below), the loop emits `assistant-thinking-delta`s interleaved with the `assistant-delta`s of the same iteration; thinking content is never accumulated into the final `assistant-message` text and has no terminal/final event of its own — the iteration's unconditional `assistant-message` emit is the implicit boundary a client uses to know a thinking segment has ended.

**Mid-turn abort repair (mandatory).** Both abort paths — `cancel` and hitting the re-ask cap — can fire while one or more tool calls from the current assistant turn have not yet received a matching tool-role response. Before emitting `turn-error` in either case, the loop pushes a synthetic tool-role message (e.g. `Error: canceled`) for every tool call in the current turn that has not yet been responded to. Without this, the `assistant` message's `tool_calls` array would carry unresponded `tool_call_id` entries into the next turn's request, which a strict OpenAI-compatible provider rejects with 400 — permanently wedging the worker. This is what makes the "conversation stays usable for the next user message" guarantee above actually hold across an aborted turn, not just a cleanly-completed one.

## Built-in tools (fast-follow)

**Status:** landing progressively across three fast-follow issues off the umbrella (#1004): FF-1a (#1042 — `Read`/`Glob`/`Grep`, the `enabledTools` policy, path confinement), FF-1b (#1043 — `Bash`), FF-1c (#1044 — `Write`/`Edit`). FF-2 (#1045, separate scope) adds OS-level sandboxing and MCP-surface per-caller tool filtering on top. This section documents the shape as of FF-1a; earlier parts of this document describing v1 tool execution as MCP-only are superseded by this section for the specifics below.

**Design direction (owner, 2026-07-12):** tools are not put on the MCP surface. They are implemented as subprocess-internal tools, the same way Claude Code / opencode implement their own `Read`/`Bash`/`Edit` — not proxied through the MCP server. Start from a subset of a reference CLI's tool shapes; do not reinvent argument schemas.

**Subprocess-local execution.** Tool definition and dispatch live inside `packages/embedded-agent`, the same process that already runs as the requesting OS user via `spawnAsUser` with `cwd = session.locationPath` ([The agent subprocess](#the-agent-subprocess-packagesembedded-agent)). Filesystem permissions and multi-user elevation are therefore automatically correct for these tools — no new elevation surface, no new MCP-auth surface. The same property that makes AGENTS.md-loading permission-correct applies here: the process boundary is already the trust boundary.

**Provider tools = builtin tools ∪ MCP tools.** At `init`, after the MCP connection succeeds, the loop merges the builtin tool set (`packages/embedded-agent/src/tools/index.ts`, resolved from `enabledTools` below) with the MCP-listed tools. On a name collision the builtin wins; the collision is logged to stderr, not exposed to the model as an error. `CompositeToolExecutor` (`packages/embedded-agent/src/tools/composite-executor.ts`) implements the merge and dispatch as a drop-in `ToolExecutor` (`packages/embedded-agent/src/mcp.ts`) wrapping the existing `McpToolClient` — the turn cycle above is unchanged; the executor swap happens entirely inside `main.ts`'s `initializeLoop`. Tool-call results ride the existing `tool-result` event and its existing 16 KiB truncation, so no wire-protocol / UI / server change was needed for tool execution itself — only the `init` command gains one optional field (`enabledTools`, already reflected in [Stdio protocol](#stdio-protocol-v1) above).

**Tool names and argument shapes match Claude Code's** (`Read`, `Glob`, `Grep`, and later `Bash`, `Write`, `Edit`): pretrained models already know these shapes, so no shape-adaptation prompt engineering is needed.

### `enabledTools` policy

`EmbeddedAgentDefinition.enabledTools?: EmbeddedAgentToolName[]`, where `EmbeddedAgentToolName = (typeof EMBEDDED_AGENT_TOOL_NAMES)[number]` and `EMBEDDED_AGENT_TOOL_NAMES = ['Read', 'Glob', 'Grep', 'Bash'] as const` (`packages/shared/src/types/embedded-agent.ts`). This constant is the single writer of tool-name literals in the codebase — the valibot schema, the builtin registry, and the UI's checkbox list all derive from it; none hardcode a parallel list.

Semantics:

- **`undefined`** (field absent on the definition) — the loop applies its own default, `DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS = ['Read', 'Glob', 'Grep']` (read-only tools ON, `Bash` OFF).
- **`[]`** — all builtin tools OFF.
- **An explicit array** — exactly that set. A name not in the array is **not represented in the provider's tools list at all** (unrepresentable, not merely rejected if called). This is what makes "opt-in for mutating tools" an actual guarantee rather than a convention: a model cannot call a tool it was never told exists, whether by hallucination or prompt injection, because `listTools()` never emitted it.

The undefined→default resolution happens **in the subprocess** (`resolveEnabledBuiltinTools`, `packages/embedded-agent/src/tools/index.ts`), not on the server, because the merge with MCP tools already happens there. The server forwards the definition's raw `enabledTools` unchanged (including `undefined`) in the `init` command.

`Bash` is enumerated in `EMBEDDED_AGENT_TOOL_NAMES` starting in FF-1a — so the schema, migration, and UI land atomically instead of needing a second migration round. Its registry entry lands in FF-1b: `resolveEnabledBuiltinTools(['Bash'])` now returns the real `bashTool`. `Bash` still stays OFF by default (`DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS` is unchanged) — a definition must opt in explicitly.

**Persistence.** New nullable `embedded_agents.enabled_tools TEXT` column (JSON array string; `NULL` ↔ `undefined`, `'[]'` ↔ `[]`, `'["Read","Glob"]'` ↔ `['Read','Glob']`). PATCH semantics on `UpdateEmbeddedAgentRequestSchema` follow the same convention as the sibling optional fields: `enabledTools: null` resets to `undefined` (default), `undefined` (key absent) means no change, an explicit array replaces.

**Edit-save pinning.** The Add/Edit form always writes an explicit array for `enabledTools` on save — it never leaves the field `undefined`. Once a definition has been through Add/Edit, its `enabledTools` is pinned to that snapshot and will NOT track future changes to `DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS`. Only definitions that have never been saved through the form (still `NULL`/`undefined` at the DB level) pick up a default change.

### Path confinement (the FF-1a "minimum floor")

All three FF-1a tools resolve their target path through `resolveConfinedPath` (`packages/embedded-agent/src/tools/path-confinement.ts`) before touching the filesystem:

1. Resolve the candidate path to absolute (relative to `locationPath` when not already absolute).
2. Follow symlinks via `realpath`, walking up to the nearest existing ancestor when the leaf does not yet exist, so a not-yet-created `Read` target or a `Glob`/`Grep` search root still gets a confinement verdict instead of an ENOENT throw.
3. Confined iff the resolved path equals `realpath(locationPath)` or is prefixed by it (`+ path.sep`).
4. On rejection, return `{ ok: false, result: 'Access outside session location is not permitted.' }` as an ordinary `tool-result` — never a turn-level error. The model sees a rejected tool call the same way it sees any other tool failure and can adjust; the turn does not abort.

This is a **process-boundary floor**, not OS-level sandboxing — a determined tool-implementation bug could still escape it, since the process itself has the OS user's full filesystem permissions. FF-2 adds OS-level sandboxing (e.g. bubblewrap) as defense-in-depth and extends the same confinement discipline to the MCP surface (per-caller filtering); FF-1a's confinement is the floor FF-2 builds on, not the final guarantee.

### `Read` / `Glob` / `Grep` (FF-1a)

| Tool | Args | Behavior |
|---|---|---|
| `Read` | `{ path: string; limit?: number; offset?: number }` | Line-numbered output (`<lineNumber>\t<line>`), 1-based numbering, default `limit` 2000 lines from `offset` 0 (0-based). Matches Claude Code's Read shape. |
| `Glob` | `{ pattern: string; path?: string }` | Glob search rooted at `path` (default `locationPath`) via Bun's native `Glob`. Results sorted by modification time, descending. Matches outside `locationPath` (e.g. via a matched symlink) are filtered out, not surfaced. |
| `Grep` | `{ pattern: string; path?: string; glob?: string; caseInsensitive?: boolean; outputMode?: 'content' \| 'files_with_matches' \| 'count' }` | Pure-TS content search — no `rg` binary dependency, since one is not guaranteed present in the deploy environment. `outputMode` defaults to `'files_with_matches'`. A deliberate subset of Claude Code's Grep, not a ripgrep reimplementation: binary files and files over ~1 MiB are skipped heuristically. |

All three: an empty match set is a successful, non-error result (`{ ok: true, result: '' }`) — "no matches" is not a tool failure.

### `Bash` (FF-1b)

| Tool | Args | Behavior |
|---|---|---|
| `Bash` | `{ command: string; timeout?: number; description?: string }` | Runs `sh -c <command>` (`packages/embedded-agent/src/tools/bash.ts`). `timeout` is optional milliseconds, clamped to `[1, 600000]`, default `120000`. `description` is accepted (matches Claude Code's shape, used for UI/logging elsewhere) but not otherwise consumed by the tool itself. |

**Execution model.** `runBash` spawns via `node:child_process`'s `spawn('sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })`, with `cwd = locationPath` (the same process-boundary confinement the FF-1a tools get for free — see [Subprocess-local execution](#built-in-tools-fast-follow) above) and `env` built by `buildBashEnv()` (`packages/embedded-agent/src/tools/env-cleaner.ts`): a copy of the loop subprocess's own `process.env` with every `AGENT_CONSOLE_*`-prefixed key stripped. This strip matters because the loop's own env may carry server-context variables — when the server spawns the loop in single-user / non-elevated mode, `spawnAsUser`'s non-elevated branch inherits the full parent `process.env` unchanged, so nothing upstream of the Bash tool has already filtered them out.

**Process-group kill on timeout.** `detached: true` makes the spawned `sh` its own process-group leader. On timeout, the ENTIRE process group is signaled — `process.kill(-pid, 'SIGTERM')` (note the negative pid), then, after a 2 s grace period, `process.kill(-pid, 'SIGKILL')` for anything still alive. This is what kills backgrounded/detached grandchildren (e.g. `nohup foo &` inside a non-interactive `sh -c` script, where job control is off and `&` does not fork a new pgid) along with the shell itself, rather than leaving them orphaned after the tool call returns.

**Output truncation (two layers).** `runBash` independently truncates `stdout` and `stderr` to 16 KiB each via the shared `truncateToBytes` helper before they are formatted into the single result string. This is separate from — and in addition to — the agent loop's own central 256 KiB truncation of the full formatted `tool-result` payload (see [The loop's turn cycle](#the-loops-turn-cycle)): the Bash-specific 16 KiB-per-stream cap keeps a single noisy command from dominating the turn's context budget, while the loop's central cap is the wire-protocol-level backstop shared by every tool.

**`ok` semantics are deliberate.** `result.ok` reflects timeout or spawn-error only — NOT the shell command's exit code. A command that runs to completion with a non-zero exit code is still `{ ok: true, ... }`, with `[Exit code: N]` appended to the formatted output for the model to see. This differs from what a reader might assume ("failed command = tool failure"): a failing shell command is normal, useful information for the model to reason about (e.g. `grep` returning 1 for "no match", a build script failing on a genuinely broken build), not an infrastructure failure of the tool call itself. Only `timedOut` or a spawn error (`ENOENT`, permission failure) sets `ok: false`.

`Bash` stays OFF by default (`DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS` unchanged) — opt-in only, via `enabledTools`, per [`enabledTools` policy](#enabledtools-policy) above.

**Abort signal (Issue #1052).** `BuiltinTool.execute(args, ctx, signal?)`'s third parameter is threaded unchanged from `CompositeToolExecutor.callTool`'s existing `signal` argument, which is itself sourced from `AgentLoop`'s per-turn `AbortController` — fired on the `cancel` command and, via `gracefulExit()`, on `shutdown`/stdin-EOF (`EmbeddedAgentWorkerService.deactivate()` already sends `{ type: 'shutdown' }` before killing the subprocess as part of worker deactivation/restart, so no server-side change was needed for this). `Bash` reuses its existing timeout kill sequence (SIGTERM to the process group → 2 s grace → SIGKILL) when the signal fires, so a Cancel pressed mid-command interrupts it in roughly the same worst-case bound as a timeout, rather than waiting out the full (up to 600 s) timeout. `Read` checks the signal once before starting its single `.text()` read (a small, not-a-real-interruption win); `Glob` and `Grep` check between traversal/matching steps and return `{ ok: false, result: 'aborted' }` the moment the signal is observed set, never throwing. `runBash` additionally: (a) decodes stdout/stderr through a persistent `node:string_decoder` `StringDecoder` per stream instead of per-chunk `Buffer#toString`, so a multi-byte UTF-8 character split across two `data` events reassembles correctly instead of producing a replacement character at the chunk boundary; (b) surfaces a `[Killed by signal]` marker in the formatted result when `exitCode === null` and the process was not killed by our own timeout/abort path (e.g. an external SIGKILL or OOM kill), so the model sees the abnormal termination instead of a silently empty status line.

### `Write` / `Edit` (FF-1c)

| Tool | Args | Behavior |
|---|---|---|
| `Write` | `{ file_path: string; content: string }` | Creates the file if it does not exist, or overwrites it entirely if it does (`packages/embedded-agent/src/tools/write.ts`). Reuses the same `resolveConfinedPath` as the FF-1a tools — a not-yet-existing leaf still resolves via the nearest-existing-ancestor walk, so a brand-new file under an existing directory confines correctly. Result string reports whether the file was created or overwritten and the byte count written, e.g. `File created: <path> (11 bytes)`. |
| `Edit` | `{ file_path: string; old_string: string; new_string: string; replace_all?: boolean }` | Replaces an exact substring match within an existing file (`packages/embedded-agent/src/tools/edit.ts`). The file must already exist — a read failure (including "file not found") is reported the same way `Read` reports it (`Failed to read file: ...`), never a crash. |

**Atomic write (shared by both tools).** Both `Write` and the write-back half of `Edit` go through one shared helper, `atomicWrite` (`packages/embedded-agent/src/tools/atomic-write.ts`): write the new content to a temp file in the SAME directory as the target (`<target>.tmp-<uuid>`, so the subsequent rename is same-filesystem and therefore atomic on POSIX), then `rename` the temp file onto the target path. If anything throws between the temp-write and the rename, the temp file is removed best-effort before the error propagates. This guarantees `file_path` is either untouched or holds the complete new content — never a partially-written file — even if the process is killed mid-write.

**`Edit`'s match discipline.** Matching is byte-exact: occurrences of `old_string` are counted via a manual `indexOf` loop (no regex — constructing one from an arbitrary string would need full special-character escaping and risks subtle mismatches), and no whitespace or line-ending normalization is applied before comparing. This means an `old_string` that differs from the file's content by so much as one space or a `\r`/`\n` difference is a genuine non-match, not something the tool silently reconciles.

- **`old_string === new_string`** is rejected up front as a no-op, before even reading the match count, with a result string containing `no-op` so the model can recognize and correct the call.
- **Zero matches** → rejected with a result string containing `not-found`.
- **`replace_all` false/absent and more than one match** → rejected as ambiguous, with the actual match count included in the message (e.g. `ambiguous: old_string matches 3 locations; ...`), so the model can narrow `old_string` or opt into `replace_all`.
- **`replace_all` false/absent and exactly one match** → that single occurrence is replaced.
- **`replace_all` true** → every occurrence is replaced (this also covers the exactly-one-match case; `replace_all: true` with a single match is not an error).

**Full-args execution, truncated preview.** Both tools execute against the FULL, untruncated `content` / `old_string` / `new_string` argument values — truncation is never applied to what is written to disk or to what drives the match/replace logic. Only the rendered `Edit` result string previews the changed snippets, each capped to roughly 200 characters (a plain `.slice(0, 200)`, matching the "200 chars" scale of the tool-result the model sees, distinct from the wire-level 16 KiB / 256 KiB truncation layers described elsewhere in this section) so a large diff does not dominate the turn's context budget by itself.

**No Read-before-Edit enforcement (v1 decision).** Unlike some reference CLIs, this implementation does not require the model to have called `Read` on a file before calling `Edit` on it. This is a deliberate simplification for v1: enforcing it would require the loop to track a per-file "has been read" flag across the conversation and reject edits that skip it, which is extra state and complexity with no correctness benefit here (the match-count discipline above already prevents a wrong-context edit from silently landing) — this may be revisited in a later fast-follow if it proves useful in practice.

**Confinement and default-off, same as prior fast-follows.** Both tools resolve their target through the same `resolveConfinedPath` helper as [`Read` / `Glob` / `Grep`](#path-confinement-the-ff-1a-minimum-floor) — no new confinement mechanism. Like `Bash`, both are mutating tools and stay OFF by default: `DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS` is unchanged (`['Read', 'Glob', 'Grep']`), so a definition must opt in explicitly via `enabledTools` to expose `Write` and/or `Edit` to the model.

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

### Initial prompt delivery (Issue #1068)

A worktree/session created with an embedded-agent worker and a non-empty `initialPrompt` must auto-deliver that prompt as the worker's first chat message, mirroring how terminal-agent workers already receive `initialPrompt` via `activateAgentWorkerPty`. Delivery happens **server-side**, inside `EmbeddedAgentWorkerService`, triggered by the loop's `ready` event — not client-side, to avoid multi-tab double-send races and to reuse the exact same `sendUserMessage` path (turn admission, transcript append, stdin write, WS broadcast) a normal user message takes, so **the client needs zero changes** to render it, live or on history replay.

**Eligibility gate (`deliverInitialPromptOnActivation`, persisted since Issue #1074).** Only the session's *initial* embedded-agent worker — the one created together with the session, with a non-empty `initialPrompt` — is eligible. A worker added later via the generic add-worker route (`routes/workers.ts` → `sessionManager.createWorker(sessionId, body, continueConversation)`, no `initialPrompt` argument) is never eligible, even if the session happens to carry an `initialPrompt` from its own creation. `WorkerLifecycleManager.createWorker`'s `embedded-agent` branch sets `deliverInitialPromptOnActivation: !!initialPrompt?.trim()` on the `InternalEmbeddedAgentWorker` at creation time. The flag is durably persisted alongside the other embedded-agent worker fields, in the nullable `workers.deliver_initial_prompt_on_activation` `INTEGER` (0/1) column (migration v26): `WorkerManager.toPersistedWorker` writes the in-memory value, and `WorkerManager.restoreWorkersFromPersistence` reads it back (instead of hard-coding `false`) when reconstituting an `InternalEmbeddedAgentWorker` after a server restart. This closes the pre-#1074 gap where a session whose initial embedded-agent worker was created but never activated before a server restart would silently lose the eligibility marker and never receive the initial-prompt delivery — reproducible under normal dogfood deploy cadence (daily restarts), not merely a narrow edge case.

**Idempotency (`sessions.initial_prompt_delivered`, migration v24, persisted).** A session-level boolean flag, NOT "transcript is empty" — embedded workers reset their transcript/epoch on every activation (restart semantics, see [Activation](#server-side-management-embeddedagentworkerservice) step 4 above), so an empty-transcript heuristic would wrongly re-fire delivery after every restart. The flag is set **only after** `sendUserMessage` reports success (stdin write + transcript append already happened), never before. `EmbeddedAgentWorkerService.maybeDeliverInitialPrompt(ctx)` — called from `handleLoopLine` on `event.type === 'ready'` — checks `worker.deliverInitialPromptOnActivation`, `session.initialPrompt` (trimmed, non-empty), and `session.initialPromptDelivered` (must be falsy) before calling `sendUserMessage`; on success it sets `session.initialPromptDelivered = true` and persists the session. On `sendUserMessage` failure (e.g. a stdin write race), the flag stays unset so a later activation can retry.

**Never re-fires once delivered, including across worker/server restart — this is intentional.** Once `initialPromptDelivered` is true, delivery never re-fires again for that session, even after the embedded worker (or the whole server) restarts and the worker's live transcript resets to empty. This does not contradict the existing "Conversation resets when this worker or the server restarts" UI notice: that notice is about *ephemeral chat history* (what's currently visible/replayable in the transcript), while `initialPromptDelivered` guards a *one-time creation-time event* (the prompt was already acted on once; re-sending it on every restart would be surprising and duplicate work, not a restore of lost context).

`handleLoopLine` is `private async` (previously synchronous) specifically so it can `await this.maybeDeliverInitialPrompt(ctx)`; its single call site in `readStdout`'s line loop was updated to `await` it (per `workflow.md`'s "never fire-and-forget" rule).

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
  | { type: 'embedded-cancel' }                        // -> forward { type: 'cancel' } to stdin
  | { type: 'embedded-handoff' };                       // Context Handoff (Phase A); -> EmbeddedAgentWorkerService.triggerHandoff, see below
```

  `request-history` is shared with the PTY path (same semantics).
- `onClose` (`:685-697`): detach callbacks like the PTY path (the subprocess keeps running without viewers, like a PTY does).
- **`restore-info` (Transcript Restore, #1123).** A new `WorkerServerMessage` variant, `{ type: 'restore-info'; epoch: number; messageCount: number; repairedToolCallIds: string[] }`, added to `packages/shared/src/types/session.ts`'s `WorkerServerMessage` union (and `WORKER_SERVER_MESSAGE_TYPES`). Sent ONLY when an activation's restore succeeded (never on restore failure or first-ever activation). Dual delivery (fast-path push to currently-attached connections right after reconstitution, before spawn; bootstrap re-delivery to every new connection for the lifetime of the incarnation) -- see [Transcript Restore § UI](#transcript-restore) for the full mechanism and rationale.

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
// default: 'warn' for every AUTH_MODE (Sprint 2026-07-16 revert; see #1107)
function checkCallerOwnsSession(caller: McpCallerIdentity | null, claimedSessionId: string, mode: Mode): ErrorResult | null
```

  Rules: (1) if a token WAS presented and the claimed session's `createdBy` differs from `caller.userId`, reject regardless of mode (a presented-but-mismatched identity is always an error, never a warning); (2) if no token was presented, `enforce` rejects, `warn` logs and proceeds (today's behavior); (3) `off` preserves today's behavior entirely. Apply at the elevation-bearing tools first (`delegate_to_worktree`, `remove_worktree`, `run_process`, `create_conditional_wakeup`) plus `send_session_message`'s `fromSessionId`.

  **Default history — `enforce` flip landed then reverted.** Phase 4 flipped the multi-user default to `enforce`, gated on terminal-agent token delivery landing first (see below) so every agent path could carry a token before tokenless calls started being rejected. That flip held only briefly: Sprint 2026-07-16 reverted the default back to `warn` for every `AUTH_MODE`, including multi-user (Issue #1107). The reversion rationale: the deployment is a team-of-trust, and `enforce`'s ops cost (existing-session token re-delivery, Claude Code `headersHelper` per-OS-user wiring, a full dogfood pass) outweighed the safety benefit at the time. `warn` still logs tokenless callers for observability, and rule (1) above (a presented-but-mismatched token is always rejected) is unaffected by the default and has been live since phase 1. An operator can still opt into `enforce` explicitly via `AGENT_CONSOLE_MCP_AUTH=enforce`; Issue #1107 tracks restoring `enforce` as the multi-user default once the deferred ops work lands.
- **Token delivery, embedded-agent:** inside the stdin `init` message — never argv, never env. Activation always delivers a token, so embedded-agent calls are verifiable from day one.
- **Token delivery, terminal agents (Phase 4, landed):** elevated spawns MUST NOT route the token through `buildElevationArgs` env embedding (it lands in the inner shell argv, world-readable via `/proc/<pid>/cmdline`), and MUST NOT inject it through the PTY input stream either — `pty.write`-injected bytes are echoed by the shell, persisted into the worker output file, and broadcast to every connected viewer (including shared sessions), so a token routed that way leaks into durable, multi-reader storage. Instead the server writes the token to a **user-owned 0600 token file** via `writeUserOwnedSecretFile` (`privilege-elevation.ts`, a strict-thin-wrapper sibling of the `makeUserOwnedTemplateSink` precedent at `worktree-service.ts:597-602`, forcing 0600 regardless of ambient umask) and passes only the file *path* via env (`AGENT_CONSOLE_MCP_TOKEN_FILE`) — a path is not a secret. The terminal agent's MCP client reading the file and attaching the header is verified only to the level of MECHANISM EXISTENCE: Claude Code's `headersHelper` config mechanism is confirmed present in the installed CLI binary, but the functional path (helper actually reads the file, header reaches `/mcp`) requires a real multi-user host running a real Claude Code process to verify — that is owner dogfood. This dogfood step was originally tracked on the umbrella #1004 Completion checklist (item 5); since the multi-user default reverted to `warn`, it is no longer a gate on #1004 and is re-scoped as a prerequisite for Issue #1107 (restoring `enforce` as the multi-user default) instead. Until that dogfood confirmation, an unwired terminal agent's MCP calls are rejected only if an operator has explicitly opted into `AGENT_CONSOLE_MCP_AUTH=enforce`; under the current `warn` default the worker starts and its tokenless calls are merely logged.
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
  }): AsyncIterable<ProviderEvent>;   // { type:'text-delta', text } | { type:'reasoning-delta', text } | { type:'tool-call', callId, name, argsJson } | { type:'done', finishReason }
}
```

v1 ships one implementation, `OpenAIChatAdapter`: `POST {baseUrl}/chat/completions` with `stream: true`, SSE parsing, tool-call deltas accumulated by index until complete, `Authorization: Bearer <apiKey>` only when a key is configured. Anthropic and others are post-v1 adapters behind the same interface.

**Reasoning/thinking content.** Several OpenAI-Chat-Completions-compatible providers (DeepSeek-R1 API, many vLLM reasoning-parser configs, OpenRouter passthrough, some Ollama models) stream reasoning/thinking content as `choice.delta.reasoning_content` — the same delta-streaming shape as `content`, not a separate message. `OpenAIChatAdapter` reads exactly this field name (no alternate key such as `reasoning` is supported, keeping the surface as minimal as `content` itself) and yields `{ type: 'reasoning-delta', text }` independently of any `text-delta` in the same chunk (a chunk may carry either, both, or neither field). The agent loop maps this 1:1 onto the wire-level `assistant-thinking-delta` event — see [The loop's turn cycle](#the-loops-turn-cycle).

**Timeouts (mandatory).** The adapter enforces two hard deadlines on every streaming request: an **idle-read timeout** (no bytes received for 60 s) and a **total-request ceiling** (10 min). Both abort the request through the same `AbortController` that serves `cancel` / `shutdown`, and flow into the normal retry-then-`turn-error` path — so a stuck provider can never leave a turn `active` indefinitely (which would also wedge `turnActive` admission). Local models can be slow; both values come from optional `EmbeddedAgentDefinition` overrides later if dogfood demands, but v1 hardcodes the defaults.

Tool definitions come from the MCP client's `listTools()` at init: MCP already publishes JSON-Schema `inputSchema` per tool, mapped 1:1 onto the OpenAI `parameters` field. The system prompt is assembled by the loop at init, in this order: (1) context preamble (session id, worker id, cwd — so the model passes correct identity arguments); (2) discovered/opt-in **instruction segments** (see "AGENTS.md loader" below); (3) `EmbeddedAgentDefinition.systemPrompt` — operator configuration comes last so it wins on conflict.

### AGENTS.md loader

The loop discovers instruction files across three layers at every activation and injects their content into the system prompt, immediately after the context preamble and before `EmbeddedAgentDefinition.systemPrompt`:

1. **Global** — `~/.config/agent-console/AGENTS.md` (XDG-compliant: honors `XDG_CONFIG_HOME` when set). Other tools' globals (`~/.claude/CLAUDE.md`, `~/.config/opencode/AGENTS.md`, etc.) are not consulted.
2. **Chain** — every directory from the git root down to `cwd` (root-to-cwd order). When `cwd` is outside any git repository (a quick session), the chain reduces to `[cwd]` only. Git-root detection treats a directory as the root when its `.git` entry exists as either a directory (regular clone) or a **file** (a worktree's `gitdir:` pointer) — this matters because agent-console sessions are frequently worktrees.
3. **`instructions[]`** — an opt-in, per-definition explicit file list (`EmbeddedAgentDefinition.instructions?: string[]`, opencode-shaped). Each entry is resolved relative to the session's `locationPath` (the same root builtin tools use) through `resolveConfinedPath` (`packages/embedded-agent/src/tools/path-confinement.ts`) — the identical confinement helper builtin tools use, so an `instructions[]` entry can never read outside the session's working tree even when the defining `EmbeddedAgentDefinition` was authored by a different party than the executing user. Escape attempts (absolute paths outside confinement, symlink escape via `realpath`) are skipped and warn-logged, never fatal.

**AGENTS.md canonical, CLAUDE.md fallback.** Within each directory checked by the global and chain layers (not `instructions[]`, which is literal file paths only), `AGENTS.md` is canonical; `CLAUDE.md` is read only when `AGENTS.md` is absent in that same directory. When both are present, `AGENTS.md` wins and the choice is debug-logged (not warn — both-present is a normal state, e.g. a repo symlinking `AGENTS.md -> CLAUDE.md`). When neither is present, the directory is silently skipped (the normal case for most directories in a deep chain — logging here would be noise).

**Concatenation and delimiters.** Segments are joined in the order: global -> chain (root to cwd) -> `instructions[]` (array order) -> `definition.systemPrompt`. Each instruction segment is preceded by a one-line delimiter: `--- Instructions: <origin> ---`, where `<origin>` is the absolute resolved source path.

**Caps and overflow.** Each discovered/opt-in file is capped at 16 KiB; the aggregate of all such segments (excluding `definition.systemPrompt`, which is operator configuration, not a discovered file) is capped at 48 KiB. When the aggregate is exceeded, whole segments are dropped from the general side first — global, then chain starting from the root end, then `instructions[]` starting from the last array entry — until the total is back under the cap. Dropping never inserts an in-prompt placeholder describing what was dropped; the only operator-visible signal is a warn-level log line (origin + byte size) for every truncation and every drop.

The loop already runs as the requesting OS user, so filesystem permissions are naturally correct in multi-user mode — no new elevation surface. All instruction files are read once at activation and cached for the worker's lifetime; a restart re-reads (consistent with restart semantics), but there is no first-tool-call deferral and no filesystem watcher, since instructions are structurally part of the system prompt and cannot be deferred past the first provider request.

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
- Worker creation: adding a worker presents a **single unified "agent" entry point** covering both kinds: the picker lists terminal-agent definitions (`AgentDefinition`, existing agents registry) and embedded-agent definitions (`EmbeddedAgentDefinition`, `GET /api/embedded-agents`) in one list, each item carrying a kind badge (Terminal / Embedded). Selecting an item creates the matching worker type (`agent` + `agentId` vs `embedded-agent` + `embeddedAgentId`) — the user never chooses a "worker type" as a separate prior step; the kind is a property of the chosen agent. When the embedded registry is empty, the picker still lists terminal agents and shows an empty-state note linking to the Agents umbrella's management UI (Phase 3.5). Embedded-agent workers are NOT auto-created with sessions (unlike the git-diff worker, `session-manager.ts:620-623`). Terminal-agent items in the picker are shown but **disabled** with an explanatory tooltip: `CreateWorkerRequestSchema` (`packages/shared/src/schemas/worker.ts`) does not accept `type: 'agent'` creation params over the client-facing `POST /api/sessions/:sessionId/workers` route -- a terminal `AgentWorker` has only ever been creatable at session-creation time, never added to an already-running session. Listing terminal items disabled (rather than omitting them) keeps the unified list matching this section's design while accurately reflecting the current REST surface; widening the schema to support it is out of this PR's scope.
- Management surface: the agents management UI presents both registries under one "Agents" umbrella (sections or badges distinguishing the kinds); CRUD stays per-registry — REST endpoints and the data model are unchanged. This unification is **presentation-only**, per the separate-registry decision in [Embedded agent registry](#embedded-agent-registry-embeddedagentdefinition).
- Context-window usage bar, threshold banners, and the manual handoff trigger are specified separately in [Context Handoff (Phase A)](#context-handoff-phase-a) — they attach to `EmbeddedAgentWorkerView` but are enough surface area to warrant their own section.

### AI-generated HTML/SVG preview: sanitizer as depth, not the boundary

The `PreviewPanel` (Phase 3, `packages/client/src/components/workers/PreviewPanel.tsx` + `packages/client/src/lib/preview-sandbox.ts`) renders AI-generated `html`/`svg` code blocks through three layers, and the layers do not carry equal weight. The engine-independent guarantee — the property that holds regardless of which browser renders the frame — is carried entirely by the two **declarative, structural** layers: the `<iframe sandbox="">` with no tokens (no `allow-scripts`, so script execution is refused outright by the browser regardless of document content) and the wrapper document's `<meta http-equiv="Content-Security-Policy">` (`default-src 'none'`, blocking script execution and all network fetches independently of the sandbox attribute). Both are enforced by whatever engine renders the frame, Safari and Firefox included, because they are spec-mandated browser behaviors, not sanitizer output. The `DOMParser`-based sanitizer (`sanitizePreviewFragment`) is the third layer, and it is **defense-in-depth, not the boundary**: markup that survives it on a differently-parsing engine — an mXSS-class divergence, where a HTML5 parser's foreign-content/RAWTEXT/adoption-agency edge cases let sanitized-looking output mutate into live markup on a second parse — still lands inside a script-blocked, opaque-origin, network-blocked iframe. Cross-engine sanitizer variance therefore erodes depth; it does not by itself open a direct hole. This distinction is the design precondition for the sanitizer's evolution (Issue #1106): empirically-verified sanitizer gaps against real Chromium (see the regression corpus in `preview-sandbox.test.ts` and Issue #1162 for a concrete documented case) are tracked and hardened over time, but a gap is not a merge-blocking security incident as long as the sandbox + CSP layers remain intact — those two are what must never regress.

## Context Handoff (Phase A)

**Status:** implementation-grade spec, Phase A only (Issue [#1122](https://github.com/ms2sato/agent-console/issues/1122)). Landed after v1 shipped; extends the Stdio protocol, `EmbeddedAgentDefinition`, and the client store/view specified above rather than superseding them.

**Problem.** v1's [UI](#ui) states a persistent, non-dismissable notice: conversation resets when the worker or the server restarts — a worker-type inconsistency against terminal agents, which continue via `-c`. Context Handoff does not remove that notice (a restart still resets everything — [Transcript persistence / restart-resume](#post-v1-fast-follows) is the separate, not-yet-designed fast-follow that would change it). What it adds is a way to avoid *involuntarily* losing context **within** a live worker's lifetime: when the conversation approaches the model's context window, the user can trigger a **handoff** — the loop asks the model to distill the conversation so far, then seeds a fresh conversation with that distillation instead of the raw history.

**Explicitly not this design (owner directives, out of scope permanently):**
1. Claude Code-style in-place compaction — summarizing mid-turn on the same conversation confuses the model's own sense of context, per owner.
2. Archiving old context — the old context is not needed once distilled, per owner.
3. A general hooks/event framework (matcher syntax, hierarchical config) — `context-handoff` is a single, purpose-built event name; it does not borrow `PreCompact` or other harness vocabulary because this design does not compact.
4. Mid-turn handoff — handoff only runs between turns, exactly like `user-message` (never breaks an in-flight tool-call cycle).
5. Cross-worker / cross-session handoff.

**Phase split.** Phase A (this section) is **manual trigger + an always-visible usage bar + prompt-file override only**. Phase B (separate Issue, filed after Phase A dogfood) adds hard-threshold auto-fire, a shell-script override handler with trust-gating, and reads `EmbeddedAgentDefinition.handoff.auto`. Phase A's loop and server code MUST NOT read `handoff.auto` — the field is accepted and persisted (forward-compat for Phase B) but inert until Phase B lands.

### Token accounting

**Source.** `OpenAIChatAdapter`'s request body gains `stream_options: { include_usage: true }`. Per the OpenAI streaming contract this causes one additional SSE chunk at the end of the stream carrying `usage: { prompt_tokens, completion_tokens, total_tokens }` with an **empty `choices` array** — the adapter's existing `const choice = chunk.choices?.[0]; if (choice === undefined) continue;` early-continue would silently skip this chunk, so the usage read MUST happen before that guard, independent of `choice` presence. `OpenAIStreamChunk` gains `usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null`; the adapter keeps the latest non-null value seen across the stream and includes it on the `done` event: `ProviderEvent`'s `{ type: 'done'; finishReason: string | null }` variant gains an optional `usage?: { promptTokens: number; completionTokens: number; totalTokens: number }` field (field names translated from the wire's snake_case to the adapter's existing camelCase convention).

**Fallback.** A provider that ignores `stream_options` (older/non-compliant OpenAI-compatible servers) never sends `usage`; `done.usage` is then `undefined`. `AgentLoop` falls back to a **chars/4 estimate** over the full `conversation` array's `content` (all messages, JSON length of `content` strings summed, divided by 4) for that attempt, and the resulting `context-usage` event carries `estimated: true`. A real `usage.prompt_tokens` value carries `estimated: false`.

**Granularity — turn-scoped, last-attempt wins.** `runTurn`'s tool-iteration loop makes one provider request per iteration (growing `conversation` each time a tool result is appended); a turn that used 3 tool calls made 4 requests. `AgentLoop` tracks the most recent successful attempt's usage in a turn-scoped variable (real value if the provider returned `usage`, chars/4 estimate otherwise) and, at the turn's terminal exit point (no more tool calls, or the iteration cap), emits **one** `context-usage` event carrying that last value — never an event per iteration. A turn that fails on its very first provider attempt (no successful response at all that turn) has no captured value and emits **no** `context-usage` event; a turn that succeeds on iteration N then later iterations fail still emits one using iteration N's value, at whichever point the turn actually concludes. This is the property audited at review: *"context-usage is the last provider request's prompt_tokens, not an intermediate one."*

**Handoff's own usage.** The distillation request (below) is itself one provider call and follows the identical last-attempt-wins/fallback logic; its `context-usage` reflects the (large, pre-handoff) prompt size and is emitted before the atomic conversation reset. A second `context-usage` follows immediately after the reset, this one always `estimated: true` (chars/4 over the brand-new two-message seed conversation, since no provider call has run against it yet) — this is what makes the bar visibly drop right after a successful handoff instead of staying pinned at the pre-handoff percentage until the next real turn completes.

**Denominator.** `EmbeddedAgentDefinition.contextWindowTokens?: number` (new field, migration v27 below) is the ratio's denominator; it travels to the client exclusively through the existing `embedded-agent-created` / `embedded-agent-updated` registry broadcasts (no new wire event needed — [Embedded agent registry](#embedded-agent-registry-embeddedagentdefinition) already covers this path). When unset, the client shows raw token counts with no ratio, no color escalation, and no threshold banners (there is nothing to compare against) — see UI below.

### Handoff prompt loader

New module `packages/embedded-agent/src/handoff-prompt.ts`, deliberately a narrower cousin of the [AGENTS.md loader](#agentsmd-loader), not a call into it — the semantics differ (override, not concatenation):

```ts
export interface LoadHandoffPromptParams { cwd: string; homeDir?: string; xdgConfigHome?: string }
export async function loadHandoffPrompt(params: LoadHandoffPromptParams): Promise<{ content: string; origin: string }>
```

- **Layer 1 (repo):** `<cwd>/.agent-console/handoff-prompt.md` — a single literal path, not a chain walk (unlike AGENTS.md, `cwd` already IS the session's `locationPath`, so there is no ancestor chain to consider).
- **Layer 2 (global):** `<configHome>/agent-console/handoff-prompt.md`, same XDG resolution (`xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? path.join(homeDir, '.config')`) as the instruction loader.
- **Layer 3 (bundled default):** a string constant `DEFAULT_HANDOFF_PROMPT` in the same module (not a shipped file — avoids a packaging/resolution concern for a few paragraphs of static text).
- **Precedence is override, not concatenation:** the first layer whose file exists and is readable wins outright; the other layers are not read. This is the one place Phase A's "same 3-layer precedence as instructions" language (Issue [#1122](https://github.com/ms2sato/agent-console/issues/1122) §f) means *order of preference*, not *order of concatenation* — a distillation prompt is one coherent instruction, not layered guidance.
- **Cap:** 16 KiB via the existing `truncateToBytes` (same constant/behavior as `INSTRUCTION_PER_FILE_CAP_BYTES`), warn-logged on truncation, no in-prompt marker.
- **Read timing:** loaded fresh on every `handoff` command (not cached at activation) — so editing the override file takes effect on the very next handoff, without a worker restart.

Bundled default (Layer 3), the canonical text implementers must ship verbatim unless the owner revises it:

```text
This conversation is approaching its context window limit. Produce a concise
but complete distillation of the conversation so far: the task, key
decisions made, the current state of any in-progress work, and the concrete
next steps. Write only the distillation text, with no preamble or
meta-commentary -- it will directly seed a fresh conversation that continues
this work.
```

### `AgentLoop.handoff()`

**Admission.** `handoff` shares the exact same `turnActive`/`currentTurn` gate in `main.ts`'s `runLoop` that `user-message` uses: a `handoff` command received while a turn (normal or a prior handoff) is active is ignored with a stderr log, mirroring "`user-message` while a turn is active" in [Error handling & edge cases](#error-handling--edge-cases). Server-side, `EmbeddedAgentWorkerService.triggerHandoff` performs the identical synchronous `runtime.turnActive` check-and-set `sendUserMessage` does before writing to stdin, returning `TURN_IN_PROGRESS` otherwise — no new admission mechanism, the existing one is reused for a second command type.

**Steps** (`AgentLoopDeps` gains `reassembleSystemPrompt: () => Promise<string>` and `loadHandoffPrompt: () => Promise<string>`, both closures built once in `main.ts`'s `initializeLoop` over the same `init` fields already used to build the system prompt at activation):

1. Emit `{ type: 'state', state: 'active' }` (existing event, existing client gating — see UI below for how the client shows a distinct "Handing off…" label on top of this).
2. `await this.deps.loadHandoffPrompt()`. On throw: `emitTurnError` with a synthetic `turnId` (`crypto.randomUUID()`), return. **`this.conversation` has not been touched**, and `emitTurnError`'s built-in `emitIdle()` call (see step 13) has already cleared `turnActive`, so the next `handoff` or `user-message` is immediately admissible.
3. Build a **transient** request array `[...this.conversation, { role: 'user', content: handoffPromptText }]` — passed directly into the provider call, never pushed onto `this.conversation`. (This requires factoring `runProviderWithRetries`/`runProviderAttempt` to accept an explicit `messages` argument instead of implicitly reading `this.conversation`, so `runTurn` and `handoff` share the retry/backoff/timeout logic without duplicating it — a pure refactor of the existing methods' signature, no behavior change for `runTurn`'s own call sites.)
4. Run it through the same retry-with-backoff path (`MAX_PROVIDER_ATTEMPTS`, `DEFAULT_RETRY_DELAYS_MS`, the same idle/total timeouts at the adapter level) normal turns use. On failure or cancel: `emitTurnError`, return. **`this.conversation` still has not been touched — this is the failure invariant**, and `turnActive` is already clear (same `emitTurnError` -> `emitIdle()` chain as step 2).
5. **Validate the outcome.** No tool calls are expected or handled in this request (the distillation prompt does not offer tools). If the provider returns any tool calls anyway, OR returns empty/whitespace-only text (`outcome.toolCalls.length > 0 || outcome.text.trim().length === 0`), the response has nothing usable to seed a fresh conversation with: `emitTurnError` with an explicit "no usable distillation" message, return. **`this.conversation` still has not been touched** — this is the same failure invariant as steps 2 and 4, preventing an irreversible replacement of the conversation with an empty or partial summary — and `turnActive` is already clear via the same `emitTurnError` -> `emitIdle()` chain.
6. Emit `context-usage` using the distillation call's own `outcome.usage` (real `promptTokens`/`estimated: false` if the provider returned usage, chars/4 estimate/`estimated: true` otherwise — same last-attempt-wins/fallback logic as a normal turn). This reflects the (large, pre-handoff) prompt size and is emitted before anything about `this.conversation` changes — see "Handoff's own usage" in [Token accounting](#token-accounting) above.
7. `distillation = outcome.text` (capped at the same 256 KiB `WIRE_EVENT_MAX_BYTES` UTF-8-safe truncation `assistant-message` uses, applied before emission).
8. `await this.deps.reassembleSystemPrompt()` — re-runs `loadInstructions` + `assembleSystemPrompt` so AGENTS.md/CLAUDE.md edits made during the worker's lifetime are picked up, per Issue [#1122](https://github.com/ms2sato/agent-console/issues/1122) §d's "AGENTS.md changes also get picked up" side benefit. On throw here (e.g. a transient fs error), fall back to the ORIGINAL `deps.systemPrompt` string captured at construction rather than aborting: distillation has already succeeded (steps 5-7), so the reset must complete as a unit even in this degraded form.
9. Emit `{ type: 'context-handoff', distillation }` — **immediately before** the conversation mutation, with no `await` between this line and step 11's splice below. Reassembly (step 8) now runs BEFORE this marker, so there is no async gap left between committing the persisted/broadcast marker and mutating `this.conversation`: a crash or a hung filesystem operation can no longer land between the two.
10. Seed text (fixed, NOT operator-overridable — distinct from the handoff prompt above): `` `This conversation continues from a previous one. Prior context summary: ${distillation}` ``.
11. **Atomic switch**, one synchronous statement: `this.conversation.splice(0, this.conversation.length, { role: 'system', content: newSystemPrompt }, { role: 'user', content: seedText })`. Nothing async happens between step 9's marker emission and this splice.
12. Emit a fresh `context-usage` (chars/4 estimate of the two-message seed conversation, `estimated: true` — see Token accounting above). This is the SECOND `context-usage` event of a successful handoff; step 6 emitted the first.
13. `emitIdle()` — same `{ type: 'state', state: 'idle' }` every turn ends with; `runtime.turnActive` clears server-side exactly as it does today.

**Failure invariant (the property under audit).** Every early-return path (prompt-load failure at step 2, provider failure/cancel at step 4, an empty or tool-call-only distillation at step 5) returns strictly before step 9's `context-handoff` emission — there is no path that mutates `this.conversation` without also having successfully emitted the marker. Every one of those early-return paths calls `emitTurnError`, whose last line is `emitIdle()` — the same `{ type: 'state', state: 'idle' }` transition step 13 ends a successful handoff with — so `runtime.turnActive` is cleared server-side on every failure path exactly as it is on success, making an immediate retry safe without any separate cleanup step. Conversely, once step 5's validation has passed, steps 6-13 are a straight-line sequence that always completes the reset: step 8 degrades gracefully on failure (falls back to the original system prompt, never aborts), and step 9 (the marker) is immediately followed — with no `await` in between — by step 11 (the splice), so nothing async can land between committing the marker and mutating the conversation. A polarity test MUST assert both directions directly against `this.conversation`'s observable content (not just "a turn-error was emitted"): drive a fake adapter that throws for the distillation request and assert the array is byte-identical to its pre-handoff state (verified by driving a subsequent `runTurn` and inspecting the `messages` array the fake adapter actually received); then flip the fake to succeed and assert the array now matches the seed shape.

### UI

Attaches to `EmbeddedAgentWorkerView` (v1 spec, [UI](#ui) above) as new siblings, not as changes to `MessagePanel` — `MessagePanel` is shared with PTY workers and stays worker-type-agnostic, exactly like the existing v1 reset-notice banner already positioned as a sibling above it.

**Always-visible usage bar.** A 2px-tall horizontal bar rendered as an in-flow sibling between the transcript scroll region and `<MessagePanel>` (both are existing siblings inside `EmbeddedAgentWorkerView`'s flex-column root; the bar and its banner insert between them, each `shrink-0` so the transcript's `flex-1` scroll region is unaffected). `role="progressbar"`; when `contextWindowTokens` is defined, also `aria-valuenow`/`aria-valuemin={0}`/`aria-valuemax={100}` (determinate); when undefined, those three attributes are omitted (indeterminate) and the track renders as a dashed/striped pattern with no fill and a tooltip reading `N tokens used; set contextWindowTokens for a gauge` (with a leading `~` and a trailing ` (estimated)` clause ONLY when `contextUsage.estimated` is `true` — a provider-reported exact count renders without either) — no animation (an animated stripe here would be visual noise per owner UX review). No numeric label is drawn on the bar itself (space-constrained); the same percentage + raw-token detail is available on hover via a tooltip, honoring `contextUsage.estimated` the same way (leading `~` on the percentage and a trailing `; estimated` clause only when the reading is the chars/4 fallback, never for a provider-reported exact count). Color bands, `ratio = contextUsage.promptTokens / contextWindowTokens`: `ratio < softRatio` → subtle/gray (minimal visual noise); `softRatio <= ratio < hardRatio` → amber; `ratio >= hardRatio` → red. `softRatio`/`hardRatio` default to 0.75/0.90 when the definition's `handoff.softRatio`/`handoff.hardRatio` are unset. A `contextWindowTokens` change (via the registry broadcast) is reflected on the next render with no transition animation — the bar simply switches from the dashed/indeterminate rendering to a solid, ratio-driven fill (or vice versa).

**Threshold banners.** Two independently-tracked thresholds (soft, hard), each fires **at most once per crossing**: crossing is defined as `prevRatio < threshold <= currentRatio` (treating "no prior reading yet" as `prevRatio = 0`, so a worker whose very first usage reading already exceeds a threshold still fires once). A banner auto-hides as soon as `ratio` drops back below its own threshold — e.g. a successful handoff that drops usage from 90% to 20% clears both the soft and hard banners on that same update, without requiring a dismiss click — and only re-fires on a genuinely fresh upward crossing after that (not merely `ratio` ticking back up while still under the threshold). Dismissing a banner via its own close button hides it early (before the ratio has dropped), with the same re-arm rule: it does not reappear until the ratio drops back below that specific threshold and crosses it again. A single usage update that jumps across both thresholds at once (e.g. 60% -> 95% in one turn) fires both banners in that update, independently. Soft: amber banner, "Context is `N`% full — consider starting a handoff", CTA button "Handoff now". Hard: red banner, more urgent copy, same CTA — Phase A does **not** auto-trigger anything at the hard threshold (that is Phase B's entire purpose); the red banner and the bar's red color are Phase A's only hard-threshold behavior. Neither banner renders when `contextWindowTokens` is undefined (no ratio to compare against a threshold).

**Handoff in flight.** The client sets a local `handoffInFlight` flag when it sends `embedded-handoff` (via the store's `triggerHandoff()` action, mirroring `cancel()`) and clears it when it observes either `context-handoff` (success), `turn-error` (NDJSON failure), or an immediate/synchronous server admission error delivered as a WS `error` message (e.g. `TURN_IN_PROGRESS`) — safe because the server-side admission gate guarantees no other turn can be interleaved during this window. `triggerHandoff()` is admission-atomic: it no-ops if `handoffInFlight` is already `true` (rejecting duplicate triggers from rapid clicks), and only latches `handoffInFlight: true` when the underlying socket write actually succeeds — a failed/not-connected send never leaves the UI showing "Handing off…" for a message that was never transmitted. While `handoffInFlight`, the view shows a `Handing off…` label wherever it already shows an activity indicator, and `MessagePanel`'s existing `cancelState` prop is passed `{ active: isTurnActive || handoffInFlight, onCancel: cancel }` — Send is disabled via the SAME mechanism a normal in-flight turn already uses, no new gating primitive. `cancel()` also works against an in-flight handoff (the loop's `AbortController` is shared between `runTurn` and `handoff`), surfacing as an ordinary `turn-error`.

**Handoff CTA placement.** Reachable from (a) either threshold banner's CTA button, and (b) a button in `EmbeddedAgentWorkerView`'s own chrome (e.g. near the activity/status indicator) so a handoff can be triggered even with both banners dismissed — never inside `MessagePanel`, per the shared-contract principle above. All three CTA buttons (both banners' "Handoff now" and the chrome's "Start handoff") share the same `disabled={isTurnActive || handoffInFlight}` guard, so a turn already in progress or a handoff already in flight cannot be re-triggered from any entry point.

**Transcript divider on completion.** The `context-handoff` event folds into a new `EmbeddedAgentChatEntry` kind (`{ kind: 'context-handoff'; distillation: string }`), rendered as a `<details>`/`<summary>` row using the same native-disclosure + stable-key discipline `WorkingAccordion` already uses ([WebSocket & client protocol](#websocket--client-protocol) context; see the component for the keying rationale), closed by default: summary line `— Context handoff: conversation restarted from summary —`, expanded body shows the full `distillation` text.

**Failure surfacing.** A handoff failure emits an ordinary `turn-error` (message prefixed, e.g. `Context handoff failed: <reason>`) — rendered by the existing `turn-error` chat-entry case, no new UI needed for the failure path itself; the conversation is provably unchanged (see the failure invariant above), so the existing "the conversation stays usable for the next message" framing already covers retry.

### Definition config, migration, and forms

`EmbeddedAgentDefinition.handoff?: { softRatio?: number; hardRatio?: number; auto?: boolean }` — whole-object replace on `PATCH` (same mechanics as the required `provider` field: `handoff: null` clears to `undefined`, an explicit object replaces wholesale, `undefined`/absent key means no change), not a per-subfield merge; there is no existing partial-nested-object PATCH precedent in this schema to extend instead, and whole-object replace keeps the three ratios/flag internally consistent by construction.

**Migration v27** (`packages/server/src/database/connection.ts`, following the `migrateToV26` template exactly): adds nullable columns `context_window_tokens INTEGER`, `handoff_soft_ratio REAL`, `handoff_hard_ratio REAL`, `handoff_auto INTEGER` (0/1 boolean convention, matching `deliver_initial_prompt_on_activation`) to `embedded_agents`. Mapper (`mappers.ts`) flattens/reconstructs `handoff` the same way `provider` flattens to `provider_*` columns, except reconstruction is conditional (build the nested object only when at least one of the three columns is non-null; `provider` is unconditional because it is required).

**Forms.** `EmbeddedAgentForm.tsx` gains an optional `contextWindowTokens` numeric input (mirrors the existing `maxToolIterationsInput` string-state/parse-on-save pattern exactly) and optional `handoff.softRatio` / `handoff.hardRatio` percentage inputs (e.g. a "75" input maps to `0.75`), plus an object-level check rejecting submission when both are present and the soft value exceeds the hard value. Percentage inputs accept and preserve decimal precision (e.g. "75.6" maps to `0.756`); `formatHandoffRatioInput` (which pre-fills the Edit form from a stored ratio) rounds only to strip floating-point representation noise from the `* 100` multiplication, never to a whole percent — a decimal threshold round-trips through Edit unchanged instead of drifting on an unrelated re-save. Phase A's form does **not** expose an `auto` checkbox — the schema accepts the field (forward-compat for Phase B's UI), but this form never writes a value for it, so it stays `undefined` for every definition created or edited through Phase A tooling.

### Testing (additions to the plan above)

- **Unit — loop package:** the usage-accounting fallback (real `usage.prompt_tokens` vs chars/4 estimate, `estimated` flag correctness), last-attempt-wins granularity across a multi-iteration turn, the handoff prompt loader's 3-layer override precedence (repo beats global beats bundled; cap/truncation), and — **mandatory, the audited property** — the `handoff()` failure-invariant polarity test described above (both directions, asserted against the actual `messages` array a subsequent provider call receives, not merely against emitted-event side effects).
- **Unit — client:** the threshold-crossing pure function (`prevRatio < threshold <= currentRatio`) at its boundary values — exactly-at-threshold on both sides, `prevRatio = null`/first-ever reading, a single update crossing both thresholds at once, dismiss-then-redisplay-only-on-a-fresh-crossing.
- **Integration (`packages/integration/src/`):** the Q10 wire-boundary test extended to cover `context-usage` and `context-handoff` round-tripping through `EmbeddedAgentStreamEventSchema`, and `EmbeddedAgentDefinition`'s `contextWindowTokens`/`handoff` fields round-tripping through the REST CRUD + registry-broadcast path.
- **Browser QA (mandatory, gated true-path per `workflow.md` §5):** the bar's three color bands and hover tooltip; a soft-threshold banner appearing on crossing and not reappearing until dismissed-then-re-crossed; a full manual handoff (banner CTA -> `Handing off…` -> transcript divider with expandable distillation -> bar visibly drops).

## Transcript Restore

**Status:** design-first, Stage a (this section is the entire deliverable of Stage a) -- specification only, Issue [#1123](https://github.com/ms2sato/agent-console/issues/1123). No production code changes accompany this section. Stage b (implementation, a separate PR) follows once the embedded-agent architect reviews this section clean. This is the post-v1 fast-follow named in [Post-v1 fast-follows](#post-v1-fast-follows) item 1 and the [Design Decisions](#design-decisions) point 2 deferral.

**Policy status -- un-defer, not re-litigation.** [Design Decisions](#design-decisions) point 2 deferred "restart-resume" to a post-v1 fast-follow on the reasoning that v1's reset-on-restart was *parity* with the terminal worker's PTY-loss behavior, not a regression. Owner directive (2026-07-15) reverses that deferral as a **formal policy change**: full conversation restore across worker/server restart becomes the default target for the embedded agent worker, closing the UX gap against the terminal worker's `-c` continuation ([Design Decisions](#design-decisions) "Worker-type behavior inconsistency"). This section is the first specification of that reversal. It does not re-open or re-argue point 2's original reasoning -- that reasoning remains accurate design history for why v1 shipped without restore; the un-defer is authorized new scope layered on top of it, not a correction of it.

### Definition

**Restore** = reconstitution of the LLM-facing `conversation` array (the message list sent to the provider) from the worker's persisted NDJSON output log, performed at activation, in place of v1's unconditional fresh-epoch-and-truncate reset ([Server-side management](#server-side-management-embeddedagentworkerservice) step 4). Restore reconstructs only that array -- the loop's other in-memory state (turn counters, the per-turn `AbortController`, etc.) always starts fresh, whether or not restore succeeds.

### Tier scope: Tier B adopted, Tier C mid-turn repair in the same scope

Using the tiers Issue #1123 introduced:

| Tier | Scope | This spec |
|---|---|---|
| A | Full restore; no context-window judgement; provider rejects with 400 on overflow | Baseline every restore performs |
| B | Tier A + context-usage threshold detection, steering the user toward [Context Handoff](#context-handoff) before overflow | **Adopted** |
| C | Tier B + mid-turn / mid-tool-call synthetic repair | **Adopted, same scope as Tier B, not a separately-gated follow-up** |

Tier C is in scope alongside Tier B because it is not a new mechanism -- it is a second call site for the [Mid-turn Repair](#mid-turn-repair) logic already shipped for the runtime-abort case ([The loop's turn cycle](#the-loops-turn-cycle) "Mid-turn abort repair (mandatory)"). Shipping Tier B without Tier C would leave every restart that happens to land mid-tool-call permanently unrecoverable: the malformed tail (an assistant `tool_calls` entry with no matching tool-role response) does not heal itself, so every subsequent activation replays the same malformed tail and the provider rejects it every time -- a correctness gap, not an incremental nice-to-have, so it is not deferred.

### Runtime abort-repair vs. restore-time repair: parts cross-reference

Required by AC 2: the historically most common bug source in this codebase is a "machinery partially ported" defect -- one call site's mechanism copied without every part of its contract. This table is the audit surface for stage b: every row must have an entry in both columns, or the gap is a bug, not a design choice.

| # | Part | Runtime abort-repair (existing, [The loop's turn cycle](#the-loops-turn-cycle)) | Restore-time repair (new, this section) |
|---|---|---|---|
| 1 | Trigger | `cancel` command, or the re-ask cap exceeded, during an in-flight `runTurn` | Activation-time replay of the persisted NDJSON stream, before the loop accepts its first command |
| 2 | Detection scope | The CURRENT turn's tool calls in the live, in-memory `this.conversation` | Every `tool-call` event in the restore window ([Context-handoff boundary](#context-handoff-boundary)) with no matching `tool-result` event in the log |
| 3 | Detection surface | In-process array indices / object references | Log-derived event pairing (parse `tool-call`/`tool-result` pairs by `callId`) -- a different data source, same predicate ("was this `tool_call_id` ever answered?") |
| 4 | Synthetic message content | Two exact reasons depending on the abort cause, both via `fillPendingToolResponses`'s `` `Error: ${reason}` `` (`packages/embedded-agent/src/agent-loop.ts:267-281`): `Error: tool call canceled` (`cancel` / abort mid-execution, `agent-loop.ts:217,232`) or `Error: tool call not completed: turn ended after repeated malformed arguments` (re-ask cap exceeded, `agent-loop.ts:194-198`) | `Error: tool call not completed: worker restarted before this response was recorded` -- same `` `Error: ${reason}` `` shape; the UI's separate, human-facing transparency note ("Repair transparency" below) is distinct copy, not this string |
| 5 | Insertion target | `this.conversation` (live, in-process, about to be handed to the next provider call) | The reconstructed array built by the restore routine, before it is handed to the loop via the `init` command's `restoredConversation` field |
| 6 | Timing | Synchronously, inside `runTurn`'s abort branch, before `turn-error` is emitted | Synchronously, inside the restore routine, before activation reports success and before the loop accepts its first `user-message` |
| 7 | Wire persistence of the repair itself | NOT emitted as a wire event -- a pure in-memory fix, invisible in the persisted log | Also not a new wire event -- the repair is re-derived from the raw log on every restore attempt (idempotent by construction: replaying the same log always reconstructs the same repaired array), so nothing needs to be durably marked |
| 8 | Downstream state transition | `turn-error` -> `emitIdle()` (`turnActive` clears; the live turn is reported as failed) | No `turn-error` -- there is no live turn to fail. The repaired array is simply the conversation the loop starts with; the client's signal is this section's "Repair transparency" UI note, not an error event |

Row 7 is the property to watch under audit: because restore reconstructs from the raw log every time (never a cached/pre-computed repair), a corrupted or hand-edited log always re-derives the same result from its current bytes -- there is no separate "repair record" that could drift from the log it was derived from.

### Restore trigger & activation flow

Extends [Server-side management](#server-side-management-embeddedagentworkerservice) step 4 ("Reset the output stream"). Step 4 becomes conditional:

4. **Attempt restore before resetting**, unless this is the worker's first-ever activation (empty persisted output file -- nothing to restore, proceed with today's v1 reset unconditionally):
   - **4a.** Read the persisted NDJSON stream (the same file [Persistence and DB changes](#persistence-and-db-changes-workers-table) already maintains).
   - **4b.** Locate the restore window: the tail of the stream strictly after the most recent `context-handoff` event, or the whole stream if none exists -- see [Context-handoff boundary](#context-handoff-boundary).
   - **4c.** Replay that window into a `ChatMessage[]` array, classifying every member of the `EmbeddedAgentStreamEvent` union per the table below (a total classification -- no event kind is left for stage b to guess about).
   - **4d.** Apply [Mid-turn Repair](#mid-turn-repair) (Tier C) to the reconstructed array.
   - **4e.** On success: skip `resetWorkerOutput` entirely -- do not truncate, do not mint a fresh epoch (this mirrors `activateAgentWorkerPty`'s `revived: true` epoch-preserving branch, which v1 explicitly avoided per the restart-resume deferral and which this fast-follow now adopts for embedded-agent workers too). Pass the reconstructed array as a new `init` field, `restoredConversation` (below), so the loop seeds `this.conversation` before accepting any command.
   - **4f.** On failure at any step (unparseable stream, a reconstruction invariant violated, an I/O error): fall back to today's v1 activation behavior exactly -- see [Failure invariant](#failure-invariant-restore).

**4c's event classification (total over `EmbeddedAgentStreamEvent`):**

| Bucket | Event kinds | Handling |
|---|---|---|
| Mapped (built into the array) | `user-message`, `assistant-message`, `tool-call`, `tool-result` | `user-message` -> `{role:'user'}`; a terminal `assistant-message` -> `{role:'assistant', tool_calls?}`; a `tool-call`/`tool-result` pair -> the owning assistant message's `tool_calls` entry plus a matching `{role:'tool'}` message |
| Noise (replay-only, contributes nothing) | `assistant-delta`, `assistant-thinking-delta`, `state`, `context-usage`, `ready`, `exited`, `turn-error`, `fatal` | Skipped. Reasoning/thinking content is never part of the conversation array even live ([The loop's turn cycle](#the-loops-turn-cycle)), so restore does not reconstruct it either. A `turn-error` (or `fatal`) immediately following an unresponded `tool-call` is the expected wire trace of a live-aborted turn -- the runtime repair that ran at the time was in-memory-only and never reached the wire (row 7 of the [parts cross-reference](#runtime-abort-repair-vs-restore-time-repair-parts-cross-reference) table). Restore-time repair (4d) heals this the same way the live abort would have; 4c does not need to special-case `turn-error`/`fatal` presence |
| Boundary (handled by 4b, not 4c) | `context-handoff` | Never replayed into the array by 4c -- consumed by 4b to locate the restore window's start, per [Context-handoff boundary](#context-handoff-boundary) |

**Reconstruction fidelity is wire-faithful, not live-array-faithful (accepted degradation).** Two known divergences between what restore reconstructs and what the original live `this.conversation` actually held -- both intentional trade-offs for stage b to test against, not bugs to fix:

1. **`tool_calls` arguments may be capped.** The reconstructed assistant message's `tool_calls[].function.arguments` come from the wire `tool-call` event's `args` field, which is `capToolCallArgsForWire`'d (`packages/embedded-agent/src/agent-loop.ts:104-107`): when the raw `argsJson` exceeds `WIRE_EVENT_MAX_BYTES`, the wire carries a truncated JSON *string* instead of the parsed object, while the live conversation's own `tool_calls[].function.arguments` always held the full, uncapped `argsJson` (`buildAssistantMessage`, `agent-loop.ts:283-293`). A restored conversation can therefore differ from the original for any tool call whose arguments exceeded the cap. This asymmetry does NOT apply to `tool-result`: the wire `tool-result.result` and the live conversation's `{role:'tool'}` content use the identical `truncateToBytes(..., TOOL_RESULT_MAX_BYTES)` value (`agent-loop.ts:237-250`), so tool-result reconstruction is exact.
2. **Malformed-argument re-ask exchanges are invisible to restore.** When `parseToolArgs` rejects a tool call's arguments, the loop pushes a synthetic `{role:'tool'}` correction message directly into `this.conversation` (`agent-loop.ts:206-213`) WITHOUT ever emitting a `tool-call` or `tool-result` wire event for that call. Restore therefore cannot and does not reproduce this exchange -- the malformed call simply does not appear in the reconstructed `tool_calls` at all, which is safe (no dangling `tool_call_id` results either) but is not a byte-faithful replay of what the live turn actually contained.

Stage b's fidelity tests are scoped to these two accepted divergences: assert restore reproduces the wire-faithful shape (per the Mapped row above), not the live-array-faithful shape -- the excess argument bytes and the malformed-args exchange were never persisted, so restore structurally cannot recover them.

New optional `init` field, extending [Stdio protocol](#stdio-protocol-v1) (no other command or event shape changes):

```ts
| { v: 1; type: 'init';
    ...
    restoredConversation?: ChatMessage[]; }  // Transcript Restore (#1123); absent = fresh conversation (today's v1 behavior)
```

No new persisted/wire EVENT type is introduced -- consistent with the Issue's own expectation of no new events: restore is pure reconstitution from the existing `EmbeddedAgentStreamEvent` union already on disk, plus one new optional command field to hand the result to the loop.

### Context-handoff boundary

[Context Handoff (Phase A)](#context-handoff-phase-a)'s `context-handoff` marker event is deliberately persisted into the same stream a restore replays -- already called out in [Post-v1 fast-follows](#post-v1-fast-follows) item 1. Restore treats the most recent `context-handoff` event as a hard cut: reconstruction starts from that event, using its `distillation` field to rebuild the exact seed pair a live handoff would have produced -- `[{role:'system', content: <reassembled post-handoff system prompt>}, {role:'user', content: 'This conversation continues from a previous one. Prior context summary: <distillation>'}]` (the identical seed shape [Context Handoff (Phase A)](#context-handoff-phase-a)'s `AgentLoop.handoff()` steps 10-11 construct live) -- plus every event after it. Events before the boundary are never replayed into the conversation array: a handoff is a deliberate, intentional discard of prior context (per the owner directives in [Context Handoff (Phase A)](#context-handoff-phase-a): "the old context is not needed once distilled"), and restore must not silently resurrect what a handoff already discarded. This is the "restore does not cross the handoff boundary" requirement from AC 3.

When no `context-handoff` event exists anywhere in the stream, the boundary is the start of the stream: reconstruction reassembles the original activation-time system prompt the same way ([Context Handoff (Phase A)](#context-handoff-phase-a) step 8's `reassembleSystemPrompt`), since AGENTS.md/CLAUDE.md content may have changed since the worker's original activation.

### Failure invariant (restore)

**Correction (architect review, PR #1191 R1).** An earlier draft of this subsection claimed the v1 reset fallback already preserves pre-reset bytes via the Archive Segment machinery. That premise is false against the actual code: `WorkerOutputFileManager.resetWorkerOutput` (`packages/server/src/lib/worker-output-file.ts:1068-1138`) calls `deleteContentFiles` (`:1175-1211`), which deletes the live file, the legacy compressed file, AND every archived segment, then writes a fresh empty manifest plus an empty live file. The Archive Segment mechanism ("Replaces destructive truncation", glossary) is a separate code path that fires on live-file size-overflow rotation -- it does not run before an activation reset. `resetWorkerOutput` is unconditionally destructive; nothing precedes it that archives the bytes it is about to delete. Restore-failure fallback therefore needed a new preservation step, added below -- without it, a transient I/O error during restore (not a genuinely unrecoverable conversation) would permanently discard a conversation that was otherwise fully recoverable, directly against the owner directive that full restore is the default.

Restore failure must never destroy the persisted log without a recovery path, and must always degrade to a behavior already proven safe: today's v1 reset-and-empty-conversation activation, with one addition (the sidecar below).

- Every restore step (read, parse, replay, repair) is wrapped so a thrown error at any point aborts the restore attempt without partial mutation of the output file or the worker record -- restore only *reads* the log; nothing about the read path writes to it.
- **Restore-failure sidecar (new).** Immediately before invoking `resetWorkerOutput`, best-effort-rename the CURRENT live output file (not the manifest, not any already-archived segment) to a **fixed** name, `<workerId>.restore-failed.log`, in the same worker directory, overwriting any prior file of that name -- this is genuinely single-slot (a name keyed on the old epoch would accumulate one file per failed generation instead of retaining only the most recent; the epoch of the preserved bytes is recoverable from the log content itself, so the filename does not need to carry it). The rename runs INSIDE `WorkerOutputFileManager`'s per-key exclusive domain (implementation shape: an option on `resetWorkerOutput`, or a sibling manager method it calls under the same `runExclusive` lock) -- never as a bare caller-side `fs.rename`. `resetWorkerOutput` already drops any pending flush for the same key inside that lock (`:1073-1077`); a rename outside the lock would race a pending flush recreating the live file between the rename and the reset, silently losing exactly the bytes the sidecar exists to keep. (Corollary: any buffer content not yet flushed to the live file at the moment of rename is, by the nature of a best-effort preservation step, not in the sidecar either -- an accepted limitation, not a defect.)
  - **Not manifest-referenced, never client-visible.** The sidecar is not listed in the manifest and is never replayed or offered over the worker WebSocket protocol -- it is inert, diagnostic-only storage.
  - **Not automatically consumed by a later restore attempt.** The next activation runs the normal restore-then-reset flow against the (now empty, post-reset) live file exactly like any other worker; recovering the sidecar's content is a manual/operational action (an operator reading the file directly), not an automated retry path. This is an explicit accepted limitation for this fast-follow, not an oversight -- automating sidecar-driven recovery is a follow-up candidate.
  - **Best-effort, never blocking.** If the rename itself fails (e.g. an I/O error on the same volume that already caused the restore failure), log it and proceed with the reset regardless. The invariant is "preserve when possible, never let preservation block or replace the reset" -- blocking the reset on a failed preservation attempt would trade a data-loss hazard for a worse one, a permanently wedged worker.
  - **Scope limitation.** The sidecar preserves the live file only. If the worker's stream had already rotated into archived segments before the failed restore attempt (an overflow rotation, unrelated to restore), those segments are still deleted by `deleteContentFiles` exactly as today -- unchanged v1 behavior for the segment-rotation case, not a new gap this fast-follow introduces. Extending the sidecar to cover rotated segments is a follow-up candidate if this proves insufficient in practice.
- The fallback path is otherwise byte-identical to v1's unconditional activation step 4 today: `resetWorkerOutput` (fresh epoch + truncate), run immediately after the sidecar rename attempt (whether or not that attempt succeeded).
- The client-visible behavior on fallback is exactly v1's existing "conversation resets on restart" notice ([UI](#ui)) -- restore failure is not a new user-facing error state, it is silent degradation to the documented v1 baseline (plus the inert, invisible-to-the-client sidecar above).

### UI

**Delivery mechanism: `restore-info` (worker WS envelope, not the stdio/persisted-NDJSON protocol).** Both UI behaviors below are driven by a new `WorkerServerMessage` variant -- `{ type: 'restore-info'; epoch: number; messageCount: number; repairedToolCallIds: string[] }` (`packages/shared/src/types/session.ts`) -- NOT a new `EmbeddedAgentEvent`/`EmbeddedAgentServerEvent`/persisted-NDJSON row (the "no new persisted/wire EVENT type" statement above is scoped to the stdio protocol / `EmbeddedAgentStreamEvent`; the worker WS outer envelope is a separate layer that already carries transient, non-persisted pushes like `activity`/`error`). `restore-info` is sent ONLY when restore succeeded (4e) -- restore failure (4f) sends nothing extra, exactly v1's existing silent-degradation behavior.

**Dual delivery (fast-path push + bootstrap-authoritative), mirroring the existing epoch-distribution pattern** (`routes.ts` `onWorkerRestarted`: the app-ws broadcast is a UX fast-path that can be missed, `closeWorkerSocketsForRestart` forcing a fresh bootstrap is authoritative -- see `terminal-history-paging.md` §3.4/§4.5):

1. **Fast-path push.** Immediately after reconstitution (4a-4d) completes -- before the subprocess is spawned -- the server broadcasts `restore-info` to every currently-attached `connectionCallbacks` entry for the worker (`EmbeddedAgentWorkerService`, mirroring `broadcastActivity`'s fan-out). Reaches zero listeners when nobody is watching yet; not a correctness requirement.
2. **Bootstrap re-delivery (authoritative).** The server retains the current incarnation's restore result (`messageCount`, `repairedToolCallIds`) in the worker's runtime state for the lifetime of that incarnation (subprocess alive). EVERY new WS connection during that incarnation -- not only the one that triggered the activation -- receives `restore-info` again as part of its bootstrap, alongside its initial `history` response. This is what makes the note durable across reconnects: a client that connects (or reconnects) after the fast-path push already fired still learns about the restore.

`epoch` is included specifically as a **cross-incarnation staleness guard**: the client feeds it through the SAME `acceptEpoch` gate `history`/`output` messages already use, so a `restore-info` from a superseded incarnation (e.g. a slow-arriving fast-path push racing a subsequent restart) is discarded exactly like a stale `output` frame would be -- no separate freshness mechanism.

- **Restoring state.** Derived client-side, not a new state enum: `restore-info` has been received for the current epoch AND the loop's `ready` event has not yet been observed in the replayed/live stream. While derived-true, the view shows a loading state: `Restoring conversation from N previous messages...`, using the received `messageCount`.
- **Sending a new user message is blocked** while restore/activation is in flight, via the same admission-gate shape [Server-side management](#server-side-management-embeddedagentworkerservice)'s `sendUserMessage` already uses for "turn in progress" -- extended to also cover "activation/restore in progress".
- **Repair transparency.** When the received `restore-info.repairedToolCallIds` is non-empty, the client renders a non-blocking, non-dismissable-until-acknowledged note -- re-rendered after any reset-then-rebuild of the local entry list, so a fresh reconnect's bootstrap redelivery reconstructs it -- `Some tool calls were interrupted by a restart and marked as errors` (per Issue #1123's UI note), as a new `EmbeddedAgentChatEntry` kind, `{ kind: 'restore-repair'; toolCallIds: string[] }`, using the same closed-by-default `<details>`/`<summary>` disclosure pattern the `context-handoff` divider already uses ([WebSocket & client protocol](#websocket--client-protocol)).

### Testing (design-time polarity signal -- AC 5)

Implementation and the test itself land in stage b; this subsection fixes the test's *shape* now so stage b does not need to re-derive it.

**Polarity test: provider 400 on an unresponded `tool_call_id`.**

- **Fixture:** a persisted NDJSON log fragment ending in a `tool-call` event with no matching `tool-result` (simulating a crash between tool-call emission and tool execution completing -- the exact Tier C scenario).
- **Fake provider:** a stub `ProviderAdapter` that enforces the real OpenAI-Chat-Completions constraint -- it rejects any request whose `messages` array contains an assistant message with `tool_calls` not immediately followed, for every one of those `tool_call_id`s, by a matching `tool`-role message. This reproduces real provider behavior in a unit test without a live API.
- **Direction 1 (repair NOT applied -- must fail):** replay the fixture WITHOUT step 4d ([Mid-turn Repair](#mid-turn-repair)) applied, then drive one turn against the fake provider. Assert the fake provider rejects and the turn surfaces as `turn-error`. This is the reproduction of the bug this design fixes.
- **Direction 2 (repair applied -- must pass):** the same fixture, WITH step 4d applied. Assert the fake provider accepts the request (the synthetic tool-role message closes every `tool_call_id`) and the turn proceeds normally.
- The audited property: *a restored conversation with a dangling `tool_call_id` never reaches the provider unrepaired.* Per `workflow.md`'s TDD polarity discipline, stage b's implementation PR must include this test, verified in both directions (stash-the-fix-and-confirm-fail, restore-and-confirm-pass) -- see [Testing plan](#testing-plan) for the sibling precedent (`handoff()`'s failure-invariant polarity test, [Context Handoff (Phase A)](#context-handoff-phase-a) "Testing").

## Error handling & edge cases

| Case | Behavior |
|---|---|
| Loop crashes (unexpected exit) | Server appends `exited { code }`, sets `subprocess = null` / `activated: false`, activity `idle`, revokes token. UI offers Restart. |
| Malformed NDJSON line from loop | Log + skip the line; after 5 consecutive parse failures, kill the subprocess (protocol integrity lost) and treat as crash. |
| Oversized events | Loop truncates `tool-result.result` to 16 KiB, and `assistant-message.text` / tool-call `args` to 256 KiB, before emitting (both UTF-8-safe, same truncation helper) — this keeps every well-formed event well clear of the server's 1 MiB line-kill; server rejects (kills on) single lines > 1 MiB as protocol violation regardless. |
| `cancel` while idle | No-op (loop ignores it). |
| `user-message` while a turn is active | v1: server rejects with an error to the client ("turn in progress"); queueing is post-v1. |
| Provider unreachable at first turn | Normal `turn-error` path; the worker stays activated (the loop is healthy; the provider is not). |
| Discovered/opt-in instruction file unreadable / oversized / missing (`instructions[]` entry) | Unreadable or missing: skip + warn log (never fatal); routine absence of AGENTS.md/CLAUDE.md in a chain directory is silent (not logged). Oversized: truncate at the per-file 16 KiB cap, warn-logged, no in-prompt notice. |
| Dangling `embeddedAgentId` (definition deleted while worker exists) | Activation fails with explicit error; worker stays deactivated. Definition deletion warns when workers reference it, regardless of their current activation state (a referencing worker fails on its next activation attempt either way). |
| Dangling `embeddedAgentId` at worker creation | `createWorker` resolves the definition BEFORE initializing/persisting and rejects with 400; the worker name derives from the definition (parallel to agent workers). This complements (does not replace) the activation-time check above — a definition deleted after creation still fails activation. |
| Session without `createdBy` at token mint | Activation fails with an explicit error (mint would produce an identity that `checkCallerOwnsSession` false-rejects). Surfaced to the client, not a silent fallback to tokenless. |
| Concurrent `activate()` calls for the same worker | The second (and any further) concurrent call awaits the SAME in-flight activation as the first — no duplicate spawn, no duplicate token mint. A stale `exited` event from a superseded attempt (which cannot occur under the guard, but is defended anyway) is detected by identity check and does not mutate the current live subprocess's state. |
| Post-mint activation failure (any step after the MCP token mint throws — spawn, stdin write, output reset) | The minted token is revoked and any already-spawned subprocess is killed before the error propagates. No orphaned token or process from a failed activation. |
| Activation failure — client-visible message policy (Issue #1026) | Activation failures are marked at the throw site by a structural allowlist, not by matching message text: the small, enumerable set of developer-authored reasons (session not found, worker not an embedded-agent worker, dangling `embeddedAgentId`, session missing `createdBy`) throws `EmbeddedAgentActivationError`, and its `message` is forwarded to the client verbatim. Every other activation failure (provider key loading, spawn username resolution, process spawn, output reset, session persistence — unbounded, potentially sensitive content) is replaced with a fixed generic message before it reaches the client. The server-side log always records the full original error (`err`, including message and stack) regardless of which branch applies. |
| `sendUserMessage` stdin write failure | The stdin write is attempted BEFORE the server-authored `user-message` event is appended to the persisted stream: both operations are synchronous (no `await` between them, nothing else can interleave), and the loop's own response always arrives over the separate async stdout path, so this ordering does not affect replay stability either way. Writing first means a failed write never leaves a persisted/broadcast "phantom" row for a message the loop never actually received — the previous v1 design (append-before-write, documented as an accepted trade-off in [PR #1073](https://github.com/ms2sato/agent-console/pull/1073)) is superseded by this ordering; the phantom-row trade-off no longer applies. `sendUserMessage` returns an error to the caller when the write fails; `turnActive` is cleared so a retry is possible. This ordering also matters for correlation (Issue #1117): a phantom echo would falsely resolve the sending client's pending promise despite the error response. |
| Mid-round abort (`cancel` or the re-ask cap exceeded while tool calls from the current turn are still unresponded) | Synthetic tool-role error messages are inserted for every unresponded `tool_call_id` before `turn-error` is emitted, keeping the conversation valid for the next turn (every `tool_calls` entry has a matching tool response). See [The loop's turn cycle](#the-loops-turn-cycle). |
| WS client disconnects | Callbacks detached; subprocess keeps running (parity with PTY workers). |
| Server restart | Orphan reaping SIGTERMs the loop via the persisted pid (`killOrphanWorkers`, unchanged); next access re-activates with a fresh epoch + conversation. |
| Context Handoff: distillation provider call fails or is canceled | `turn-error` emitted via the shared `emitTurnError` helper, whose last line always calls `emitIdle()` — the same `{ type: 'state', state: 'idle' }` transition every other failed turn ends with, clearing `runtime.turnActive` server-side exactly as it does today; `conversation` is untouched (failure invariant); no `context-handoff` event; the worker is left exactly as usable as after any other failed turn — retry is a fresh `handoff` command, immediately admissible since `turnActive` is already clear. See [Context Handoff (Phase A)](#context-handoff-phase-a). |
| Context Handoff: `handoff` received while a turn (or another handoff) is active | Ignored with a stderr log on the loop side / `TURN_IN_PROGRESS` on the server side — identical to "`user-message` while a turn is active" above, same admission gate. |
| Context Handoff: `contextWindowTokens` unset on the definition | Client shows raw token counts with no ratio, no color escalation, no threshold banners; manual handoff remains available regardless (it never depended on the ratio). |

## Testing plan

Per `test-trigger.md` placements (sibling `__tests__/`), TDD polarity discipline per `workflow.md`.

- **Unit — loop package** (`packages/embedded-agent/src/**/__tests__/`): SSE/stream parsing of the OpenAI adapter against a mocked `fetch`; tool-call delta accumulation; malformed-args re-ask (max 2) and iteration cap; NDJSON line splitting with partial-chunk carry; init-first protocol enforcement (exit 2); instruction-loader prompt assembly (AGENTS.md/CLAUDE.md fallback, chain discovery incl. a `.git`-as-a-file worktree root, global layer, `instructions[]` confinement incl. symlink-escape, per-file and aggregate cap/overflow-drop order; assembly order preamble -> instruction segments -> systemPrompt). Boundary values: empty tool list, empty assistant text, zero-length delta.
- **Unit — server** (`packages/server/src/**/__tests__/`): `McpTokenRegistry` (mint/verify/revoke; unknown token → null); `checkCallerOwnsSession` mode matrix (presented-mismatch always rejects; absent-token × warn/enforce/off); capability predicates; `EmbeddedAgentWorkerService` with injected `spawnAsUserFn` (activation argv shape incl. no-token-no-key-in-argv/env assertions — negative assertions mandatory; exit/crash paths; stdin `init` first-line; user-message append-before-forward ordering). Use command-discriminating responders when a test doubles `spawnAsUserFn` for multiple call shapes (memory: wrapper-consumer responder splitting).
- **Integration** (`packages/integration/src/`): the Q10 wire test — a session containing a `EmbeddedAgentWorker` serializes over the app WS and parses through `WorkerSchema` with `embeddedAgentId`/`activated` intact; plus a worker-WS test: connect, receive history bytes, parse NDJSON, reconnect with offset and receive only the tail.
- **E2E (shipping path, mandatory before "done")**: with a local stub OpenAI-compatible HTTP fixture (scripted responses incl. one tool call), drive the real flow — create a `EmbeddedAgentDefinition` via REST, add a embedded-agent worker, send a message from the UI/WS client, observe the tool call hit the real MCP server with the bearer token and the result render. A PTY-byte-probe-style shortcut does not count (`workflow.md` mechanism-probe rule).
- **Smoke (multi-user, before claiming multi-user support)**: `scripts/smoke/check-embedded-agent-elevation.ts`, importing the production spawn helper (never replicating argv), spawning as a real second user, asserting: loop starts (bun resolvable on the target user's login PATH), `init` handshake completes, and — negative assertions — the MCP token / provider key appear in neither `/proc/<pid>/cmdline` nor `/proc/<pid>/environ`. Exit codes 0/1/2 per `os-environment-coupling.md`; documented in the multi-user setup guide.
- **Smoke (multi-user Bash env non-leakage, FF-1b, before claiming `Bash` support)**: `scripts/smoke/check-embedded-agent-bash-env.ts`, driving a real scripted turn (stub provider returns a `Bash` tool call for `env`, then a final answer) through a definition with `enabledTools: ['Bash']`, spawning as a real second user. Asserts the Bash tool's `env` output shows `USER=`/`LOGNAME=` equal to the target user (proves the tool ran as the target OS user under real elevation), and — negative assertions — no `AGENT_CONSOLE_*`-prefixed env var nor the provider API key appears in that output. Exit codes 0/1/2 per `os-environment-coupling.md`; documented in the multi-user setup guide.

## Implementation plan (phases)

Each phase is a PR (or small PR series) with its own tests and green CI; later phases depend on earlier ones. Counts below set reviewer expectations, not scope escape hatches.

| Phase | Content | Key acceptance criteria |
|---|---|---|
| **0a** | Capability-predicate refactor (pure; predicates + replace 5 guard sites) | No behavior change; existing MCP tool tests pass unmodified; new predicate unit tests |
| **0b** | #878 phase 1: `McpTokenRegistry`, `/mcp` bearer parsing + ALS, `checkCallerOwnsSession` (default `warn` in all modes; Phase 4 briefly flipped multi-user to `enforce`, reverted to `warn` in Sprint 2026-07-16 — see Issue #1107), wired into the 4 elevation-bearing tools + `send_session_message` | Mode matrix unit-tested; presented-mismatch rejects; no token → unchanged behavior under the `warn` default; existing agents unaffected |
| **1** | Shared types + valibot schemas (worker union, embedded-agent types/events, client messages), DB migration (`workers.embedded_agent_id`, `embedded_agents` table), mappers, `EmbeddedAgentManager` registry + REST CRUD | Q10 integration wire test green; migration up-tested; `check-mirror-drift` untouched |
| **2** | `packages/embedded-agent` (adapter, normalization, MCP client, protocol, incl. instruction-loader prompt assembly) + `EmbeddedAgentWorkerService` (spawn/init/tail/append/exit/orphan/pause) | Loop unit suite green; service unit suite incl. negative argv/env assertions; E2E with stub provider passes in single-user mode; `COVERAGE_PATTERNS` in `check-utils.js` extended with `packages/embedded-agent/src/**/*.ts` AND its two mirrors updated in the same PR (`test-trigger.md` table + YAML globs; `check-mirror-drift.js` green) |
| **3** | WS routes branch + client transport reuse + `EmbeddedAgentWorkerView` + unified agent-selection UI (both kinds, one entry point) + reset-on-restart indicator | Browser QA with true-path screenshots (feature-visible state, per `workflow.md` §5); reconnect history replay verified |
| **3.5** | EmbeddedAgentDefinition management UI: minimal create/edit/delete form + Agents-umbrella presentation of both registries (spec §UI Management surface). Depends on Phase 1 only; parallel with Phase 4. | Browser QA true-path: create an embedded definition via the form, see it in the unified picker, edit, delete-with-live-worker-warning |
| **4** | Multi-user: smoke script + setup-guide docs (incl. the shared-key trust statement); terminal-agent token-file delivery + agent-side header wiring verified (prerequisite for `enforce`); the multi-user default flip to `enforce` in `resolveMcpAuthMode`; `session-worker-design.md` Worker Types table row + glossary sync | Smoke green on the dogfood host asserting the effective mode is `enforce` with no `AGENT_CONSOLE_MCP_AUTH` set; unit test: `AUTH_MODE=multi-user` + unset env var resolves to `enforce`; terminal agents functional in multi-user; setup guide documents the default flip; docs updated in the same PR — **superseded, Sprint 2026-07-16:** the `enforce` default was reverted to `warn` for every `AUTH_MODE`; the `headersHelper` functional dogfood step (originally umbrella #1004 Completion checklist item 5) is re-scoped as a prerequisite for Issue #1107 (restoring `enforce` as the multi-user default) rather than an in-scope #1004 deliverable |

## Post-v1 fast-follows

1. **Transcript persistence / restart-resume** — **un-deferred (Issue #1123, owner directive 2026-07-15); specified in [Transcript Restore](#transcript-restore).** This section's spec (Stage a) is design-only; the implementation (Stage b) is a separate PR. Context Handoff (Phase A)'s `context-handoff` marker event is deliberately persisted into the same NDJSON stream restore replays, so a handoff boundary within a worker's lifetime is already representable — it did not need its own retrofit, per the [Context-handoff boundary](#context-handoff-boundary) subsection.
2. `asking` activity state (loop-side heuristics or model-declared).
3. Inbound `send_session_message` → `user-message` routing for embedded-agent workers (extend `canReceiveSessionMessages`).
4. Non-native tool-calling: text-parse fallback, constrained decoding (llama.cpp / vLLM structured output).
5. Provider key management UI/API; per-user keys.
6. Single-user `enforce` default (retiring `warn`) once tokenless callers no longer exist anywhere.
7. Anthropic (and other) provider adapters.
8. Turn queueing while active.
9. Instruction-loader remainder: other-tool globals (`~/.claude/CLAUDE.md`, `~/.config/opencode/AGENTS.md`, etc.), `@import`/include syntax, dynamic reload / re-read on file change (the loader reads once per activation), other-vendor formats (`.cursor/rules`, etc.), glob/directory/URL entries in `instructions[]` (literal file paths only today), and a session-user-scope per-user `instructions` override (definition-scope only today).
10. **Context Handoff Phase B** (separate Issue, filed after Phase A dogfood): hard-threshold auto-fire (reads `EmbeddedAgentDefinition.handoff.auto`, inert in Phase A), a shell-script override handler (stdin JSON `{conversation, metadata, provider}` -> stdout distillation text, non-zero exit or 30s timeout falls back to the built-in prompt-file path, Codex-style trust-gating on script hash changes). See [Context Handoff (Phase A)](#context-handoff-phase-a).

## Cross-references

- [Session & Worker Design](session-worker-design.md) -- Worker type union, the non-PTY worker precedent (`GitDiffWorker`), and the "Adding New Worker Types" extension steps this design follows.
- [Custom Agent Registration Design](custom-agent-design.md) -- the existing **terminal-based** custom-agent path (template + PTY spawn). The embedded agent worker is a distinct execution model, not a variant of that template mechanism.
- [WebSocket Protocol](websocket-protocol.md) -- the worker channel; embedded-agent reuses the byte-offset/epoch framing with NDJSON content (see [WebSocket & client protocol](#websocket--client-protocol)).
- [`elevation-helpers.md`](../../.claude/rules/elevation-helpers.md) -- the `spawnAsUser` contract and consumer obligations this design depends on.
- [`os-environment-coupling.md`](../../.claude/rules/os-environment-coupling.md) -- real-machine smoke-test discipline; the v1 smoke script is specified in [Testing plan](#testing-plan).
- Issue [#878](https://github.com/ms2sato/agent-console/issues/878) -- MCP caller identity; phase 1 designed in [MCP caller identity](#mcp-caller-identity-issue-878-phase-1).
- Issue [#1004](https://github.com/ms2sato/agent-console/issues/1004) -- umbrella tracking Phases 0a-4 plus the post-v1 fast-follows below.
- Issue [#1107](https://github.com/ms2sato/agent-console/issues/1107) -- restoring the multi-user `enforce` default (reverted to `warn` in Sprint 2026-07-16); tracks the `headersHelper` functional dogfood step re-scoped out of the #1004 Completion checklist.
- Issues [#1042](https://github.com/ms2sato/agent-console/issues/1042) (FF-1a), [#1043](https://github.com/ms2sato/agent-console/issues/1043) (FF-1b), [#1044](https://github.com/ms2sato/agent-console/issues/1044) (FF-1c), [#1045](https://github.com/ms2sato/agent-console/issues/1045) (FF-2) -- [Built-in tools](#built-in-tools-fast-follow) fast-follow series.
- Issue [#1122](https://github.com/ms2sato/agent-console/issues/1122) -- Context Handoff Phase A, designed in [Context Handoff (Phase A)](#context-handoff-phase-a); Phase B (auto-fire + script override) is a separate Issue to be filed after Phase A dogfood.
- Issue [#1123](https://github.com/ms2sato/agent-console/issues/1123) -- Transcript Restore across worker/server restart, designed (Stage a, spec-only) in [Transcript Restore](#transcript-restore); Stage b (implementation) is a separate PR.
- MCP server implementation: `packages/server/src/mcp/mcp-server.ts`.
- Elevation primitives: `packages/server/src/services/privilege-elevation.ts`.
- Subprocess-management precedent: `packages/server/src/services/interactive-process-manager.ts` (volatile by design; this design combines its mechanics with worker persistence).
- Output-file machinery reused as-is: `packages/server/src/lib/worker-output-file.ts`, `worker-output-manifest.ts`.
- Shared service core: `packages/server/src/app-context.ts`, `packages/server/src/services/`.
- [Agent Surface design](agent-surface.md) -- the cross-surface query layer (`AgentSurface` / `AgentDirectory`) unifying `list_agents` and `delegate_to_worktree`'s agent resolution across this design's `EmbeddedAgentManager` and the terminal-agent `AgentManager`, without merging the two registries (Issue #1160).
