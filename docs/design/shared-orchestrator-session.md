# Shared Service-Account Sessions — Design

> **Scope.** This document specifies a multi-user affordance: running a session under a dedicated OS service account so that all authenticated users can see and interact with the same PTY through the normal session UI. The **Orchestrator** (invoked via the `/orchestrator` skill) is the primary motivating use-case, but nothing in this design treats the Orchestrator as a product-level concept. The filename retains "orchestrator" for cross-reference stability; the mechanism is general.
>
> **Background on the reframe.** An earlier version of this document positioned the "shared Orchestrator session" as a first-class entity. The April 2026 design conversation captured in [`docs/narratives/2026-04-21-orchestrator-as-skill.md`](../narratives/2026-04-21-orchestrator-as-skill.md) concluded that no first-class designation is needed — the PTY UI already supports multi-human interaction with any session, and the Orchestrator remains a skill. What remains as a design artifact is the service-account mechanism itself, described below.

## Context

Agent Console supports multi-user operation via `AUTH_MODE=multi-user` (see [`multi-user-shared-setup.md`](./multi-user-shared-setup.md)). In that mode, each authenticated OS user has their own personal sessions, and PTY processes are spawned as that user via `sudo -u`. Session records live in a single server-side SQLite at `$AGENT_CONSOLE_HOME/data.db`, with `sessions.created_by` identifying the session owner.

What is not yet supported: a session whose PTY process runs under a **dedicated service account** rather than any individual user. The motivating use-case is team coordination: a single Orchestrator session that all team members submit requests to through the normal session UI. But the mechanism is general — any workflow that needs a shared compute identity separate from any individual user (shared bots, team dashboards, coordination surfaces) fits here.

This document specifies how to add service-account sessions on top of the existing multi-user foundation.

## Terminology

- **Shared service account** — a dedicated OS account on the server, distinct from the server's service user (`agentconsole`) and from any individual end-user. Operators choose the account name freely. The examples in this document use `agent-console-shared`; that specific name is not a product-level identifier.
- **Shared session** — a session whose `created_by` references the shared service account's `users.id`. Visible and writable by all authenticated users by default; this is the basis on which multiple humans interact with the same PTY through the UI.
- **Personal session** — the existing per-user session (`created_by` references the authenticated user's `users.id`).

## Orchestrator is a Skill, Not a Session Type

The `/orchestrator` skill (`.claude/skills/orchestrator/`) loads a set of behaviours — leadership cadence, delegation pattern, sprint lifecycle procedures. Any session can invoke it. There is no `sessions.type = 'orchestrator'`, no `repositories.orchestrator_session_id`, no claim/release API. Discovery of the Orchestrator-role session is by title; routing from humans to the Orchestrator is by clicking the session in the session list and typing into its PTY terminal.

Consequently:

- A team may run a single shared session with `/orchestrator` invoked and call it "the team Orchestrator".
- A larger organisation may run multiple shared sessions each with `/orchestrator` invoked, each scoped to a different surface (user-facing UI, admin console, infrastructure) and titled accordingly.
- The same service-account mechanism also supports non-Orchestrator shared sessions (team terminal for a shared tool, a coordination channel, etc.).

The **session type** here is "shared" (distinguished from "personal" by whose OS account spawns the PTY). The **role** played by a session is determined by which skill was invoked and what the users ask of it. These two axes are independent.

## Design Goals

1. **Multi-human access through the PTY UI.** Any authenticated user can open a shared session's worker and type into its PTY. No additional inbound-routing machinery is introduced; the session list and PTY terminal already in Agent Console are the interaction surface.
2. **No change to existing storage model.** The single server-side `data.db` and the `sessions.created_by` column already support the distinction.
3. **Clean OS account separation.** The shared service account is distinct from the server's service user (`agentconsole`) — no privilege conflation, no credential sharing between the server process and the spawned CLI processes.
4. **API-key authentication for shared service accounts.** The shared account authenticates to the LLM vendor via an organisation-owned API key (Commercial Terms), independent of any individual user's subscription. Personal sessions continue to use subscription authentication in each user's own OS account.
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
    users                          ← includes shared service account record(s)
    sessions                       ← created_by associates with users.id
                                     (application-level linkage; the shared
                                      service account record is the one
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

<service-account-1>   (shared service account)   shared sessions spawn
<service-account-2>                              as these users
...                                              (examples: agent-console-shared,
                                                  team-frontend-shared, etc.)
```

A shared service account is a normal OS user with its own `$HOME`, its own credential storage, and an entry in the `users` table. Exactly like any authenticated user in structure — the only distinction is that its PTY is reachable by all authenticated users (by policy), and its authentication to the LLM vendor is API-key-based rather than subscription-based.

### Authentication model

| Session type | PTY runs as | Auth method |
|---|---|---|
| Personal session | Authenticated OS user | Subscription (individual `claude login` in that user's home) |
| Shared session | Shared service account | **API key** configured in the service account's home |

Rationale for API keys on shared accounts: a shared account serves multiple people, which fits organisation-level (Commercial Terms) access rather than individual subscription terms. API keys also rotate cleanly and do not break when any one individual's subscription lapses. This is compatible with vendor offerings that provide organisation-level API access.

## Session Creation Flow

End user `userA` clicks "Create shared session" in the UI. If the server is configured with multiple shared service accounts, the UI presents a picker for which account to create under.

1. Client sends a standard session-create request with a `shared` indicator (concrete API schema deferred to implementation) and, if applicable, the chosen shared-account identifier.
2. Server validates `userA`'s JWT via normal auth middleware and checks the shared-session-creation permission (default: all authenticated users may create).
3. Server resolves the selected shared service account's `users.id` from its configuration (see Configuration below).
4. Server creates the session with:
   - `sessions.created_by` = shared service account's `users.id`
   - `sessions.initiated_by` = `userA.id` (optional column, for audit)
5. When the session's PTY is spawned, the server uses `sudo -u <service-account-name> -i sh -c '...'`. The existing `agentconsole ALL=(ALL) NOPASSWD: /bin/sh, /bin/bash, /bin/zsh` sudoers rule covers this — no additional sudoers configuration.
6. The PTY runs with the service account's environment: `$HOME` points to the service account's home, which contains the API-key credentials. The `claude` CLI (or any LLM CLI) authenticates using those credentials.

End-user perspective: a shared session appears in the session list. Any authenticated user can click it, open its worker's PTY, and type into it — exactly like a personal session, except the PTY process is running as the shared service account and the participants include the whole team.

## Permission Model (Initial: Open)

- **Create** — any authenticated user may create a shared session.
- **Read** — any authenticated user may view any shared session's state and worker output.
- **Write (stdin)** — any authenticated user may send input to any shared session's worker PTY.
- **Delete** — any authenticated user may delete any shared session they can see.

This open model matches the "small-team coordination hub" usage described in `docs/strategy/strategy-overview.md` §5 (small-team orchestration). Participant restrictions, role-based access, and admin-only creation can be layered on later via a `sessions.visibility` / `participants` table extension — out of scope for the initial design.

## Data Storage (Unchanged)

- All session rows live in the server-side `data.db`.
- All worker output files live under `$AGENT_CONSOLE_HOME/...` as specified by [`session-data-path.md`](./session-data-path.md), owned by the `agentconsole` service user (same as personal sessions).
- The shared service account's `$HOME` is used only for CLI credentials and any user-facing state the CLI itself writes (shell history, `.claude/` config, etc.). It is not used for session persistence.

## Configuration

Shared service-account sessions are **opt-in**. Deployments that do not want them leave the relevant variables unset; the feature is simply off. Deployments that do want them set the variables to the OS username(s) of the shared account(s).

| Variable | Default | Semantics |
|---|---|---|
| `AGENT_CONSOLE_SHARED_USERNAME` | (unset) | OS username of the default shared service account (single-account case). |

Multiple shared accounts (a natural extension for larger organisations) would use a comma-separated list, a separate per-account config file, or an equivalent mechanism. The initial implementation targets exactly one account via the single variable above; the extension is straightforward when needed.

### Startup behaviour

- **Unset** — shared feature disabled. Server logs one informational line (`"shared service account: disabled (AGENT_CONSOLE_SHARED_USERNAME not set)"`) and continues. UI does not display shared-session affordances.
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

The server operator becomes the shared service account and sets up credentials once.

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
- The session's worker terminal runs as the shared service account (`whoami` inside the terminal returns the account's username).
- `echo $ANTHROPIC_API_KEY` (or equivalent check) confirms the API-key credentials are present.
- Other authenticated users can see and write to the same session.

## Credential Rotation

Rotation is manual, triggered when a key is compromised or reaching expiry:

```bash
sudo -u <service-account-name> -i
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

1. **"Create shared session" affordance** — a distinct button or menu item, visible when at least one shared service account is configured.
2. **Visual distinction for shared sessions** — badge, colour, or label so users know they are typing into a shared space (reduces accidental secret leakage into a visible-to-all terminal).
3. **List / filter** — shared sessions appear in all users' session lists by default. The existing per-user filter can be extended with a "shared only" or "personal only" toggle.
4. **Indicator of other active participants** (optional) — "3 users currently viewing" — useful for coordination but out of scope for the minimum viable implementation.

The Orchestrator-role session, when a team runs one, is discovered the same way as any other shared session: by title in the session list.

## Security Considerations

### Why shared service accounts are separate from the server service user

The server's service user (`agentconsole`) runs the Hono process and has `NOPASSWD` sudo to any OS user. Running a shared session as the service user would introduce these risks:

1. **JWT secret exposure** — the server stores `${AGENT_CONSOLE_HOME}/jwt-secret`. A PTY running as the service user can read it and exfiltrate via stdin interactions, enabling session forgery.
2. **Direct DB write capability** — `data.db` is owned by the service user. A PTY running as the service user bypasses the server's validation layer.
3. **Sudo privilege amplification** — the service user can `sudo -u` to any account. A PTY with that identity can be coerced into elevating privileges.

Keeping the shared service account distinct from the service user preserves defense-in-depth: the service process only spawns PTYs; the LLM process only runs the LLM.

### Why API key, not subscription, for shared service accounts

- **Commercial compliance** — personal subscription terms typically preclude multi-user business use. An organisation-owned API key (Commercial Terms) is the appropriate authentication form for shared infrastructure.
- **Operational independence** — the shared account does not break when any individual's subscription lapses.
- **Credential rotation** — API keys rotate cleanly; subscription login flows are awkward to rotate without human interaction.
- **Billing attribution** — API-key usage is attributed to the organisation via the vendor's billing dashboard.

### Stdin to a shared session

Any authenticated user can type into a shared session. This is an intentional property of the "single entry point for team coordination" use case, not a bug. Practical considerations:

- **Visible to all** — operators should remind the team that content typed into a shared session is visible to every team member. The UI affordance reinforces this.
- **No content moderation in the first version** — the session is trusted within the team's trust boundary.
- **Audit** — `sessions.initiated_by` records the session creator. A future `participant_events` table could log per-stdin-message authorship if needed.

## Schema Notes

Initial minimum schema changes: **none required**. The existing `users` and `sessions` tables handle shared service accounts via `created_by`.

Optional additions considered but deferred:

- `sessions.initiated_by` — who created the shared session (distinct from `created_by` which represents the PTY identity). Useful for audit. Can be added as a nullable column in a later migration.
- `sessions.visibility` enum (`personal`, `shared`, `team-private`) — generalises beyond "all-or-nothing" for future permission extensions.
- `participants` table — for invite-only shared sessions.

Decisions about `sessions.created_by` gaining a DB-level `REFERENCES users(id)` are tracked separately in Issue [#680](https://github.com/ms2sato/agent-console/issues/680).

## Open Questions

- **Multiple shared service accounts.** Concrete config form for more than one account (comma-separated env var, config file, or per-repository association). Schema-wise free; runtime form is an implementation choice.
- **Shared session audit depth.** Current design records creator. Per-stdin-message authorship would require an additional table — revisit if team operators report need.
- **API-key storage form inside the shared account's home.** Two equivalent options: env-var export in shell profile, or CLI-native credential file. Operator choice; does not affect the server.
- **Repository registration via clone URL.** Shared-service-account sessions operating on a repository currently assume the shared account already has a local clone (registered via the existing path-based `registerRepository` flow in `packages/server/src/services/repository-manager.ts`). Multi-user rollout likely benefits from a "clone from URL on behalf of account X" flow. Tracked as a pre-requisite design item for multi-user implementation.

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
