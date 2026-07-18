# Glossary

This document defines canonical terminology used throughout the Agent Console project to resolve terminology drift across documentation and codebase.

## Core Architecture

### Agent
A general term for AI-powered tools like Claude Code. See also: [AgentDefinition](#agentdefinition), [AgentWorker](#agentworker).

### AgentDefinition
The stored configuration for an AI agent, including command templates and activity patterns. Referenced by `agentId` in [AgentWorker](#agentworker).
- **Aliases:** Agent configuration, Agent preset
- **See:** [Agent concepts in session-worker-design.md](design/session-worker-design.md#agent-types)

### AgentKind
**Implemented (Issue #1160 PR-A).** The discriminator `'terminal' | 'embedded'` distinguishing which registry an agent entry belongs to. Single writer: the `AGENT_KINDS` constant in [agent-surface.ts](../packages/shared/src/types/agent-surface.ts); every consumer derives from it or the `AgentKind` type rather than hardcoding the union. Does not merge [AgentDefinition](#agentdefinition) and [EmbeddedAgentDefinition](#embeddedagentdefinition) — the two registries stay separate; `AgentKind` only tags which one a given [AgentDirectoryEntry](#agentdirectoryentry) came from.
- **See:** [Agent Surface design](design/agent-surface.md)

### AgentDirectoryEntry
**Implemented (Issue #1160 PR-A).** A kind-tagged union `{ kind: 'terminal'; agent: AgentDefinition } | { kind: 'embedded'; agent: EmbeddedAgentDefinition }` returned by [AgentSurface](#agentsurface) and [AgentDirectory](#agentdirectory). Full-fidelity (not a lossy summary projection) — consumers narrow on `kind` via an exhaustive switch/if-else to recover the concrete `AgentDefinition` or `EmbeddedAgentDefinition`.
- **See:** [Agent Surface design](design/agent-surface.md)

### AgentSurface
**Implemented (Issue #1160 PR-A).** A per-registry query interface (`list` / `get` / `findByName`, generic over [AgentKind](#agentkind)) implemented by both `AgentManager` (`AgentSurface<'terminal'>`) and `EmbeddedAgentManager` (`AgentSurface<'embedded'>`). Read-only query surface; does not add CRUD or lifecycle methods beyond what each manager already exposes.
- **See:** [Agent Surface design](design/agent-surface.md)

### AgentDirectory
**Implemented (Issue #1160 PR-A).** A stateless, policy-free composite (`packages/server/src/services/agent-directory.ts`) over the `terminal` and `embedded` [AgentSurface](#agentsurface) registries. Provides `listAll()` (used by the MCP `list_agents` tool) and `resolve({ agentId?, agentName? })` (used by `delegate_to_worktree`'s agent resolver, absorbing the short-term two-registry facade from PR #1165 verbatim — same terminal-first-by-id precedence and ambiguity error messages). Owns no lifecycle, no caching, no CRUD; suggestion policy and default-agent policy stay at callers, following the same strict-thin-wrapper discipline as [`privilege-elevation.ts`](../.claude/rules/elevation-helpers.md). Does NOT merge [AgentDefinition](#agentdefinition) and [EmbeddedAgentDefinition](#embeddedagentdefinition) — the two registries remain separate data models with separate id namespaces; `AgentDirectory` only unifies what their consumers can *query*.
- **See:** [Agent Surface design](design/agent-surface.md)

### AgentOperation
**Implemented (Issue #1160 PR-D).** The discriminator naming a cross-surface action performable against "an agent" (`listAgents`, `resolveAgent`, `createSessionWithAgent`, `addWorkerToSession`, `manageDefinitions`). Single writer: the `AGENT_OPERATIONS` constant in [agent-operations.ts](../packages/shared/src/types/agent-operations.ts). Distinct from [AgentKind](#agentkind): `AgentKind` tags which registry an agent belongs to; `AgentOperation` names what a consumer surface (UI / MCP / embedded-visible) can do to an agent. Each surface owns an exposure table typed `satisfies Record<AgentOperation, SurfaceExposure>`, so adding a new operation is a compile error in every table until it records an explicit exposed/not-exposed decision.
- **See:** [Agent Surface design](design/agent-surface.md) Mechanism 3

### SurfaceExposure
**Implemented (Issue #1160 PR-D).** The value type of an exposure-table entry: `{ exposed: true; via: string } | { exposed: false; reason: string }`. `via` names a human-locatable entry point (a component, a page, an MCP tool name); `reason` is the rationale for an intentional omission. Defined alongside [AgentOperation](#agentoperation) in `agent-operations.ts`.
- **See:** [Agent Surface design](design/agent-surface.md) Mechanism 3

### Repository
A registered Git repository available for session creation. Code reference: `repositoryId` (UUID).
- **See:** [Core concepts in session-worker-design.md](design/session-worker-design.md#key-concepts)

### Clone Job
An asynchronous server-side job that clones a remote Git URL into the shared [source-repos directory](#source-repos-directory) and registers the result as a [Repository](#repository) (Issue [#834](https://github.com/ms2sato/agent-console/issues/834)). The HTTP endpoint `POST /api/repositories/clone` returns `202 Accepted` with a `jobId`; the client polls `GET /api/repositories/clone/:jobId` for status (`pending` / `cloning` / `succeeded` / `failed`). On failure, a classified `CloneErrorCode` (`auth_failed` / `network_error` / `repo_not_found` / `permission_denied` / `name_conflict` / `timeout` / `validation_error` / `unknown`) lets the UI render actionable copy. In multi-user mode, the clone subprocess runs as the requesting user via the privilege-elevation pattern ([Issue #837](https://github.com/ms2sato/agent-console/issues/837)).
- **Aliases:** clone-and-register job
- **See:** `packages/shared/src/schemas/repository.ts` (`CloneRepositoryRequestSchema`, `CloneJobStatusResponse`)

### Session
A work session tied to a directory location, containing one or more workers.
- **Aliases:** Work session
- **See:** [Core concepts in session-worker-design.md](design/session-worker-design.md#key-concepts)

### Worker
A work unit within a session (agent, terminal, diff viewer, etc.).
- **See:** [Core concepts in session-worker-design.md](design/session-worker-design.md#key-concepts)

### Worktree
A Git worktree representing a physical working directory.
- **See:** [Core concepts in session-worker-design.md](design/session-worker-design.md#key-concepts)

## Session Types

### PersonalSession
A session created and owned by an authenticated user, running with that user's OS identity.
- **Contrast:** [SharedSession](#sharedsession)
- **See:** [Multi-user terminology in multi-user-shared-setup.md](design/multi-user-shared-setup.md#terminology)

### QuickSession
A session tied only to a directory path, without repository or worktree management.
- **Contrast:** [WorktreeSession](#worktreesession)
- **See:** [Session types in session-worker-design.md](design/session-worker-design.md#session-types)

### SharedSession
A session running under a shared account OS identity, accessible to all authenticated users.
- **Contrast:** [PersonalSession](#personalsession)
- **Identifier:** `Session.isShared: boolean` (boolean discriminator on the wire, server-derived via `SharedAccountRegistry.isSharedUserId(createdBy)`)
- **See:** [Terminology in shared-orchestrator-session.md](design/shared-orchestrator-session.md#terminology)

### WorktreeSession
A session tied to a repository and worktree, with branch management features.
- **Contrast:** [QuickSession](#quicksession)
- **See:** [Session types in session-worker-design.md](design/session-worker-design.md#session-types)

## Worker Types

### AgentWorker
A worker running an AI agent with activity detection and PTY capabilities.
- **See:** [Worker types in session-worker-design.md](design/session-worker-design.md#worker-types-current--future)

### TerminalWorker
A worker running a plain terminal shell.
- **See:** [Worker types in session-worker-design.md](design/session-worker-design.md#worker-types-current--future)

### GitDiffWorker
A worker that shows the git diff between a base commit and a target ref for its session's working directory. Has no PTY; computes diffs on demand and watches the working tree for changes.
- **Aliases:** DiffWorker, git-diff worker
- **See:** [GitDiffWorker in worker.ts](../packages/shared/src/types/worker.ts)

### PTY-backed Worker
A capability grouping over the concrete worker types: a worker backed by a PTY process — currently the `agent` and `terminal` types — able to receive injected input and `[internal:*]` PTY notifications. The canonical single-writer predicates `isPtyBackedWorker` / `canReceiveSessionMessages` in [worker.ts](../packages/shared/src/types/worker.ts) codify this capability; MCP tools (`send_session_message`, `create_timer`, `create_conditional_wakeup`, `run_process`) guard on these predicates instead of per-type negations. [GitDiffWorker](#gitdiffworker) is not PTY-backed; [EmbeddedAgentWorker](#embeddedagentworker) is not PTY-backed either (it streams NDJSON over stdout rather than terminal bytes — a v1 decision in the design doc).
- **Aliases:** PTY-backed worker
- **See:** [Capability predicates in worker.ts](../packages/shared/src/types/worker.ts); [MCP tool surface: capability predicates in embedded-agent-worker.md](design/embedded-agent-worker.md#mcp-tool-surface-capability-predicates-not-per-type-branches)

### EmbeddedAgentWorker
**Implemented for v1, including multi-user support** (Phases 1–4 landed: shared types, wire schema, persistence, registry + REST; the agent subprocess `packages/embedded-agent` and its server-side `EmbeddedAgentWorkerService`; WebSocket routing (`isStreamWorker`-gated `attachWorkerCallbacks`/`detachWorkerCallbacks`, the `embedded-agent` branch in `websocket/routes.ts`); the chat UI `EmbeddedAgentWorkerView` and the unified agent-selection picker; the multi-user elevation real-machine smoke (`scripts/smoke/check-embedded-agent-elevation.ts`), and terminal-agent MCP token-file delivery; the multi-user `enforce` default flip landed in Phase 4 but was reverted to `warn` for all modes in Sprint 2026-07-16 — see [MCP Caller Token](#mcp-caller-token) and Issue #1107). Phase 3.5 (EmbeddedAgentDefinition management UI, tracked separately as Issue #1029) is presentation-layer only and does not gate multi-user support** (worker type literal: `embedded-agent`). A worker type whose agent LLM loop is written and owned by Agent Console itself, instead of running a fixed external terminal program — "embedded" in the *embedded database* sense (SQLite vs a DB server): the app runs the capability within itself rather than delegating to an external program. The loop runs as a per-user subprocess (spawned via `spawnAsUser`), streams NDJSON-structured events (text / tool-call / tool-result / activity-state) over stdout rather than terminal bytes, and calls the built-in MCP server for app operations like today's terminal agents. Targets OpenAI-compatible API endpoints and local LLMs; complements (does not replace) the PTY-backed [AgentWorker](#agentworker). Configured by an [EmbeddedAgentDefinition](#embeddedagentdefinition), not an [AgentDefinition](#agentdefinition).
- **Aliases:** embedded agent worker, agent-owned-loop worker (former working name), loop-agent (former literal), in-process agent (historical framing, superseded — the chosen design is a subprocess, not in-process)
- **See:** [Embedded Agent Worker design](design/embedded-agent-worker.md)

### EmbeddedAgentDefinition
**Implemented** (type in [embedded-agent.ts](../packages/shared/src/types/embedded-agent.ts); registry `EmbeddedAgentManager` with REST CRUD under `/api/embedded-agents`; DB table `embedded_agents`). The registration record for an [EmbeddedAgentWorker](#embeddedagentworker)'s model configuration: provider base URL (OpenAI-compatible), model id, optional provider-key reference, optional system prompt, a per-turn tool-iteration cap, and (FF-1a, Issue #1042) an `enabledTools` policy — see [Builtin Tool (embedded-agent)](#builtin-tool-embedded-agent). Deliberately a separate registry from [AgentDefinition](#agentdefinition) (which describes how to launch a *terminal program*); the two id namespaces never mix (`EmbeddedAgentWorker.embeddedAgentId` vs `AgentWorker.agentId`).
- **Aliases:** LoopAgentDefinition (former working name)
- **See:** [Embedded agent registry in embedded-agent-worker.md](design/embedded-agent-worker.md#embedded-agent-registry-embeddedagentdefinition)

### Builtin Tool (embedded-agent)
**Implemented (FF-1a, Issue #1042; FF-1b, Issue #1043; FF-1c, Issue #1044)** (`Read`/`Glob`/`Grep` land in FF-1a; `Bash` in FF-1b; `Write`/`Edit` in FF-1c). A tool executed *inside* the [EmbeddedAgentWorker](#embeddedagentworker)'s own subprocess (`packages/embedded-agent/src/tools/`), as opposed to an MCP tool proxied through the MCP server — matching how Claude Code / opencode implement their own file/shell tools rather than putting them on a tool-call RPC surface. Tool names and argument shapes match Claude Code's own tools. Which builtin tools a given [EmbeddedAgentDefinition](#embeddedagentdefinition) exposes to the provider is governed by its `enabledTools?: EmbeddedAgentToolName[]` field (`EmbeddedAgentToolName` derived from the single-writer constant `EMBEDDED_AGENT_TOOL_NAMES`): `undefined` = the loop's own default (`Read`, `Glob`, `Grep` on, `Bash`/`Write`/`Edit` off), `[]` = all off, an explicit array = exactly that set (an excluded tool is not represented in the provider's tools list at all, not merely rejected if called). At `init` the loop merges its resolved builtin tools with the MCP-listed tools (`CompositeToolExecutor`); on a name collision the builtin wins. All builtin tools resolve their target path through path confinement (`resolveConfinedPath`) before touching the filesystem — a process-boundary floor (not OS-level sandboxing) that rejects any path resolving outside the session's `locationPath`, including via a symlink. `Bash` additionally spawns via `node:child_process` with `detached: true` so a timeout can kill the whole process group, and strips `AGENT_CONSOLE_*`-prefixed env vars before spawning (`env-cleaner.ts`'s `buildBashEnv`). `Write`/`Edit` share an `atomicWrite` helper (`packages/embedded-agent/src/tools/atomic-write.ts`) that writes to a same-directory temp file then renames it onto the target, so a crash mid-write never leaves a partial file; `Edit` matches `old_string` byte-exactly (no regex, no whitespace/CRLF normalization) and rejects zero-match, ambiguous multi-match (without `replace_all`), and no-op (`old_string === new_string`) calls — see [Built-in tools (fast-follow)](design/embedded-agent-worker.md#built-in-tools-fast-follow) for the full spec.
- **See:** [Built-in tools (fast-follow) in embedded-agent-worker.md](design/embedded-agent-worker.md#built-in-tools-fast-follow)

### Reasoning/Thinking Content (embedded-agent)
**Implemented, backend and client (Issue #1070).** LLM reasoning/thinking output some OpenAI-Chat-Completions-compatible providers stream separately from the final answer text (DeepSeek-R1 API, many vLLM reasoning-parser configs, OpenRouter passthrough, some Ollama models), via a `choice.delta.reasoning_content` string field alongside (not instead of) `content`. `OpenAIChatAdapter` yields it as a `{ type: 'reasoning-delta' }` `ProviderEvent`; the [EmbeddedAgentWorker](#embeddedagentworker) loop maps it 1:1 onto the wire-level `assistant-thinking-delta` `EmbeddedAgentEvent`, interleaved with `assistant-delta`. It is never accumulated into the final `assistant-message` text and has no terminal/final event of its own — the iteration's unconditional `assistant-message` emit is the implicit boundary a client uses to know a thinking segment has ended (the client also defensively closes an open thinking entry on `turn-error`/`fatal`/`exited`, for the case where no `assistant-message` ever arrives for that turn). Client-side, `embedded-agent-store.ts` folds the delta stream into a dedicated `assistant-thinking` chat-entry kind (accumulate-then-finalize, same replace-not-mutate discipline as `assistant-message`), and `EmbeddedAgentWorkerView.tsx` renders it as a collapsed-by-default `<details>`/`<summary>` accordion (plain text, not Markdown), visually muted relative to the main assistant bubble.
- **See:** [The loop's turn cycle in embedded-agent-worker.md](design/embedded-agent-worker.md#the-loops-turn-cycle); [Provider adapter & tool-call normalization in embedded-agent-worker.md](design/embedded-agent-worker.md#provider-adapter--tool-call-normalization)

### Initial Prompt (Session) — `initialPrompt`, `initialPromptDelivered`
**Implemented (Issue #1068; eligibility marker persisted per Issue #1074).** A user-supplied first message attached to a `Session` at creation time, delivered as the session's initial [EmbeddedAgentWorker](#embeddedagentworker)'s first user message rather than left for the user to retype after the worker connects. `EmbeddedAgentWorkerService.maybeDeliverInitialPrompt` runs when that worker first reports `ready`, and flips `Session.initialPromptDelivered` `undefined → true` via a durable write to the `sessions.initial_prompt_delivered` column (nullable `INTEGER` 0/1, migration v24). Delivery is single-shot per session: the persisted flag gates re-delivery, so a server restart followed by re-activation does not re-send it. A send failure leaves the flag `undefined` so a later activation can retry. Eligibility is scoped to the session's initial embedded-agent worker only — a worker added later via the generic add-worker route does not receive it — via the `InternalEmbeddedAgentWorker.deliverInitialPromptOnActivation` marker, durably persisted to the `workers.deliver_initial_prompt_on_activation` column (nullable `INTEGER` 0/1, migration v26) so the eligibility survives a server restart that happens before the worker's first activation.
- **See:** [Initial prompt delivery in embedded-agent-worker.md](design/embedded-agent-worker.md#initial-prompt-delivery-issue-1068)

### clientMessageId
**Implemented (Issue #1117).** An optional, client-generated correlation id attached to an [EmbeddedAgentWorker](#embeddedagentworker) `embedded-user-message` send (`WorkerClientMessage`, `packages/shared/src/types/session.ts`) and echoed back verbatim on the corresponding persisted `user-message` `EmbeddedAgentServerEvent` (`packages/shared/src/types/embedded-agent.ts` and its `EmbeddedAgentServerEventSchema`). Exists to let a client's `sendUserMessage` pending-promise resolve only on ITS OWN echo, not on any `user-message` event — without it, the same worker open in two tabs/clients could have one tab's pending send falsely resolved by the other tab's accepted send. Generated via `crypto.randomUUID()` in `embedded-agent-store.ts`; capped at 64 characters and type-checked server-side (`packages/server/src/websocket/routes.ts`, `EMBEDDED_CLIENT_MESSAGE_ID_MAX_LENGTH`) before being persisted. Deliberately decoupled from the server-assigned `user-message.id` (which feeds the client's chat-entry key, `user-${id}`) so a client-supplied value can never collide with or pollute that key. The loop's stdin protocol (`EmbeddedAgentCommand`) is unaffected — correlation is strictly client↔server.
- **Aliases:** correlation id (informal)
- **Contrast:** `user-message.id` (server-assigned, feeds the chat-entry React key; never client-supplied)
- **See:** [Embedded Agent Worker design](design/embedded-agent-worker.md) "WebSocket & client protocol"

### AGENTS.md / Instruction Loader
**Implemented** (Issue #1072). The [EmbeddedAgentWorker](#embeddedagentworker) loop's instruction-file discovery, run once per activation and injected into the system prompt between the context preamble and `EmbeddedAgentDefinition.systemPrompt`. Discovery spans three layers, concatenated in order: **global** (`~/.config/agent-console/AGENTS.md`, honoring `XDG_CONFIG_HOME`), **chain** (every directory from the git root down to `cwd`, root-to-cwd order — reduces to `[cwd]` outside a git repository; root detection accepts `.git` as either a directory or a worktree gitfile), and **`instructions[]`** (`EmbeddedAgentDefinition.instructions?: string[]`, an opt-in explicit file list, opencode-shaped). Within the global and chain layers, each directory applies AGENTS.md-canonical / CLAUDE.md-fallback: `AGENTS.md` wins when both are present (debug-logged, not warn — a normal state); neither present is silently skipped (the routine case for most directories). Each `instructions[]` entry is resolved relative to the session's `locationPath` through `resolveConfinedPath` — the same confinement helper builtin tools use — so a definition authored by a different party than the executing user cannot read outside the session's working tree; escape attempts are skipped and warn-logged, never fatal. Per-file content is capped at 16 KiB; the aggregate of all discovered/opt-in segments (excluding `systemPrompt`, which is operator configuration) is capped at 48 KiB, with whole-segment overflow-dropping from the general side first (global, then chain root-to-leaf, then `instructions[]` last-entry-backward) until back under the cap — no in-prompt trace of what was dropped, only a warn log per drop. Instructions are read once at activation and cached for the worker's lifetime; a restart re-reads.
- **See:** [AGENTS.md loader in embedded-agent-worker.md](design/embedded-agent-worker.md#agentsmd-loader); [Post-v1 fast-follows](design/embedded-agent-worker.md#post-v1-fast-follows)

### MCP Caller Token
**Implemented** (Issue #878 phase 1, completed through Phase 4). A per-worker bearer token verified by the `/mcp` endpoint, binding MCP tool calls to a verified `{sessionId, workerId, userId}` identity instead of trusting caller-supplied session ids. Phase 1 implements the in-memory registry, `/mcp` bearer verification, and the `checkCallerOwnsSession` ownership-enforcement wiring at the elevation-bearing tools (`delegate_to_worktree`, `remove_worktree`, `run_process`, `create_conditional_wakeup`) plus `send_session_message`. Phase 2 added minting and delivery for embedded-agent workers: `EmbeddedAgentWorkerService` mints a token at activation (failing activation when the session has no `createdBy` — a mint from an ownerless session would produce an identity that `checkCallerOwnsSession` always rejects), delivers it inside the stdin `init` message, and revokes it on subprocess exit. Phase 4 added minting and delivery for terminal-agent workers: in multi-user mode, the server mints a token, writes it to a user-owned `0600` file at `<homeDir>/.agent-console/mcp-tokens/<workerId>.token`, and passes only the file path via the `AGENT_CONSOLE_MCP_TOKEN_FILE` env var — never the raw token via argv, env-under-elevation, or PTY injection, all of which leak into world-readable or persisted-and-broadcast channels; the file is deleted on the same worker exit/kill/delete events that revoke the in-memory token. A presented-but-mismatched token is always rejected; tokenless calls are logged-and-allowed under `warn` and rejected under `enforce`. Phase 4 made `enforce` the multi-user default, but Sprint 2026-07-16 reverted the default to `warn` for every `AUTH_MODE` (including multi-user): the deployment is a team-of-trust and the ops cost of `enforce` (existing-session token re-delivery, Claude Code `headersHelper` per-OS-user wiring, full dogfood) outweighed the safety benefit at the time. `warn` still logs tokenless callers for observability. An operator can still opt into `enforce` explicitly via `AGENT_CONSOLE_MCP_AUTH=enforce`; restoring `enforce` as the multi-user default is tracked in Issue [#1107](https://github.com/ms2sato/agent-console/issues/1107).
- **Key code:** `McpCallerIdentity` / `McpTokenRegistry` / `checkCallerOwnsSession` in [mcp-auth.ts](../packages/server/src/mcp/mcp-auth.ts); `writeUserOwnedSecretFile` in [privilege-elevation.ts](../packages/server/src/services/privilege-elevation.ts); mode env var `AGENT_CONSOLE_MCP_AUTH` (values `off | warn | enforce`; default `warn` for every `AUTH_MODE` since Sprint 2026-07-16, see Issue #1107).
- **See:** [MCP caller identity in embedded-agent-worker.md](design/embedded-agent-worker.md#mcp-caller-identity-issue-878-phase-1); Issue [#878](https://github.com/ms2sato/agent-console/issues/878)

### Context Handoff
**Implemented, Phase A only (Issue #1122).** A manually-triggered mechanism for an [EmbeddedAgentWorker](#embeddedagentworker) to avoid running out of context window mid-lifetime: the loop asks the model to distill the conversation so far into a summary, then atomically seeds a fresh conversation with that summary instead of the raw history. Deliberately NOT Claude Code-style in-place compaction (owner directive: summarizing on the same conversation confuses the model's own context sense) and NOT an archive of the old context (owner directive: the old context is not needed once distilled) — hence a purpose-built event name (`context-handoff`) rather than borrowed harness vocabulary like `PreCompact`. Driven by a new `EmbeddedAgentCommand` (`{ type: 'handoff' }`, client → server → loop stdin, admitted through the same `turnActive` gate as `user-message`) and a new `AgentLoop.handoff()` method (`packages/embedded-agent/src/agent-loop.ts`): loads an operator-overridable distillation prompt (see [Handoff Prompt](#handoff-prompt) below), sends it plus the current conversation as one transient (never persisted-until-success) provider request, and — only on success — emits the `context-handoff` marker event, reassembles the system prompt (picking up AGENTS.md/CLAUDE.md edits made during the worker's lifetime), and atomically replaces the in-memory conversation with `[system, seed-user-message]`. **Failure invariant (the property under test/audit):** every failure path (prompt-load failure, provider failure, cancel) returns before the `context-handoff` marker is emitted, so the conversation is never mutated on failure — the worker stays exactly as usable as after any other failed turn, and retry is just another `handoff` command. Phase A is manual-trigger + an always-visible usage bar only; Phase B (separate Issue, filed after Phase A dogfood) adds hard-threshold auto-fire and a shell-script override handler — `EmbeddedAgentDefinition.handoff.auto` is accepted/persisted in Phase A but not read by any Phase A code path.
- **Aliases:** handoff (informal); NOT an alias of "compaction" or "archive" (explicitly rejected designs, see above)
- **Contrast:** [clientMessageId](#clientmessageid) (a different embedded-agent correlation mechanism, unrelated to context management)
- **See:** [Context Handoff (Phase A) in embedded-agent-worker.md](design/embedded-agent-worker.md#context-handoff-phase-a); Issue [#1122](https://github.com/ms2sato/agent-console/issues/1122)

### Context Usage
**Implemented, Phase A (Issue #1122).** The token-accounting wire event and denominator that back [Context Handoff](#context-handoff)'s always-visible usage bar. `EmbeddedAgentDefinition.contextWindowTokens?: number` is the operator-declared model context window (the ratio's denominator; undefined = raw-token display only, no ratio/color/threshold banners). The loop emits a `context-usage` `EmbeddedAgentEvent` (`{ v: 1; type: 'context-usage'; promptTokens: number; estimated: boolean }`) once per turn conclusion (last-provider-request-wins across a multi-tool-iteration turn — never per iteration, and not emitted at all when a turn's very first provider attempt fails), sourced from the OpenAI-compatible `usage.prompt_tokens` field (`stream_options: { include_usage: true }`) when the provider supplies it (`estimated: false`), falling back to a chars/4 estimate over the conversation when it does not (`estimated: true`). `EmbeddedAgentDefinition.handoff?: { softRatio?: number; hardRatio?: number; auto?: boolean }` (default 0.75/0.90 when unset) drives the client's two independently-tracked threshold banners, each firing at most once per crossing (`prevRatio < threshold <= currentRatio`, treating no-prior-reading as `prevRatio = 0`) — dismissing a banner does not reappear until the ratio drops back below that threshold and re-crosses.
- **Key code:** usage accounting in `AgentLoop`/`OpenAIChatAdapter` (`packages/embedded-agent/src/agent-loop.ts`, `providers/openai-chat-adapter.ts`); threshold-crossing predicate `crossedThreshold` (`packages/client/src/components/workers/context-usage-threshold.ts`); bar rendering `ContextUsageBar.tsx`.
- **See:** [Context Handoff (Phase A) in embedded-agent-worker.md](design/embedded-agent-worker.md#context-handoff-phase-a) "Token accounting" and "UI" subsections.

### Handoff Prompt
**Implemented, Phase A (Issue #1122).** The operator-overridable instruction sent to the model when a [Context Handoff](#context-handoff) fires, asking it to distill the conversation. Loaded fresh on every `handoff` command (not cached at activation, unlike [AGENTS.md / Instruction Loader](#agentsmd--instruction-loader)) by `loadHandoffPrompt` (`packages/embedded-agent/src/handoff-prompt.ts`), via the same 3-layer precedence order as the instruction loader — repo (`<locationPath>/.agent-console/handoff-prompt.md`) → global (`~/.config/agent-console/handoff-prompt.md`) → bundled default — but **override semantics, not concatenation**: the first layer whose file exists and is readable wins outright and the others are never read, unlike AGENTS.md's all-layers-concatenated behavior. Capped at 16 KiB via the shared `truncateToBytes` helper. Distinct from the fixed (never operator-overridable) seed template used to build the fresh conversation's first user message after a successful handoff (`This conversation continues from a previous one. Prior context summary: <distillation>`).
- **Contrast:** [AGENTS.md / Instruction Loader](#agentsmd--instruction-loader) (concatenates all layers, cached at activation; the handoff prompt picks one layer, loaded fresh per trigger)
- **See:** [Context Handoff (Phase A) in embedded-agent-worker.md](design/embedded-agent-worker.md#context-handoff-phase-a) "Handoff prompt loader" subsection.

### Transcript Restore
**Design-first (Issue #1123): Stage a (spec) and Stage b (implementation) have both landed.** Reconstitution of an [EmbeddedAgentWorker](#embeddedagentworker)'s LLM-facing conversation array from its persisted NDJSON output log at activation, replacing v1's unconditional reset (fresh epoch + empty conversation). Un-defers the "restart-resume" deferral recorded in the design doc's Design Decisions (owner directive, 2026-07-15) — closing the UX gap against the terminal worker's `-c` continuation — as a formal policy change, not a re-litigation of the original deferral's reasoning. Reconstruction stops at the most recent [Context Handoff](#context-handoff) marker event (a handoff's deliberate discard of prior context is respected, not resurrected) and applies [Mid-turn Repair](#mid-turn-repair) to heal a conversation whose tail ends mid-tool-call (Tier C, adopted in the same scope as Tier B's context-usage threshold detection). Restore failure falls back to v1's existing reset-and-empty-conversation activation — which is itself destructive (`resetWorkerOutput` deletes the live file, legacy compressed file, and every archived segment) — but best-effort-preserves the pre-reset live file to a single-slot, manifest-invisible `<workerId>.restore-failed.log` diagnostic sidecar first (renamed inside the output-file manager's own exclusive lock, never a bare caller-side rename, to avoid racing a pending flush), so a transient restore failure does not silently discard an otherwise-recoverable conversation. The client learns about a successful restore via a new `restore-info` `WorkerServerMessage` variant (dual-delivered: a fast-path push right after reconstitution, plus authoritative bootstrap re-delivery to every new connection for the incarnation's lifetime) -- see [Transcript Restore in embedded-agent-worker.md](design/embedded-agent-worker.md#transcript-restore) § UI.
- **Contrast:** [Context Handoff](#context-handoff) (acts on a LIVE conversation to avoid running out of context mid-lifetime; Transcript Restore acts on an IDLE/dead conversation to recover it after a restart).
- **See:** [Transcript Restore in embedded-agent-worker.md](design/embedded-agent-worker.md#transcript-restore); Issue [#1123](https://github.com/ms2sato/agent-console/issues/1123)

### Mid-turn Repair
**Generalizes the v1 "Mid-turn abort repair" mechanism** ([The loop's turn cycle](design/embedded-agent-worker.md#the-loops-turn-cycle)) across two call sites as of Issue #1123's [Transcript Restore](#transcript-restore) design: the original runtime site (a live turn aborted by `cancel` or the re-ask cap, operating on the in-memory `conversation` mid-`runTurn`) and the new restore-time site (a persisted log replayed at activation, operating on the reconstructed array before the loop resumes). Both sites push a synthetic `{role:'tool'}` message for every `tool_call_id` left unresponded by its enclosing assistant `tool_calls` entry — the requirement an OpenAI-Chat-Completions-compatible provider imposes before it accepts the next request; without it the provider rejects with 400 and the worker is permanently wedged. The two sites differ in trigger, detection surface (live in-memory array vs. log-derived event pairing), and the synthetic message's `Error: ${reason}` text (`Error: tool call canceled` / `Error: tool call not completed: turn ended after repeated malformed arguments` for the runtime site vs. `Error: tool call not completed: worker restarted before this response was recorded` for the restore site) — both routed through the shared `pushSyntheticToolError` insertion primitive (`packages/embedded-agent/src/tool-call-repair.ts`), which the runtime site's `fillPendingToolResponses` and the restore site's `repairDanglingToolCalls` each call once per unresponded call; the mechanism itself — synthetic tool-role message inserted before anything else touches the conversation — is identical. The client-facing UI transparency note shown on the restore site is separate, human-facing copy, not this internal string.
- **Aliases:** Mid-turn abort repair (the original, runtime-only name, still used for that specific call site)
- **See:** [The loop's turn cycle in embedded-agent-worker.md](design/embedded-agent-worker.md#the-loops-turn-cycle); [Transcript Restore in embedded-agent-worker.md](design/embedded-agent-worker.md#transcript-restore)

### Login-Shell Sentinel
The spawn → gate → inject protocol used to launch an [AgentWorker](#agentworker) PTY through the user's login shell. Instead of running the agent command directly (which skips `.bashrc` / `.profile` and yields an incomplete PATH), the PTY spawns a login shell whose inner command echoes a per-activation random marker (`__AGENT_CONSOLE_READY_<id>`) and then execs an interactive shell. The worker-manager's onData handler **gates** on the marker: all output before it (login-shell init noise) is dropped and never reaches the output buffer, the persisted output file, clients, or the ActivityDetector; detection is chunk-boundary-safe via a bounded carry of the pre-sentinel tail. On detection, the pending agent command is **injected** with `pty.write(command + '\r')`, avoiding shell-quoting double-escapes.

Both spawn routes honor the same protocol: the direct path (`spawnDirectPty`, single-user mode and the multi-user elevation-skip case) wraps the marker in `$SHELL -l -c`, and the elevated path (`MultiUserMode.spawnSudoPty`) emits it from the inner command of the elevation argv (the elevated login shell provides the login init). A route that spawned without emitting the marker would leave the gate closed forever and silently drop all agent worker output.

- **Key code:** `AgentPtySpawnRequest.sentinel` ([user-mode.ts](../packages/server/src/services/user-mode.ts)); `InternalAgentWorker.loginShellSentinel` / `pendingCommand` ([worker-types.ts](../packages/server/src/services/worker-types.ts)); gate + inject in `WorkerManager.setupWorkerEventHandlers` ([worker-manager.ts](../packages/server/src/services/worker-manager.ts))
- **Aliases:** sentinel protocol, login-shell sentinel protocol, readiness sentinel
- **See:** Issue [#999](https://github.com/ms2sato/agent-console/issues/999) (structural enforcement follow-up: sentinel protocol single-writer + spawn-contract conformance suite)

### Base Spec
The persisted comparison base of a [GitDiffWorker](#gitdiffworker), stored in `workers.base_commit`. Unlike a frozen commit hash, a base spec records the user's *intent* and is **re-resolved on every diff computation**, so the diff stays aligned with GitHub's merge-base (three-dot) view as the branch absorbs upstream commits. Forms:
- `merge-base:<ref>` — fork point via `git merge-base <ref> HEAD` (e.g. `merge-base:origin/main`); re-resolves each diff.
- A branch name — re-resolves to the branch tip each diff.
- An explicit commit hash — stays pinned (no re-resolution).
- `reserved:default-fork-point` — sentinel for migrated workers; resolves the repository's default fork point fresh (prefers `origin/<default>`, falls back to local `<default>`, then the first commit). The `reserved:` namespace is illegal in git ref names, so it can never collide with a real branch/tag.

New git-diff workers default to `merge-base:origin/<default>` when the remote default exists, otherwise `merge-base:<default>`.
- **Aliases:** base commit spec
- **See:** [MERGE_BASE_REF_PREFIX / DEFAULT_FORK_POINT_SPEC in git-diff.ts](../packages/shared/src/types/git-diff.ts)

## States

### AgentActivityState
The detected activity state of an agent: 'active', 'idle', 'asking', or 'unknown'.
- **See:** [Agent activity state in session-worker-design.md](design/session-worker-design.md#type-definitions)

### SessionActivationState
Whether a session has active PTY processes: 'running' or 'hibernated'.
- **Aliases:** Activation state
- **See:** [Session activation in session.ts](../packages/shared/src/types/session.ts)

### SessionStatus
The logical status of a session: 'active' or 'inactive'.
- **See:** [Session status in session-worker-design.md](design/session-worker-design.md#type-definitions)

## Multi-User Identity

### assignee
Delegate target user identifier introduced in PR #682 (`delegate_to_worktree.assignee`).
- **Aliases:** target user, caller (used temporarily in the PR #682 draft)
- **See:** [Orchestrator-facing interface in shared-orchestrator-session.md](design/shared-orchestrator-session.md#orchestrator-facing-interface)

### authenticated user
End-user who authenticates to the Agent Console UI.
- **Aliases:** end user, User (capitalised in setup guide)
- **See:** [Multi-user terminology in multi-user-shared-setup.md](design/multi-user-shared-setup.md#terminology)
- **Contrast:** [created_by](#created_by) (PTY OS identity), [initiated_by](#initiated_by) (audit trail)

### created_by
Database field identifying the session owner (whose OS identity runs the PTY process).
- **Aliases:** session owner, session creator, worktree owner (user-facing wording for sidebar display)
- **Contrast:** [initiated_by](#initiated_by)
- **See:** [Session ownership in multi-user-shared-setup.md](design/multi-user-shared-setup.md#user-identity), [createdByUsername](#createdbyusername)

### createdByUsername
Derived `Session` response field carrying the OS username resolved server-side from `created_by` (UUID) via `UserRepository.findById`. Always populated on the wire as either the resolved username (string) or `null` (legacy session with no `created_by`, or deleted user account). Server resolution is gated by a sync in-memory cache (`UsernameLookupService`) primed at lifecycle boundaries (session create / restore / resume / load-from-DB) so per-render `toPublicSession` stays sync without per-render DB I/O. Client uses this to render the "worktree owner" label in the active-sessions sidebar in multi-user mode (Issue [#914](https://github.com/ms2sato/agent-console/issues/914)). Same `derived field on shared type + conditional client render` pattern as Repository's [`clonedSourceRepoPath`](#clonedsourcerepopath).
- **Used by:** `Session` (packages/shared/src/types/session.ts), `SessionConverterService.toPublicSession` / `persistedToPublicSession`, sidebar component (Issue [#914](https://github.com/ms2sato/agent-console/issues/914)).
- **Contrast:** [created_by](#created_by) (UUID, persisted) vs createdByUsername (string, derived, never persisted).

### initiated_by
Database field identifying the authenticated user who actually created the session (audit trail).
- **Contrast:** [created_by](#created_by)  
- **See:** [Schema notes in shared-orchestrator-session.md](design/shared-orchestrator-session.md#schema-notes)

### Service User
The dedicated OS account (typically `agentconsole`) that runs the server process.
- **Aliases:** Server service user, agentconsole service user, server process user
- **See:** [Terminology in multi-user-shared-setup.md](design/multi-user-shared-setup.md#terminology)

### agent-console-users
Shared system group used in multi-user mode (Issue [#830](https://github.com/ms2sato/agent-console/issues/830)) to grant cross-user access to the data root and all worktrees. Every interactive user joins this group; the service user is also a member. Data root and worktrees are owned `<service-user>:agent-console-users` with mode `2775` (setgid + group-writable). The bootstrap script `scripts/setup-multiuser-for-ubuntu.sh` creates and populates the group.
- **See:** [Architecture Decisions in multi-user-shared-setup.md](design/multi-user-shared-setup.md#architecture-decisions)

### source-repos directory
Shared directory under the data root (`${DATA_ROOT}/source-repos` by default, e.g. `/var/lib/agent-console/source-repos`) where operators clone source repositories that multiple OS users will register through Agent Console (Issue [#833](https://github.com/ms2sato/agent-console/issues/833)). Created by `scripts/setup-multiuser-for-ubuntu.sh` Step 5 with owner `<service-user>:agent-console-users` and mode `2775` so any interactive group member can `git clone` into it and the service user can fetch / update refs. Operators clone with `umask 0002` or `--config core.sharedRepository=group` so newly created files preserve group write access. The location is overridable via `--source-repos-dir <path>` or `AGENT_CONSOLE_SOURCE_REPOS_DIR`.
- **Aliases:** shared source-repos directory, source repos dir
- **Contrast:** the worktree subtree `<data-root>/repositories/<org>/<repo>/worktrees/...` is created and managed by agent-console; the source-repos directory is the operator-facing clone target.
- **See:** [Shared source-repos directory in multi-user-setup-guide.md](multi-user-setup-guide.md#shared-source-repos-directory-linux-multi-user)

### clonedSourceRepoPath
Field on the Repository response that carries `repo.path` when the registered path lives under the [source-repos directory](#source-repos-directory) (`getSourceReposDir()`), and `null` otherwise. This is a pure path-containment check, NOT a provenance check: any repository whose registered path falls inside the source-repos prefix surfaces this field as non-null regardless of HOW the directory was created -- via `POST /api/repositories/clone` (Issue [#834](https://github.com/ms2sato/agent-console/issues/834)), via an operator-side `git clone` into the shared directory followed by registration through `POST /api/repositories`, or any other means. The frontend uses this field to decide whether to show the "also remove the cloned source repo" checkbox during unregister (Issue [#905](https://github.com/ms2sato/agent-console/issues/905)). When checked, the body of `DELETE /api/repositories/:id` carries `removeSourceRepo: true` and the server-side CLEANUP_REPOSITORY job removes the source-repo directory via `extraDir` in addition to the main data subtree.
- **Used by:** `Repository` (packages/shared/src/types/repository.ts), `withRepositoryRemote` (server-side derivation against `getSourceReposDir()`), `DELETE /api/repositories/:id` semantics.

### AGENT_CONSOLE_HOME
Environment variable selecting the agent-console data root. Defaults:
- `AUTH_MODE=none` (single-user): `~/.agent-console`.
- `AUTH_MODE=multi-user`: `/var/lib/agent-console` (system-wide, group-traversable).

An explicit value overrides both defaults. The multi-user bootstrap script sets it explicitly on the systemd unit.
- **See:** [Architecture Decisions in multi-user-shared-setup.md](design/multi-user-shared-setup.md#architecture-decisions), [Environment Variables in multi-user-setup-guide.md](multi-user-setup-guide.md#environment-variables)

### Shared Account
A dedicated OS account distinct from service user and individual users, used for shared sessions.
- **Aliases:** Shared session account, shared service account (historical, briefly used in PR #682 draft)
- **Capability flag:** `/api/config.sharedAccountsAvailable: boolean` (server exposes this when `AGENT_CONSOLE_SHARED_USERNAME` resolves to a real OS user; gate for client UI affordance)
- **See:** [Terminology in shared-orchestrator-session.md](design/shared-orchestrator-session.md#terminology)

### requestUsername
The OS username passed as the elevation context for `runAsUser` / `spawnAsUser`-routed operations in multi-user mode. Resolved at the request boundary from either `authUser.username` (for REST routes the user invokes directly, e.g. `DELETE /api/repositories/:id/worktrees/*`) or `session.createdBy → userRepository.findById → osUsername` (for MCP tools acting on behalf of a session, e.g. `delegate_to_worktree`, `remove_worktree`, `run_process`, `create_conditional_wakeup`). When `null` / `undefined` / matches the server process user, elevation is bypassed and operations run as the server user. Threaded through call chains so every step that touches user-owned files (worktree create / remove, rollback paths, hook commands, git operations) executes as the requesting user.

The session-side resolution is encapsulated by one of two sibling helpers in `packages/server/src/services/resolve-spawn-username.ts` with distinct downstream contracts:
- **`resolveSpawnUsername(createdBy, userRepository): Promise<string>`** — always returns a usable username (falls back to the [Service User](#service-user) on miss). For PTY-spawn callers that always pass *something* to `Bun.spawn` / `runAsUser` (e.g. worker lifecycle, session pause/resume).
- **`resolveRequestUsername(createdBy, userRepository, context): Promise<string | null>`** — returns `null` on miss so the explicit "no elevation" signal propagates downstream; `runAsUser` / `spawnAsUser` short-circuit elevation on null/undefined username (`shouldElevateForUser`). For MCP / route callers (`delegate_to_worktree`, `run_process`, `create_conditional_wakeup`). The `context` parameter (`{ toolName: string } & Record<string, unknown>`) shapes the structured warn payload emitted when `createdBy` is set but does not resolve.

- **Aliases:** requestUser (lib/git.ts trailing parameter name), elevation context, request username
- **Contrast:** [Service User](#service-user) (the OS account the server process runs as — what elevation is FROM, not TO).
- **See:** Issue [#837](https://github.com/ms2sato/agent-console/issues/837) (privilege-elevation umbrella), [`packages/server/src/services/privilege-elevation.ts`](../packages/server/src/services/privilege-elevation.ts) — exposes `runAsUser` / `spawnAsUser` / `rmRecursiveAsUser` (the canonical elevated-recursive-removal helper) / `writeUserOwnedSecretFile` (elevated user-owned secret-file write, forced 0600 regardless of ambient umask; used for the terminal-agent MCP token file, Phase 4). The strict-thin-wrapper family also includes domain-level runners that compose `runAsUser` plus caller semantics: [`packages/server/src/services/github-cli.ts`](../packages/server/src/services/github-cli.ts)'s `runGh` (gh-CLI-specific; throws on non-zero exit / timeout — lives in `services/` rather than `privilege-elevation.ts` per [Elevation Helpers rule](../.claude/rules/elevation-helpers.md) because it adds semantic layering). Identity-resolution helpers live alongside in [`packages/server/src/services/resolve-spawn-username.ts`](../packages/server/src/services/resolve-spawn-username.ts) (`resolveSpawnUsername` / `resolveRequestUsername` — see the bullet pair above). Issues [#879](https://github.com/ms2sato/agent-console/issues/879) and [#886](https://github.com/ms2sato/agent-console/issues/886). PRs #843 / #856 / #877 / #880 / #881 / #888 / #889 / #892 for individual consumer migrations and resolver / runner extractions

## Client Capabilities

### VSCodeOpenMode
Union type controlling how the client opens paths in VS Code from the "Open in VS Code" UI. Determined server-side and delivered to the client via `/api/config.capabilities.vscodeOpenMode`.

- `local-spawn` — the server spawns `code <path>` on its own host via `Bun.spawn`. Suitable for single-machine setups (server and browser run on the same OS). Default when `AUTH_MODE=none`.
- `remote-url-scheme` — the client navigates to `vscode://vscode-remote/ssh-remote+<host><path>`, letting the browser's local VS Code + Remote-SSH extension open the file over SSH. Suitable for remote-access setups (server on a remote host, browser on the user's local machine). Default when `AUTH_MODE=multi-user`.

**Server env overrides:**
- `VSCODE_OPEN_MODE` — explicit `local-spawn` / `remote-url-scheme`; wins over the `AUTH_MODE`-derived default. Invalid values throw at server startup.
- `VSCODE_REMOTE_HOST` — string surfaced on `/api/config.capabilities.vscodeRemoteHost` (null when unset). When null, the client falls back to `window.location.hostname` for host derivation.

**Related capability fields:**
- `capabilities.vscode: boolean` — the button-visibility gate. Unconditionally `true` in `remote-url-scheme` mode (the client's local VS Code handles the URL scheme, so the server's `code` binary presence is irrelevant); in `local-spawn` mode reflects the `which code` / `which code-insiders` detection.
- `capabilities.vscodeRemoteHost: string | null` — the host embedded in the SSH-remote URL when the client dispatches the URL scheme.

**Guardrails:** `POST /api/system/open-in-vscode` rejects (400) in `remote-url-scheme` mode so stale clients cannot silently spawn on the wrong host.

- **Aliases:** vscodeOpenMode (`ConfigResponse` field name), Open-in-VSCode mode
- **See:** Issue [#987](https://github.com/ms2sato/agent-console/issues/987) (introduces the URL-scheme dispatch); [`packages/shared/src/types/auth.ts`](../packages/shared/src/types/auth.ts) (`VSCodeOpenMode`, `ConfigResponse.capabilities`); [`packages/server/src/services/system-capabilities-service.ts`](../packages/server/src/services/system-capabilities-service.ts) (`resolveVSCodeOpenMode`); [`packages/client/src/lib/vscode-url.ts`](../packages/client/src/lib/vscode-url.ts) (`buildVSCodeRemoteUrl`).

### serverPort
The backend HTTP port the server is bound to, exposed to the client so it can compose absolute URLs pointing at the same server without hard-coding a port. Positive integer.

- **Source of truth:** `serverConfig.PORT` (env-configured; string in env, coerced to `Number(...)` at the response boundary; default `3457`).
- **Wire:** `/api/config.serverPort` (`packages/server/src/routes/api.ts`), typed on `ConfigResponse.serverPort` in [`packages/shared/src/types/auth.ts`](../packages/shared/src/types/auth.ts).
- **Consumer:** the client caches the value in [`packages/client/src/lib/server-info.ts`](../packages/client/src/lib/server-info.ts) (module-level `setServerPort` / `getServerPort` set once at app init, mirroring the `homeDir` pattern). Used by [`buildMcpInstallCommand`](../packages/client/src/lib/mcp-install-url.ts) to decide whether the current browser origin is same-origin with the backend (production single-port serving / reverse proxy on default 80/443) or split-port (dev with Vite on 5173 proxying `/api` to backend on `serverPort`); the split case composes `${protocol}//${hostname}:${serverPort}/mcp` so the copied install command targets the backend directly.
- **Related:** [`buildMcpInstallCommand`](../packages/client/src/lib/mcp-install-url.ts), the "Install MCP server in Claude Code" Settings section ([`McpInstallSection`](../packages/client/src/components/settings/McpInstallSection.tsx)).
- **See:** Issue [#991](https://github.com/ms2sato/agent-console/issues/991).

### user-accessible host
The hostname the user's browser can actually reach the server (and its sibling ports) at, derived from `window.location.hostname`. When AgentConsole is accessed remotely, `localhost` / `127.0.0.1` on the server side is meaningless to the browser, so the user-accessible host is used instead.

- **Canonical helpers:** [`getUserAccessibleHost()`](../packages/client/src/lib/user-accessible-host.ts) (returns `window.location.hostname` verbatim), [`isRemoteAccess()`](../packages/client/src/lib/user-accessible-host.ts) (true when the browser is not on a loopback host), and `bracketHostForUrl()` (IPv6 bracket-wrapping when composing a URL authority) in [`packages/client/src/lib/user-accessible-host.ts`](../packages/client/src/lib/user-accessible-host.ts).
- **Consumers:** VSCode remote-URL open ([`openInVSCode`](../packages/client/src/lib/api.ts)), MCP install-command composition ([`buildMcpInstallCommand`](../packages/client/src/lib/mcp-install-url.ts)), and terminal localhost-URL rewrite ([`localhost-rewrite.ts`](../packages/client/src/components/terminal/transforms/localhost-rewrite.ts)), which rewrites a printed `localhost` URL's href to the user-accessible host so a remote browser can click it.
- **See:** Issues [#987](https://github.com/ms2sato/agent-console/issues/987) (introduces the browser-host derivation), [#988](https://github.com/ms2sato/agent-console/issues/988) (extracts the helpers and adds the terminal URL rewrite).

## Events & Communication

### ConditionalWakeup
A registered shell-condition + interval that the server polls silently and notifies the session only when the condition exits 0 or a timeout is reached. Designed to preserve LLM context windows during "wait for X to be true" patterns.
- **Aliases:** wakeup, conditional poll
- **See:** Issue [#700](https://github.com/ms2sato/agent-console/issues/700), MCP tools `create_conditional_wakeup` / `delete_conditional_wakeup`
- **Contrast:** [Timer](#timer) (fires on interval regardless of state)

### Inter-Session Messaging
File-based message delivery channel between sessions. Used by the `send_session_message` MCP tool for explicit cross-session consultations and by `outputMode: "message"` of `run_process` to route long-form script stdout and `write_process_response` content to the receiving session/worker without flooding its PTY.
- **Aliases:** inter-session messaging, inter-session message files, inter-session message service, InterSessionMessageService, inter-session-message-service
- **See:** [Inter-Session Messaging design](design/inter-session-messaging.md), implementation [`packages/server/src/services/inter-session-message-service.ts`](../packages/server/src/services/inter-session-message-service.ts), MCP tool `send_session_message`, [outputMode](#outputmode)

### outputMode
Parameter on the `run_process` MCP tool that selects how the script's stdout and `write_process_response` content are delivered to the calling agent. Two modes:
- `"pty"` (default): the script's stdout is delivered as a `[internal:process]` PTY notification carrying the full content; `write_process_response` echoes content directly to the worker PTY. Existing behavior, backward-compatible with all prior `run_process` callers.
- `"message"`: the script's stdout is captured and routed through [Inter-Session Messaging](#inter-session-messaging) to the calling session/worker; `write_process_response` content is delivered through the same channel after stdin write succeeds. PTY receives only a brief `[stdout via message] path=… bytes=…` / `[response via message] …` notification per chunk so the owner retains progress visibility without the conversation being flooded by long-form Q&A. Designed for long interactive scripts (e.g., `.claude/skills/orchestrator/acceptance-check.js`, `sprint-retro.js`).
- **Aliases:** output mode, run_process outputMode
- **See:** Issue [#664](https://github.com/ms2sato/agent-console/issues/664), router [`packages/server/src/services/process-output-router.ts`](../packages/server/src/services/process-output-router.ts)

### Schema Version
A build-time content hash over the wire-schema file set (`packages/shared/src/schemas/*.ts`) that identifies the generation of the server/client wire contract. Derived by `scripts/generate-schema-version.mjs` into the committed constant `SCHEMA_VERSION` (`packages/shared/src/schema-version.gen.ts`), which is staleness-guarded by a test invoking the script's `--check` mode — no manual bump exists. The server advertises the version as the first frame on `/ws/app` (`{ type: 'schema-version', version }`) and as an `X-Schema-Version` header on every REST response (middleware mounted before auth). The client compares it against its compiled-in constant and force-reloads on mismatch at most once per server version (sessionStorage guard `agent-console:schema-version-reload-attempted`); a mismatch persisting after reload degrades to a manual-refresh error banner instead of looping.
- **Aliases:** SCHEMA_VERSION, X-Schema-Version, schema-version (WS message type)
- **See:** Issue [#927](https://github.com/ms2sato/agent-console/issues/927), [`scripts/generate-schema-version.mjs`](../scripts/generate-schema-version.mjs), [`packages/client/src/lib/schema-version.ts`](../packages/client/src/lib/schema-version.ts), [`packages/server/src/middleware/schema-version-header.ts`](../packages/server/src/middleware/schema-version-header.ts)
- **Contrast:** [WebSocket Connection](#websocket-connection) (the transport itself; the schema version describes the payload contract generation carried over it)

### SystemEvent
The top-level event format representing meaningful occurrences in the system.
- **Aliases:** System-wide event
- **See:** [Event format in system-events.md](design/system-events.md#event-format)

### Timer
A periodic, fixed-interval notification mechanism for sessions. Fires on every interval regardless of state.
- **See:** MCP tools `create_timer` / `delete_timer`
- **Contrast:** [ConditionalWakeup](#conditionalwakeup) (silent until condition true)

### WebSocket Connection
Real-time bidirectional communication channel between client and server.
- **Types:** App Connection (`/ws/app`), Worker Connection (`/ws/session/:id/worker/:id`)
- **See:** [WebSocket protocol in websocket-protocol.md](design/websocket-protocol.md)

### Archive Segment

A gzip-compressed slice of a worker's historical output stream (`<workerId>.seg-<N>.log.gz`), produced when the live output file exceeds its size limit. Replaces destructive truncation. Immutable once written; mapped to absolute stream offsets by the Segment Manifest. Defined in [terminal-history-paging.md](design/terminal-history-paging.md).

### Segment Manifest

Sidecar JSON (`<workerId>.segments.json`) recording each Archive Segment's absolute offset range plus `liveBaseOffset` (the absolute position of the live file's first byte). The single source for mapping a history-range request to a file. Defined in [terminal-history-paging.md](design/terminal-history-paging.md).

### Absolute Stream Offset

The byte position in a worker's cumulative output stream since worker creation (or last restart). Never rebased by archival. After the #959 accounting change, every `offset` on the worker WebSocket protocol uses this coordinate system (previously `history` offsets were live-file-relative and diverged from `output` offsets after truncation). Defined in [terminal-history-paging.md](design/terminal-history-paging.md).

### Worker Epoch

A per-worker incarnation identifier: the creation timestamp (milliseconds) minted when the worker is created or restarted, persisted in the Segment Manifest and carried on `output` / `history` / `history-range` messages. Clients compare epochs for **equality only** (never ordering), so clock regression across restarts is tolerated; a mismatch means the worker was restarted and the client must resync. A timestamp rather than a counter makes reuse impossible even if the manifest is lost. Defined in [terminal-history-paging.md](design/terminal-history-paging.md).

### Backwards Range Fetch

The `request-history-range` / `history-range` worker-WebSocket message pair for paging older history upward. A request names a `beforeOffset` (fetch bytes strictly before this Absolute Stream Offset), an optional `maxBytes` hint, and a `requestId` echoed back for correlation. The server answers with one storage unit's worth of bytes (a single Archive Segment or the live window — never stitched across a boundary), a `hasMore` flag (`startOffset > firstAvailableOffset`), and the Worker Epoch captured under the per-worker lock. Defined in [terminal-history-paging.md](design/terminal-history-paging.md) §5.

## Maintenance

This glossary is canonical. When the following changes are introduced, the glossary must be updated in the same PR:

- New design doc (`docs/design/`) introducing a new domain concept
- New type, DB schema field, or API endpoint name representing a domain concept
- Existing design doc's Terminology section is added, renamed, or revised
- New rule / skill / narrative referring to a project-wide concept

If a term in the codebase or documentation does not appear here, either it is a drift to fix or a missing entry to add — both belong in the same PR that surfaced the gap.

**Responsibility**: PR author owns the glossary update for their PR. Orchestrator confirms during acceptance check via `acceptance-check.js` Q9 (Glossary Integrity).

**Operational rule**: see [`.claude/rules/glossary-maintenance.md`](../.claude/rules/glossary-maintenance.md) for the full trigger list, role assignments, and drift-handling decision tree. Automated linter detection is tracked separately (Issue [#671](https://github.com/ms2sato/agent-console/issues/671)).