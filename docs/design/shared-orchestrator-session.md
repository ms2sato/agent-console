# Shared Orchestrator Session — Design

## Context

Agent Console currently supports multi-user mode via `AUTH_MODE=multi-user` (see [`multi-user-shared-setup.md`](./multi-user-shared-setup.md)). In that mode, each authenticated OS user has their own personal sessions, and PTY processes are spawned as that user via `sudo -u`. Session records live in a single server-side SQLite at `$AGENT_CONSOLE_HOME/data.db`, with `sessions.created_by` identifying the owner.

What is not yet supported: a **shared Orchestrator session** that all team members can see and interact with. The intended usage is a single entry point through which multiple humans submit requests — the Orchestrator coordinates, resolves conflicts, and dispatches — enabling coherent team development.

This document specifies how to add shared sessions on top of the existing multi-user foundation.

## Terminology

- **Shared Orchestrator account**: a dedicated OS account on the server whose identity is used by shared Orchestrator sessions. Operators choose the account name freely (example used in this doc: `agent-console-shared`). The name is not a product-level identifier.
- **Shared session**: a session whose `created_by` references the shared Orchestrator account's `users.id`. Visible and writable by all authenticated users by default.
- **Personal session**: the existing per-user session (`created_by` references the authenticated user's `users.id`).

## Design Goals

1. **Single entry point for team coordination.** A shared Orchestrator receives requests from multiple humans and keeps team development coherent.
2. **No change to existing storage model.** The single server-side `data.db` and the `sessions.created_by` column already support the required distinction.
3. **Clean OS account separation.** The shared account is distinct from the server's service user (`agentconsole`) — no privilege conflation, no credential sharing between the service process and the LLM process.
4. **API-key authentication for the shared account.** The shared account uses API-key-based authentication (organization-owned credentials), independent of any individual user's subscription. Personal sessions continue to use subscription authentication on each user's OS account.
5. **No user-side impersonation burden.** End users click a button; the server handles OS-level impersonation (via the existing `agentconsole` sudo privilege). No `sudo` or account switching is required from end-user terminals.

## Non-Goals

- Supporting multiple concurrent shared accounts with different responsibilities — the initial design assumes one shared account. The schema does not forbid more; runtime semantics for "which shared account handles which workflow" are deferred.
- Per-participant access control (invite-only shared sessions). Initial permission model is open to all authenticated users.
- Internal billing / usage dashboard inside Agent Console. External Anthropic console dashboards cover usage visibility for the initial release.
- Automatic credential rotation. Rotation is a manual operational procedure (documented below).

## Architecture Overview

### Storage layer — reuse existing

```
$AGENT_CONSOLE_HOME/data.db        ← single DB (unchanged)
    users                          ← includes shared account record
    sessions                       ← created_by → users.id (shared account for shared sessions)
```

No schema changes are required for the minimum viable version. Optional additions below are for future observability.

### Identity layer — one additional OS account

```
agentconsole          (service user)         runs server process,
                                             NOPASSWD sudo to any user

userA, userB, ...     (authenticated users)   personal sessions spawn
                                             as these users

<shared-account-name> (shared orchestrator)   shared sessions spawn
                                             as this user
                                             (example: agent-console-shared)
```

The shared account is a normal OS user. It has its own `$HOME`, its own credential storage, and is known to the `users` table like any other account.

### Authentication model

| Session type | PTY runs as | Auth method |
|---|---|---|
| Personal session | Authenticated OS user | Subscription (individual `claude login` in that user's home) |
| Shared session | Shared Orchestrator OS account | **API key** configured in the shared account's home |

Rationale: the shared account serves multiple people (plausible commercial use) and should not depend on any one individual's personal subscription. API-key-based authentication matches the organizational-ownership pattern and aligns with Anthropic's Commercial Terms for multi-user workloads. This is compatible with vendor offerings that provide organization-level API access.

## Session Creation Flow

End user `userA` clicks "Create shared Orchestrator session" in the UI.

1. Client sends a standard session-create request with a new field `shared: true` (or an equivalent — see API schema below).
2. Server validates `userA`'s JWT (normal auth middleware) and checks the shared-session-creation permission (default: all authenticated users may create).
3. Server resolves the shared account's `users.id` (looked up by configuration — the server operator sets the shared account's username via env var, see Configuration below).
4. Server creates the session with:
   - `sessions.created_by` = shared account's `users.id`
   - `sessions.initiated_by` = `userA.id` (optional column, for audit)
5. When the session's PTY is spawned, the server uses `sudo -u <shared-account-name> -i sh -c '...'`. The existing `agentconsole ALL=(ALL) NOPASSWD: /bin/sh, /bin/bash, /bin/zsh` sudoers rule covers this — no additional sudoers configuration.
6. The PTY runs with the shared account's environment: `$HOME` points to the shared account's home, which contains the API-key credentials. The `claude` CLI (or any LLM CLI) authenticates using those credentials.

End user perspective: a shared session appears. They can write to its stdin and receive its stdout like any personal session. No `sudo`, no account switching.

## Permission Model (Initial: Open)

- **Create**: any authenticated user may create a shared session.
- **Read**: any authenticated user may view any shared session's state and worker output.
- **Write (stdin)**: any authenticated user may send input to any shared session's worker PTY.
- **Delete**: any authenticated user may delete any shared session they can see.

This open model matches the "small-team coordination hub" usage described in `docs/strategy/strategy-overview.md` §5 (small-team orchestration). Participant restrictions, role-based access, and admin-only creation can be layered on later via a `sessions.visibility` / `participants` table extension — out of scope for this initial design.

## Data Storage (Unchanged)

- All session rows live in the server-side `data.db`.
- All worker output files live under `$AGENT_CONSOLE_HOME/...` as specified by `docs/design/session-data-path.md`, owned by the `agentconsole` service user (same as personal sessions).
- The shared account's `$HOME` is used only for CLI credentials and any user-facing state the CLI itself writes (shell history, `.claude/` config, etc.). It is not used for session persistence.

## Configuration

Shared orchestrator is **opt-in**. Teams that do not want a shared Orchestrator leave the variable unset; the feature is simply off. Teams that do want it set the variable to the OS username of the shared account.

| Variable | Default | Semantics |
|---|---|---|
| `AGENT_CONSOLE_SHARED_USERNAME` | (unset) | OS username of the shared Orchestrator account. |

### Startup behaviour

- **Unset** — shared feature disabled. Server logs one informational line (`"shared orchestrator: disabled (AGENT_CONSOLE_SHARED_USERNAME not set)"`) and continues. UI does not display shared-session affordances.
- **Set, and the OS account exists** — server upserts the account into `users` on startup, enables shared-session creation endpoints and UI.
- **Set, and the OS account does not exist** — server **fails fast at startup** with a clear error instructing the operator to create the OS account or unset the variable. This catches misconfiguration (typos, accidental unset during deployment) before users encounter a missing button.

### Relationship to `AUTH_MODE`

- In `AUTH_MODE=multi-user`, `AGENT_CONSOLE_SHARED_USERNAME` is honoured per the rules above.
- In `AUTH_MODE=none`, `AGENT_CONSOLE_SHARED_USERNAME` is ignored — shared sessions require multi-user authentication to be meaningful.

Multiple shared accounts (a future extension) would use a comma-separated list or a separate per-account config file; the initial design supports exactly one.

## Operational Setup

One-time setup on the server (only in `AUTH_MODE=multi-user`):

### 1. Create the shared OS account

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
  # Configure the LLM CLI with an organization-level API key.
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
- The session's worker terminal runs as the shared account (`whoami` inside the terminal returns the shared account's username).
- `echo $ANTHROPIC_API_KEY` (or equivalent check) confirms the API-key credentials are present.
- Other authenticated users can see and write to the same session.

## Credential Rotation

Rotation (manual, triggered when a key is compromised or reaching expiry):

```bash
sudo -u <shared-account-name> -i
  # Update the CLI's stored credential with the new API key.
  # If it's an env-var-based setup: edit ~/.zshrc (or equivalent).
  # If it's a login-based setup: re-run the login command with the new key.
  exit

# Optional: restart active shared-session PTYs so they pick up the new key.
# (If the CLI re-authenticates on each spawn, no restart is needed.)
```

Rotation frequency is an operator decision; typical: every 6–12 months or immediately on suspected compromise.

## UI / UX

Minimum viable changes:

1. **"Create shared session" affordance** — a distinct button / menu item, visible when `AGENT_CONSOLE_SHARED_USERNAME` is configured on the server.
2. **Visual distinction for shared sessions** — badge, colour, or label so users know they are typing into a shared space (to reduce accidental secret leakage).
3. **List / filter** — shared sessions appear in all users' session lists by default. The existing per-user filter can be extended with a "shared only" or "personal only" toggle.
4. **Indicator of other active participants** (optional) — "3 users currently viewing" — useful but out of scope for the minimum viable implementation.

## Security Considerations

### Why the shared account is separate from the service user

The server's service user (`agentconsole`) runs the Hono process and has `NOPASSWD` sudo to any OS user. Running the shared Orchestrator as the same user would introduce these risks:

1. **JWT secret exposure** — the server stores `${AGENT_CONSOLE_HOME}/jwt-secret`. A PTY that runs as the service user can read it and exfiltrate via stdin interactions, enabling session forgery.
2. **Direct DB write capability** — `data.db` is owned by the service user. A PTY that runs as the service user bypasses the server's validation layer.
3. **Sudo privilege amplification** — the service user can `sudo -u` to any account. A PTY with that identity can be coerced into elevating privileges.

Keeping the shared account distinct from the service user preserves defense-in-depth: the service process only spawns PTYs; the LLM process only runs the LLM.

### Why API key, not subscription, for the shared account

- **Commercial compliance**: personal subscription terms typically preclude multi-user business use. An organization-owned API key (Commercial Terms) is the appropriate authentication form for shared infrastructure.
- **Operational independence**: the shared account does not break when any individual's subscription lapses.
- **Credential rotation**: API keys rotate cleanly; subscription login flows are awkward to rotate without human interaction.
- **Billing attribution**: API-key usage is attributed to the organization via the vendor's billing dashboard.

### Stdin to shared session

Any authenticated user can type into a shared session. This is an intentional property of the "single entry point for team coordination" use case, not a bug. Practical considerations:

- **Visible to all**: operators should remind users that shared sessions are public within the team. The UI affordance above reinforces this.
- **No content moderation in the first version**: the session is trusted within the team's trust boundary.
- **Audit**: `sessions.initiated_by` records the creator. A future `participant_events` table could log per-message authorship if needed.

## Schema Notes

Initial minimum schema changes: **none required**. The existing `users` and `sessions` tables handle the shared case via `created_by`.

Optional additions considered but deferred:

- `sessions.initiated_by` — who created the shared session (distinct from `created_by` which represents the PTY identity). Useful for audit. Can be added as a nullable column in a later migration.
- `sessions.visibility` enum (`personal`, `shared`, `team-private`) — generalises beyond "all-or-nothing" for future permission extensions.
- `participants` table — for invite-only shared sessions.

## Open Questions

- **Multiple shared accounts.** Whether to allow more than one shared Orchestrator account (e.g., different responsibilities). Schema-wise it is free; the runtime question is which account handles which UI entry point. Deferred.
- **Shared session creator identity in audit logs.** If a shared session causes an incident, tracing which authenticated user initiated or what they wrote depends on audit additions (above). Current design does not persist per-stdin-message authorship.
- **API-key storage form inside the shared account's home.** Two equivalent options: env-var export in shell profile, or CLI-native credential file. Choice is operator-driven and does not affect the server.
- **Internal usage dashboard.** Out of scope now; external Anthropic console covers billing. Revisit if team operators need per-session-level attribution.

## Migration / Rollout

This is additive: pre-existing personal sessions and the single-user `AUTH_MODE=none` flow are unchanged.

1. Merge the server code supporting `AGENT_CONSOLE_SHARED_USERNAME` + shared-session UI.
2. Existing deployments: no mandatory action. Shared-session creation is disabled when the env var is unset.
3. Operators who want shared sessions: perform the Operational Setup above, set the env var, restart the server.

Rollback: unset `AGENT_CONSOLE_SHARED_USERNAME` and restart. Existing shared-session rows remain in the DB (harmless) but cannot be spawned until the env var is restored.

## References

- [`multi-user-shared-setup.md`](./multi-user-shared-setup.md) — base multi-user authentication, sudoers, per-user PTY spawn model
- [`session-data-path.md`](./session-data-path.md) — session data storage and path-resolution contract
- [`session-worker-design.md`](./session-worker-design.md) — session / worker architecture
- `docs/strategy/strategy-overview.md` §5 "Small-team orchestration" — the strategic target this design serves
- `docs/narratives/2026-04-18-strategic-position.md` — phenomenological background for the small-team direction
