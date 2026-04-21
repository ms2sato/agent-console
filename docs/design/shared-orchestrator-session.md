# Shared-Account Sessions — Design

> **Scope.** This document specifies a multi-user affordance: running a session under a dedicated OS shared account so that all authenticated users can see and interact with the same PTY through the normal session UI. The **Orchestrator** (invoked via the `/orchestrator` skill) is the primary motivating use-case, but nothing in this design treats the Orchestrator as a product-level concept. The filename retains "orchestrator" for cross-reference stability; the mechanism is general.
>
> **Background on the reframe.** An earlier version of this document positioned the "shared Orchestrator session" as a first-class entity. The April 2026 design conversation captured in [`docs/narratives/2026-04-21-orchestrator-as-skill.md`](../narratives/2026-04-21-orchestrator-as-skill.md) concluded that no first-class designation is needed — the PTY UI already supports multi-human interaction with any session, and the Orchestrator remains a skill. What remains as a design artifact is the shared-account mechanism itself, described below.

## Context

Agent Console supports multi-user operation via `AUTH_MODE=multi-user` (see [`multi-user-shared-setup.md`](./multi-user-shared-setup.md)). In that mode, each authenticated OS user has their own personal sessions, and PTY processes are spawned as that user via `sudo -u`. Session records live in a single server-side SQLite at `$AGENT_CONSOLE_HOME/data.db`, with `sessions.created_by` identifying the session owner.

What is not yet supported: a session whose PTY process runs under a **dedicated shared account** rather than any individual user. The motivating use-case is team coordination: a single Orchestrator session that all team members submit requests to through the normal session UI. But the mechanism is general — any workflow that needs a shared compute identity separate from any individual user (shared bots, team dashboards, coordination surfaces) fits here.

This document specifies how to add shared-account sessions on top of the existing multi-user foundation.

## Terminology

- **Shared account** — a dedicated OS account on the server, distinct from the server's service user (`agentconsole`) and from any individual end-user. Operators choose the account name freely. The examples in this document use `agent-console-shared`; that specific name is not a product-level identifier.
- **Shared session** — a session whose `created_by` references the shared account's `users.id`. Visible and writable by all authenticated users by default; this is the basis on which multiple humans interact with the same PTY through the UI.
- **Personal session** — the existing per-user session (`created_by` references the authenticated user's `users.id`).

## Orchestrator is a Skill, Not a Session Type

The `/orchestrator` skill (`.claude/skills/orchestrator/`) loads a set of behaviours — leadership cadence, delegation pattern, sprint lifecycle procedures. Any session can invoke it. There is no `sessions.type = 'orchestrator'`, no `repositories.orchestrator_session_id`, no claim/release API. Discovery of the Orchestrator-role session is by title; routing from humans to the Orchestrator is by clicking the session in the session list and typing into its PTY terminal.

Consequently:

- A team may run a single shared session with `/orchestrator` invoked and call it "the team Orchestrator".
- A larger organisation may run multiple shared sessions each with `/orchestrator` invoked, each scoped to a different surface (user-facing UI, admin console, infrastructure) and titled accordingly.
- The same shared-account mechanism also supports non-Orchestrator shared sessions (team terminal for a shared tool, a coordination channel, etc.).

The **session type** here is "shared" (distinguished from "personal" by whose OS account spawns the PTY). The **role** played by a session is determined by which skill was invoked and what the users ask of it. These two axes are independent.

## Design Goals

1. **Multi-human access through the PTY UI.** Any authenticated user can open a shared session's worker and type into its PTY. No additional inbound-routing machinery is introduced; the session list and PTY terminal already in Agent Console are the interaction surface.
2. **No change to existing storage model.** The single server-side `data.db` and the `sessions.created_by` column already support the distinction.
3. **Clean OS account separation.** The shared account is distinct from the server's service user (`agentconsole`) — no privilege conflation, no credential sharing between the server process and the spawned CLI processes.
4. **API-key authentication for shared accounts.** The shared account authenticates to the LLM vendor via an organisation-owned API key (Commercial Terms), independent of any individual user's subscription. Personal sessions continue to use subscription authentication in each user's own OS account.
5. **No user-side impersonation burden.** End users click a button; the server handles OS-level impersonation via the existing `agentconsole` sudo privilege. No `sudo` or account switching from end-user terminals.

## Non-Goals

- **Product-level "Orchestrator" entity.** Orchestrator remains a skill. No DB column, no UI badge, no designation API tied specifically to orchestration.
- **Per-participant access control on shared sessions.** Initial permission model is open to all authenticated users.
- **Internal billing / usage dashboard inside Agent Console.** External Anthropic console dashboards cover usage visibility.
- **Automatic credential rotation.** Rotation is a manual operational procedure (see below).
- **Enforcing a one-shared-session-per-repository constraint.** Multiple shared sessions per repository are explicitly permitted and, at team scale, expected.

## Architecture Overview

### Storage layer — reuse existing

```text
$AGENT_CONSOLE_HOME/data.db        ← single DB (unchanged)
    users                          ← includes shared account record(s)
    sessions                       ← created_by associates with users.id
                                     (application-level linkage; the shared
                                      shared account record is the one
                                      referenced for shared sessions)
```

No schema changes are required for the minimum viable version. Optional additions are discussed under Schema Notes below.

Note on `sessions.created_by`: the column is a plain `text` with no foreign-key DDL (see `packages/server/src/database/connection.ts` migration v14 — `addColumn('created_by', 'text')`). Association with `users.id` is maintained by the application layer. Whether to add a DB-level foreign key later is a separate decision (tracked in Issue [#680](https://github.com/ms2sato/agent-console/issues/680)).

### Identity layer — one or more additional OS accounts

```text
agentconsole          (service user)             runs the server process,
                                                 NOPASSWD sudo to any user

userA, userB, ...     (authenticated users)      personal sessions spawn
                                                 as these users

<shared-account-1>   (shared account)   shared sessions spawn
<shared-account-2>                              as these users
...                                              (examples: agent-console-shared,
                                                  team-frontend-shared, etc.)
```

A shared account is a normal OS user with its own `$HOME`, its own credential storage, and an entry in the `users` table. Exactly like any authenticated user in structure — the only distinction is that its PTY is reachable by all authenticated users (by policy), and its authentication to the LLM vendor is API-key-based rather than subscription-based.

### Authentication model

| Session type | PTY runs as | Auth method |
|---|---|---|
| Personal session | Authenticated OS user | Subscription (individual `claude login` in that user's home) |
| Shared session | Shared account | **API key** configured in the shared account's home |

Rationale for API keys on shared accounts: a shared account serves multiple people, which fits organisation-level (Commercial Terms) access rather than individual subscription terms. API keys also rotate cleanly and do not break when any one individual's subscription lapses. This is compatible with vendor offerings that provide organisation-level API access.

## Session Creation Flow

End user `userA` clicks "Create shared session" in the UI. If the server is configured with multiple shared accounts, the UI presents a picker for which account to create under.

1. Client sends a standard session-create request with a `shared` indicator (concrete API schema deferred to implementation). When multiple shared accounts are configured, the chosen account's identifier accompanies the request; its form (username, id, or another key) is resolved together with the multi-account config form — see Open Questions.
2. Server validates `userA`'s JWT via normal auth middleware and checks the shared-session-creation permission (default: all authenticated users may create).
3. Server resolves the selected shared account's `users.id` from its configuration (see Configuration below).
4. Server creates the session with:
   - `sessions.created_by` = shared account's `users.id`
   - `sessions.initiated_by` = `userA.id` (records the authenticated user who clicked "Create shared session"; persisted for audit — see Schema Notes)
5. When the session's PTY is spawned, the server uses `sudo -u <shared-account-name> -i sh -c '...'`. The existing `agentconsole ALL=(ALL) NOPASSWD: /bin/sh, /bin/bash, /bin/zsh` sudoers rule covers this — no additional sudoers configuration.
6. The PTY runs with the shared account's environment: `$HOME` points to the shared account's home, which contains the API-key credentials. The `claude` CLI (or any LLM CLI) authenticates using those credentials.

End-user perspective: a shared session appears in the session list. Any authenticated user can click it, open its worker's PTY, and type into it — exactly like a personal session, except the PTY process is running as the shared account and the participants include the whole team.

## Per-user Worktree Dispatch

The shared session is only half the multi-user story. The other half is what happens when the Orchestrator inside the shared session delegates work to an individual team member: the resulting worktree must live under the **assignee's** own home directory, and all commits made there must bear the assignee's git identity.

### Identity × filesystem boundary

A hard invariant: **no process writes into a user's `$HOME` unless it is running as that user.**

- The server process (running as `agentconsole`) never writes files into `alice`'s home directory.
- The shared account (e.g. `agent-console-shared`) never writes files into `alice`'s home directory.
- All filesystem operations that land under `alice`'s home — initial clone, `git worktree add`, template file copy, any post-setup hook — are executed via `sudo -u alice -H <command>`.

This preserves two properties at once: filesystem permissions stay sound (alice owns her own files), and git attribution stays honest (alice's `.gitconfig`, SSH key, and GPG key are in scope for every commit that originates there).

### Path convention (derived, not stored)

Per-user clone and worktree locations follow a fixed convention:

```text
${user.homeDir}/.agent-console/repositories/<org>/<repo>/                        ← per-user clone
${user.homeDir}/.agent-console/repositories/<org>/<repo>/worktrees/wt-NNN-xxxx/  ← per-user worktree
```

The server derives these paths from `users.home_dir` and the repository's `<org>/<repo>` slug. They are **not** stored in the `repositories` or `worktrees` tables — the filesystem is the source of truth; the DB caches only intent (which user was asked to work on which repo, at which session).

Rationale: in a multi-user deployment, users come and go, home directories move, deployments migrate. Storing literal paths ties the DB to a particular filesystem snapshot. Derivation keeps path-resolution in one place and lets the server self-heal by re-bootstrapping a clone when the derived path is missing.

`sessions.location_path` continues to store the literal worktree path for each session (current behaviour) — acceptable because a session is tied to a physical working directory at creation time. If that path disappears, the session is marked broken through the existing missing-path skip logic in `RepositoryManager.initialize()`.

### Repository registration via URL

Today's `RepositoryManager.registerRepository(path)` accepts an existing local directory (`packages/server/src/services/repository-manager.ts:106`). This is insufficient for multi-user dispatch — the server cannot clone into a user's home on behalf of a user whose home it cannot write to.

The extension:

```typescript
RepositoryManager.registerRepositoryFromUrl({
  url: string,           // e.g. git@github.com:ms2sato/agent-console.git
  description?: string,
})
```

The server records the URL and canonical `<org>/<repo>` slug. Per-user clones are created **lazily on first dispatch**, not eagerly. Each user's access to the remote is their own concern (their SSH key, their HTTPS credentials); if alice lacks access, her first dispatch fails with an actionable error and the operator resolves access separately — the design does not conceal or retry auth failures.

### `delegate_to_worktree` assignee parameter

The existing MCP tool has no concept of "who will own this work" beyond the caller's identity. For shared-session dispatch we add an explicit `assignee`:

```typescript
delegate_to_worktree({
  repositoryId: string,
  assignee?: string,     // users.username of the target user; defaults to caller
  branch: string,
  prompt: string,
  // ...existing parameters
})
```

The `assignee` is a username, not a UUID — this is the identifier a human-in-the-loop Orchestrator skill naturally uses when a team member is mentioned. The server resolves it to a stable `users.id` at dispatch time. A username change between dispatch and PTY spawn (an operationally rare event) surfaces as a clear error, not a silent redirection to a different user.

Resolution and authorisation:

1. **Resolve** — `assignee` is looked up in the `users` table. If it does not resolve, the tool returns an error; the Orchestrator sees it and can ask the operator to verify the user.
2. **Authorise** — only sessions running under a shared account may set `assignee` to someone other than the caller. The server determines whether the calling session is a shared-session by looking up the session's `created_by`, then checking whether that `users.id` is in the set of configured shared account identities (the set upserted at startup per `AGENT_CONSOLE_SHARED_USERNAME`; when multi-account config lands, the set becomes larger). Rejected cases: a personal session attempting to dispatch to another user; **a shared session attempting to dispatch to a shared account (including its own caller account)** — this prevents recursive self-delegation, the Orchestrator delegating work back to its own OS identity. This is the minimum permission boundary; richer role models can be added later.
3. **Dispatch** — the server computes the target user's clone and worktree paths by convention. If the clone is absent, the server first creates the parent directory (`sudo -u <assignee> -H mkdir -p <clone-parent>`) — `git clone` creates only the leaf, not intermediate path segments — then bootstraps the clone (`sudo -u <assignee> -H git clone <url> <clone-path>`). Next it creates the worktree (`sudo -u <assignee> -H git -C <clone> worktree add ...`), copies template files (see Template file handling below), creates a session row with `created_by = <assignee>.id`, and spawns the session's PTY via the existing `MultiUserMode.spawnPty` with `username = <assignee>`.

The Dispatch step for a single (assignee, repository) pair is serialised by an in-memory lock keyed on `{assignee.users.id, repository.id}`. Two concurrent `delegate_to_worktree` calls targeting the same pair do not race on the lazy clone bootstrap — the second waits on the first (preferred) or receives an "already in progress" error the Orchestrator can retry. The lock is held throughout bootstrap-plus-worktree so the dispatch appears atomic from the Orchestrator's perspective. Per-worktree creation after the clone exists does not need global serialisation — `git worktree add` is atomic against a single clone — but the lock spans the whole sequence for simplicity.

In `AUTH_MODE=none`, `assignee` is either absent or equals the server process user; the existing direct-spawn and direct-git paths are taken. Single-user behaviour is unchanged.

### Template file handling

`copyTemplateFiles` in `packages/server/src/services/worktree-service.ts` currently uses `fsPromises.writeFile`, which writes as the server process user. This is incompatible with the identity-filesystem boundary above.

The replacement pattern preserves the recursive, binary-safe, permission-preserving behaviour of the current `copyTemplateFiles`, executed as the target user:

1. For each sub-directory in the template tree, run `sudo -u <user> -H mkdir -p <dest-dir>` before writing files into it. `git worktree add` does not pre-create template sub-directories.
2. For each file, pipe its bytes to `sudo -u <user> -H sh -c 'cat > <dest-path>'` with the content supplied on stdin. This is binary-safe — text and non-text template files are handled uniformly.
3. Preserve the source file's mode bits: after writing, run `sudo -u <user> -H chmod <mode> <dest-path>` so that executable templates (e.g., `.sh` hooks) stay executable.

Ownership and group are correct from the moment of creation because every step runs under the target user's identity.

Alternatives considered and rejected:

- **Staging directory + `sudo -u <user> mv`** — the staged file is briefly owned by the server process user; partial failure leaves orphaned files the user cannot clean up. Violates the boundary rule during the staging window.
- **Ship templates inside the repo and let `git worktree add` populate them** — requires templates to live in the repository, which is not the current model (`.agent-console/` templates live outside or alongside the repo). Would require a separate large migration.

### Single-user compatibility

In `AUTH_MODE=none`:

- Exactly one user (the server process user) exists in the `users` table.
- `delegate_to_worktree` with no `assignee` resolves to that user; `assignee` set to the same user is a no-op special case.
- The per-user path convention collapses to `${serverProcessUser.homeDir}/.agent-console/repositories/<org>/<repo>/...` — the path `getConfigDir()` already yields today.
- All `sudo -u <user>` invocations detect `username === serverProcessUsername` and fall back to direct `Bun.spawn(['git', ...])` — extending the existing sudo-skip optimisation already used for PTY spawn in `MultiUserMode.spawnPty` (`packages/server/src/services/user-mode.ts:328`) to git operations as well.

Single-user behaviour is preserved exactly. The multi-user dispatch path is a superset; the single-user path is its degenerate case.

### Failure modes

| Condition | Behaviour |
|---|---|
| `AGENT_CONSOLE_SHARED_USERNAME` unset | Shared-session feature disabled; personal sessions only (existing fail-safe). |
| Configured shared account's OS user missing | Server fails fast at startup (existing behaviour). |
| `delegate_to_worktree` called with unknown `assignee` | Tool returns error; Orchestrator receives it and can ask the operator. |
| `assignee` exists in DB but the OS account is gone | Dispatch fails at the first `sudo -u` step; returned as a clone or spawn error. |
| Assignee lacks `git clone` access to the repository URL | Lazy bootstrap fails during `git clone`; error returned to the Orchestrator (no silent retry). |
| Assignee's home directory is missing or unwritable | `sudo -u` succeeds but subsequent `git` operations fail; returned as a clone error. |
| Personal session attempts to dispatch with a non-self `assignee` | Rejected at authorisation step; returns error. |

### Implementation dependencies

Landing this design requires the following server-side extensions, none of which exist today (verified against the codebase on 2026-04-21):

1. **`packages/server/src/lib/git.ts` — `runAs` support.** `git(args, cwd, { runAs?: { osUser: string, homeDir: string } })`. When `runAs` is set and `osUser` is not the server process user, the command is wrapped in `sudo -u <osUser> -H git ...`.
2. **`packages/server/src/services/worktree-service.ts` — target-user-aware creation.** `createWorktree` accepts an `ownerUser: AuthUser` parameter. Path resolution, git invocation, and template file copy all use that user's identity.
3. **`packages/server/src/services/repository-manager.ts` — URL registration.** A new `registerRepositoryFromUrl` method; the lazy-per-user-clone bootstrap lives in the worktree creation path, not in registration.
4. **MCP `delegate_to_worktree` — `assignee` parameter.** Plus the authorisation check that restricts cross-user dispatch to shared-session callers.
5. **Sudoers policy extension.** The server operator grants the shared account `NOPASSWD` sudo to `/usr/bin/git` in addition to the shells it already has. Documented alongside the existing sudoers fragment in [`multi-user-shared-setup.md`](./multi-user-shared-setup.md).

These land together as a single multi-user-dispatch iteration; partial adoption leaves the system in an inconsistent state.

## Orchestrator-facing Interface

The server-side extensions above are invisible to the Orchestrator's skill. What the Orchestrator actually sees — and what must therefore be captured as a short, non-overlookable convention — is a small surface.

### Tool surface

Only **one new MCP tool** and **one existing-tool parameter** are introduced on top of today's surface:

- **`delegate_to_worktree({ ..., assignee?: string })`** — existing tool, new parameter. When `assignee` is set, the resulting worktree is created under that user's home and the session is spawned under that user's identity; when omitted, the caller's own identity is used. Shared-session callers may name any user; personal-session callers may only name themselves (see the Permission Model section below, which governs authorisation).
- **`list_users()`** — new tool. Returns `{ id: string, username: string, hasActiveSession: boolean }[]` for all users known to the server. `hasActiveSession` is `true` when the user currently has at least one session with a live PTY worker (stopped or closed sessions do not count). A user appears in this list only after their first login — the `users` row is upserted at that point. Invited-but-not-yet-logged-in team members are therefore not visible until they first log in; this is a point worth surfacing to operators onboarding a new team member.

All other information the Orchestrator needs — ongoing sessions, delegated-work callbacks, PR/CI events — is served by existing tools (`list_sessions`, `get_session_status`, `send_session_message`, `write_memo`) and existing inbound routing (the parent-bubble behaviour referenced earlier via `send_session_message` and the webhook pipeline). Nothing else needs to be added.

### Orchestrator in a personal session

`/orchestrator` can be invoked in a personal session (any non-shared session), not only in shared sessions. In that case the Orchestrator can still call `delegate_to_worktree` and `list_users`, but `assignee` is restricted to the session's own user (rejected at the authorisation step described above). Cross-user dispatch requires a shared session. Single-human workflows — one individual using the Orchestrator as a personal coordination aid — work unchanged.

### Request attribution convention (server-side stdin prefix)

In a shared session, multiple users write into the same PTY via the web UI. The raw stdin stream carries no attribution by default. To make multi-human dispatch reliable without relying on the Orchestrator to ask "who is this?" on every turn, the **server** attaches a short prefix to every **LF-terminated line** of stdin that enters a shared session's worker:

```text
[@<username>] <user's typed content>
```

- **Where** — the WebSocket ingress handler that forwards browser stdin to a worker's PTY (today resident in `packages/server/src/websocket/`; the specific file and symbol are confirmed at implementation time). Not the browser client: client-side tagging would be forgeable by a malicious client; server-side tagging is authoritative.
- **Who** — the `<username>` is `users.username` resolved from the authenticated WebSocket's identity, not free text.
- **When** — only for **agent workers** (workers whose `type` is `agent`) in sessions whose `created_by` resolves to a shared account. Terminal / shell workers pass stdin through unchanged, even when the containing session is shared: prefix injection is a communication-context affordance for conversational agents, and `[@alice] ls` is not a valid shell command. Personal sessions receive no prefix regardless of worker type — they are single-user by construction and would noisily tag a single-person dialogue.
- **Granularity** — the prefix is inserted only when a complete line arrives (LF received). Partial lines mid-typing, keystroke streams from terminal control sequences, and tab-completion echo traffic pass through unprefixed. Only user-visible "submitted lines" carry attribution.
- **Format lock** — the exact prefix form is part of the server's contract with the Orchestrator skill convention below. Changing the format is a breaking change for that convention.

This is a format, not a procedure. The prefix is present as literal bytes in the Orchestrator's input stream; even if the skill convention is skim-read, the prefix remains parseable.

### Orchestrator skill convention

The `/orchestrator` skill adds three short lines, stated as contract rather than walk-through so that skim-reading still yields correct behaviour:

```
- delegate_to_worktree(assignee) creates the worktree under that user's
  home and spawns the session as that user. Use when work should attach
  to a specific team member. In a personal (non-shared) session,
  assignee is restricted to the session's own user.
- list_users() enumerates valid assignees; call it when an `assignee`
  name is not already known to be valid.
- In a shared session, every LF-terminated stdin line is prefixed by
  [@<username>] by the server. The <username> is authoritative — use
  it to attribute requests and pick assignees.
- Inbound messages from other sessions via send_session_message arrive
  as file-based notifications with a `from: <sessionId>` field, not as
  prefixed stdin. Team requests can arrive via either path; check both
  when identifying the originator.
```

Anything more elaborate — when to delegate vs handle directly, how to phrase callback responses — is general Orchestrator judgment, not mechanics of this feature, and does not belong in the convention.

## Permission Model (Initial: Open)

- **Create** — any authenticated user may create a shared session.
- **Read** — any authenticated user may view any shared session's state and worker output.
- **Write (stdin)** — any authenticated user may send input to any shared session's worker PTY.
- **Delete** — any authenticated user may delete any shared session they can see.

This open model matches the "small-team coordination hub" usage described in `docs/strategy/strategy-overview.md` §5 (small-team orchestration). Participant restrictions, role-based access, and admin-only creation can be layered on later via a `sessions.visibility` / `participants` table extension — out of scope for the initial design.

## Data Storage (Unchanged)

- All session rows live in the server-side `data.db`.
- All worker output files live under `$AGENT_CONSOLE_HOME/...` as specified by [`session-data-path.md`](./session-data-path.md), owned by the `agentconsole` service user (same as personal sessions).
- The shared account's `$HOME` is used only for CLI credentials and any user-facing state the CLI itself writes (shell history, `.claude/` config, etc.). It is not used for session persistence.

## Configuration

Shared-account sessions are **opt-in**. Deployments that do not want them leave the relevant variables unset; the feature is simply off. Deployments that do want them set the variables to the OS username(s) of the shared account(s).

| Variable | Default | Semantics |
|---|---|---|
| `AGENT_CONSOLE_SHARED_USERNAME` | (unset) | OS username of the default shared account (single-account case). |

Multiple shared accounts (a natural extension for larger organisations) would use a comma-separated list, a separate per-account config file, or an equivalent mechanism. The initial implementation targets exactly one account via the single variable above; the extension is straightforward when needed.

### Startup behaviour

- **Unset** — shared feature disabled. Server logs one informational line (`"shared account: disabled (AGENT_CONSOLE_SHARED_USERNAME not set)"`) and continues. UI does not display shared-session affordances.
- **Set, and the OS account exists** — server upserts the account into `users` on startup, enables shared-session creation endpoints and UI.
- **Set, and the OS account does not exist** — server **fails fast at startup** with a clear error instructing the operator to create the OS account or unset the variable. This catches misconfiguration (typos, accidental unset during deployment) before users encounter a missing button.

### Relationship to `AUTH_MODE`

- In `AUTH_MODE=multi-user`, `AGENT_CONSOLE_SHARED_USERNAME` is honoured per the rules above.
- In `AUTH_MODE=none`, `AGENT_CONSOLE_SHARED_USERNAME` is ignored — shared sessions require multi-user authentication to be meaningful.

## Operational Setup

One-time setup on the server (only in `AUTH_MODE=multi-user`):

### 1. Create the shared service OS account

Operators choose the name; the example below uses `agent-console-shared`.

```bash
# macOS
sudo dscl . -create /Users/agent-console-shared
sudo dscl . -create /Users/agent-console-shared UserShell /bin/zsh
sudo dscl . -create /Users/agent-console-shared NFSHomeDirectory /Users/agent-console-shared
sudo dscl . -create /Users/agent-console-shared UniqueID <unique-uid>
sudo dscl . -create /Users/agent-console-shared PrimaryGroupID 20
sudo createhomedir -c -u agent-console-shared

# Linux
sudo useradd -m -s /bin/bash agent-console-shared
```

### 2. Configure the LLM CLI with an API key

The server operator becomes the shared account and sets up credentials once.

```bash
sudo -u agent-console-shared -i
  # Configure the LLM CLI with an organisation-level API key.
  # Exact command depends on the CLI. For Claude Code:
  #   (interactive) claude login           # select API-key option when prompted
  # or environment-variable based:
  #   echo 'export ANTHROPIC_API_KEY=<your-api-key>' >> ~/.zshrc
  exit
```

### 3. Configure the server

Set `AGENT_CONSOLE_SHARED_USERNAME=<shared-account-name>` in the server's environment (e.g., systemd unit, launchd plist).

### 4. Verify

Start the server, log in as any user, create a shared session, verify:

- The session appears in the UI with a visible "shared" indicator.
- The session's worker terminal runs as the shared account (`whoami` inside the terminal returns the account's username).
- Credentials are in place — the check depends on the setup chosen in step 2. For the env-var path, `echo $ANTHROPIC_API_KEY` shows a value. For the login-based path, an authenticated CLI probe (e.g., `claude --help` returning without a login prompt, or the equivalent for the chosen CLI) succeeds. Either path is acceptable.
- Other authenticated users can see and write to the same session.

## Credential Rotation

Rotation is manual, triggered when a key is compromised or reaching expiry:

```bash
sudo -u <shared-account-name> -i
  # Update the CLI's stored credential with the new API key.
  # Env-var based setup: edit ~/.zshrc (or equivalent).
  # Login-based setup: re-run the login command with the new key.
  exit

# Optional: restart active shared-session PTYs so they pick up the new key.
# (If the CLI re-authenticates on each spawn, no restart is needed.)
```

Rotation frequency is an operator decision; typical: every 6–12 months, or immediately on suspected compromise.

## UI / UX

Minimum viable changes:

1. **"Create shared session" affordance** — a distinct button or menu item, visible when at least one shared account is configured.
2. **Visual distinction for shared sessions** — badge, colour, or label so users know they are typing into a shared space (reduces accidental secret leakage into a visible-to-all terminal).
3. **List / filter** — shared sessions appear in all users' session lists by default. The existing per-user filter can be extended with a "shared only" or "personal only" toggle.
4. **Indicator of other active participants** (optional) — "3 users currently viewing" — useful for coordination but out of scope for the minimum viable implementation.

The Orchestrator-role session, when a team runs one, is discovered the same way as any other shared session: by title in the session list.

## Security Considerations

### Why shared accounts are separate from the server service user

The server's service user (`agentconsole`) runs the Hono process and has `NOPASSWD` sudo to any OS user. Running a shared session as the service user would introduce these risks:

1. **JWT secret exposure** — the server stores `${AGENT_CONSOLE_HOME}/jwt-secret`. A PTY running as the service user can read it and exfiltrate via stdin interactions, enabling session forgery.
2. **Direct DB write capability** — `data.db` is owned by the service user. A PTY running as the service user bypasses the server's validation layer.
3. **Sudo privilege amplification** — the service user can `sudo -u` to any account. A PTY with that identity can be coerced into elevating privileges.

Keeping the shared account distinct from the service user preserves defense-in-depth: the service process only spawns PTYs; the LLM process only runs the LLM.

### Why API key, not subscription, for shared accounts

- **Commercial compliance** — personal subscription terms typically preclude multi-user business use. An organisation-owned API key (Commercial Terms) is the appropriate authentication form for shared infrastructure.
- **Operational independence** — the shared account does not break when any individual's subscription lapses.
- **Credential rotation** — API keys rotate cleanly; subscription login flows are awkward to rotate without human interaction.
- **Billing attribution** — API-key usage is attributed to the organisation via the vendor's billing dashboard.

### Stdin to a shared session

Any authenticated user can type into a shared session. This is an intentional property of the "single entry point for team coordination" use case, not a bug. Practical considerations:

- **Visible to all** — operators should remind the team that content typed into a shared session is visible to every team member. The UI affordance reinforces this.
- **No content moderation in the first version** — the session is trusted within the team's trust boundary.
- **Audit** — `sessions.initiated_by` records the session creator. A future `participant_events` table could log per-stdin-message authorship if needed.

### Shared account rename and identity stability

`sessions.created_by` references `users.id` (a UUID), stable across OS account renames. The sudo target uses `users.username`, which is re-read from the `users` table on each PTY spawn. The `users` row is upserted at server startup for configured shared accounts (see Configuration), and re-upserted on each user's login.

Operator workflow for renaming a shared account (rare):

1. Rename the OS account (`usermod -l ...` on Linux, equivalent on macOS).
2. Update `AGENT_CONSOLE_SHARED_USERNAME` to the new name.
3. Restart the server. The startup upsert reconciles the `users` row by `os_uid` and writes the new username. Existing `sessions.created_by` references remain valid.

Per-user accounts (alice, bob) follow the same pattern: their `users` row is keyed by `os_uid`, so a rename plus a subsequent login writes the updated username without orphaning any session record.

## Schema Notes

Required schema addition for this design: **`sessions.initiated_by`** (nullable text, application-level linkage to `users.id`). For personal sessions it equals `created_by`; for shared sessions it records the authenticated user who clicked "Create shared session" — distinct from `created_by`, which represents the PTY spawn identity. The Session Creation Flow above (step 4) persists this value, so it must exist from day one.

Aside from this one column, the existing `users` and `sessions` tables already handle shared accounts via the `created_by` mechanism; no further schema changes are required for the minimum viable version.

Optional additions considered but deferred:

- `sessions.visibility` enum (`personal`, `shared`, `team-private`) — generalises beyond "all-or-nothing" for future permission extensions.
- `participants` table — for invite-only shared sessions.

Decisions about `sessions.created_by` gaining a DB-level `REFERENCES users(id)` are tracked separately in Issue [#680](https://github.com/ms2sato/agent-console/issues/680).

## Open Questions

- **Multiple shared accounts.** Concrete config form for more than one account (comma-separated env var, config file, or per-repository association). Schema-wise free; runtime form is an implementation choice. The session-create API's shared-account identifier (Session Creation Flow step 1) is resolved alongside this.
- **Shared session audit depth.** Current design records creator. Per-stdin-message authorship would require an additional table — revisit if team operators report need.
- **API-key storage form inside the shared account's home.** Two equivalent options: env-var export in shell profile, or CLI-native credential file. Operator choice; does not affect the server.
- **Rate limiting and abuse control.** The initial design does not rate-limit shared-session creation or stdin throughput. Runaway consumption by a compromised or misbehaving internal actor is an operator concern, handled externally (reverse proxy limits, vendor-side billing caps). Revisit if self-service shared sessions become available to a larger audience.

## Migration / Rollout

This is additive. Pre-existing personal sessions and the single-user `AUTH_MODE=none` flow are unchanged.

1. Merge the server code supporting `AGENT_CONSOLE_SHARED_USERNAME` + shared-session UI.
2. Existing deployments: no mandatory action. Shared-session creation is disabled when the env var is unset.
3. Operators who want shared sessions: perform the Operational Setup above, set the env var, restart the server.

Rollback: unset `AGENT_CONSOLE_SHARED_USERNAME` and restart. Existing shared-session rows remain in the DB (harmless) but cannot be spawned until the env var is restored.

## References

- [`multi-user-shared-setup.md`](./multi-user-shared-setup.md) — base multi-user authentication, sudoers, per-user PTY spawn model
- [`session-data-path.md`](./session-data-path.md) — session data storage and path-resolution contract
- [`session-worker-design.md`](./session-worker-design.md) — session / worker architecture
- `docs/strategy/strategy-overview.md` §5 "Small-team orchestration" — the strategic target this design serves
- [`docs/narratives/2026-04-21-orchestrator-as-skill.md`](../narratives/2026-04-21-orchestrator-as-skill.md) — the design conversation that produced the current frame (Orchestrator as skill, not as a product concept)
- [`docs/narratives/2026-04-18-strategic-position.md`](../narratives/2026-04-18-strategic-position.md) — phenomenological background for the small-team direction
