# Glossary

This document defines canonical terminology used throughout the Agent Console project to resolve terminology drift across documentation and codebase.

## Core Architecture

### Agent
A general term for AI-powered tools like Claude Code. See also: [AgentDefinition](#agentdefinition), [AgentWorker](#agentworker).

### AgentDefinition
The stored configuration for an AI agent, including command templates and activity patterns. Referenced by `agentId` in [AgentWorker](#agentworker).
- **Aliases:** Agent configuration, Agent preset
- **See:** [Agent concepts in session-worker-design.md](design/session-worker-design.md#agent-types)

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

### Agent-Owned-Loop Worker
**Designed, not yet implemented** (worker type literal: `loop-agent`). A worker type whose agent LLM loop is written and owned by Agent Console itself, instead of running a fixed external terminal program. The loop runs as a per-user subprocess (spawned via `spawnAsUser`), streams NDJSON structured events (text / tool call / tool result / activity state) over stdout rather than terminal bytes, and calls the built-in MCP server for app operations like today's terminal agents. Targets OpenAI-compatible API endpoints and local LLMs; complements (does not replace) the PTY-backed [AgentWorker](#agentworker). Configured by a [LoopAgentDefinition](#loopagentdefinition), not an [AgentDefinition](#agentdefinition).
- **Aliases:** loop-agent worker, LoopAgentWorker, in-process agent (historical framing, superseded — the chosen design is a subprocess, not in-process)
- **See:** [Agent-Owned-Loop Worker design](design/agent-owned-loop-worker.md)

### LoopAgentDefinition
**Designed, not yet implemented.** The registration record for an [Agent-Owned-Loop Worker](#agent-owned-loop-worker)'s model configuration: provider base URL (OpenAI-compatible), model id, optional provider-key reference, optional system prompt, and a per-turn tool-iteration cap. Deliberately a separate registry from [AgentDefinition](#agentdefinition) (which describes how to launch a *terminal program*); the two id namespaces never mix (`LoopAgentWorker.loopAgentId` vs `AgentWorker.agentId`).
- **See:** [Loop agent registry in agent-owned-loop-worker.md](design/agent-owned-loop-worker.md#loop-agent-registry-loopagentdefinition)

### MCP Caller Token
**Designed, not yet implemented** (Issue #878 phase 1). A per-worker bearer token minted by the server at worker activation and verified by the `/mcp` endpoint, binding MCP tool calls to a verified `{sessionId, workerId, userId}` identity instead of trusting caller-supplied session ids. Delivered to loop-agent workers inside the stdin `init` message (never argv/env, which leak across user boundaries under elevated spawns); terminal-agent delivery is specified but enforcement defaults to `warn` until it lands.
- **See:** [MCP caller identity in agent-owned-loop-worker.md](design/agent-owned-loop-worker.md#mcp-caller-identity-issue-878-phase-1); Issue [#878](https://github.com/ms2sato/agent-console/issues/878)

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
- **See:** Issue [#837](https://github.com/ms2sato/agent-console/issues/837) (privilege-elevation umbrella), [`packages/server/src/services/privilege-elevation.ts`](../packages/server/src/services/privilege-elevation.ts) — exposes `runAsUser` / `spawnAsUser` / `rmRecursiveAsUser` (the canonical elevated-recursive-removal helper). The strict-thin-wrapper family also includes domain-level runners that compose `runAsUser` plus caller semantics: [`packages/server/src/services/github-cli.ts`](../packages/server/src/services/github-cli.ts)'s `runGh` (gh-CLI-specific; throws on non-zero exit / timeout — lives in `services/` rather than `privilege-elevation.ts` per [Elevation Helpers rule](../.claude/rules/elevation-helpers.md) because it adds semantic layering). Identity-resolution helpers live alongside in [`packages/server/src/services/resolve-spawn-username.ts`](../packages/server/src/services/resolve-spawn-username.ts) (`resolveSpawnUsername` / `resolveRequestUsername` — see the bullet pair above). Issues [#879](https://github.com/ms2sato/agent-console/issues/879) and [#886](https://github.com/ms2sato/agent-console/issues/886). PRs #843 / #856 / #877 / #880 / #881 / #888 / #889 / #892 for individual consumer migrations and resolver / runner extractions

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