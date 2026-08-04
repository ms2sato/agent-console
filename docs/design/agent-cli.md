# Bundled Agent CLI

## Summary

Provide a CLI binary, bundled with the agent-console server deploy, as the primary operation surface for PTY-based agent workers (Claude Code, Codex, Gemini CLI, custom terminal agents). The server injects the CLI onto the worker's `PATH` at PTY spawn time and passes a session-scoped ephemeral token through the environment, so any agent that can run a shell command can operate agent-console with zero client-side configuration. Usage guidance is delivered as an agent skill plus self-describing `--help` output. The existing MCP server stays in place; the CLI and MCP coexist, with the CLI becoming the recommended path for PTY workers.

Embedded-agent workers are out of scope: they already have an in-process tool surface and never needed MCP's process-boundary crossing in the first place.

## Background / Problem

MCP solves a real problem — giving an out-of-process agent a typed tool surface — but it couples that surface to *client-side* configuration: the agent's own MCP registration, connection lifecycle, and per-client protocol support. Three failure classes follow from that coupling, all observed in practice:

1. **Client config drift.** MCP registration in `~/.claude.json` is keyed by project path. A delegated worktree session runs in a path the registration does not cover, so the delegated agent silently has no agent-console tools. This happened during the Issue [#1260](https://github.com/ms2sato/agent-console/issues/1260) investigation: the investigating agent's mandated `send_session_message` callback had no tool to call, and the report had to be delivered by hand-rolling JSON-RPC over HTTP. The server spawned that PTY itself — it had every opportunity to provision the tooling — but MCP's client-side registration model gave it no way to do so.
2. **Per-agent protocol support variance.** Claude Code, Codex, Gemini CLI, and custom agents support MCP to different degrees and with different configuration surfaces. Every supported agent multiplies the configuration matrix. Every agent, however, can execute a command found on `PATH`.
3. **Version skew.** The MCP client configuration and the server evolve independently. A bundled CLI ships in the same deploy artifact as the server it talks to, so the two cannot drift.

`docs/design/embedded-agent-worker.md` ("The core insight: MCP is a consequence of the process boundary") already established that MCP is not the point — it is one mechanism for crossing a process boundary. For embedded agents the boundary disappeared and MCP with it. For PTY agents the boundary is real and stays, but the server controls the child process's environment at spawn time, which is exactly the hook a CLI needs and MCP cannot use.

The precedent is `gh`: a CLI on `PATH` with a token in the environment has proven more robust in agent workflows than the equivalent MCP integration, because there is nothing to configure on the agent side.

## Goals

- PTY agent workers can operate agent-console with **zero client-side configuration**: no MCP registration, no per-project setup, no per-agent support matrix.
- **Session-scoped ephemeral credentials**: each worker gets a token bound to its session identity, revoked when the session ends. No long-lived or account-scoped keys are handed to agents.
- **Agent-agnostic**: works identically for Claude Code, Codex, Gemini CLI, and any custom terminal agent.
- **Full operation parity with the MCP tool surface** from the first release (all 22 tools, see Command Set).
- **Coexistence**: MCP keeps working unchanged. Nothing breaks for existing setups.

## Non-goals

- **Embedded-agent workers.** They call tools in-process (`agent-operations-embedded.ts` exposure surface); the CLI targets the PTY process boundary only.
- **Removing MCP.** Deprecation is a separate, later decision informed by observed usage after the CLI lands.
- **Defending against malicious co-located users.** The multi-user threat model is a single company/team whose members are trusted (see Security & Threat Model). Multi-tenant hardening is explicitly out of scope and this document is the revisit anchor if that assumption ever changes.
- **A new wire protocol.** The CLI is a thin client over the existing HTTP surface; no new server protocol is introduced.

## Terminology

- **Agent CLI** — the bundled binary this document specifies (working name `agent-console`; final name is an open question).
- **Session Token** — the ephemeral credential minted per worker at PTY spawn, carrying the same `{ sessionId, workerId, userId }` identity as the existing MCP Caller Token, and revoked on session teardown.

Both terms are added to `docs/glossary.md` in the same PR as this document.

## Current State Survey

What already exists and is reused:

- **MCP tool surface**: 22 tools registered in `packages/server/src/mcp/mcp-server.ts` (enumerated in Command Set below). Their handlers already validate input, resolve identity via `checkCallerOwnsSession`, and return JSON.
- **Environment injection**: PTY spawn already injects `AGENT_CONSOLE_BASE_URL`, `AGENT_CONSOLE_SESSION_ID`, `AGENT_CONSOLE_WORKER_ID`, `AGENT_CONSOLE_REPOSITORY_ID`, and `AGENT_CONSOLE_PARENT_SESSION_ID` / `AGENT_CONSOLE_PARENT_WORKER_ID` for delegated sessions.
- **Token machinery**: `McpTokenRegistry` (`packages/server/src/mcp/mcp-auth.ts`) mints per-worker bearer tokens with `{ sessionId, workerId, userId }`, and multi-user mode already writes the token to a user-owned `0600` file and injects only the file path via env (`worker-manager.ts`, "MCP caller identity"), keeping the raw secret out of the elevated spawn's argv-visible command string.
- **Surface parity enforcement**: `AGENT_OPERATIONS` (`packages/shared/src/types/agent-operations.ts`) with per-surface exposure tables typed `satisfies Record<AgentOperation, SurfaceExposure>` (UI / MCP / embedded-visible), per `docs/design/agent-surface.md` Mechanism 3.

## Design

### CLI shape and distribution

- A single executable bundled into the server deploy artifact (same build pipeline that bundles the server and the embedded-agent entry; see PR [#1256](https://github.com/ms2sato/agent-console/pull/1256) for the embedded-agent precedent).
- The server injects the CLI's directory onto `PATH` (or injects an absolute-path env var; see OS Environment Coupling) when spawning PTY workers. Nothing is installed into the user's shell profile; a terminal outside agent-console does not see the CLI unless the operator installs it deliberately.
- The CLI reads its connection parameters exclusively from the environment (`AGENT_CONSOLE_BASE_URL`, identity vars, token) — no config file, no flags required for the common case. Explicit flags override env for debugging.

### Command set

Grouped noun–verb subcommands, mapped 1:1 from the MCP tools. All 22 ship in the first release.

| MCP tool | CLI command |
|---|---|
| `list_agents` | `agent-console agents list` |
| `restart_all_agents` | `agent-console agents restart-all` |
| `list_repositories` | `agent-console repos list` |
| `update_repository` | `agent-console repos update` |
| `list_sessions` | `agent-console sessions list` |
| `get_session_status` | `agent-console sessions status` |
| `send_session_message` | `agent-console sessions send` |
| `close_session` | `agent-console sessions close` |
| `write_memo` | `agent-console sessions memo` |
| `delegate_to_worktree` | `agent-console delegate` |
| `remove_worktree` | `agent-console worktrees remove` |
| `create_timer` | `agent-console timers create` |
| `delete_timer` | `agent-console timers delete` |
| `list_timers` | `agent-console timers list` |
| `create_conditional_wakeup` | `agent-console wakeups create` |
| `delete_conditional_wakeup` | `agent-console wakeups delete` |
| `run_process` | `agent-console proc run` |
| `write_process_response` | `agent-console proc write` |
| `kill_process` | `agent-console proc kill` |
| `list_processes` | `agent-console proc list` |
| `write_review_annotations` | `agent-console review annotate` |
| `clear_review_annotations` | `agent-console review clear` |

Notes:

- `delegate` is top-level (not under a noun) because it is the highest-frequency cross-session operation and the one whose ergonomics matter most in callback instructions.
- `proc run` is kept for parity even though a PTY agent already has a shell: `run_process` provides server-managed lifecycle (survives the agent, elevation to the session owner, later `proc write` / `proc kill` from other sessions), which a plain shell subprocess does not.
- Parameters map from the MCP input schemas to flags (`--repository-id`, `--prompt`, `--branch`, ...). Parameters the CLI can default from the environment are defaulted: e.g. `delegate` defaults `--repository-id` from `AGENT_CONSOLE_REPOSITORY_ID` and `--parent-session-id` / `--parent-worker-id` from the session identity vars — which structurally removes the "parentless embedded delegate" failure mode observed in #1260 verification (the CLI always knows who is calling).

### Transport

The CLI is a thin client over the existing HTTP surface exposed by the server at `AGENT_CONSOLE_BASE_URL`. It reuses the same handler logic the MCP tools call today; where the only existing entry point is the MCP endpoint, the handler is lifted into a shared service function that both the MCP tool and the new HTTP route call (no logic duplication, no behavioral fork). No new protocol, serialization, or transport layer is introduced.

### Authentication

- At PTY spawn, the server mints a **Session Token** via the same registry that backs MCP Caller Tokens: identity `{ sessionId, workerId, userId: session.createdBy }`, revoked on worker/session teardown.
- **Single-user mode**: the raw token is injected directly as `AGENT_CONSOLE_TOKEN`. Environment variables are readable only by same-UID processes, which in single-user mode is the trust boundary anyway.
- **Multi-user mode**: reuse the existing MCP-token file mechanism unchanged — token written to a user-owned `0600` file, `AGENT_CONSOLE_TOKEN_FILE` carries the path. This keeps the raw secret out of the elevated spawn's inner command string, which is argv-visible to other local users (`/proc/<pid>/cmdline`); a file path is not a secret.
- The CLI resolves the token as: `AGENT_CONSOLE_TOKEN` if set, else read `AGENT_CONSOLE_TOKEN_FILE`, else fail with a message naming both variables.
- Sessions without `createdBy` cannot mint a token (same constraint as the embedded-agent MCP identity). For PTY workers this degrades exactly as today's MCP mint skip does: the worker starts, and unauthenticated CLI calls are subject to the server's `AGENT_CONSOLE_MCP_AUTH` mode (`warn` logs, `enforce` rejects).
- Baseline lifetime is the session lifetime (parity with MCP Caller Tokens). An optional TTL + re-issue endpoint (`agent-console auth refresh`) is deferred to Open Questions.

### Output contract

- Success: result JSON on stdout, exit code 0.
- Failure: error JSON (`{ "error": "..." }`) on stderr, non-zero exit code. Exit codes distinguish usage errors (2) from server-reported failures (1), mirroring the smoke-script convention already used in `scripts/smoke/`.
- No interactive prompts, no TTY detection tricks: every command is non-interactive so agents can call it fire-and-forget.

### Discoverability: skill and --help

- A skill (`.claude/skills/`) documents the operation surface for Claude Code agents: when to delegate, how to report back to a parent, how to manage timers/wakeups. It replaces the MCP tool descriptions as the primary usage documentation for PTY workers.
- `--help` output is written for agents as much as humans: every subcommand documents its env-var defaults and one copy-pasteable example. Agents without skill support (Codex, Gemini CLI, custom) discover the surface through `agent-console --help` alone.
- The delegate callback instructions (`buildMessageCallbackPrompt` in `mcp-server.ts` and its CLI counterpart) switch from "use the `send_session_message` MCP tool" to the `agent-console sessions send` invocation, with env-var-based parameter defaults making the instruction shorter than today's.

## Surface Symmetry (AGENT_OPERATIONS)

The CLI is a fourth consumer surface in the sense of `docs/design/agent-surface.md` Mechanism 3. The same PR that introduces the CLI adds a fourth exposure table, co-located with the CLI's code and typed `satisfies Record<AgentOperation, SurfaceExposure>`, covering all of `AGENT_OPERATIONS` (`listAgents`, `resolveAgent`, `createSessionWithAgent`, `addWorkerToSession`, `manageDefinitions`). Where a `via` claim is mechanically checkable (the named subcommand must exist in the CLI's command registry), a test asserts it, following the pattern of `agent-operations-mcp.test.ts`.

## Security & Threat Model

**Assumption (recorded here as the revisit anchor): multi-user deployments consist of members of one company or team who are mutually trusted. A malicious co-located OS user is out of scope.** If agent-console ever targets less-trusted multi-tenant deployments, this section is where the review starts.

Within that model:

- The Session Token is short-lived in authority even without a TTL: it is scoped to one session's operations, comparable to session ownership on every call (`checkCallerOwnsSession`), and revoked at session end. Leak blast radius is "act as this one session until it closes".
- Single-user env injection adds no exposure beyond what the same-UID boundary already implies.
- Multi-user delivery reuses the token-file mechanism specifically because the elevated spawn path materializes some environment variables inside an argv-visible command string; secrets must not ride that channel. This is an implementation constraint inherited from the elevation design, not a new analysis.
- The CLI honors the same `AGENT_CONSOLE_MCP_AUTH` enforcement mode as MCP calls, so operators tune one knob for both surfaces.

## OS Environment Coupling

Multi-user mode spawns PTY workers as other OS users through an elevated, non-interactive login shell, which does not source user shell init and therefore does not see user-local `PATH` entries (`.claude/rules/os-environment-coupling.md`, Discipline 3). Consequences, following the `EMBEDDED_AGENT_BUN_PATH` precedent (Issue [#1221](https://github.com/ms2sato/agent-console/issues/1221)):

- The CLI's location is carried as an absolute path in a server config value, defaulting to the bundled artifact's path for single-user/dev.
- The multi-user setup script (`scripts/setup-multiuser-for-ubuntu.sh`) copies the CLI to a location traversable by every elevation-target user (e.g. `/usr/local/bin`), copying — not symlinking — for the same home-directory-permission reasons as the bun binary copy.
- A smoke test under `scripts/smoke/` runs the CLI through the real elevated spawn path on the deploy target and asserts both positive (command resolves and authenticates) and negative (no secret material in the inner command string) conditions, documented in `docs/multi-user-setup-guide.md` "Post-deploy Verification".

## Rollout

Single release, full surface, MCP untouched:

1. Ship the CLI with all 22 commands, PATH/env injection, token minting, the skill, and the exposure table in one coordinated change set (multiple PRs, one umbrella issue).
2. Switch delegate callback instructions to the CLI form in the same rollout.
3. MCP remains registered and functional. After the CLI has been the instructed path for a while, observed MCP usage informs a separate deprecation decision (out of scope here).

## Testing & Verification

- **Unit**: command parsing, env-var defaulting, token resolution order, output/exit-code contract.
- **Integration** (`packages/integration/`): CLI-to-server round trips for representative commands across the wire boundary, including an ownerless-session call under both `warn` and `enforce` auth modes.
- **E2E dogfood** (same shape as the #1260 acceptance): from a PTY session, `agent-console delegate` a task; the child starts automatically, appears in the UI, and reports back via `agent-console sessions send` with no MCP configuration present anywhere.
- **Multi-user smoke**: the OS Environment Coupling smoke above, run on the real deploy target before merge of the multi-user wiring and after every deploy touching it.

## Open Questions

1. **Binary name.** `agent-console` is explicit but long for high-frequency use; a short alias (`acx`, `agc`) could ship alongside. Decide before the skill is written, since the name appears in every instruction.
2. **Token TTL and refresh.** Baseline is session-lifetime revocation. Is a TTL + `auth refresh` worth its complexity inside the trusted-team model?
3. **`proc` family long-term.** If CLI-side usage shows PTY agents always prefer their own shell, the `proc` commands may become MCP-only legacy; keep or fold is a post-observation decision.
4. **MCP deprecation criteria.** What observed usage level and soak time justify removing the MCP server, and does any non-PTY external consumer (IDE plugins, third-party clients) depend on it by then?
