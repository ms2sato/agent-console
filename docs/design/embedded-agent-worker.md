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
- **LLM provider credentials** are the genuinely new half — and the asymmetry is worth stating on its own rather than only as background, because it is the single place in the product where the server holds a vendor credential at all.

  **A terminal agent's credentials never touch the server.** The CLI runs as an OS identity and reads that identity's own home; Agent Console does not supply, inspect, or constrain them, deliberately (see [Vendor Authentication](../glossary.md#vendor-authentication-agent--llm-provider) for why a host of arbitrary agent CLIs takes no position on any one vendor's terms).

  **The embedded agent breaks that pattern by necessity**: it has no CLI of its own to carry credentials, so it needs a provider API key that the *server* holds, delivered into a process running as a *different* OS user. Note the scope — this key is for the OpenAI-compatible provider an `EmbeddedAgentDefinition` names, **not** a Claude credential; an embedded agent reaching Claude through the Agent SDK would carry no `provider.apiKey` at all, since the SDK picks up the executing user's own auth like any other CLI (Issue [#1324](https://github.com/ms2sato/agent-console/issues/1324)). Under elevation, `buildSpawnArgs` embeds `opts.env` into the inner shell command, so a naive env pass-through would expose the key in the process argv (visible via `ps`); and the existing `getCleanChildProcessEnv` discipline exists precisely because env propagation across this boundary is a known leak surface. The binding constraint: provider secrets must not appear in argv / process listings, and must not be readable by other non-privileged OS users. **Resolved in Part II** ([Credentials](#credentials-provider-keys--the-init-handshake)): secrets flow over the already-piped stdin as the first protocol message, touching neither argv nor env.

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
  contextWindowTokens?: number;  // Compaction; operator-declared model context window, denominator for the usage ratio
  compaction?: { threshold?: number }; // Compaction; auto-fire ratio for the openai-api engine, default 0.85
  createdBy: string;          // users.id of the creator (same UUID space as session.createdBy)
  createdAt: string;
  updatedAt: string;
}
```

**Ownership.** Definitions select provider endpoints, prompts, and key references, so mutation is not free-for-all: in multi-user mode, `PATCH` / `DELETE` require the authenticated request user (`authMiddleware`'s `authUser.id`) to equal `createdBy`; `GET` / list / worker-creation use are shared (definitions are server-wide resources). In single-user mode the check is trivially satisfied (sole user). `createdBy` is set server-side from the authenticated user at `POST` time, never from the request body.

Plus a valibot schema in `packages/shared/src/schemas/embedded-agent.ts` (strictObject; `baseUrl` validated with `v.pipe(v.string(), v.url())`).

**DB:** new table `embedded_agents` (columns mirroring the type incl. `created_by`; `provider_*` flattened: `provider_base_url`, `provider_model`, `provider_api_key_ref`). New migration `migrateToV<next>` in `packages/server/src/database/connection.ts` (check the current max `user_version` in `runMigrations`, `connection.ts:226-315`, and take the next number; v21 was the latest at the time of writing). `context_window_tokens` landed in migration v27 (alongside three `handoff_*` columns that migration v36 replaced with `compaction_threshold`) — see [Compaction](#compaction).

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

New Bun workspace package. Depends on `packages/shared` (event types) and `@modelcontextprotocol/sdk` (MCP client). Entry: `packages/embedded-agent/src/main.ts` on a workspace checkout; bundled deploys run its bundled form `dist/embedded-agent.js` instead (see the three-tier entry resolution under the activation sequence below).

**Spawn command:** `<EMBEDDED_AGENT_BUN_PATH> <resolved absolute entry path>`, both shell-escaped, resolved by the server relative to its own install root (compute once, e.g. from `import.meta.dir`; do not rely on cwd). `cwd` = the session's `locationPath`. Under elevation this requires the install tree readable by the target user (already the shared-group model used for repositories). The `bun` binary itself is invoked via the configurable `EMBEDDED_AGENT_BUN_PATH` (`packages/server/src/lib/server-config.ts`; default `'bun'`, resolved via PATH), **not** a hardcoded bare command name — a bare `bun` is NOT resolvable inside the elevated, non-interactive login shell (`sudo -u <user> -i sh -c '...'`), whose inner `sh` (dash on Ubuntu) does not source `.bashrc` and therefore cannot see a user-local `~/.bun/bin/bun` install (Issue #1221). Multi-user deployments set `EMBEDDED_AGENT_BUN_PATH` to an absolute path (`scripts/setup-multiuser-for-ubuntu.sh` provisions `/usr/local/bin/bun`). Since Issue #1222, the server's own systemd `ExecStart` is provisioned from that SAME `/usr/local/bin/bun` value (one shell variable feeds both substitutions in `render_systemd_unit()`), so the server process and the embedded-agent subprocess always execute the identical file — version drift *between them* is structurally impossible, not merely detected after the fact. This does not eliminate all drift: the service user's own `~/.bun/bin/bun` can still diverge from the provisioned copy after a `bun upgrade`, until the setup script is re-run — a freshness property, not a correctness gap. This remains an OS-coupled assumption -> the smoke test in [Testing](#testing-plan) is mandatory before multi-user support is claimed (`os-environment-coupling.md`).

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
      instructions?: string[];                // opt-in instruction-file list, forwarded unchanged; the loop resolves + confines + loads them — see AGENTS.md loader
      compaction: { auto: boolean; contextWindowTokens?: number; threshold?: number }; // Compaction; `auto` is the WORKER's toggle, the other two the definition's
      restoredUsage?: { promptTokens: number; estimated: boolean }; // #1419; openai-api ARM ONLY. The newest authoritative context reading in the persisted log, seeding the restore-boundary check. Absent = no reading in the log (the estimator fallback stands). `estimated` is the reading's OWN honesty, carried forward unchanged
      resume?: { sdkSessionId: string } }     // Transcript Restore R1 (#1410); claude-sdk ARM ONLY (the real type is engine-discriminated -- an openai-api init carrying one is not representable). Absent = fresh session. The id comes from the workers row and nowhere else
  | { v: 1; type: 'user-message'; id: string; text: string } // id minted by server, echoed in events
  | { v: 1; type: 'cancel' }                                 // abort the in-flight turn (AbortController)
  | { v: 1; type: 'set-auto-compaction'; enabled: boolean }  // Compaction; reflects a toggle change into a running subprocess. Not gated on turnActive — the flag is only read at the turn boundary
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
  | { v: 1; type: 'turn-error'; turnId: string; message: string }    // turn aborted (provider error, iteration cap, cancel, compaction failure)
  | { v: 1; type: 'fatal'; message: string }                         // the ENGINE is dead. Whether the loop then exits is engine-specific and NOT part of this event's meaning -- `openai-api` only ever emits it on its way to exit(1), `claude-sdk` also emits it from a live harness whose SDK query died. See "Unobserved incarnation death" (#1414) for what the server does about the second case
  | { v: 1; type: 'context-usage'; promptTokens: number; estimated: boolean } // Compaction; emitted after every turn/compaction attempt that produced a usable value
  | { v: 1; type: 'context-compacted'; source: 'auto' | 'manual'; summary?: string; preTokens?: number; postTokens?: number } // Compaction; persisted boundary marker, emitted immediately before the atomic conversation replacement. The token pair is what the transcript row renders, so an aggressive compaction reports its own severity
  | { v: 1; type: 'context-handoff'; distillation: string }          // RETIRED (Context Handoff, #1122): no longer emitted; the type and its parse/render path are retained so persisted transcripts written before #1401 still replay
  | { v: 1; type: 'sdk-session-id'; sdkSessionId: string }           // claude-sdk only; the worker's CURRENT SDK session id, last-write-wins. Arrives with the first turn, not at activation
  | { v: 1; type: 'sdk-resume-failed'; requestedSdkSessionId: string; reason: SdkResumeFailureReason }; // Transcript Restore R1 (#1410); claude-sdk only. reason = 'not-found' | 'lookup-failed' | 'refused', enumerated once in SDK_RESUME_FAILURE_REASONS (#1426). The MACHINE-readable half -- the `turn-error` beside a refusal is what the user reads. The server branches on `reason`: only 'refused' clears the stored id and replaces the incarnation
```

Two further event kinds are written into the persisted stream by the SERVER, not the loop, so that the on-disk log is the complete transcript. The **replay/persistence union includes them** — clients that parsed only `EmbeddedAgentEvent` would silently drop every user message and exit row from replayed history:

```ts
type EmbeddedAgentServerEvent =
  | { v: 1; type: 'user-message'; id: string; text: string }  // appended when forwarding to stdin
  | { v: 1; type: 'turn-interrupted'; turnId: string }        // Transcript Restore R1 (#1410); appended at activation for a turn the previous incarnation never answered. Server-authored on purpose -- never a synthesized `turn-error`
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
5. `spawnAsUserFn({ username, command: '<shellEscape(bunPath)> <shellEscape(entryPath)>', cwd: session.locationPath })` — `bunPath` defaults to `serverConfig.EMBEDDED_AGENT_BUN_PATH` (overridable via `deps.embeddedAgentBunPath`, the same DI test-seam shape as `entryPath` below; Issue #1221) — store `subprocess`/`stdin` on the internal worker, write the `init` command as the first stdin line. **`entryPath` is resolved by `resolveEmbeddedAgentEntryPath` via three tiers**, tried in order, because `@agent-console/embedded-agent` is a *private* workspace package — `bun install --production` never installs it into a bundled deploy's `dist/`, so package-manager resolution alone is not deployment-correct:

1. **Bundle sibling** (production-deploy-correct): `packages/server/build.ts` bundles the embedded-agent subprocess loop to `dist/embedded-agent.js` via `Bun.build`, the same way it bundles `dist/server.js` and `dist/index.js`. Under a bundled deploy (`bun dist/index.js`), `import.meta.dir` points into that `dist/` directory, so `embedded-agent.js` is checked as a sibling file (`existsSync`) and used directly if present — no package resolution needed.
2. **Workspace-package resolution** (dev-checkout-correct): `Bun.resolveSync('@agent-console/embedded-agent/package.json', baseDir)` (package-manager-view resolution follows the installed workspace dependency edge — `packages/embedded-agent/package.json` has no `exports` map, so this is the resolvable subpath; an arbitrary `src/*` subpath is not) gives the package's directory, into which `src/main.ts` is joined. This is what a dev workspace checkout and CI exercise (`bun install` wires the workspace edge, no bundle sibling exists).
3. **Source-tree-relative fallback**: covers the local pre-`bun install` state, where neither of the above resolve.

`baseDir` defaults to `import.meta.dir` and is overridable as a test seam.
6. Start the stdout reader: split into lines (carry partial-line remainder across chunks), parse each with the valibot event schema, then (a) append the raw line + `\n` to the worker output file via the existing content-agnostic append path (updating `outputOffset`), (b) fan out to `connectionCallbacks[].onData(line, offset, epoch)` — the same callback shape PTY workers use, and (c) side-channel `state` events into the activity flow below. Start the stderr reader (log-only).
7. Observe `subprocess.exited` (after stream completion, mirroring `interactive-process-manager.ts:151-166`): verify the exiting subprocess is still the CURRENTLY-recorded one for this worker before mutating any state (guards against a stale exit from a superseded activation attempt — see the concurrency guard in step 0.5); if current, append a server-authored `exited` event to the stream, set `subprocess = null`, revoke the MCP token, emit activity `idle`, and fire `onExit` callbacks (`'managed'` vs crash distinguished by whether a shutdown was requested).
7.5. **Post-mint failure unwind.** If any step after the token mint (step 3) throws — provider spawn failure, stdin write failure, output-reset failure — the minted token is revoked and any already-spawned subprocess is killed before the error propagates, so a failed activation never leaves an orphaned token or process behind.

**Deactivation / deletion**: send `shutdown` on stdin, grace 3 s, then SIGTERM, then the existing kill-timeout escalation pattern (`worker-manager.ts:775-850` precedent, `PTY_EXIT_TIMEOUT_MS`). Wire into `WorkerLifecycleManager.deleteWorker` (`worker-lifecycle-manager.ts:303-345`) as a third branch beside the PTY and git-diff branches; output cleanup reuses `cleanupWorkerOutput`.

**Session pause/resume**: treat like PTY agent workers — the pause path kills the subprocess; resume + next access re-activates with restart semantics (conversation resets; this is the documented v1 inconsistency).

**Obligation-scoped auto-activation on revival (Issue #1264).** The "next access" wording above is the general case (a browser opening the worker, or `send_session_message` activating it via activate-on-delivery). One class of revived embedded-agent worker cannot wait for "next access" at all: a worker whose session carries an undelivered `initialPrompt` (see [Initial prompt delivery](#initial-prompt-delivery-issue-1068) below) has no browser coming and no message that will arrive to trigger it — nobody can trigger the work it exists to do. `SessionPauseResumeService.resumeSessionInternal` — the single site both the startup auto-resume path (`SessionManager`'s private `initialize()`, driven by `SessionInitializationService.initialize()`'s returned `autoResumeSessionIds`) and the manual pause→resume REST route (`POST /api/sessions/:id/resume`) funnel through — therefore auto-activates exactly the embedded-agent workers for which `hasUndeliveredInitialPrompt(worker, session)` holds, by calling the same idempotent `EmbeddedAgentWorkerService.activate` every other activation path uses. Every other revived embedded-agent worker (prompt already delivered, or never eligible) is left exactly as before: deactivated until a browser opens it or a message arrives. Activation runs sequentially, inline in the existing per-worker `for` loop that already activates PTY workers one at a time; each embedded-agent activation attempt is wrapped in its own try/catch so one worker's activation failure is logged and never aborts the remaining revivals or the session resume itself — deliberately NOT the same failure-handling shape as the PTY branch above it, which aborts the whole resume on any single worker's activation failure (a revived-but-idle embedded-agent worker is a much lower-stakes miss than a broken resume).

This is safe precisely because of what the eligible class excludes: an undelivered initial prompt means the worker's loop has never received its first user message, so there is no conversation transcript at risk — the [Transcript Restore](#transcript-restore) mid-turn repair machinery only matters for workers this policy deliberately does not touch. A worker that *was* mid-turn when the server died stays on the lazy "next access" path, unaffected by this change; see Issue #1264 for the residual (no completion/failure signal reaches a delegating parent for that class) tracked as a separate follow-up.

**User message forwarding** (`sendUserMessage(sessionId, workerId, text)`): admission is a **synchronous check-and-set** on the internal worker — verify `subprocess !== null` and `turnActive === false`, then set `turnActive = true`, all before the first `await`. Only then: mint `id`, append the server-authored `user-message` event to the output stream (so replay ordering is stable), then write the command to stdin + flush. Because admission completes synchronously on the single JS thread, two concurrent WS clients cannot both observe an idle worker and double-admit; the loser gets the "turn in progress" rejection. `turnActive` clears on `state: idle` (turn complete or `turn-error`) and on subprocess exit.

### Initial prompt delivery (Issue #1068)

A worktree/session created with an embedded-agent worker and a non-empty `initialPrompt` must auto-deliver that prompt as the worker's first chat message, mirroring how terminal-agent workers already receive `initialPrompt` via `activateAgentWorkerPty`. Delivery happens **server-side**, inside `EmbeddedAgentWorkerService`, triggered by the loop's `ready` event — not client-side, to avoid multi-tab double-send races and to reuse the exact same `sendUserMessage` path (turn admission, transcript append, stdin write, WS broadcast) a normal user message takes, so **the client needs zero changes** to render it, live or on history replay.

**Eligibility gate (`deliverInitialPromptOnActivation`, persisted since Issue #1074).** Only the session's *initial* embedded-agent worker — the one created together with the session, with a non-empty `initialPrompt` — is eligible. A worker added later via the generic add-worker route (`routes/workers.ts` → `sessionManager.createWorker(sessionId, body, continueConversation)`, no `initialPrompt` argument) is never eligible, even if the session happens to carry an `initialPrompt` from its own creation. `WorkerLifecycleManager.createWorker`'s `embedded-agent` branch sets `deliverInitialPromptOnActivation: !!initialPrompt?.trim()` on the `InternalEmbeddedAgentWorker` at creation time. The flag is durably persisted alongside the other embedded-agent worker fields, in the nullable `workers.deliver_initial_prompt_on_activation` `INTEGER` (0/1) column (migration v26): `WorkerManager.toPersistedWorker` writes the in-memory value, and `WorkerManager.restoreWorkersFromPersistence` reads it back (instead of hard-coding `false`) when reconstituting an `InternalEmbeddedAgentWorker` after a server restart. This closes the pre-#1074 gap where a session whose initial embedded-agent worker was created but never activated before a server restart would silently lose the eligibility marker and never receive the initial-prompt delivery — reproducible under normal dogfood deploy cadence (daily restarts), not merely a narrow edge case.

**Idempotency (`sessions.initial_prompt_delivered`, migration v24, persisted).** A session-level boolean flag, NOT "transcript is empty" — embedded workers reset their transcript/epoch on every activation (restart semantics, see [Activation](#server-side-management-embeddedagentworkerservice) step 4 above), so an empty-transcript heuristic would wrongly re-fire delivery after every restart. The flag is set **only after** `sendUserMessage` reports success (stdin write + transcript append already happened), never before. The three-part eligibility check — `worker.deliverInitialPromptOnActivation`, `session.initialPrompt` (trimmed, non-empty), and `session.initialPromptDelivered` (must be falsy) — is the single exported predicate `hasUndeliveredInitialPrompt(worker, session)` (Issue #1264; I-2 Single Writer for Derived Values). `EmbeddedAgentWorkerService.maybeDeliverInitialPrompt(ctx)` — called from `handleLoopLine` on `event.type === 'ready'` — calls the predicate before calling `sendUserMessage`; on success it sets `session.initialPromptDelivered = true` and persists the session. On `sendUserMessage` failure (e.g. a stdin write race), the flag stays unset so a later activation can retry. The same predicate gates the [obligation-scoped auto-activation on revival](#server-side-management-embeddedagentworkerservice) described above — the two consumers must never diverge on what counts as "undelivered".

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
```

  `request-history` is shared with the PTY path (same semantics).
- `onClose` (`:685-697`): detach callbacks like the PTY path (the subprocess keeps running without viewers, like a PTY does).
- **`restore-info` (Transcript Restore, #1123; `sdkResumed` added by R1/#1410).** A `WorkerServerMessage` variant, `{ type: 'restore-info'; epoch: number; restoredMessageCount: number; repairedToolCallIds: string[]; completed: boolean; sdkResumed?: boolean }`, whose `sdkResumed` is set **only** by the `claude-sdk` engine (`openai-api` omits it; absence means "this engine has no such concept" and must never be read as `false` — the client tests `=== false` explicitly), added to `packages/shared/src/types/session.ts`'s `WorkerServerMessage` union (and `WORKER_SERVER_MESSAGE_TYPES`). Sent ONLY when an activation's restore succeeded (never on restore failure or first-ever activation). Dual delivery (fast-path push to currently-attached connections right after reconstitution, before spawn; bootstrap re-delivery to every new connection for the lifetime of the incarnation), PLUS a third push once the new incarnation's `ready` event is observed server-side, re-sending the same message with `completed` flipped to `true` -- see [Transcript Restore § UI](#transcript-restore) for the full mechanism and rationale (`completed`'s corrected role is described there, Issue #1205).

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

**Update (Issue #1260 PR-2, post-v1): the `send_session_message` capability was extended to embedded-agent.** `canReceiveSessionMessages` is now:

```ts
export function canReceiveSessionMessages(w: Worker): w is AgentWorker | EmbeddedAgentWorker {
  return w.type === 'agent' || w.type === 'embedded-agent';
}
```

`isPtyBackedWorker` is unchanged (embedded-agent workers still have no PTY) — the two predicates have diverged, and callers must pick the one matching what they actually need: genuine PTY delivery (`isPtyBackedWorker`, still used by `create_timer` / `create_conditional_wakeup` / `run_process`) vs. the `send_session_message` capability (`canReceiveSessionMessages`, used by `send_session_message`'s explicit-target and auto-select paths, combined as `isPtyBackedWorker(w) || canReceiveSessionMessages(w)` at the explicit-target guard so terminal workers — admitted only via `isPtyBackedWorker` — stay valid explicit targets without being folded into `canReceiveSessionMessages` itself). Delivery for the embedded branch routes through `SessionManager.sendMessage`'s and the MCP tool's own activate-on-delivery + `EmbeddedAgentWorkerService.sendUserMessage` call, not a PTY write — see [PTY-backed Worker in the glossary](../glossary.md#pty-backed-worker) for the up-to-date capability-grouping statement.

This mirrors the repo's existing disciplines: single-writer patterns (`COVERAGE_PATTERNS`, sentinel protocol #999), "enforce constraints through structure, not convention" (`design-principles.md`), and the two-PR-convergence extraction rule (`elevation-helpers.md`).

## MCP caller identity (Issue #878, phase 1)

Before Issue #1269, the `/mcp` endpoint had **no authentication at all**: the MCP Hono app was mounted outside the `/api` router's `authMiddleware` chain (`packages/server/src/index.ts:132` vs `:156`; `routes/api.ts:41`), and tool handlers trusted caller-supplied `sessionId` / `fromSessionId` / `parentSessionId` (existence checks only — `mcp-server.ts:476-490`, deferral comment `:954-956`). Every elevation-bearing tool followed the same trust chain: claimed session id → that session's `createdBy` → `resolveRequestUsername` (`resolve-spawn-username.ts:88-107`) → elevation. `AuthUser.id` and `session.createdBy` share the same `users.id` UUID space, so a verified caller identity is directly comparable to session ownership. This section designs the bearer-token / `checkCallerOwnsSession` mechanism below, which answers **authorization** ("does this caller own the claimed session?") for the tools that claim one; [Transport-level authN gate](#transport-level-authn-gate-issue-1269) later in this section designs the **authentication** answer ("is this caller anyone at all?") that Issue #1269 added on top, covering every tool.

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
- **Token delivery, terminal agents (Phase 4, landed):** elevated spawns MUST NOT route the token through `buildElevationArgs` env embedding (it lands in the inner shell argv, world-readable via `/proc/<pid>/cmdline`), and MUST NOT inject it through the PTY input stream either — `pty.write`-injected bytes are echoed by the shell, persisted into the worker output file, and broadcast to every connected viewer (including shared sessions), so a token routed that way leaks into durable, multi-reader storage. Instead the server writes the token to a **user-owned 0600 token file** via `writeUserOwnedSecretFile` (`privilege-elevation.ts`, a strict-thin-wrapper sibling of the `makeUserOwnedTemplateSink` precedent at `worktree-service.ts:597-602`, forcing 0600 regardless of ambient umask) and passes only the file *path* via env (`AGENT_CONSOLE_MCP_TOKEN_FILE`) — a path is not a secret. **Functionally verified** (2026-08-03, dogfood against a throwaway multi-user instance, both the negative arm -- tokenless call rejected -- and the positive arm -- `headersHelper` reads the file and the bearer header reaches `/mcp` with the exact matching token, confirmed against server-side request logs): the terminal agent's MCP client (Claude Code's `headersHelper` config mechanism) does read `AGENT_CONSOLE_MCP_TOKEN_FILE` and attach the resulting `Authorization: Bearer <token>` header. This dogfood step was tracked on the umbrella #1004 Completion checklist (item 5) and closed that checklist. Until an operator wires `headersHelper` for a given target user, that user's terminal-agent MCP calls remain tokenless and are rejected only once the operator has explicitly opted into `AGENT_CONSOLE_MCP_AUTH=enforce`; under the `warn` default the worker starts and its tokenless calls are merely logged.
- Revocation: on worker exit/kill/delete and on embedded-agent deactivation; token files are deleted on the same events.

### Transport-level authN gate (Issue #1269)

**Diagnosis.** `checkCallerOwnsSession` above answers **authorization**: "does this caller own the session it claims?" It requires a *claimed session* to compare against, so it only ever runs inside the 5 tools that claim one (`send_session_message`, `delegate_to_worktree`, `remove_worktree`, `create_conditional_wakeup`, `run_process`). Nothing at the `/mcp` boundary ever answered **authentication**: "is this caller anyone at all?" Authentication *appeared* to work only because `checkCallerOwnsSession`'s tokenless branch (`enforce` → reject) incidentally stood in for it, for those 5 tools only. The other 17 registered tools — including several that mutate state (`close_session`, `restart_all_agents`, `update_repository`, `kill_process`, `write_process_response`, `write_review_annotations`, `clear_review_annotations`, `create_timer`, `delete_timer`, `delete_conditional_wakeup`, `write_memo`) — had no auth mechanism of any kind reachable from any request, regardless of `AGENT_CONSOLE_MCP_AUTH`'s value. Combined with `serverConfig.HOST` defaulting to `0.0.0.0` (see below), this meant a network caller with zero credentials could read every session's data and mutate instance-wide state through those 17 tools.

**The fix: one authN layer, not 17 more authZ checks.** A single Hono middleware (`createMcpAuthMiddleware`, `packages/server/src/mcp/mcp-auth.ts`) is mounted via `mcpApp.use('/mcp', ...)` in `createMcpApp` (`packages/server/src/mcp/mcp-server.ts`), in front of the sole `mcpApp.all('/mcp', ...)` dispatch handler. Because every MCP tool is a JSON-RPC method dispatched *inside* `transport.handleRequest` rather than a separate Hono route, this single mount point structurally covers **every** request to `/mcp` — `initialize`, `notifications/initialized`, `tools/list`, and every `tools/call`, present and future — before any tool body runs. A newly-registered `mcpServer.tool(...)` call requires zero additional wiring to be covered.

**The authN/authZ split, made explicit:**

| Layer | Question | Mechanism | Scope |
|---|---|---|---|
| Authentication (new) | "Is this caller anyone at all?" | `createMcpAuthMiddleware` / `evaluateMcpAuthGate` | Every `/mcp` request, before dispatch |
| Authorization (existing, unchanged) | "Does this caller own the claimed session?" | `checkCallerOwnsSession` | The 5 tools that claim a session |

The two layers compose: under `enforce`, a tokenless request never reaches a tool body at all (rejected by the authN gate at the transport layer, HTTP 401), so `checkCallerOwnsSession`'s own tokenless-`enforce` branch becomes unreachable via the real HTTP path for those 5 tools specifically — it remains directly unit-tested and is still exercised by `warn`/`off` modes, where the authN gate *does* let a tokenless caller's request continue into the tool body. This is expected, not a regression: `checkCallerOwnsSession` is a general-purpose authorization helper, and its own contract (rules 1–2 in the section above) is untouched.

**Mode semantics are identical to `checkCallerOwnsSession`'s tokenless branch by design** (`off` proceeds silently, `warn` logs once and proceeds, `enforce` rejects with a distinct message naming the mode) — the two are intentionally *not* consolidated into one shared function: `checkCallerOwnsSession` is explicitly retained unchanged, and the two log different payload shapes (the transport gate has no `toolName` / `claimedSessionId` to report, since it runs before the request body is known to name a specific tool).

**No localhost/loopback exception.** `evaluateMcpAuthGate` takes only the already-resolved caller identity and the mode — no request object, header, or source-address input of any kind. There is no signal available for a "but it's only localhost" bypass to key off of without changing the function's signature (and therefore this decision) explicitly. A source-address-based bypass would in any case be defeated by containers, port forwards, and any SSRF-capable caller reachable from the server's own network namespace.

**Why `HOST=0.0.0.0`'s default makes this mandatory, not optional hardening.** `serverConfig.HOST` (`packages/server/src/lib/server-config.ts`) defaults to `0.0.0.0`, and `Bun.serve({ hostname: serverConfig.HOST, ... })` (`packages/server/src/index.ts`) binds it — any host that can reach the server's port can reach `/mcp` directly. This default is **not** part of this fix's remedy: LAN-reachable multi-user deployment is a documented, legitimate topology (see [Multi-user setup guide](../multi-user-setup-guide.md)), not an edge case to be closed off. Precisely *because* the server is reachable beyond localhost by default, an unauthenticated `/mcp` endpoint is a genuine network-facing hole rather than a local-only concern — which is what makes the authN gate mandatory rather than defense-in-depth.

**Ordering: Issue #1269 before Issue #1107.** This fix (#1269) must land and be verified before #1107 (restoring `enforce` as the multi-user default) is attempted. Before #1269, `enforce` was near-vacuous — it gated only 5 of 22 tools — so promoting it to the default first would have manufactured false assurance that the deployment was actually protected. **Merging #1269 alone does not close the exposure while `AGENT_CONSOLE_MCP_AUTH` stays at its `warn` default**: closing it requires both this gate (structural coverage of all 22 tools) *and* an operator opting into `enforce` (or #1107 eventually promoting it to the default). Operators who need the exposure closed today must set `AGENT_CONSOLE_MCP_AUTH=enforce` explicitly in multi-user mode.

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
- A persistent, non-dismissable note in the view: conversation resets when the worker or server restarts (the v1 worker-type inconsistency called out in [Design Decisions](#design-decisions)). **Since Transcript Restore (#1123)** this note's exact wording/condition depends on the worker's [Engine](../glossary.md#engine-embedded-agent--openai-api--sdk): `openai-api` workers keep the "restored automatically" wording (accurate — their conversation IS reconstructed); a `claude-sdk`-engine worker normally gets **no** notice, because R1 ([#1410](https://github.com/ms2sato/agent-console/issues/1410)) resumes the SDK session and the conversation genuinely does continue; the distinct notice Phase 3 ([#1335](https://github.com/ms2sato/agent-console/issues/1335)) shipped survives as the FALLBACK, shown only when a resume was attempted and did not take (`restore-info.sdkResumed === false`) — see [embedded-agent-sdk-engine.md §4.3](embedded-agent-sdk-engine.md#43-ui-the-restore-divergence-notice-sdk-engine-phase-3-polarity-inverted-by-r1) for the inverted polarity table and why porting the old unconditional rule forward would show a permanent false warning.
- `exited` events render as an inline system row with a Restart action (re-activation = fresh conversation).
- Dispatch: extend `SessionPage.tsx` (`:42`, `:459`, `:504-505`, error-fallback `:49-56`).
- Worker creation: adding a worker presents a **single unified "agent" entry point** covering both kinds: the picker lists terminal-agent definitions (`AgentDefinition`, existing agents registry) and embedded-agent definitions (`EmbeddedAgentDefinition`, `GET /api/embedded-agents`) in one list, each item carrying a kind badge (Terminal / Embedded). Selecting an item creates the matching worker type (`agent` + `agentId` vs `embedded-agent` + `embeddedAgentId`) — the user never chooses a "worker type" as a separate prior step; the kind is a property of the chosen agent. When the embedded registry is empty, the picker still lists terminal agents and shows an empty-state note linking to the Agents umbrella's management UI (Phase 3.5). Embedded-agent workers are NOT auto-created with sessions (unlike the git-diff worker, `session-manager.ts:620-623`). Terminal-agent items in the picker are shown but **disabled** with an explanatory tooltip: `CreateWorkerRequestSchema` (`packages/shared/src/schemas/worker.ts`) does not accept `type: 'agent'` creation params over the client-facing `POST /api/sessions/:sessionId/workers` route -- a terminal `AgentWorker` has only ever been creatable at session-creation time, never added to an already-running session. Listing terminal items disabled (rather than omitting them) keeps the unified list matching this section's design while accurately reflecting the current REST surface; widening the schema to support it is out of this PR's scope.
- Management surface: the agents management UI presents both registries under one "Agents" umbrella (sections or badges distinguishing the kinds); CRUD stays per-registry — REST endpoints and the data model are unchanged. This unification is **presentation-only**, per the separate-registry decision in [Embedded agent registry](#embedded-agent-registry-embeddedagentdefinition).
- **Since SDK Engine Phase 1** the terminal-agent picker also includes "Claude Code" (a TUI worker) and the embedded-agent picker includes "Claude" (an embedded `claude-sdk`-engine worker, built-in) — this is the owner's actual user-facing choice underlying [Engine (embedded-agent)](../glossary.md#engine-embedded-agent--openai-api--sdk): running Claude as a familiar terminal program, or as a structured chat worker in this UI. The two entries are distinguished purely by the existing kind badge + naming, never by the word "engine" (§3.1 of [embedded-agent-sdk-engine.md](embedded-agent-sdk-engine.md) — the engine is not user-facing configuration). Two consequences of picking the embedded "Claude" are worth knowing before picking it: it costs roughly what a Claude Code TUI worker already costs, not the much lighter custom-loop baseline other embedded agents use (owner-accepted trade, [embedded-agent-sdk-engine.md §1.1](embedded-agent-sdk-engine.md#11-memory-an-accepted-cost-not-a-benefit)); and a worker/server restart does not resume its live conversation the way a fresh restore reconstructs an `openai-api` embedded worker's — the UI states this at the moment it matters ([§4.3](embedded-agent-sdk-engine.md#43-ui-the-restore-divergence-notice-sdk-engine-phase-3)).
- The context-window usage bar, the auto-compaction toggle, and the compaction boundary marker are specified separately in [Compaction](#compaction) — they attach to `EmbeddedAgentWorkerView` but are enough surface area to warrant their own section.

### AI-generated HTML/SVG preview: sanitizer as depth, not the boundary

The `PreviewPanel` (Phase 3, `packages/client/src/components/workers/PreviewPanel.tsx` + `packages/client/src/lib/preview-sandbox.ts`) renders AI-generated `html`/`svg` code blocks through three layers, and the layers do not carry equal weight. The engine-independent guarantee — the property that holds regardless of which browser renders the frame — is carried entirely by the two **declarative, structural** layers: the `<iframe sandbox="">` with no tokens (no `allow-scripts`, so script execution is refused outright by the browser regardless of document content) and the wrapper document's `<meta http-equiv="Content-Security-Policy">` (`default-src 'none'`, blocking script execution and all network fetches independently of the sandbox attribute). Both are enforced by whatever engine renders the frame, Safari and Firefox included, because they are spec-mandated browser behaviors, not sanitizer output. The `DOMParser`-based sanitizer (`sanitizePreviewFragment`) is the third layer, and it is **defense-in-depth, not the boundary**: markup that survives it on a differently-parsing engine — an mXSS-class divergence, where a HTML5 parser's foreign-content/RAWTEXT/adoption-agency edge cases let sanitized-looking output mutate into live markup on a second parse — still lands inside a script-blocked, opaque-origin, network-blocked iframe. Cross-engine sanitizer variance therefore erodes depth; it does not by itself open a direct hole. This distinction is the design precondition for the sanitizer's evolution (Issue #1106): empirically-verified sanitizer gaps against real Chromium (see the regression corpus in `preview-sandbox.test.ts` and Issue #1162 for a concrete documented case) are tracked and hardened over time, but a gap is not a merge-blocking security incident as long as the sandbox + CSP layers remain intact — those two are what must never regress.

## Compaction

**Status:** implementation-grade spec. **Supersedes Context Handoff (Phase A)** (Issue [#1122](https://github.com/ms2sato/agent-console/issues/1122)), retired by owner decision 2026-08-28 and replaced by compaction in one atomic swap (Issue [#1401](https://github.com/ms2sato/agent-console/issues/1401)). Like the section it replaces, it extends the Stdio protocol, `EmbeddedAgentDefinition`, the worker row, and the client store/view specified above rather than superseding them.

**Correction trail — why handoff was retired.** Handoff's distinctive part was *ending the session and standing up a successor*: a new conversation seeded with a distillation of the old one. That part only ever existed on the `claude-sdk` engine (`sdk-engine.ts`'s `'distillation'` turn mode plus its reseed). On `openai-api`, `handoff()` was already an in-place compaction — distill, then `this.conversation.splice(0, len, ...seed)` — so the engine never terminated anything. The owner's 2026-08-28 decision resolves that asymmetry in favor of the in-place shape on both engines and drops the successor-session mechanism entirely. The earlier owner directive recorded in the retired section — "Claude Code-style in-place compaction is out of scope, summarizing mid-turn on the same conversation confuses the model's own sense of context" — is **explicitly reversed by this decision**; it is recorded here rather than deleted, because a future reader finding the old directive quoted elsewhere needs to know which way it was settled and when. Note the reversal is narrower than it looks: compaction still never runs *mid-turn* (see Admission below) — what changed is that the conversation is no longer replaced by a successor.

### The shared experience

This paragraph is the normative statement of the feature. Everything below is a mechanism for producing it, and any implementation detail that contradicts it is wrong:

> The conversation stays the same conversation and simply becomes shorter, and one line marking the compaction boundary appears in the transcript. Automatic compaction is a worker-level toggle; manual compaction is a request made to the agent (a `Compact` tool).

Two contracts follow from it directly. First, **the user is never told which engine they are on** — the toggle's wording, the boundary row's wording, and the `Compact` tool's result text are all engine-neutral (the no-leak principle, `embedded-agent-sdk-engine.md` §3.1). Second, **manual compaction is a request to the agent, not a button on the chrome**: the user asks in the message box, the model calls the tool. There is no server → subprocess launch path for compaction at all (see [Deletion checklist](#deletion-checklist)); auto fires inside the engine, manual arrives as a tool call.

### Per-engine mechanism

| | auto | manual |
|---|---|---|
| **`openai-api`** | fires inside the engine when the usage/window ratio crosses a threshold at turn end → the existing distillation + splice, reused | the `Compact` tool → the same distillation + splice |
| **`claude-sdk`** | the SDK's own auto-compaction (worker toggle → the SDK's own settings; **default ON**) | the `Compact` tool → `/compact` sent as a user message after the turn ends |
| boundary visibility | `context-compacted` event (`summary` = the distillation) | the same event (from the SDK's `compact_boundary` message / the `PostCompact` hook's `compact_summary`) |

The two mechanisms are deliberately **not** unified behind an abstraction. `openai-api` owns its conversation array and can splice it; `claude-sdk` does not own the conversation at all and can only ask the SDK to compact its own. A shared "compaction strategy" layer with exactly two implementations and one consumer would be over-engineering; the engine branch inside the `Compact` tool is the whole of the sharing.

**`claude-sdk` does not get our distillation** (owner decision, 2026-08-28). If `/compact` turns out not to exist on this SDK, the correct response is an explanatory tool result — never a silent fallback into our own distillation machinery, and never a fake affordance.

### `openai-api` threshold semantics

The auto trigger is evaluated **at turn end only**, never mid-turn: splicing the conversation array while a provider request is in flight destroys the turn. Concretely, after `runTurn` has emitted its terminal `context-usage`, the loop compares that reading against the definition's window:

- `ratio = contextUsage.promptTokens / contextWindowTokens`; fires when `ratio >= threshold`.
- `threshold` defaults to `AUTO_COMPACTION_DEFAULT_THRESHOLD = 0.85` (a named constant in `agent-loop.ts`). The rationale for leaving 15% of the window unused is that **the distillation call itself is a provider request against the pre-compaction conversation** — it needs room to run. A threshold at 1.0 would mean the compaction that is supposed to relieve the pressure is the request that overflows.
- `EmbeddedAgentDefinition.compaction.threshold` overrides the default per definition.
- **`contextWindowTokens` unset ⇒ auto compaction can never fire.** There is no denominator, therefore no ratio, therefore no threshold to cross. This is a hard structural gate, not a defaulted guess at the model's window: guessing wrong in the low direction would compact conversations that had plenty of room left.
- An **empty conversation** produces no usage reading at all and therefore cannot fire (the vacuous case — the ratio is not merely small, it is absent).
- The worker-level `autoCompaction` toggle gates the whole check: OFF means the ratio is never even computed.

A compaction that fires automatically emits exactly the same `context-compacted` event a manual one does, differing only in `source: 'auto'` vs `'manual'`.

### Compaction at the restore boundary

**Status:** Issue [#1411](https://github.com/ms2sato/agent-console/issues/1411). Extends the threshold semantics above with a **second firing point** for the same predicate. It introduces no new event, no new `source` value, and no change to [Transcript Restore](#transcript-restore)'s reconstruction or replay.

Auto compaction as specified above fires **at turn end**. That is the wrong moment for one population: a worker whose *restored* conversation is already large sends its first provider call **before any turn completes**, so the turn-end trigger has not run even once and that first call overflows the window. The population is real but bounded — workers whose logs were written before compaction existed ([#1403](https://github.com/ms2sato/agent-console/pull/1403)), and sessions that ran with the toggle off.

The fix is a second evaluation of the *same* predicate at a second point: **right after `init`, before the first user turn**.

Let `S` = the check's input (defined immediately below), `W` = `compaction.contextWindowTokens`, `T` = the auto threshold, `F` = the full-distillation ceiling, and `P` = the partial-distillation input budget ratio.

**`S` is a measurement where one exists, and an estimate otherwise (#1419).** Write `E` = `estimateTokensFromChars(conversation)` (the same chars/4 estimator the turn-end path falls back to) and `R` = `init.restoredUsage`, the newest authoritative reading the server extracted from the persisted log. Then:

```text
S = max(E, R)     when the log carried a reading
S = E             otherwise
```

The maximum rather than a preference, because **both are lower bounds on the request the provider will actually price, and each misses what the other catches**: `R` measures a real request — tool schemas included — but measures the conversation as it stood when it was published, so messages appended after it are not in it; `E` covers every message present now but sums `.content` only, omitting the published tool schemas entirely. Taking the larger is the tightest bound available without attributing individual restored messages to positions in the log, which would put a message-index correspondence on the wire to recover a term `R` already contains. `S` cannot over-fire from a stale reading in the ordinary case, because readings only grow within a compaction window and the server never seeds from one taken before the last boundary (see "Seed extraction" below).

| Condition | Behaviour |
|---|---|
| `W` unset | Nothing. No denominator means auto is inert — the same ruling the threshold semantics above make — and the provider's 400 stays Tier A's accepted behaviour. `S` is still PUBLISHED as the restored worker's pre-turn reading; nothing is decided by it |
| `S < T×W` | Nothing. Growth from here is turn-end auto's job |
| `T×W ≤ S ≤ F×W` | **Compact at the restore boundary.** `compact('auto')`, unchanged, whole conversation as the distillation input — byte-identical to what the live turn-end path does at the same size. Only the trigger point is new |
| `S > F×W` | **Partial distillation.** The whole-conversation distillation call would itself overflow, so only the largest tail suffix that fits `P×W` becomes its input |

#### Seed extraction (#1419)

The server extracts `R` during the same reconstruction pass that produces the conversation (4a–4d), so the ordering rule below is not a second policy kept in step with 4b — it *is* 4b's window.

Two event kinds are readings, and the newer of them wins: a `context-usage` (published after every turn and every compaction attempt that produced a usable value), and a `context-compacted`'s `postTokens` (the size of the conversation that compaction left behind, which is itself a reading). Concretely:

1. The last `context-usage` **strictly after** the last compaction boundary, if any.
2. Otherwise that boundary's own `postTokens`, if it carries one.
3. Otherwise nothing.

**A reading from before the last boundary is never eligible.** It measures a conversation that boundary then discarded, so it overstates what remains by however much the compaction removed — which for an aggressive one is nearly everything. The legacy `context-handoff` carries no post-size, so a stream cut by one correctly yields nothing.

`estimated` travels with the number rather than being recomputed. A reading the previous incarnation had to estimate must not arrive at the next one dressed as a measurement — and a boundary's `postTokens` is always `estimateTokensFromChars(seed)`, the loop's own chars/4 number, so it reports itself as an estimate even when it is the newest reading available.

**Both paths are required.** A worker killed before completing any turn published no reading, and the field is simply absent: the estimator remains, bias and all. That is a legitimate state, not a fault, and it is the residual this Issue does not close (see below).

**Scope is the `openai-api` arm.** `claude-sdk` carries its own context state through the SDK resume and computes no ratio of its own, so the field is not representable on its arm — the same structural containment `resume` gets from the other direction.

The check runs **only when the loop was seeded from a restored conversation that carries something** -- more than a bare system-prompt head. Evaluating the ratio against a lone system message is the vacuous case the threshold semantics above already exclude.

The distinction is `> 1` rather than `> 0`, and it became load-bearing when `S` started reading a measurement. A reconstruction legitimately yields a length-1 array: the server sends `[{role:'system'}]` whenever the restore window replayed no messages, which a rotated live window produces by starting after a turn's last `assistant-message` and before the `context-usage` that followed it (restore reads only the live window -- archived segments are excluded by construction). Under `> 0` that counted as a restore, and nothing came of it because the estimate of one system message is a few tokens. **A reading does not shrink with the window it outlived**, so the same array would now clear the threshold and distil a conversation consisting only of the system prompt -- replacing it with a seed announcing a summary of earlier messages that were never in front of the model. The post-compaction seed pair (`[system, seedUser]`) is length 2 and still qualifies, which is the case that must keep working.

The worker-level `auto` toggle gates the whole check exactly as it gates the turn-end one — the predicate *is* `shouldAutoCompact()`, reached by seeding `lastTurnUsage` with `S` before consulting it -- carrying the reading's own `estimated` flag, so a measurement seed is published as one and an estimated seed is not dressed up as a measurement. The seeding is not merely plumbing to reuse a function: it is also the usage reading a restored worker publishes before its first turn, which previously stayed absent until a turn had completed.

**Ordering: after the compaction FINISHES, not after it succeeds.** The compaction is awaited inside the subprocess's `init` handling, and `ready` is emitted only afterwards — but it is emitted **unconditionally**, including when the compaction failed. A provider that is down at activation time must not be able to wedge the worker: the failure path is `compact()`'s existing preserve-on-failure (a `turn-error`, conversation untouched), after which the worker is fully usable and the first user turn simply overflows the way the `W`-unset row already does. "Do not emit `ready` before the compaction" means *before it finishes*, never *before it succeeds*.

Two consequences of the ordering are load-bearing. First, `main.ts`'s command dispatch is a `for await` over stdin, so awaiting inside `init` is by itself what prevents a `user-message` from interleaving with the compaction — no turn-active bookkeeping exists or is needed for this path. Second, the server hangs two things off `ready`: [Initial prompt delivery](#initial-prompt-delivery-issue-1068), and flipping `restore-info`'s `completed` flag ([UI](#ui)). Gating `ready` therefore makes both fire only once the worker is genuinely usable, rather than against a conversation that is about to be spliced. **The new activation property, stated as a contract.** This subsection is what first puts a provider round-trip in front of `ready`: before it, activation could not be delayed by a provider at all, at any duration. So, normatively — **an `openai-api` activation may include at most one bounded compaction operation (at most `RESTORE_BOUNDARY_COMPACTION_BUDGET_MS` of wall clock, inside which the provider may be retried up to `MAX_PROVIDER_ATTEMPTS` times — the budget is wall-clock, not per-request). On exceeding the budget the compaction is abandoned through its existing cancel path, leaving the conversation unchanged, and `ready` is emitted regardless.**

**What the budget does NOT bound, as a named premise.** It bounds the **provider round-trip**. `compact()` also awaits the compaction-prompt load before it and the system-prompt reassembly after it; neither takes a signal, and neither is interrupted. Both are local filesystem reads, **assumed prompt** — the same assumption every other activation-time filesystem read already makes, so threading a signal into only these two would be asymmetric theater. The exposure the budget was built against is a provider stream that keeps emitting without ending, which has no filesystem analogue. The declaration and the implementation are made to match by narrowing the declaration, not by widening the code.

**The commit point.** "Abandoned, leaving the conversation unchanged" is only true if there is a point after which cancellation provably cannot act, and every check sits before it. That point is the **final abort check immediately before the `context-compacted` marker is emitted**: before it, cancellation is always honoured; after it, no `await` exists until the splice completes, so there is nothing left for a cancel to interrupt. The rule that follows, and the reason the boundary is named rather than merely implemented: **a new `await` may only be added above the commit point** — between it and the end of the splice the code must stay synchronous. Adding one below silently reopens the window. (The earlier check, which classifies a canceled provider outcome, is early-exit economy and not the boundary; it was the only check that existed, which is how a cancel landing during reassembly used to commit a compaction anyway.) Anyone adding further work to activation should read that as the standing limit rather than re-deriving it.

The bound is not decorative. `runLoop`'s serial `for await` is what keeps a `user-message` from interleaving, and it holds `cancel` and `shutdown` behind the same await — so an unbounded compaction would not merely delay `ready`, it would make the worker unstoppable while it waited. Without a bound the exposure is roughly thirty minutes: the adapter's 600 s per-attempt total timeout, retried three times, reachable by a stream that keeps emitting without ever ending. The same thirty minutes has always been possible at a *turn* boundary, where it leaves a usable worker; at activation it leaves one that never reports `ready`, so the server never delivers the initial prompt and never flips `restore-info.completed`, and the client sits in its loading state. That asymmetry is why the bound belongs here and not there.

**`restore-info.restoredMessageCount` is the PRE-compaction count, and stays so.** The server computes it from the reconstruction (4a-4d) and pushes it before the subprocess is even spawned, so it necessarily predates any boundary compaction. That is the honest number for what it names — how much conversation was recovered from the log — and the `context-compacted` marker that follows says what then happened to it. Recomputing it after the fact would report a smaller restore than actually occurred.

**Correction (Issue [#1428](https://github.com/ms2sato/agent-console/issues/1428)): it was not the honest number until that fix, and the field was renamed to say so.** It had been the reconstruction's whole array length, seed included, so it over-reported by one — or two past a compaction boundary — on every restore, and could never reach zero. The claim above about *which* conversation the number describes was always right; the claim that it counted only that conversation was not. The paragraph is kept because the pre-compaction property it states is still the design, and the rename is what stops a reader carrying the old meaning across.

#### The two ratios, and why they are two

An earlier draft of this section carried a single constant `D = 0.7` serving as both the full/partial cut and the partial input budget. That is **internally inconsistent with the live path** and is corrected here (Architect ruling, 2026-08-29, before implementation). The live turn-end compaction sends the **entire** conversation as its distillation input and does so successfully at `E ≈ 0.85W` and above — that is the mechanism running in production today. A single `D = 0.7` would therefore make the same machine treat the same conversation differently depending only on *where* it was triggered: a conversation at `0.87W` gets a whole-conversation distillation from the live path and a truncated one from the restore boundary. The cut and the budget are two different quantities and get two constants:

- **`FULL_DISTILL_MAX_RATIO = 0.9`** (`F`) — the ceiling below which the whole conversation may still be the distillation input. Derived from the live path's demonstrated behaviour at `≥ 0.85W`, plus room for the compaction prompt and the summary the model is about to write, plus margin for the estimator's error.
- **`PARTIAL_DISTILL_INPUT_RATIO = 0.7`** (`P`) — the input budget for the suffix, and *only* that. **Named premise:** `E` is a coarse character-count estimate, not a token count, and can be wrong in either direction for any given tokenizer, so the budget measured against it stays conservative; and the compaction prompt and the summary need room of their own inside the same window. Partial distillation is the path taken *because* the estimate has already proven to be near the wall, which is exactly where a conservative budget earns its keep.

Neither is operator-configurable. Both are internal safety margins on our own estimator, not policies an operator has the information to set.

**Measured: `E` under-counts, and in one direction.** An earlier draft of this subsection said the estimate "can be wrong in either direction". A real-instance run during #1411 measured otherwise: `estimateTokensFromChars` sums only each message's `.content`, while the request the provider actually prices also carries the **tool schemas** — every builtin, every MCP tool, plus `Compact`. On a small conversation the schemas dominate: `E` read 1102 where the provider reported 6722 prompt tokens for the same (already narrowed) request. So the error is systematic and one-signed — `E` is always low by roughly a fixed per-worker constant, the size of the published tool list.

Two consequences, neither of which changes the design but both of which a reader should have:

1. **The boundary check under-fires**, by that constant. Against a realistic window (100k+) a few thousand tokens of schema is a rounding error and the rows behave as written. Against a small declared window it is the dominant term, and a conversation that would overflow can sit below `T×W` and compact nothing.

   **When that is reachable, as an inequality.** With `G` the tool-schema gap, the two halves must hold at once — the check must not fire (`E < T×W`) and the request must exceed the model's real limit `L`. Declaring `W` honestly at `L` gives `W ≤ E + G < T×W + G`, so:

   > **`W < G / (1 − T)`** — with the measured `G = 5620` and the default `T = 0.85`, about **37,500 tokens**.

   The inequality is the useful form because it tells a later reader whether this is live for them. On a 32k model it is; on a 128k model it is not. Measured on the instance this was investigated on (2026-08-29): the smallest context window across its provider's whole catalogue was 196,608, so the wedge was **not reachable there at all** — a fact about that provider, not about the defect. Pushing `G` up does not close it: the entire published builtin tool list serializes to ~1.1k tokens, and the measured 5620 is dominated by the MCP tool list.

   **The harm is not necessarily a 400.** A strict provider rejects the over-window request and the wedge below follows. A lenient one *silently truncates* instead — measured on the same instance, one model capped its reported `prompt_tokens` exactly at its window and answered anyway. That path produces no error at all: the model simply stops seeing the earliest part of the conversation, with nothing surfaced to the user and nothing for the server to observe. It is the worse of the two, and a reader who concludes "no 400, therefore no problem" has it backwards.

   **State the consequence at its real size, because "under-fires" understates it.** When that happens the first user turn overflows and ends in `error` — and `settleCompactionAtTurnBoundary` returns early on any ending other than `completed`, so the turn-end path never fires either. Every subsequent turn repeats it. The `Compact` tool is no escape: the request fails before the model can call anything. The worker is **wedged**, recoverable only by raising the declared window or resetting the transcript.

   **This is pre-existing, and narrowed rather than created here.** A restored over-window conversation has always failed its first turn and always ended that turn in `error`, with the turn-end trigger never firing — that chain predates the restore boundary entirely. What this section adds is a check that closes the common case; what it does not do is close the case where the estimate is the thing that is wrong. The distinction matters for who owns the fix: a claim this design introduces must be made true here, while a pre-existing defect it merely narrows may be a follow-up. This is the latter, and the follow-up was the `context-usage` seeding described just above, shipped as #1419.
2. **`P×W` bounds our estimate of the request, not the request.** A partial distillation's suffix is chosen so the *estimated* input fits the budget; the wire request is larger by the same constant. The conservatism `P = 0.7` buys is what absorbs it, which is the second half of that constant's premise doing exactly its job — but it is absorbing a known bias, not merely noise.

**Closed by [#1419](https://github.com/ms2sato/agent-console/issues/1419), for every worker that ever produced a reading.** Of the two ways to close it — counting the tool schemas in the estimate, or seeding the check from the real reading already sitting in the persisted log — the second was taken: it replaces an estimate with a measurement rather than improving the estimate, and it needs no per-provider tokenizer knowledge. `S`'s definition above and "Seed extraction" are that change; this subsection is retained because the bias it measures is still what the fallback path lives with.

**The residual, which #1419 does not close.** A worker that never completed a turn has no reading, so `S = E` and the under-count is exactly as described above. The estimator's bias is unchanged for that population; what has changed is that it is now the *only* population exposed to it. Closing it further needs a different mechanism — an error-path escape that forces a partial compaction when a request comes back over-window — rather than a better number up front.

With the defaults `T = 0.85` and `F = 0.9`, the full-compaction band `[0.85W, 0.9W]` is **non-empty**, so both the full row and the partial row are reachable — and testable — without overriding `compaction.threshold`.

**A remaining asymmetry, recorded as an observation, not fixed here.** The live turn-end path has no `F` ceiling of its own: it always sends the whole conversation. A live conversation that overshoots past `0.9W` within a single turn will therefore attempt a whole-conversation distillation that the restore boundary would have declined to attempt. If that call overflows, `compact()`'s preserve-on-failure already handles it — a `turn-error`, conversation intact. Teaching the live path the same ceiling is a change to a shipped, working path and is out of scope for #1411; it is noted so a later reader finds this asymmetry documented rather than surprising.

#### Partial distillation

`compact()`'s normal input is `[...conversation, compactionPrompt]`. When `E > F×W` that request is the very thing that would overflow, so the input — and **only** the input — is narrowed:

1. **Budget.** `budgetTokens = floor(P × W)`, measured with the same `estimateTokensFromChars` used for `E`, over the request array actually being assembled (system message + selected suffix + the compaction prompt message). Measuring the assembled request rather than the suffix alone is what keeps the prompt's own room from being double-counted or forgotten.
2. **Selection.** The **largest tail suffix** of the conversation that fits, subject to one structural rule: a suffix may not begin at a `{role:'tool'}` message. Starting there would hand the provider a tool result whose owning assistant `tool_calls` entry is not in the request — the same structural violation [Mid-turn Repair](#runtime-abort-repair-vs-restore-time-repair-parts-cross-reference) exists to prevent, arriving from the other direction. Candidate start points are scanned from the tail toward the head, and a candidate landing on a `tool` message is skipped rather than accepted or repaired.
3. **Head.** The conversation's system message is always included and always counted. It is the model's operating instructions for the summary it is being asked to write; dropping it to buy budget would trade the quality of the one output that survives for a few percent of room.
4. **Everything else is `compact()` unchanged** — same prompt loader, same failure invariant (every early return happens strictly before the `context-compacted` marker is emitted, so the conversation is never mutated on failure), same `emitDeltas: false`, same marker, same `source: 'auto'`.

**One field changes meaning, and it is worth knowing which.** [Token accounting](#token-accounting) says `preTokens` is the distillation call's own prompt size, *i.e. the conversation as it stood going in* — the two are the same thing for a full compaction. For a partial one they are not: `preTokens` is the **narrowed** input, so the boundary marker under-reports the true before-size in precisely the case that discarded the most. It is still the right number to send. It is the only *real* provider count available at that moment; substituting our own estimate of the full conversation would report smaller still, since that estimator measures low (see "Measured: `E` under-counts" above), and would mix a provider count with an estimate inside one field.

**The caveat travels inside the summary, not around it.** A partial distillation prepends one fixed line to the model's distillation output before anything else sees it:

> `[Earlier messages exceeded the context window and are not covered by this summary.]`

(`PARTIAL_DISTILL_CAVEAT_LINE` in `agent-loop.ts`, the caveat's single writer.)

That line is part of the `summary` string — the string carried by the `context-compacted` event, persisted to the log, rendered in the transcript, and seeded into the conversation. Putting it *there* rather than in the seed sentence around it is what makes it survive a restart: the persisted event has no field that distinguishes a partial distillation from a full one, so a later [Transcript Restore](#transcript-restore) reseeds through the ordinary `buildCompactionSeedMessages` wording — and the caveat, being in the summary text itself, is still read by the model. `buildCompactionSeedMessages` therefore stays **exactly** the single writer it already was, with no partial/full branch: the one and only writer of the caveat is the partial-distillation path.

**Named degradation (small, and deliberate).** The outer seed sentence still says *"Summary of the earlier part of this conversation, which has been compacted away"*, which overclaims coverage; the embedded line corrects it in-band, immediately after the colon. Two sentences that disagree slightly, in the right order, is the accepted cost of not adding a field to a persisted wire event and not touching `restore.ts`. Should it ever need closing properly, the shape is a discriminating field on the marker event read by `4b` — not a second writer of the seed.

**It announces itself, like every other compaction.** `source` stays `'auto'` and the `context-compacted` marker is emitted exactly as always, so a partial distillation immediately after a restore is visible in the transcript rather than silent. That visibility is the point: an aggressive discard the user did not ask for is precisely the kind of event that must not look like a bug.

**What the user keeps, and what is actually lost.** The **UI transcript is unaffected** — it replays our persisted stream, so every message the worker ever wrote is still there to read, before and after the boundary alike. What a compaction discards is the **model's** memory of the conversation, not the user's record of it. For a partial distillation the loss is larger than for a full one: the summary covers only the tail that fit the budget, so the head of the conversation reaches the model neither directly nor in summary. Stating this plainly is part of the spec, because "compaction" is otherwise easy to read as lossless.

**When nothing fits (accepted failure).** If no non-empty suffix fits `budgetTokens` — a small `W` against a large system prompt — there is no usable distillation input. The partial distillation then fails the way every other compaction failure already does: a `turn-error`, and `this.conversation` left exactly as it was. The reason string **names this cause specifically** rather than folding into the generic wording —

> `Context compaction failed: restore-boundary compaction skipped: conversation exceeds the distillation input budget`

— because the 400 that follows on the first user turn is otherwise indistinguishable from every other overflow, and this is the one line that explains it. The alternatives were both worse: splicing in a summary of nothing destroys the conversation to avoid an error, and inventing a smaller working window is the guessed denominator the threshold semantics above already rule out.

### PS3 and the handoff E2E: a verified but unshipped mechanism

`embedded-agent-sdk-engine.md` §5's **PS3** (session-boundary seeding recalls the distilled context — verified with a real recall test) and PR [#1349](https://github.com/ms2sato/agent-console/pull/1349)'s handoff E2E become **a verified but unshipped mechanism**. The record is not deleted. Its value is that a future re-offering of the feature — which the owner has named as possible — will not need to re-probe it: the mechanism is known to work, and the evidence stays available. Only its *status as the regression floor* moves, to the compaction E2E (`embedded-agent-sdk-engine.md` §7).

### Deferral with an address: our compaction, offered to Claude

The owner remarked on 2026-08-28 that our own distillation-based compaction might later be offered for `claude-sdk` too, as an alternative to the SDK's built-in compaction — the two produce different summaries and a user might prefer ours. That is deferred, not rejected.

**The design implication, stated so a future implementer does not start in the wrong place:** if `openai-api`'s compaction is ever offered to `claude-sdk`, the connection point is **the `Compact` tool's engine branch** — the one place that already knows which mechanism a given engine uses — not a new shared layer. Do not build an abstraction for it in advance. A single-consumer engine-agnostic compaction layer is over-engineering today and would have to be re-cut anyway once the second consumer's real constraints are known.

### Token accounting

**Source.** `OpenAIChatAdapter`'s request body carries `stream_options: { include_usage: true }`. Per the OpenAI streaming contract this causes one additional SSE chunk at the end of the stream carrying `usage: { prompt_tokens, completion_tokens, total_tokens }` with an **empty `choices` array** — the adapter's existing `const choice = chunk.choices?.[0]; if (choice === undefined) continue;` early-continue would silently skip this chunk, so the usage read MUST happen before that guard, independent of `choice` presence. `OpenAIStreamChunk` carries `usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null`; the adapter keeps the latest non-null value seen across the stream and includes it on the `done` event: `ProviderEvent`'s `{ type: 'done'; finishReason: string | null }` variant carries an optional `usage?: { promptTokens: number; completionTokens: number; totalTokens: number }` field (field names translated from the wire's snake_case to the adapter's existing camelCase convention).

**Fallback.** A provider that ignores `stream_options` (older/non-compliant OpenAI-compatible servers) never sends `usage`; `done.usage` is then `undefined`. `AgentLoop` falls back to a **chars/4 estimate** over the full `conversation` array's `content` (all messages, JSON length of `content` strings summed, divided by 4) for that attempt, and the resulting `context-usage` event carries `estimated: true`. A real `usage.prompt_tokens` value carries `estimated: false`. An estimated reading is a legitimate trigger for auto compaction — a coarse denominator is what the user configured, and refusing to act on it would leave the exact overflow case the feature exists for unhandled.

**Granularity — turn-scoped, last-attempt wins.** `runTurn`'s tool-iteration loop makes one provider request per iteration (growing `conversation` each time a tool result is appended); a turn that used 3 tool calls made 4 requests. `AgentLoop` tracks the most recent successful attempt's usage in a turn-scoped variable (real value if the provider returned `usage`, chars/4 estimate otherwise) and, at the turn's terminal exit point (no more tool calls, or the iteration cap), emits **one** `context-usage` event carrying that last value — never an event per iteration. A turn that fails on its very first provider attempt (no successful response at all that turn) has no captured value and emits **no** `context-usage` event; a turn that succeeds on iteration N then later iterations fail still emits one using iteration N's value, at whichever point the turn actually concludes. This is the property audited at review: *"context-usage is the last provider request's prompt_tokens, not an intermediate one."*

**Compaction's own usage.** The distillation request is itself one provider call and follows the identical last-attempt-wins/fallback logic; its `context-usage` reflects the (large, pre-compaction) prompt size and is emitted before the splice. A second `context-usage` follows immediately after, this one always `estimated: true` (chars/4 over the brand-new two-message seed conversation, since no provider call has run against it yet) — this is what makes the bar visibly drop right after a successful compaction instead of staying pinned at the pre-compaction percentage until the next real turn completes.

**Denominator.** `EmbeddedAgentDefinition.contextWindowTokens?: number` (migration v27) is the ratio's denominator; it travels to the client exclusively through the existing `embedded-agent-created` / `embedded-agent-updated` registry broadcasts (no new wire event needed — [Embedded agent registry](#embedded-agent-registry-embeddedagentdefinition) already covers this path). When unset, the client shows raw token counts with no ratio and no color escalation, and — per the threshold semantics above — auto compaction cannot fire.

### Compaction prompt loader

Module `packages/embedded-agent/src/compaction-prompt.ts` (renamed from `handoff-prompt.ts`), deliberately a narrower cousin of the [AGENTS.md loader](#agentsmd-loader), not a call into it — the semantics differ (override, not concatenation):

```ts
export interface LoadCompactionPromptParams { cwd: string; homeDir?: string; xdgConfigHome?: string }
export async function loadCompactionPrompt(params: LoadCompactionPromptParams): Promise<{ content: string; origin: string }>
```

- **Layer 1 (repo):** `<cwd>/.agent-console/compaction-prompt.md` — a single literal path, not a chain walk (unlike AGENTS.md, `cwd` already IS the session's `locationPath`, so there is no ancestor chain to consider).
- **Layer 2 (global):** `<configHome>/agent-console/compaction-prompt.md`, same XDG resolution (`xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? path.join(homeDir, '.config')`) as the instruction loader.
- **Layer 3 (bundled default):** a string constant `DEFAULT_COMPACTION_PROMPT` in the same module (not a shipped file — avoids a packaging/resolution concern for a few paragraphs of static text).
- **Precedence is override, not concatenation:** the first layer whose file exists and is readable wins outright; the other layers are not read. A compaction prompt is one coherent instruction, not layered guidance.
- **Cap:** 16 KiB via the existing `truncateToBytes` (same constant/behavior as `INSTRUCTION_PER_FILE_CAP_BYTES`), warn-logged on truncation, no in-prompt marker.
- **Read timing:** loaded fresh on every compaction (not cached at activation) — so editing the override file takes effect on the very next compaction, without a worker restart.
- **Filename migration is deliberately not performed.** An operator who wrote `.agent-console/handoff-prompt.md` under the retired feature will find it silently ignored. The loader does not fall back to the old filename: a stale override that keeps quietly working under a renamed feature is worse than one that visibly stops, because its text ("hand over to a new session") now describes something the system no longer does. This is called out in the deletion checklist so it reaches the release note.

Bundled default (Layer 3), the canonical text implementers ship verbatim unless the owner revises it. Note the framing change from the retired handoff prompt: it no longer describes seeding a *fresh* conversation, because there is no longer a fresh conversation.

```text
This conversation is approaching its context window limit. Produce a concise
but complete distillation of the conversation so far: the task, key
decisions made, the current state of any in-progress work, and the concrete
next steps. Write only the distillation text, with no preamble or
meta-commentary -- it replaces the earlier messages of THIS conversation,
which continues from it.
```

### `AgentLoop.compact()`

**Admission.** Compaction never runs mid-turn. Both triggers respect that structurally rather than by check:

- **auto** is evaluated after `runTurn`'s terminal event, inside the same `runTurn` call, so there is no other turn to collide with.
- **manual** is a `Compact` tool call, which by definition happens *inside* a turn. It therefore cannot execute immediately: it sets a **reservation flag** (`pendingCompact`) and returns; the loop drains the reservation at the turn boundary, after the turn has concluded. The tool's result text says so (`Compaction scheduled; runs when this turn completes`).

**Reservation semantics** (the boundary values a reviewer should look for):

| Case | Behavior |
|---|---|
| `Compact` called twice in one turn | Idempotent — one compaction at the boundary, not two. |
| Context is small | Runs anyway. Manual compaction has no threshold gate; the user asked. |
| The turn ended in an error | Still runs at the boundary. A failed turn is exactly when a user may want the context reclaimed. |
| The turn was canceled | The reservation is **discarded**. Cancel means "stop what you were doing", and the tool call was part of what was being done. |
| Shutdown | The reservation is discarded — the process is going away. |

**Steps.** `AgentLoopDeps` carries `reassembleSystemPrompt: () => Promise<string>` and `loadCompactionPrompt: () => Promise<string>`, both closures built once in `main.ts`'s `initializeLoop` over the same `init` fields already used to build the system prompt at activation.

1. Emit `{ type: 'state', state: 'active' }`.
2. `await this.deps.loadCompactionPrompt()`. On throw: `emitTurnError` with a synthetic `turnId`, return. **`this.conversation` has not been touched.**
3. Build a **transient** request array `[...this.conversation, { role: 'user', content: compactionPromptText }]` — passed directly into the provider call, never pushed onto `this.conversation`.
4. Run it through the same retry-with-backoff path normal turns use, with `emitDeltas: false` so the distillation never surfaces as a stray assistant bubble. On failure or cancel: `emitTurnError`, return. **`this.conversation` still untouched — this is the failure invariant.**
5. **Validate the outcome.** No tool calls are expected in this request. If the provider returns any anyway, OR returns empty/whitespace-only text (`outcome.toolCalls.length > 0 || outcome.text.trim().length === 0`), there is nothing usable: `emitTurnError` with an explicit "no usable summary" message, return. **`this.conversation` still untouched.**
6. Emit `context-usage` using the distillation call's own `outcome.usage` — the (large, pre-compaction) prompt size, emitted before anything changes.
7. `summary = outcome.text`, capped at the same 256 KiB `WIRE_EVENT_MAX_BYTES` UTF-8-safe truncation `assistant-message` uses.
8. `await this.deps.reassembleSystemPrompt()` — picks up AGENTS.md/CLAUDE.md edits made during the worker's lifetime. On throw, fall back to the ORIGINAL `deps.systemPrompt` captured at construction rather than aborting: the distillation already succeeded, so the replacement must complete as a unit even in this degraded form.
9. Emit `{ type: 'context-compacted', source, summary }` — **immediately before** the mutation, with no `await` between this line and step 11.
10. Seed text (fixed, NOT operator-overridable — distinct from the compaction prompt above): `` `Summary of the earlier part of this conversation, which has been compacted away: ${summary}` ``. **This wording changed with the swap** (it read `This conversation continues from a previous one. Prior context summary: …` under handoff): the model's own framing of what just happened must match the shared experience above, and telling it the conversation is a *new* one directly contradicts "the conversation stays the same conversation". `buildCompactionSeedMessages` (renamed from `buildHandoffSeedMessages`) stays the single writer of this shape, shared with the restore path.
11. **Atomic switch**, one synchronous statement: `this.conversation.splice(0, this.conversation.length, ...buildCompactionSeedMessages(newSystemPrompt, summary))`.
12. Emit a fresh `context-usage` (chars/4 estimate of the two-message seed, `estimated: true`) so the bar visibly drops.
13. `emitIdle()`.

**Failure invariant (the property under audit).** Every early-return path (steps 2, 4, 5) returns strictly before step 9's `context-compacted` emission — no path mutates `this.conversation` without having emitted the marker first. Every one of those paths calls `emitTurnError`, whose last line is `emitIdle()`, so `runtime.turnActive` is cleared server-side on every failure path exactly as on success. Conversely, once step 5 passes, steps 6-13 are a straight line that always completes: step 8 degrades gracefully, and step 9 is followed with no `await` by step 11. **A polarity test MUST assert both directions directly against `this.conversation`'s observable content** (not just "a turn-error was emitted"): drive a fake adapter that throws for the distillation request and assert the array is byte-identical to its pre-compaction state (verified by driving a subsequent `runTurn` and inspecting the `messages` array the fake adapter actually received); then flip the fake to succeed and assert the array matches the seed shape.

### The `Compact` tool

A **builtin tool registered on both engines**, named `Compact`, taking no parameters.

**It is always enabled and outside `enabledTools`' reach.** This is a structural property, not a defaulting rule. `Compact` is deliberately NOT a member of `EMBEDDED_AGENT_TOOL_NAMES` and NOT a member of `BUILTIN_TOOLS`. On `openai-api`, `AgentLoop` itself prepends the tool's definition to the tool list it hands the provider and intercepts the call by name before dispatching to `CompositeToolExecutor` — so there is no representable `enabledTools` value that removes it, and it never appears in the definition form's tool checkboxes. On `claude-sdk`, it is served by an **in-process SDK MCP server** (`createSdkMcpServer`) added to the engine's `mcpServers`, with its name added to the allowlist; the §4.1 tool-containment check already exempts `mcp__`-prefixed names, so containment needs no change. Both registrations are inside the subprocess, where the state being acted on lives; the server has no part in either.

**The self-management tool class (first member: `Compact`)** — recorded by name for [#1045](https://github.com/ms2sato/agent-console/issues/1045)'s designer, who must not mistake this for a capability tool that was left ungated by oversight:

> A **self-management tool** is owned by the loop/engine and lives outside the capability builtin registry (`EMBEDDED_AGENT_TOOL_NAMES`). It has zero outward capability: it reads no file, writes no file, runs no process, reaches no network, and cannot affect anything outside the worker's own conversation. §4.1's opt-in rationale for `enabledTools` — every member of that set can reach outside the worker, so each must be individually granted — therefore does not apply to it. A future tool-permission floor must not govern the two classes with one mechanism: gating a self-management tool buys no safety and costs the user the ability to manage their own conversation.

**The model-visible name differs per engine; the contract does not.** On `openai-api` the model sees `Compact`; on `claude-sdk` it sees `mcp__console__Compact` (the in-process server is named `console`, chosen to read acceptably in a transcript, where this name is visible). Parameters (none), reservation semantics, and result wording are identical across both. The asymmetry is inherent — the SDK namespaces every MCP tool — and is recorded here rather than papered over.

**The call is observable.** On both engines, a `Compact` call surfaces in the transcript through the ordinary `tool-call` / `tool-result` events, on the same emission path every other tool call uses. `openai-api`'s by-name interception happens *after* the `tool-call` emit and produces a `tool-result` exactly as a dispatched tool would; `claude-sdk` gets it for free from the SDK's own `tool_use` / `tool_result` echo. A user must be able to see in the transcript that the agent reserved a compaction — a compaction that appears from nowhere is indistinguishable from a bug.

**Per-engine behavior:**

- **`openai-api`** — sets `pendingCompact`; result: `Compaction scheduled; runs when this turn completes.`
- **`claude-sdk`** — enqueues `/compact` as a user message onto the SDK's own input queue after the turn ends, riding the SDK's own admission of that command. Probe [#1400](https://github.com/ms2sato/agent-console/issues/1400) P2 confirmed `/compact` exists and that its `compact_boundary` reaches the query iterator. **This injection produces no server-side `user-message` echo**: the server-authored echo exists so a real human/API-caller message appears in the persisted transcript, and a synthetic `/compact` is neither. A fake user row saying `/compact` would misattribute the action to the user.

**Turn attribution for the injected `/compact` (`claude-sdk`), by decision.** Because the injection bypasses `runTurn` to avoid a fake user row, the SDK's response to it carries the **reserving turn's** `turnId` — the turn in which the agent called `Compact`. That is the contract, not a leftover: the compaction was requested during that turn and its acknowledgement belongs to it, which is what a user reads as "I asked, and it answered". The attribution is persisted in the transcript permanently, so it is wire semantics. **Do not mint a fresh `turnId` there**: with no `user-message` row for the injected command, a fresh id produces an assistant bubble belonging to no user message at all — trading a defensible attribution for an orphaned one. Pinned by a test.

**The attribution is structural, not assumed.** `handleResult` defers `state: idle` and the turn's settlement until the injected `/compact` reaches its own terminal `result`, so `main.ts` keeps `turnActive` set across the whole compaction and a `user-message` arriving mid-compaction is refused rather than started. Nothing can reassign `currentTurnId` while the injected turn's events are in flight. This also restores parity with `openai-api`, where `runUserTurn` and `settleCompactionAtTurnBoundary` have always been one promise for the same reason — the earlier "settle, then drain" ordering on the SDK side was an omission rather than a deliberate asymmetry, and it left the attribution above holding only for as long as nobody typed during a compaction (which emitting `state: idle` first actively invited). The turn therefore reads as `active` for the duration of a compaction; that is honest, and the alternative is not responsiveness but a next input silently absorbed into the wrong turn.

**One more boundary value, on `claude-sdk` only.** A conversation too short to compact is declined by the SDK: no `compact_boundary`, and the refusal (`Not enough messages to compact.`) comes back as an ordinary assistant turn. **Nothing is broken and nothing hangs** — the refusal is visible in the transcript where the user can read it, which is the whole handling this case needs. Two consequences a future implementer needs stated rather than inferred. First, *a missing boundary is not evidence that the command does not exist*; that inference is exactly what P2 was run to settle, and it is settled. Second, **do not add a compensating mechanism here** — no synthetic marker, no retry, no client-side "compaction failed" state. The `openai-api` engine has no equivalent path at all (our distillation never declines on conversation length), so this is a real behavioral difference between the engines, and the honest response is to let each engine's own output speak.

### The worker-level auto toggle

`autoCompaction` is a property of the **worker**, not of the definition. Two workers created from the same embedded-agent definition can differ, because the decision belongs to the conversation in front of the user, not to the agent's configuration.

- **DB:** `workers.auto_compaction INTEGER NOT NULL DEFAULT 1` (migration v35). Default ON, and every pre-existing worker row falls to ON — that is what the owner's decision means; a toggle that shipped OFF-by-default would leave every existing worker with no context management at all, which is the state the swap exists to end.
- **Wire:** `EmbeddedAgentWorker.autoCompaction: boolean`, carried on the worker shape the app-state broadcast already sends. Because the runtime schema is a `strictObject`, this field must be added to `EmbeddedAgentWorkerSchema` in `packages/shared/src/schemas/app-server-message.ts` **in the same change as the TypeScript type** — valibot silently strips unknown fields, so a type-only addition disappears at the wire boundary with no error on either side (Gap-Scan Q10).
- **Write path:** `PATCH /api/sessions/:sessionId/workers/:workerId` with `{ autoCompaction: boolean }`. There is no WebSocket command for it: this is durable per-worker configuration, not a per-turn signal, and REST is where this codebase puts durable writes.
- **When it takes effect: immediately, on both engines.** A `set-auto-compaction` command reaches a running subprocess; it is deliberately NOT gated on `turnActive`, because the flag is only read at the turn boundary, so recording it mid-turn is safe — and gating would silently drop the change for the length of a long turn, which is exactly when a user reaches for the toggle. `openai-api` reads its own flag at the next boundary. `claude-sdk` writes the SDK's own setting mid-session; probe [#1400](https://github.com/ms2sato/agent-console/issues/1400) P1a measured that write taking effect in all four directions (construct-false → false, `applyFlagSettings(true)` → true, and the symmetric pair), which is what admitted live reflection into this PR rather than deferring it.
- **What OFF means on `claude-sdk`, stated honestly.** Setting the SDK's auto-compaction flag to false also **disables the window setting entirely**, leaving the effective window at the model's full 1M. The SDK says so itself when asked to narrow the window with the flag off: *"Auto-compact window set to 100k tokens, but a higher-priority override is active (1m tokens)"*. Two things follow. First, that coupling is itself evidence the flag is honored — a flag being ignored would not selectively disable the window alongside it. Second, it makes the OFF arm **structurally unverifiable under pressure**: there is no way to give it a small window to fill, and probe #1400's OFF-side non-firing at ~112k tokens is 11% of a 1M window, which a completely-ignored flag would produce identically. The verdict recorded is therefore *"OFF's effectiveness: supported by configuration evidence; not verified under pressure, and unverifiable by construction"*. In practice the distinction does not reach a user: with the flag off the effective threshold sits near 934k tokens, which real conversations do not reach. The canonical record of all of this is `embedded-agent-sdk-engine.md` §5's PS1 correction trail — read that rather than this paragraph if the two ever disagree.

### UI

Attaches to `EmbeddedAgentWorkerView` as siblings, not as changes to `MessagePanel` — `MessagePanel` is shared with PTY workers and stays worker-type-agnostic.

**Always-visible usage bar — unchanged on both engines.** The 2px in-flow bar between the transcript scroll region and `<MessagePanel>` keeps its existing behavior: `role="progressbar"` with `aria-valuenow`/`aria-valuemin`/`aria-valuemax` when `contextWindowTokens` is defined, the dashed/indeterminate rendering with its tooltip when it is not, the hover tooltip honoring `contextUsage.estimated` with a leading `~` and a trailing `; estimated` clause. **The three-band color escalation is retained** and now reads against the compaction threshold rather than the retired soft/hard pair: subtle/gray below `threshold - 0.15`, amber from there to `threshold`, red at or above `threshold`. This keeps the bar informative — the user can see compaction coming — without reintroducing a second configurable ratio.

**The threshold banners and their CTA are deleted.** They existed to tell the user to press a button that no longer exists; auto compaction is the toggle and manual compaction is a request to the agent. With them go the two-stage soft/hard ratio pair, `context-usage-threshold.ts`'s crossing predicate, and the client's `handoffInFlight` / `triggerHandoff` machinery. Issue [#1206](https://github.com/ms2sato/agent-console/issues/1206) — which redesigned the CTA's reachability and the missing in-flight indicator — is **moot** and closed: the mechanism it redesigned is gone.

**The auto-compaction toggle.** A control in `EmbeddedAgentWorkerView`'s own chrome, adjacent to the usage bar (the two are about the same thing). Label and helper text must never expose the word "engine" or name either mechanism — `Compact automatically when the context fills up` is the shape, not `Use SDK auto-compaction`. It is a plain checkbox/switch reflecting `worker.autoCompaction`, writing through the PATCH above, disabled while the write is in flight, and reverting on failure (the server is the source of truth; the client follows it).

**The client must not substitute the ON default when the value is unknown.** That default belongs to the server (`workers.auto_compaction NOT NULL DEFAULT 1`); repeating it in the rendering would give one fact two sources, and a field lost at the wire would then render as a confident ON and look entirely normal — the Gap-Scan Q10 failure shape. An unknown value disables the control instead, which also stops a click from writing a value derived from a displayed guess. Regression-locked in the sibling test.

**Transcript boundary marker.** The `context-compacted` event folds into an `EmbeddedAgentChatEntry` kind (`{ kind: 'context-compacted'; source: 'auto' | 'manual'; summary?: string }`), rendered as one slim row — the "one line marking the compaction boundary" of the shared experience. When a `summary` is present it is a closed-by-default `<details>`/`<summary>` disclosure (the same native-disclosure + stable-key discipline `WorkingAccordion` uses): summary line `— Context compacted —`, body the full summary text. When `summary` is absent the row renders as a plain, non-expandable line.

**Legacy `context-handoff` rows keep rendering.** Persisted transcripts written before this change contain `context-handoff` events. The client's parse and render paths for that kind are **retained**, annotated legacy-only; only the *emission* is retired. A historical-stream fixture regression-locks this — see Testing.

**Failure surfacing.** A compaction failure emits an ordinary `turn-error` (message prefixed `Context compaction failed: <reason>`), rendered by the existing `turn-error` chat-entry case. The conversation is provably unchanged (the failure invariant above), so the existing "the conversation stays usable for the next message" framing already covers retry.

### Definition config, migration, and forms

`EmbeddedAgentDefinition.compaction?: { threshold?: number }` — whole-object replace on `PATCH` (`compaction: null` clears to `undefined`, an explicit object replaces wholesale, an absent key means no change), matching the convention `provider` already sets.

This replaces `handoff?: { softRatio?: number; hardRatio?: number; auto?: boolean }`. The two-stage soft/hard pair dies with the banners it drove — there is one threshold now because there is one behavior. The dormant `auto` flag, which the retired section documented as "accepted and persisted but NOT read until Phase B", is finally consumed: **as a per-worker toggle rather than a per-definition one**, because the owner's decision put it on the worker.

**Migration v35** — `workers.auto_compaction INTEGER NOT NULL DEFAULT 1` (see the toggle above).

**Migration v36** — `embedded_agents`: drop `handoff_soft_ratio` / `handoff_hard_ratio` / `handoff_auto`, add `compaction_threshold REAL`. Dedicated column, not JSON, matching how the retired columns were shaped and how `provider_*` is flattened. Follows `migrateToV32`'s table-recreation template exactly (SQLite cannot drop columns in place at the SQLite version this project targets, and v32 is the established shape for recreating this specific table). **No value is carried across:** `handoff_soft_ratio` and `handoff_hard_ratio` were the two ends of a banner escalation, not a compaction trigger point, and mapping either of them onto `compaction_threshold` would silently invent a threshold the operator never chose. Existing definitions land on `compaction_threshold = NULL`, i.e. the 0.85 default.

**Forms.** `EmbeddedAgentForm.tsx` keeps its optional `contextWindowTokens` numeric input and replaces the two ratio inputs with one optional `compaction.threshold` percentage input (an `85` input maps to `0.85`), preserving the existing decimal handling — `formatCompactionThresholdInput` rounds only to strip floating-point noise from the `* 100` multiplication, never to a whole percent, so a decimal threshold round-trips through Edit unchanged. The cross-field soft ≤ hard validation is deleted along with the second field.

### Deletion checklist

The swap is mostly subtraction. Everything below is removed in the same PR; the list exists so a reviewer can check completeness mechanically rather than by reading the whole diff.

| Removed | Location |
|---|---|
| `handoff` member of `EmbeddedAgentCommand` | `packages/shared/src/types/embedded-agent.ts`, `packages/shared/src/schemas/embedded-agent.ts` |
| `handoff` case in the stdin dispatch loop, `KNOWN_COMMAND_TYPES` entry | `packages/embedded-agent/src/main.ts` |
| `Engine.handoff()` | `packages/embedded-agent/src/engine-types.ts` |
| `SdkEngine`'s distillation machinery: `turnMode`, `distillationText`, `distillationSawToolCall`, `distillationDeferred`, `runDistillationTurn`, `settleDistillation`, `settlePendingDistillation`, `reseed`, `emitHandoffFailure`, `originalSystemPromptAppend`, `loadHandoffPrompt` dep | `packages/embedded-agent/src/sdk-engine.ts` |
| `queryGeneration` multi-generation guard, simplified back to Phase 1's clean-stream-end guard | `packages/embedded-agent/src/sdk-engine.ts` |
| `triggerHandoff`, `TriggerHandoffResult` | `packages/server/src/services/embedded-agent-worker-service.ts` |
| `triggerEmbeddedAgentHandoff` | `packages/server/src/services/session-manager.ts` |
| `embedded-handoff` client message + its WS case | `packages/shared/src/types/session.ts`, `packages/server/src/websocket/routes.ts` |
| `triggerHandoff`, `handoffInFlight` | `packages/client/src/components/workers/embedded-agent-store.ts`, `.../hooks/useEmbeddedAgentWorker.ts` |
| Soft/hard threshold banners + CTAs, `DEFAULT_SOFT_RATIO`/`DEFAULT_HARD_RATIO`, crossing-predicate module | `packages/client/src/components/workers/EmbeddedAgentWorkerView.tsx`, `.../context-usage-threshold.ts` |
| `handoff` definition field and its three DB columns | shared types/schemas, `mappers.ts`, `schema.ts`, migration v36 |
| `.agent-console/handoff-prompt.md` override filename | operator-visible; call it out in the release note (see the loader's migration note above) |

**Explicitly NOT removed** (each of these has a named reason, and removing one is a regression):

1. **`context-handoff` in `EmbeddedAgentEvent` and `EmbeddedAgentStreamEventSchema`.** Persisted transcripts contain those rows; removing the type breaks replay at the *parse* step, before rendering is even reached. Emission is retired; parse and render are retained with a legacy annotation.
2. **`restore.ts`'s treatment of `context-handoff` as a restore boundary.** A worker whose stream contains a historical handoff must still restore to the post-handoff state, or restore would resurrect context a handoff deliberately discarded. `context-compacted` joins it as a second boundary kind; both use `buildCompactionSeedMessages`.
3. **The eviction structural reservation** — the `spawnClaudeCodeProcess` override and the persisted SDK session id. Unrelated to handoff; [#1336](https://github.com/ms2sato/agent-console/issues/1336) depends on it (`embedded-agent-sdk-engine.md` §6). Probe [#1400](https://github.com/ms2sato/agent-console/issues/1400) verified PS4 (`resume` recalls a killed session's conversation verbatim, on the same session id) and additionally that a resumed session lands in the **post**-compaction state rather than replaying the pre-compaction history — so the reservation's premise is now measured, not merely typed. **§4's `reserved` marking on the process-lifetime row stays as it is**: what PS4 unblocks is writing #1336's AC, and `reserved` is lifted by shipping the eviction feature, not by verifying its premise.
4. **`buildCompactionSeedMessages` (or equivalent behavior) survives the removal of the handoff mechanism**, as legacy-restore-only. The path that rebuilds a conversation from a historical `context-handoff` row in a persisted stream keeps running long after the last such row is emitted, and the semantic that survives with it is *"restore does not cross the boundary"* — not just the function. Whoever writes [#1123](https://github.com/ms2sato/agent-console/issues/1123)'s next AC will meet this line; it is here so they meet it as a requirement rather than as a surprise.

**And three things NOT to build, named** so a future reader who has just learned that compaction fidelity is non-deterministic can see *why* the obvious defenses were declined rather than overlooked:

- **A pre-compaction snapshot.** The persisted transcript already is one (see Summary fidelity above); a second copy inside the engine would duplicate it at the layer least able to use it.
- **Automatic retry on a suspect summary.** "Suspect" has no definition here — the measurement is N=2 with conditions unseparated — so a retry rule would encode a guess about a mechanism nobody has identified, and would spend a full provider call doing it.
- **A fidelity check.** Same reason, one layer worse: it would need a ground truth for "faithful enough", which is exactly the thing [#1350](https://github.com/ms2sato/agent-console/issues/1350) is open to establish. Building the check before the criterion is designing the answer around the first two data points.

All three become reasonable the moment the conditions are separated and the mechanism is known. Until then they are speculation with a maintenance cost, and the honest position is the one above: make it visible, keep the transcript.

### Testing

- **Unit — loop package:** `compact()`'s reshape (distillation preserved, splice, `context-compacted` emitted with the right `source`); the auto threshold's three boundary points (just below, exactly at, just above) plus `contextWindowTokens` unset ⇒ cannot fire and an empty conversation ⇒ does not fire (the vacuous cases); reservation idempotency, cancel discards, execution after an error-terminated turn; the **failure-invariant polarity test** described above, in both directions, asserted against the actual `messages` array a subsequent provider call receives.
- **Unit — SDK engine:** `compact_boundary` → `context-compacted`; the tripwire's four quadrants (OFF + drop ⇒ warn; ON + drop + boundary ⇒ marker only; ON + drop + no boundary ⇒ **still warns**, because an unexplained drop remains a genuine anomaly; the reseed concept is gone). The reseed tests are deleted and the guard-simplification is covered instead.
- **Unit — tool:** `Compact`'s per-engine behavior, and that it is present regardless of `enabledTools` (including `enabledTools: []`); that the call surfaces as an ordinary `tool-call` + `tool-result` pair on both engines; and that `claude-sdk`'s `/compact` injection appends **no** server-authored `user-message` row.
- **Unit — client:** the boundary marker row renders (with and without a summary); **the legacy `context-handoff` row still renders, regression-locked with a historical-stream fixture**; the banners are gone; the toggle reflects and writes.
- **Server:** a sibling test for the `PATCH` toggle; the tests that die with `triggerHandoff` / `embedded-handoff` are removed rather than left asserting deleted behavior.
- **Integration (`packages/integration/src/`):** the worker wire's `autoCompaction` round trip (Q10), and **the compaction E2E** on the shipping path — an `openai-api` worker crosses the threshold, auto compaction fires, the boundary marker appears, and the conversation continues. Reuse PR [#1349](https://github.com/ms2sato/agent-console/pull/1349)'s E2E construction. This is `embedded-agent-sdk-engine.md` §7's new verification floor.
- **Migrations:** one test each for v35 and v36.
- **Browser QA (mandatory, gated true-path per `workflow.md` §5):** `openai-api` auto compaction firing and the resulting boundary marker (driven by a temporary dev definition with a small `contextWindowTokens`, the technique documented transparently in the PR body); the toggle going OFF → ON; asking the agent to compact and seeing "scheduled" followed by the boundary.

### Summary fidelity

[#1350](https://github.com/ms2sato/agent-console/issues/1350) stays open and is re-pointed: its subject was the handoff distillation's fidelity, and it is now read as **the compaction summary's** fidelity, on **both** engines. The concern transfers intact — "how much did we lose, and can the user tell?" is identical whether the summary seeds a successor conversation or replaces the head of this one.

**What was measured (probe [#1400](https://github.com/ms2sato/agent-console/issues/1400), SDK 0.3.238, 2026-08-28).** SDK-side compaction fidelity is **non-deterministic**. Two pressure runs over a ~95k-token conversation, same shape and same prompt, produced different outcomes: one compacted to an 872-token summary that lost both a nonce the prompt had explicitly asked to keep verbatim and the topic it belonged to (a same-run control confirmed the loss was the compaction's, not the probe's); the other kept both in a larger summary. A small conversation (25k → 2.1k) and an automatic firing (102k → 2.7k) preserved the planted nonce every time. **N=2, conditions unseparated, mechanism unknown.** The finding does not change the ON-by-default decision — the owner's anchor for that decision is parity with Claude Code, and terminal Claude Code compacts through this same mechanism — but it is recorded here rather than in a review thread, because the design's response to it is a *design decision*.

**The response is visibility, not prevention.** The `context-compacted` marker carries `preTokens`/`postTokens`, straight from data the boundary already reports, and the transcript row states them: `— Context compacted (102k → 2.7k) —`. An unusually aggressive compaction therefore reports its own severity to the user, unprompted. **The marker's wording is a statement of fact and never a guarantee**: anything of the form "your history is preserved" would be falsified by one counterexample, and we have one. The same discipline binds the toggle's label and the `Compact` tool's result text.

**The architecture is the real mitigation, and it is already in place.** Compaction shrinks what the *model* can recall. It does not shrink the **persisted NDJSON transcript**, which keeps the entire pre-compaction history and stays readable in the UI. A lost detail is therefore a loss of the model's recall, not a destruction of information: the boundary marker points at exactly where recall was cut, and the user can scroll above it and re-introduce anything the summary dropped. That property is what makes non-deterministic fidelity survivable without any new machinery.

## Transcript Restore

**Status:** design-first, Stage a (spec, PR [#1191](https://github.com/ms2sato/agent-console/pull/1191)) followed by Stage b (implementation, Issue [#1123](https://github.com/ms2sato/agent-console/issues/1123)) -- both now landed. Stage a was this section, specification only, with no accompanying production code. Stage b implemented restore reconstruction (`reconstructConversation`, the loop-side override) to this section's spec after the embedded-agent architect reviewed it clean. This is the post-v1 fast-follow named in [Post-v1 fast-follows](#post-v1-fast-follows) item 1 and the [Design Decisions](#design-decisions) point 2 deferral.

**Policy status -- un-defer, not re-litigation.** [Design Decisions](#design-decisions) point 2 deferred "restart-resume" to a post-v1 fast-follow on the reasoning that v1's reset-on-restart was *parity* with the terminal worker's PTY-loss behavior, not a regression. Owner directive (2026-07-15) reverses that deferral as a **formal policy change**: full conversation restore across worker/server restart becomes the default target for the embedded agent worker, closing the UX gap against the terminal worker's `-c` continuation ([Design Decisions](#design-decisions) "Worker-type behavior inconsistency"). This section is the first specification of that reversal. It does not re-open or re-argue point 2's original reasoning -- that reasoning remains accurate design history for why v1 shipped without restore; the un-defer is authorized new scope layered on top of it, not a correction of it.

### The track's contract

**A conversation survives a process boundary.** Neither the kind of boundary — an eviction we intended, a restart we did not — nor the engine changes the experience. What the user reads after a revival is the conversation they were having, and the agent they are talking to is the one they were talking to.

The mechanism is engine-specific, and deliberately so. `openai-api` reconstructs the conversation from our own persisted NDJSON stream and hands it back to the provider. `claude-sdk` asks the SDK to resume its own session state ([embedded-agent-sdk-engine.md §4](embedded-agent-sdk-engine.md), Transcript restore row) and never sends it a reconstruction. Two mechanisms, one promise — which is why §4's row reads **mechanism parity** rather than `mapped`.

**What eviction adds, and what it does not.** Idle eviction ([#1336](https://github.com/ms2sato/agent-console/issues/1336) / [#1412](https://github.com/ms2sato/agent-console/issues/1412), now shipped — see [Idle eviction](#idle-eviction-r3-issue-1412)) contributes only the decision to drop a process *on purpose*. Bringing it back is this section's mechanism, unchanged: the eviction phase wrote a policy, not a restore path. The prediction that it would also have to read [#1414](https://github.com/ms2sato/agent-console/issues/1414) first held — a kill the server does not observe reproduces that defect by design, which is why eviction routes through the existing deactivation path rather than inventing a kill.

**One writer for what the user sees.** The transcript rendered on revival is always a replay of our persisted stream, on both engines. The SDK's session state is never a second source of what gets displayed; on `claude-sdk` it is what makes the *model's* memory agree with that display. Keeping this asymmetric is deliberate: two writers for one transcript is the shape this codebase has repeatedly paid for.

**Decomposition.** R1 ([#1410](https://github.com/ms2sato/agent-console/issues/1410)) = `claude-sdk` resume plus the local half of [#1273](https://github.com/ms2sato/agent-console/issues/1273) · R2 ([#1411](https://github.com/ms2sato/agent-console/issues/1411)) = compaction at the restore boundary, plus closing out Transcript Restore's verification (the `openai-api` reconstruction and Tiers B/C had already shipped in [#1201](https://github.com/ms2sato/agent-console/pull/1201) / #1205 — see #1411's own scope correction) · R3 ([#1412](https://github.com/ms2sato/agent-console/issues/1412)) = eviction policy.

### Definition

**Restore** = reconstitution of the LLM-facing `conversation` array (the message list sent to the provider) from the worker's persisted NDJSON output log, performed at activation, in place of v1's unconditional fresh-epoch-and-truncate reset ([Server-side management](#server-side-management-embeddedagentworkerservice) step 4). Restore reconstructs only that array -- the loop's other in-memory state (turn counters, the per-turn `AbortController`, etc.) always starts fresh, whether or not restore succeeds.

### Tier scope: Tier B adopted, Tier C mid-turn repair in the same scope

Using the tiers Issue #1123 introduced:

| Tier | Scope | This spec |
|---|---|---|
| A | Full restore; no context-window judgement; provider rejects with 400 on overflow | Baseline every restore performs |
| B | Tier A + context-usage threshold detection, steering the conversation toward [Compaction](#compaction) before overflow | **Adopted** |
| C | Tier B + mid-turn / mid-tool-call synthetic repair | **Adopted, same scope as Tier B, not a separately-gated follow-up** |

Tier C is in scope alongside Tier B because it is not a new mechanism -- it is a second call site for the [Mid-turn Repair](#runtime-abort-repair-vs-restore-time-repair-parts-cross-reference) logic already shipped for the runtime-abort case ([The loop's turn cycle](#the-loops-turn-cycle) "Mid-turn abort repair (mandatory)"). Shipping Tier B without Tier C would leave every restart that happens to land mid-tool-call permanently unrecoverable: the malformed tail (an assistant `tool_calls` entry with no matching tool-role response) does not heal itself, so every subsequent activation replays the same malformed tail and the provider rejects it every time -- a correctness gap, not an incremental nice-to-have, so it is not deferred.

### Runtime abort-repair vs. restore-time repair: parts cross-reference

Required by AC 2: the historically most common bug source in this codebase is a "machinery partially ported" defect -- one call site's mechanism copied without every part of its contract. This table is the audit surface for stage b: every row must have an entry in both columns, or the gap is a bug, not a design choice.

| # | Part | Runtime abort-repair (existing, [The loop's turn cycle](#the-loops-turn-cycle)) | Restore-time repair (new, this section) |
|---|---|---|---|
| 1 | Trigger | `cancel` command, or the re-ask cap exceeded, during an in-flight `runTurn` | Activation-time replay of the persisted NDJSON stream, before the loop accepts its first command |
| 2 | Detection scope | The CURRENT turn's tool calls in the live, in-memory `this.conversation` | Every `tool-call` event in the restore window ([Compaction boundary](#compaction-boundary)) with no matching `tool-result` event in the log |
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
   - **4b.** Locate the restore window: the tail of the stream strictly after the most recent compaction-boundary event (`context-compacted`, or a legacy `context-handoff`), or the whole stream if none exists -- see [Compaction boundary](#compaction-boundary).
   - **4c.** Replay that window into a `ChatMessage[]` array, classifying every member of the `EmbeddedAgentStreamEvent` union per the table below (a total classification -- no event kind is left for stage b to guess about).
   - **4d.** Apply [Mid-turn Repair](#runtime-abort-repair-vs-restore-time-repair-parts-cross-reference) (Tier C) to the reconstructed array.
   - **4e.** On success: skip `resetWorkerOutput` entirely -- do not truncate, do not mint a fresh epoch (this mirrors `activateAgentWorkerPty`'s `revived: true` epoch-preserving branch, which v1 explicitly avoided per the restart-resume deferral and which this fast-follow now adopts for embedded-agent workers too). Pass the reconstructed array as a new `init` field, `restoredConversation` (below), so the loop seeds `this.conversation` before accepting any command.
   - **4f.** On failure at any step (unparseable stream, a reconstruction invariant violated, an I/O error): fall back to today's v1 activation behavior exactly -- see [Failure invariant](#failure-invariant-restore).

**The persisted stream does not constrain the relative order of `assistant-message` and `tool-call` within one iteration, and the reader reconstructs an assistant turn from either.** The two engines genuinely differ: `openai-api` emits the iteration's (possibly empty) `assistant-message` and then its calls, while `claude-sdk` emits a `tool-call` as soon as it observes one and flushes the assistant message afterwards -- an iteration that opens with a tool use has no accumulated text to flush yet. Both are the same conversation, and 4c produces the same array from either.

Concretely, a `tool-call` arriving with no assistant message open **opens an implicit empty one** and adopts the writer's own flush into it when that arrives, rather than starting a second message -- so one assistant turn never splits in two, and the two orders converge on one reconstruction. That tolerance is gated on **a turn having begun in the window** (a `user-message` already replayed). Debris from a window that began mid-turn has no such `user-message` -- the cut took it -- and still fails 4f, because synthesising an assistant message there would present a **truncated** conversation as a whole one. The two cases are indistinguishable at the `tool-call` itself, which is why the discriminator is the turn's beginning rather than anything about the call.

**Order-dependence is a property of this reader, not of the stream.** Appendix A of [embedded-agent-sdk-engine.md](embedded-agent-sdk-engine.md) previously recorded that downstream consumers of `tool-call` "only render, so the contract holds"; that premise is retired there, because this reader is structural rather than rendering. Any future consumer that depends on event order has to say so where the writer can see it.

**4c's event classification (total over `EmbeddedAgentStreamEvent`):**

| Bucket | Event kinds | Handling |
|---|---|---|
| Mapped (built into the array) | `user-message`, `assistant-message`, `tool-call`, `tool-result` | `user-message` -> `{role:'user'}`; a terminal `assistant-message` -> `{role:'assistant', tool_calls?}`; a `tool-call`/`tool-result` pair -> the owning assistant message's `tool_calls` entry plus a matching `{role:'tool'}` message |
| Noise (replay-only, contributes nothing) | `assistant-delta`, `assistant-thinking-delta`, `state`, `context-usage`, `ready`, `exited`, `turn-error`, `fatal` | Skipped. Reasoning/thinking content is never part of the conversation array even live ([The loop's turn cycle](#the-loops-turn-cycle)), so restore does not reconstruct it either. A `turn-error` (or `fatal`) immediately following an unresponded `tool-call` is the expected wire trace of a live-aborted turn -- the runtime repair that ran at the time was in-memory-only and never reached the wire (row 7 of the [parts cross-reference](#runtime-abort-repair-vs-restore-time-repair-parts-cross-reference) table). Restore-time repair (4d) heals this the same way the live abort would have; 4c does not need to special-case `turn-error`/`fatal` presence |
| Boundary (handled by 4b, not 4c) | `context-compacted`, and legacy `context-handoff` | Never replayed into the array by 4c -- consumed by 4b to locate the restore window's start, per [Compaction boundary](#compaction-boundary) |

**Reconstruction fidelity is wire-faithful, not live-array-faithful (accepted degradation).** Two known divergences between what restore reconstructs and what the original live `this.conversation` actually held -- both intentional trade-offs for stage b to test against, not bugs to fix:

1. **`tool_calls` arguments may be capped.** The reconstructed assistant message's `tool_calls[].function.arguments` come from the wire `tool-call` event's `args` field, which is `capToolCallArgsForWire`'d (`packages/embedded-agent/src/agent-loop.ts:104-107`): when the raw `argsJson` exceeds `WIRE_EVENT_MAX_BYTES`, the wire carries a truncated JSON *string* instead of the parsed object, while the live conversation's own `tool_calls[].function.arguments` always held the full, uncapped `argsJson` (`buildAssistantMessage`, `agent-loop.ts:283-293`). A restored conversation can therefore differ from the original for any tool call whose arguments exceeded the cap. This asymmetry does NOT apply to `tool-result`: the wire `tool-result.result` and the live conversation's `{role:'tool'}` content use the identical `truncateToBytes(..., TOOL_RESULT_MAX_BYTES)` value (`agent-loop.ts:237-250`), so tool-result reconstruction is exact.
2. **Malformed-argument re-ask exchanges are invisible to restore.** When `parseToolArgs` rejects a tool call's arguments, the loop pushes a synthetic `{role:'tool'}` correction message directly into `this.conversation` (`agent-loop.ts:206-213`) WITHOUT ever emitting a `tool-call` or `tool-result` wire event for that call. Restore therefore cannot and does not reproduce this exchange -- the malformed call simply does not appear in the reconstructed `tool_calls` at all, which is safe (no dangling `tool_call_id` results either) but is not a byte-faithful replay of what the live turn actually contained.

Stage b's fidelity tests are scoped to these two accepted divergences: assert restore reproduces the wire-faithful shape (per the Mapped row above), not the live-array-faithful shape -- the excess argument bytes and the malformed-args exchange were never persisted, so restore structurally cannot recover them.

New optional `init` field, extending [Stdio protocol](#stdio-protocol-v1) (no other command or event shape changes):

```ts
| { v: 1; type: 'init';
    ...
    restoredConversation?: ChatMessage[];    // Transcript Restore (#1123); openai-api only -- absent = fresh conversation
    resume?: { sdkSessionId: string }; }     // Transcript Restore R1 (#1410); claude-sdk only -- the SDK resumes its own session state rather than using a reconstruction, so these two fields are never both MEANINGFUL for one engine. Meaningful is about consumption, not wiring: `restoredConversation` rides in the shared half of `init` and is therefore DELIVERED to both engines; the claude-sdk arm ignores it
```

No new persisted/wire EVENT type is introduced -- consistent with the Issue's own expectation of no new events: restore is pure reconstitution from the existing `EmbeddedAgentStreamEvent` union already on disk, plus one new optional command field to hand the result to the loop.

### Compaction boundary

[Compaction](#compaction)'s `context-compacted` marker event is deliberately persisted into the same stream a restore replays -- already called out in [Post-v1 fast-follows](#post-v1-fast-follows) item 1. Restore treats the most recent boundary event as a hard cut: reconstruction starts from that event, using its `summary` field to rebuild the exact seed pair a live compaction would have produced -- the shape `buildCompactionSeedMessages` constructs, which is the single writer shared by the live path ([Compaction](#compaction)'s `AgentLoop.compact()` steps 10-11) and this one -- plus every event after it. Events before the boundary are never replayed into the conversation array: compaction is a deliberate discard of the conversation's head, and restore must not silently resurrect what a compaction already discarded. This is the "restore does not cross the compaction boundary" requirement from AC 3.

**Legacy `context-handoff` markers are boundaries too.** A stream written before the compaction swap ([#1401](https://github.com/ms2sato/agent-console/issues/1401)) carries `context-handoff` rather than `context-compacted`. 4b treats both kinds as boundary events and takes the most recent of either, reseeding from the legacy event's `distillation` field through the same `buildCompactionSeedMessages`. Dropping this would make an old worker's restore replay the entire pre-handoff history -- the exact resurrection the paragraph above forbids.

**One seed text, deliberately, for both boundary kinds.** Restoring across a legacy `context-handoff` produces today's *compaction* wording, not the retired handoff wording. The alternative -- branching `buildCompactionSeedMessages` on which marker kind was found, so a legacy boundary reproduces the sentence the retired code wrote -- was considered and rejected. The seed is a **prompt to the model, not a historical record**: what it must describe accurately is the situation the model is in *now*, and after a restore that situation is identical either way, a conversation whose head is a summary. The handoff wording would in fact be the *less* accurate of the two here, since restore is resuming this very worker rather than starting a successor. Branching would buy fidelity to a sentence nobody reads and pay for it with a second writer of the seed shape, which is the drift vector the single writer exists to close.

When no boundary event of either kind exists anywhere in the stream, the boundary is the start of the stream: reconstruction reassembles the original activation-time system prompt the same way ([Compaction](#compaction) step 8's `reassembleSystemPrompt`), since AGENTS.md/CLAUDE.md content may have changed since the worker's original activation.

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

**Delivery mechanism: `restore-info` (worker WS envelope, not the stdio/persisted-NDJSON protocol).** Both UI behaviors below are driven by a new `WorkerServerMessage` variant -- `{ type: 'restore-info'; epoch: number; restoredMessageCount: number; repairedToolCallIds: string[]; completed: boolean; sdkResumed?: boolean }` (`packages/shared/src/types/session.ts`) -- NOT a new `EmbeddedAgentEvent`/`EmbeddedAgentServerEvent`/persisted-NDJSON row (the "no new persisted/wire EVENT type" statement above is scoped to the stdio protocol / `EmbeddedAgentStreamEvent`; the worker WS outer envelope is a separate layer that already carries transient, non-persisted pushes like `activity`/`error`). `restore-info` is sent ONLY when restore succeeded (4e) -- restore failure (4f) sends nothing extra, exactly v1's existing silent-degradation behavior.

**Correction (Issue #1205, discovered in dogfood immediately after Stage b / PR #1201 merged).** The paragraphs below through "Restoring state" originally specified a CLIENT-derived completion signal: "`restore-info` has been received for the current epoch AND the loop's `ready` event has not yet been observed in the replayed/live stream." That derivation is a structural design flaw, not an implementation bug in PR #1201 (PR #1201 implemented it exactly as specified here). The flaw: 4e above establishes that a SUCCESSFUL restore never mints a new epoch -- so a worker restart's `ready` event lands in the SAME epoch as the PRIOR incarnation's `ready` event. Any client that was already attached (or reconnects after a full history replay) has therefore typically already observed a `ready` event in that epoch BEFORE the new incarnation's `restore-info` arrives, so the "has the loop's `ready` event not yet been observed" half of the derivation is false from the very first message, and the loading state never activates. This is not scenario-specific -- it reproduces for every restart after a worker's first-ever activation, not just the process-crash case that surfaced it. Root cause is a scope error: the derivation needs to track "has THIS INCARNATION's restore completed", but `ready`-observation bookkeeping was scoped to the epoch instead, and epoch and incarnation are NOT the same lifetime once a successful restore is in the picture. The corrected design (below) replaces the client-derived flag with a server-authoritative `completed` field carried on `restore-info` itself, closing the gap without relying on client-side event ordering at all.

**Dual delivery (fast-path push + bootstrap-authoritative) PLUS a ready-triggered completion repush, mirroring the existing epoch-distribution pattern** (`routes.ts` `onWorkerRestarted`: the app-ws broadcast is a UX fast-path that can be missed, `closeWorkerSocketsForRestart` forcing a fresh bootstrap is authoritative -- see `terminal-history-paging.md` §3.4/§4.5):

1. **Fast-path push, `completed: false`.** Immediately after reconstitution (4a-4d) completes -- before the subprocess is spawned -- the server broadcasts `restore-info` to every currently-attached `connectionCallbacks` entry for the worker (`EmbeddedAgentWorkerService`, mirroring `broadcastActivity`'s fan-out), with `completed: false` (the new incarnation has not reported `ready` yet). Reaches zero listeners when nobody is watching yet; not a correctness requirement.
2. **Bootstrap re-delivery (authoritative), current value.** The server retains the current incarnation's restore result (`restoredMessageCount`, `repairedToolCallIds`, `completed`) in the worker's runtime state for the lifetime of that incarnation (subprocess alive). EVERY new WS connection during that incarnation -- not only the one that triggered the activation -- receives `restore-info` again as part of its bootstrap, alongside its initial `history` response, carrying whichever `completed` value is CURRENTLY true. This is what makes the note durable across reconnects: a client that connects (or reconnects) after the fast-path push already fired still learns about the restore, and a client connecting AFTER the incarnation is already ready correctly sees `completed: true` immediately (no stuck loading state).
3. **Ready-triggered completion repush, `completed: true` (new, Issue #1205).** The server observes the new incarnation's `ready` NDJSON event server-side (`EmbeddedAgentWorkerService`'s stdout line handler, the same place [Initial prompt delivery](#initial-prompt-delivery) hooks). The first time `ready` is observed for an incarnation whose `restoreInfo` is non-null, the server flips that incarnation's retained `completed` flag to `true` and re-broadcasts `restore-info` (same shape, `completed: true`) to every currently-attached connection, using the identical fan-out as step 1. This is the ONLY signal that ever flips the client's loading state off -- it is authoritative because it is derived from the server having actually observed `ready`, not from client-side replay-order guessing.

**What `restoredMessageCount` counts (Issue [#1428](https://github.com/ms2sato/agent-console/issues/1428)) — a criterion, not a list.**

> **An entry counts if and only if its content originates from a line of the persisted transcript.**

Replayed messages count (each originates in its own row). The compaction summary counts (it originates in the `context-compacted` row). The synthetic system prompt does not, and neither does a Tier C repair marker: both are **invented by the reconstruction** so the provider will accept the array, and neither originates in any row.

**It is written as a criterion because the enumeration was tried first and failed.** "Exclude the seed" was the first definition, and a worker killed immediately after a compaction — nothing replayed after the boundary — would have reported 0 under it, **suppressing the divergence notice exactly where the model has lost the most**. Correcting that to "exclude only the synthetic system prompt" fixed the summary but was itself an enumeration, and it silently mis-classified a *third* synthetic category, the repair markers, which double-count an interaction the user sees once: the tool call is already counted as the assistant message it arrived in. **A criterion answers for a fourth category that does not exist yet; a list does not.** Empty transcript reports 0, and a boundary with nothing after it reports 1.

**The definition is engine-independent, and only the consumption differs.** The server runs the same reconstruction for both engines and reports the count under this same definition; what differs is who uses the reconstructed array. `openai-api` seeds its conversation from it. `claude-sdk` is sent it on the wire — it rides in the shared half of the `init` command — and **deliberately ignores it**, resuming the SDK's own session instead. `restoredMessageCount` therefore describes what was recovered from the log, not what the engine did with it, and means the same thing on both.

`epoch` is included specifically as a **cross-incarnation staleness guard**: the client feeds it through the SAME `acceptEpoch` gate `history`/`output` messages already use, so a `restore-info` from a superseded incarnation (e.g. a slow-arriving fast-path push racing a subsequent restart) is discarded exactly like a stale `output` frame would be -- no separate freshness mechanism. Note this guard is orthogonal to the `completed` fix: `epoch` correctly identifies cross-incarnation staleness for messages that DO carry a new epoch (restore failure), but cannot by itself distinguish two same-epoch incarnations (restore success) -- that distinction is exactly what `completed` now carries instead.

- **Restoring state.** Derived client-side, but from a purely server-authoritative signal, not a new state enum: `restoring` is true if and only if the most recently ACCEPTED `restore-info` message (per the `epoch` staleness guard above) carries `completed: false`. No client-side `ready`-observation bookkeeping is consulted at all -- the client does not need to reason about whether the current incarnation's `ready` has been folded into its local replay yet; the server already told it. While derived-true, the view shows a loading state: `Loading N previous message...` — singular or plural on N, using the received `restoredMessageCount`. **The copy here is the copy the client renders**; it previously read `Restoring conversation from N previous messages...`, which the implementation has never emitted. The singular form is reachable in production rather than theoretical: a worker killed immediately after a compaction restores exactly one entry.
- **Sending a new user message is blocked** while restore/activation is in flight, via the same admission-gate shape [Server-side management](#server-side-management-embeddedagentworkerservice)'s `sendUserMessage` already uses for "turn in progress" -- extended to also cover "activation/restore in progress". **Verified independently correct (Issue #1205 repro-first trace):** this gate is driven by `activityState`/`turnActive`, both of which already start fresh and correctly per incarnation (a brand-new `Runtime` object is installed on every activation, and the server explicitly re-pushes the current `activity` state to every new connection) -- unlike the `restoring` derivation above, this gate was never actually broken; it was independently re-confirmed via real WS-frame capture during the Issue #1205 investigation, not assumed clean by association.
- **Repair transparency.** When the received `restore-info.repairedToolCallIds` is non-empty, the client renders a non-blocking, non-dismissable-until-acknowledged note -- re-rendered after any reset-then-rebuild of the local entry list, so a fresh reconnect's bootstrap redelivery reconstructs it -- `Some tool calls were interrupted by a restart and marked as errors` (per Issue #1123's UI note), as a new `EmbeddedAgentChatEntry` kind, `{ kind: 'restore-repair'; toolCallIds: string[] }`, using the same closed-by-default `<details>`/`<summary>` disclosure pattern the `context-compacted` boundary marker already uses ([WebSocket & client protocol](#websocket--client-protocol)).

### Interrupted turns: detection and the local signal (R1, the local half of #1273)

A worker that dies mid-turn leaves its persisted stream ending on a user message that nothing ever answered. Until R1 the replayed transcript simply stopped there, and a delegating parent waiting on a callback waited forever.

R1 closes the **detection and local signal** half, which the restore machinery produces almost for free — the same activation-time replay that reconstructs the conversation already walks every event in order.

- **Detection** is engine-independent and reads only the persisted stream: a `user-message` with no `state: 'idle'` and no `turn-error` after it was interrupted. `exited` is deliberately excluded from that terminal set, and `turn-error` is deliberately included; **[embedded-agent-sdk-engine.md Appendix A.3](embedded-agent-sdk-engine.md#a3-server-side-events-engine-agnostic) is the single writer for the rule and for why each of those two choices is load-bearing** — do not restate the reasoning here.
- **Signal** is a server-authored [`turn-interrupted`](../glossary.md#turn-interrupted--turn-interrupted) event appended to the stream and rendered on replay as a marker row. Server-authored because the server does not forge engine-authored events: it does not fake a `turn-error`, which would be a claim about what the model did rather than about what the server observed.

**Explicitly not in scope**, and both by decision rather than omission: re-delivering the interrupted instruction (owner's decision, and #1264's ruling), and routing the signal to the delegating parent. That residue stays in [#1273](https://github.com/ms2sato/agent-console/issues/1273), which this event is the hook for — a future delivery mechanism reads it rather than re-deriving the condition.

### Unobserved incarnation death: the fatal route (#1414)

**The invariant, shared with eviction ([#1412](https://github.com/ms2sato/agent-console/issues/1412)):** every incarnation death is observed by the server. Either the OS exit reaches the exit observer, or a detector routes the incarnation into `deactivate` — a path the observer covers. **The third category, dead-but-unobserved, is not representable.**

[#1414](https://github.com/ms2sato/agent-console/issues/1414) is what that third category cost while it existed. Killing a `claude-sdk` worker's `claude` grandchild while its harness kept running left the worker permanently bricked *and indistinguishable from healthy*: the harness never exited, so nothing cleared `turnActive` or revoked the MCP token, a new WebSocket connection was an idempotent no-op with no `restore-info` and no `ready`, and every message after the first was refused with `TURN_IN_PROGRESS` forever.

**`fatal` is the death of an incarnation, not of the worker.** The track's contract applies to it unchanged, so the server replaces the incarnation rather than reaping it — reaping would lose the conversation, which formalises the bug's symptom instead of fixing it. The mechanism is R1's refused-resume recovery, reused: on `fatal`, a **detached, single-flight** `deactivate`, whose exit the observer fires on, so **the one existing choke point collects both dangling obligations** (`turnActive` cleared, `revokeByWorker`, runtime deleted); then a fresh spawn, which resumes the persisted `sdkSessionId` like any other re-activation.

Four properties carry it, and each answers a way the naive version fails:

- **No new turn-ending `turnActive` writer.** The turn-ending writers are two — `state: 'idle'` and the exit observer — and the fatal path *reaches* them rather than joining them. (A third *assignment* site exists, in the `writeCommand` catch of `deliverUserTurn`, but it is not a turn-ending writer: it undoes the optimistic set for an admission whose message never reached the subprocess, so no turn ever began. Counting it here would obscure the property that matters.) Adding a genuine third turn-ending writer breaks the single-writer property that made this defect findable at all.
- **Detached, and that is load-bearing.** The handler runs inside the stdout reader's own loop, and `deactivate` awaits the exit observer, which awaits that same reader. Awaiting the replacement from there deadlocks the reader against itself and hangs the worker the recovery exists to rescue.
- **One replacement per fatal chain**, reset by a completed turn. A persistent cause (a bad definition, an unauthenticated CLI) would otherwise loop fatal → respawn → fatal forever, and **an infinite respawn is worse than the brick**. The second fatal in a chain still gets the teardown — "visibly `exited`" is a promise only an observed exit can keep — but no replacement.
- **Engine-gated, by a named predicate rather than by the event.** Only an engine whose harness can outlive its engine is routed. `openai-api` has no in-harness fatal: both of its `fatal` sites are construction failures that `return null` and take the process down, so the observer already collects them and the worker correctly stays `exited`. Routing those would convert "activation failed, stay exited" into a respawn — a behaviour change that engine must not get. A future engine opts in by name, because "my harness outlives my engine" is a property of the engine's own failure handling and cannot be inferred from the event.

**Ordering, stated.** The dying incarnation's own `fatal` is appended and fanned out first, unchanged; the replacement runs after it; an unfinished turn's user-facing marker is the [`turn-interrupted`](#interrupted-turns-detection-and-the-local-signal-r1-the-local-half-of-1273) row the *fresh* incarnation appends. **No `turn-error` is synthesized**, for two independent reasons: `turn-error` is in `findInterruptedTurnId`'s terminal set, so authoring one here would close the turn and make `turn-interrupted` structurally unreachable for the very turn it describes; and the refused-resume `turn-error`'s wording ("not something this agent now remembers") is *false* on this path, where the SDK resume is expected to succeed and carry the conversation across.

**The detection limit is accepted.** Nothing polls for a dead engine; a proactive watchdog is deliberately out of scope, and idle eviction ([#1412](https://github.com/ms2sato/agent-console/issues/1412)) supplies the practical bound on a zombie's residency. What the measurement showed is that the limit is narrower than feared: the SDK engine's consumer loop is always iterating the message stream, so the transport throw — and therefore the `fatal` — arrives within ~100 ms of the child's death, without waiting for a message.
### Idle eviction (R3, Issue [#1412](https://github.com/ms2sato/agent-console/issues/1412))

**Status:** shipped. This is the phase [#1336](https://github.com/ms2sato/agent-console/issues/1336) reserved, and it lifts [embedded-agent-sdk-engine.md §4](embedded-agent-sdk-engine.md)'s process-lifetime row from `reserved`.

Eviction contributes exactly one thing: **the decision to drop a process on purpose.** Bringing it back is the restore mechanism specified above, unchanged. There is no eviction-specific restore path, and there must never be one.

#### Why the process is worth dropping

Measured on a live `claude-sdk` worker tree (R1's memory appendix, `/proc/<pid>/smaps_rollup`, PSS for fleet reasoning per [#1332](https://github.com/ms2sato/agent-console/issues/1332)): 483 MB RSS / 372 MB PSS for the tree, of which the `claude` child is ~74%. With the child gone the surviving harness holds 126 MB RSS / 90 MB PSS. **Three quarters of an idle worker is the evictable part** — which is what makes keeping many agents alive a different proposition than it is today.

#### The hazard line: eviction kills through the exit observer, or not at all

[#1414](https://github.com/ms2sato/agent-console/issues/1414) documents a worker that is **permanently bricked and looks healthy**: its `claude` grandchild dies, the harness survives, the server observes no exit, `turnActive` is never cleared, and every later message returns `TURN_IN_PROGRESS` forever.

**An eviction that terminates the subprocess through a path the exit observer does not cover reproduces that defect by design, on a timer.** This is the one constraint on the mechanism that is not negotiable, and it is why the implementation is a call into `deactivate()` — the existing deactivation path, SIGTERM escalation, `endStdinSafely`, token revocation and all — rather than a kill of its own. R1's refused-resume recovery routes the same way for the same reason.

#### Policy

| | |
|---|---|
| **Eligibility** | `claude-sdk` embedded workers only. `openai-api` is out of scope — its reconstruction path is R2's, and mixing the two would make the policy depend on which engine's restore had landed. |
| **Signal** | Idle time alone. Usage volume is deliberately **not** mixed in: a policy that weighed "how much this worker has been used" would evict the workers a user is most invested in and is unanswerable without usage data that does not exist yet. |
| **Threshold** | `EMBEDDED_AGENT_IDLE_EVICTION_MS`, default 30 minutes. Non-positive disables eviction entirely. Tests set it to milliseconds. |
| **Wake** | The existing activation path, unchanged — which is also what keeps multi-user correct, since the subprocess-side resume pre-flight travels with it. |
| **Layer** | The timer and the decision run **in the server**. It owns `activityState` and the deactivation machinery, and a subprocess cannot outlive its own eviction. |

#### The commit point

The countdown is armed when the worker looks idle. Everything can have changed by the time it fires, so the decision is re-made at the moment of the kill rather than trusted from the moment of the arm:

- **A worker mid-turn is never evicted.** `turnActive` is re-read when the countdown elapses; if a turn is in flight the countdown simply restarts.
- **The re-read and the commitment are one synchronous section.** Splitting the `turnActive` read from the `evicting` write would open a third race in the same shape as the timer-fire-to-kill window the re-check exists to close.
- `turn-interrupted` at the next activation would catch a lost race, and it is deliberately built to (its terminal set excludes `exited` precisely because a deliberate eviction produces one). **The backstop is not the mechanism** and must not be reasoned about as one.

**The countdown is armed only after the incarnation reports `ready` and its initial-prompt obligation is discharged**, and that ordering is load-bearing rather than cosmetic. `maybeDeliverInitialPrompt` reaches the delivery path from *inside the stdout reader*; the delivery choke point below awaits any in-flight eviction; an eviction awaits `deactivate` → `exitSettled` → `streamsDone` → that same reader. A countdown that could fire before `ready` finished being handled would let the reader await an eviction waiting on the reader — the exact deadlock R1's refused-resume recovery hit. Gating the arm on a per-incarnation `ready` flag removes the window structurally, in whatever order the engine chooses to emit its events.

#### The delivery invariant

**Every path that delivers input to a worker passes one choke point, which either wakes the worker or fails loudly. Silently dropping input into an evicted worker is the one non-reversible failure in this design.**

That choke point is `deliverUserTurn`: `sendUserMessage` and `sendSystemNotification` both delegate to it, and the WebSocket, inter-session and MCP paths all end at one of those two. Before admission it awaits any eviction already in flight, then wakes the worker if there is no live subprocess.

**The wake condition is "there is no live subprocess" — deliberately not "the worker is marked evicted".** A marker-gated check covers only the states someone remembered to enumerate, and the enumeration is what rots. Testing for the absence of a process instead makes a silent drop unrepresentable for callers that have not been written yet. The cost is that a worker stopped by the user is also woken by an incoming message, which is both semantically right (a message is an address) and, at every call site that exists today, already the behaviour: all three of them call `activateEmbeddedAgentWorker` immediately before delivering.

The admission check-and-set stays **synchronous, and after that await**. It remains the single commit point for admission, resting on `activate()`'s existing idempotency: two concurrent messages to an evicted worker produce one activation and one admitted turn, with the loser getting `TURN_IN_PROGRESS` exactly as it would against a live worker.

A wake that fails returns `NOT_ACTIVATED` carrying the classified activation message — the same classification `websocket/routes.ts` applies — never a success and never silence.

#### `reason: 'evicted'` — one identifier for the concept

The exit observer is the path the hazard line requires, and it did two things that made a deliberate eviction look like a failure. Both are fixed here, and both hang off a single field.

[`ExitReason`](../glossary.md#exitreason) gains `evicted`, and the same value rides on the persisted `exited` event. There is deliberately **no parallel boolean**: two writers for one concept is the shape this codebase has repeatedly paid for.

- **The notification.** The global worker-exit callback fed `notificationManager.onWorkerExit`, so an idle worker would have pinged the owner **once per threshold period, per idle worker, forever**. That is not a rendering blemish — it is the feature harassing the person it exists to help, on a timer, scaling with exactly the thing it is trying to make cheap. Evictions are suppressed there; `managed` and `unexpected` notify as before.
- **The transcript row.** The `exited` row renders as *"Agent process exited (code: 0)"* with a **Restart** button — an instruction to take a manual action the user does not need, since the next message wakes the worker by itself. An evicted row renders instead as a quiet line with no button.

**The field is three-valued and must be read as such.** Absent means the row was written by a server that predates it, and absent renders exactly as it always did. Consumers test `reason === 'evicted'`, **never** `!reason` or truthiness — the same discipline `sdkResumed` carries in [§4.3](embedded-agent-sdk-engine.md), where a negation would have shown a divergence notice on every `openai-api` worker.

This is the one place R3 touches the UI, and it is a subtraction: the assumption it overrides ("a transparent resume has nothing to show") had a false premise, because eviction was never visually silent. The choice was between a misleading rendering and an accurate one, not between none and some.

#### Assumptions, stated rather than settled

Recorded here because they are policy the owner may reverse without any change to the mechanism:

- **30 minutes.** Sized from the memory measurement above, not from usage data, which does not exist yet.
- **Wake triggers: user message, inter-session message, WebSocket connect.** The first two pass the choke point by construction. The third is the pre-existing activate-on-open in `websocket/routes.ts` and costs no new code — but note what it means: **merely opening a tab re-inflates ~74% of the tree even if no message follows.** Dropping view-path wake is a live option and requires no mechanism change.
- **No new chrome.** Eviction and resume are meant to be invisible; the `evicted` rendering above removes a misleading control rather than adding a state. Revisit only if measured wake latency turns out to be large enough for a user to notice.

#### Not in scope

The `openai-api` engine (R2's reconstruction path is a prerequisite, and the policy should not straddle two restore mechanisms mid-track) · usage-weighted or memory-pressure-driven policy · any UI beyond the row above · #1414 itself, which is a distinct exit-detection defect and stays filed on its own.

### Testing (design-time polarity signal -- AC 5)

Implementation and the test itself land in stage b; this subsection fixes the test's *shape* now so stage b does not need to re-derive it.

**Polarity test: provider 400 on an unresponded `tool_call_id`.**

- **Fixture:** a persisted NDJSON log fragment ending in a `tool-call` event with no matching `tool-result` (simulating a crash between tool-call emission and tool execution completing -- the exact Tier C scenario).
- **Fake provider:** a stub `ProviderAdapter` that enforces the real OpenAI-Chat-Completions constraint -- it rejects any request whose `messages` array contains an assistant message with `tool_calls` not immediately followed, for every one of those `tool_call_id`s, by a matching `tool`-role message. This reproduces real provider behavior in a unit test without a live API.
- **Direction 1 (repair NOT applied -- must fail):** replay the fixture WITHOUT step 4d ([Mid-turn Repair](#runtime-abort-repair-vs-restore-time-repair-parts-cross-reference)) applied, then drive one turn against the fake provider. Assert the fake provider rejects and the turn surfaces as `turn-error`. This is the reproduction of the bug this design fixes.
- **Direction 2 (repair applied -- must pass):** the same fixture, WITH step 4d applied. Assert the fake provider accepts the request (the synthetic tool-role message closes every `tool_call_id`) and the turn proceeds normally.
- The audited property: *a restored conversation with a dangling `tool_call_id` never reaches the provider unrepaired.* Per `workflow.md`'s TDD polarity discipline, stage b's implementation PR must include this test, verified in both directions (stash-the-fix-and-confirm-fail, restore-and-confirm-pass) -- see [Testing plan](#testing-plan) for the sibling precedent (`compact()`'s failure-invariant polarity test, [Compaction](#compaction) "Testing").

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
| Compaction: distillation provider call fails or is canceled | `turn-error` emitted via the shared `emitTurnError` helper, whose last line always calls `emitIdle()` — the same `{ type: 'state', state: 'idle' }` transition every other failed turn ends with, clearing `runtime.turnActive` server-side exactly as it does today; `conversation` is untouched (failure invariant); no `context-compacted` event; the worker is left exactly as usable as after any other failed turn. See [Compaction](#compaction). |
| Compaction: a `Compact` tool call arrives mid-turn | Expected, not an error — it is a reservation, drained at the turn boundary. Cancel or shutdown discards it; a second call in the same turn is idempotent. See [Compaction](#compaction) § `AgentLoop.compact()` Reservation semantics. |
| Compaction: `contextWindowTokens` unset on the definition | Client shows raw token counts with no ratio and no color escalation; **auto compaction can never fire** (no denominator, therefore no ratio to compare). Manual compaction via the `Compact` tool remains available — it never depended on the ratio. |

## Testing plan

Per `test-trigger.md` placements (sibling `__tests__/`), TDD polarity discipline per `workflow.md`.

- **Unit — loop package** (`packages/embedded-agent/src/**/__tests__/`): SSE/stream parsing of the OpenAI adapter against a mocked `fetch`; tool-call delta accumulation; malformed-args re-ask (max 2) and iteration cap; NDJSON line splitting with partial-chunk carry; init-first protocol enforcement (exit 2); instruction-loader prompt assembly (AGENTS.md/CLAUDE.md fallback, chain discovery incl. a `.git`-as-a-file worktree root, global layer, `instructions[]` confinement incl. symlink-escape, per-file and aggregate cap/overflow-drop order; assembly order preamble -> instruction segments -> systemPrompt). Boundary values: empty tool list, empty assistant text, zero-length delta.
- **Unit — server** (`packages/server/src/**/__tests__/`): `McpTokenRegistry` (mint/verify/revoke; unknown token → null); `checkCallerOwnsSession` mode matrix (presented-mismatch always rejects; absent-token × warn/enforce/off); capability predicates; `EmbeddedAgentWorkerService` with injected `spawnAsUserFn` (activation argv shape incl. no-token-no-key-in-argv/env assertions — negative assertions mandatory; exit/crash paths; stdin `init` first-line; user-message append-before-forward ordering). Use command-discriminating responders when a test doubles `spawnAsUserFn` for multiple call shapes (memory: wrapper-consumer responder splitting).
- **Integration** (`packages/integration/src/`): the Q10 wire test — a session containing a `EmbeddedAgentWorker` serializes over the app WS and parses through `WorkerSchema` with `embeddedAgentId`/`activated` intact; plus a worker-WS test: connect, receive history bytes, parse NDJSON, reconnect with offset and receive only the tail.
- **E2E (shipping path, mandatory before "done")**: with a local stub OpenAI-compatible HTTP fixture (scripted responses incl. one tool call), drive the real flow — create a `EmbeddedAgentDefinition` via REST, add a embedded-agent worker, send a message from the UI/WS client, observe the tool call hit the real MCP server with the bearer token and the result render. A PTY-byte-probe-style shortcut does not count (`workflow.md` mechanism-probe rule).
- **Smoke (multi-user, before claiming multi-user support)**: `scripts/smoke/check-embedded-agent-elevation.ts`, importing the production spawn helper (never replicating argv), spawning as a real second user, asserting: loop starts (`bun` resolved via the configured `EMBEDDED_AGENT_BUN_PATH`, not PATH-only bare-name lookup inside the elevated login shell — Issue #1221), `init` handshake completes, and — negative assertions — the MCP token / provider key appear in neither `/proc/<pid>/cmdline` nor `/proc/<pid>/environ`. (Issue #1222) When `EMBEDDED_AGENT_BUN_PATH` is an absolute path, the LIVE `agent-console.service` process (resolved via `systemctl show -p MainPID` + `/proc/<pid>/exe`) is asserted to actually execute that configured binary — this replaces the pre-#1222 assertion that compared `--version` output against the conventional `${service_home}/.bun/bin/bun` path, which became a file-vs-itself comparison once `ExecStart` and `EMBEDDED_AGENT_BUN_PATH` were unified to the same rendered value and was therefore **removed, not repointed**. A version difference between the configured path and the service user's own `~/.bun/bin/bun` is reported as a WARNING, not a failure (expected freshness after a `bun upgrade`, per the unification note above). A configured absolute `EMBEDDED_AGENT_BUN_PATH` that does not exist on disk, or a live process/unit that cannot be resolved, is a probe-cannot-run condition (exit 2), not a failure. Exit codes 0/1/2 per `os-environment-coupling.md`; documented in the multi-user setup guide.
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
| **4** | Multi-user: smoke script + setup-guide docs (incl. the shared-key trust statement); terminal-agent token-file delivery + agent-side header wiring verified (prerequisite for `enforce`); the multi-user default flip to `enforce` in `resolveMcpAuthMode`; `session-worker-design.md` Worker Types table row + glossary sync | Smoke green on the dogfood host asserting the effective mode is `enforce` with no `AGENT_CONSOLE_MCP_AUTH` set; unit test: `AUTH_MODE=multi-user` + unset env var resolves to `enforce`; terminal agents functional in multi-user; setup guide documents the default flip; docs updated in the same PR — **superseded, Sprint 2026-07-16:** the `enforce` default was reverted to `warn` for every `AUTH_MODE`; the `headersHelper` functional dogfood step (originally umbrella #1004 Completion checklist item 5) was re-scoped as a prerequisite for restoring `enforce` as the multi-user default rather than an in-scope #1004 deliverable, and was completed 2026-08-03 (both mandatory arms passed against a throwaway multi-user instance) |

## Post-v1 fast-follows

1. **Transcript persistence / restart-resume** — **un-deferred (Issue #1123, owner directive 2026-07-15); specified in [Transcript Restore](#transcript-restore).** This section's spec (Stage a) is design-only; the implementation (Stage b) is a separate PR. [Compaction](#compaction)'s `context-compacted` marker event is deliberately persisted into the same NDJSON stream restore replays, so a compaction boundary within a worker's lifetime is already representable — it did not need its own retrofit, per the [Compaction boundary](#compaction-boundary) subsection.
2. `asking` activity state (loop-side heuristics or model-declared).
3. ~~Inbound `send_session_message` → `user-message` routing for embedded-agent workers (extend `canReceiveSessionMessages`).~~ **Done (Issue #1260 PR-2).** `canReceiveSessionMessages` now admits `EmbeddedAgentWorker`; both the MCP `send_session_message` tool and the REST `POST /api/sessions/:id/messages` route deliver to embedded-agent targets via activate-on-delivery + `EmbeddedAgentWorkerService.sendUserMessage`, instead of the PTY-injection path. See the updated predicate snippet and capability-predicate discussion above (§"MCP tool surface: capability predicates, not per-type branches").
4. Non-native tool-calling: text-parse fallback, constrained decoding (llama.cpp / vLLM structured output).
5. Provider key management UI/API; per-user keys.
6. Single-user `enforce` default (retiring `warn`) once tokenless callers no longer exist anywhere.
7. Anthropic (and other) provider adapters.
8. Turn queueing while active.
9. Instruction-loader remainder: other-tool globals (`~/.claude/CLAUDE.md`, `~/.config/opencode/AGENTS.md`, etc.), `@import`/include syntax, dynamic reload / re-read on file change (the loader reads once per activation), other-vendor formats (`.cursor/rules`, etc.), glob/directory/URL entries in `instructions[]` (literal file paths only today), and a session-user-scope per-user `instructions` override (definition-scope only today).
10. ~~**Context Handoff Phase B**~~ — **cancelled.** Its two contents were auto-fire and a shell-script distillation handler. Auto-fire shipped as [Compaction](#compaction)'s worker-level toggle; the script handler was never separately requested and is not carried forward, since the whole mechanism it would have overridden is now engine-internal on one engine and the SDK's own on the other. The prompt-file override survives as the compaction prompt loader.

## Cross-references

- [Session & Worker Design](session-worker-design.md) -- Worker type union, the non-PTY worker precedent (`GitDiffWorker`), and the "Adding New Worker Types" extension steps this design follows.
- [Custom Agent Registration Design](custom-agent-design.md) -- the existing **terminal-based** custom-agent path (template + PTY spawn). The embedded agent worker is a distinct execution model, not a variant of that template mechanism.
- [WebSocket Protocol](websocket-protocol.md) -- the worker channel; embedded-agent reuses the byte-offset/epoch framing with NDJSON content (see [WebSocket & client protocol](#websocket--client-protocol)).
- [`elevation-helpers.md`](../../.claude/rules/elevation-helpers.md) -- the `spawnAsUser` contract and consumer obligations this design depends on.
- [`os-environment-coupling.md`](../../.claude/rules/os-environment-coupling.md) -- real-machine smoke-test discipline; the v1 smoke script is specified in [Testing plan](#testing-plan).
- Issue [#878](https://github.com/ms2sato/agent-console/issues/878) -- MCP caller identity; phase 1 designed in [MCP caller identity](#mcp-caller-identity-issue-878-phase-1).
- Issue [#1004](https://github.com/ms2sato/agent-console/issues/1004) -- umbrella tracking Phases 0a-4 plus the post-v1 fast-follows below.
- Issue [#1107](https://github.com/ms2sato/agent-console/issues/1107) -- restoring the multi-user `enforce` default (reverted to `warn` in Sprint 2026-07-16). Its `headersHelper` functional-dogfood prerequisite (re-scoped out of the #1004 Completion checklist) was completed 2026-08-03. Must land AFTER Issue #1269 (see [Transport-level authN gate](#transport-level-authn-gate-issue-1269)) -- promoting `enforce` to the default before #1269 would have promoted a near-vacuous protection.
- Issue [#1269](https://github.com/ms2sato/agent-console/issues/1269) -- MCP transport-level authN gate; 17 of 22 tools were structurally unreachable by any auth mechanism before this fix. Designed in [Transport-level authN gate](#transport-level-authn-gate-issue-1269).
- Issues [#1042](https://github.com/ms2sato/agent-console/issues/1042) (FF-1a), [#1043](https://github.com/ms2sato/agent-console/issues/1043) (FF-1b), [#1044](https://github.com/ms2sato/agent-console/issues/1044) (FF-1c), [#1045](https://github.com/ms2sato/agent-console/issues/1045) (FF-2) -- [Built-in tools](#built-in-tools-fast-follow) fast-follow series.
- Issue [#1122](https://github.com/ms2sato/agent-console/issues/1122) -- Context Handoff Phase A. **Retired** by owner decision 2026-08-28 and replaced by [Compaction](#compaction) (Issue [#1401](https://github.com/ms2sato/agent-console/issues/1401)); Issue [#1206](https://github.com/ms2sato/agent-console/issues/1206), which redesigned its CTA, is moot.
- Issue [#1123](https://github.com/ms2sato/agent-console/issues/1123) -- Transcript Restore across worker/server restart, designed (Stage a, spec-only) in [Transcript Restore](#transcript-restore); Stage b (implementation) is a separate PR.
- MCP server implementation: `packages/server/src/mcp/mcp-server.ts`.
- Elevation primitives: `packages/server/src/services/privilege-elevation.ts`.
- Subprocess-management precedent: `packages/server/src/services/interactive-process-manager.ts` (volatile by design; this design combines its mechanics with worker persistence).
- Output-file machinery reused as-is: `packages/server/src/lib/worker-output-file.ts`, `worker-output-manifest.ts`.
- Shared service core: `packages/server/src/app-context.ts`, `packages/server/src/services/`.
- [Agent Surface design](agent-surface.md) -- the cross-surface query layer (`AgentSurface` / `AgentDirectory`) unifying `list_agents` and `delegate_to_worktree`'s agent resolution across this design's `EmbeddedAgentManager` and the terminal-agent `AgentManager`, without merging the two registries (Issue #1160).
