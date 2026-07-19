---
name: dev-environment-quirks
description: Non-obvious operational details of the local dev environments (single-user `dev.sh`, multi-user `dev-multiuser.sh`, Docker dev stack `docker/docker-compose.yml`) — port layout, source-code propagation, sudo boundaries, multi-repo coexistence. Read when a delegated agent or the Orchestrator first needs to interact with the running dev instance, especially for Browser QA, log inspection, or restart workflows.
---

# Dev Environment Quirks

This skill captures the operational reality of the dev environments that is not obvious from reading the scripts. Each item is something the Sprint 2026-06-30 retrospective surfaced as a "discovered the hard way" trap.

## Two dev scripts, one shared data root

- `scripts/dev.sh` — single-user instance under `$HOME/.agent-console-dev`. Runs as the developer user. Suited for ordinary client / server work without multi-user concerns.
- `scripts/dev-multiuser.sh` — multi-user instance under `/var/lib/agent-console-dev`. Runs the server as the production service user (`agentconsole`) with production-mirrored ownership (`agentconsole:agent-console-users 2775`, setgid). The developer accesses the data via group membership + `core.sharedRepository=group`.

**Only one can run at a time** — both use port 3457 for the backend and port 5173 for vite (client), and both write to `/var/lib/agent-console-dev` (multi-user) or `$HOME/.agent-console-dev` (single-user). Concurrent runs collide on ports and corrupt each other's session DB.

## Docker dev stack: the AI-drivable multi-user environment

`docker/docker-compose.yml` is a third dev environment: a **multi-user dev server inside a container**, launchable with `docker` group membership alone — no privilege elevation, no password prompt. This is the default choice when a delegated agent needs to start / restart / debug a multi-user instance autonomously. Full guide: `docker/README.md`.

Operational facts that differ from the host-side scripts:

- **No rsync step.** The repo is bind-mounted; the server's `bun --watch` and vite HMR both react to host-side edits live. The `dev-multiuser.sh` "server code is a frozen snapshot" trap does not exist here.
- **Ports are env-mapped.** Container-internal ports are fixed (vite `5173`, server `3457`); host mapping is set at `up` time via `DEV_CLIENT_PORT` / `DEV_SERVER_PORT`. Because host `5173`/`3457` are often taken by `dev.sh`, `dev-multiuser.sh`, or another repo's vite, prefer explicit overrides (e.g. `DEV_CLIENT_PORT=15173 DEV_SERVER_PORT=13457 docker compose -f docker/docker-compose.yml up -d`). Changing the mapping requires `up -d` (recreate), not `restart`.
- **Login uses baked test users** (`alice` / `bob`, passwords in `docker/README.md`), not host OS accounts. The elevation path (`shouldElevateForUser` → PTY as the target user) is genuinely exercised in-container.
- **It does NOT exercise host OS quirks.** sudoers drift, PAM config, PATH/login-shell issues on the real host still need `dev-multiuser.sh` or the production instance.
- **Coexists with the verification stack** (`docker/docker-compose.verification.yml`, host port 8080 — which on the dogfood host is also the production port, so give the verification stack a different `PORT` when production is running).
- Logs / restart / shell: `docker compose -f docker/docker-compose.yml logs --tail 100 -f`, `... restart agent-console-dev`, `... exec -u agentconsole agent-console-dev sh`.
- **Known limitation: the vite `/ws` proxy is currently unreliable in this stack** (Issue #1211 — the Dashboard can hang forever on "Loading sessions..." with no client-side error). Root cause is unresolved as of this writing (ruled out: `changeOrigin`, IPv6/DNS fallback asymmetry, vite's upgrade-dispatch registration, a Bun 1.3.8→1.3.10 bump). For WS-dependent QA, prefer `scripts/dev-multiuser.sh` or `docker/docker-compose.verification.yml` until #1211 is resolved.

## Multi-user dev: source propagation is rsync, not live

`dev-multiuser.sh` rsyncs the current git checkout to `/home/agentconsole/agent-console-dev/` once at startup, then starts the server (via `sudo -u agentconsole`) from that snapshot path. The developer's worktree is the source for the rsync; it is **not** the source for the running server.

Consequences:

- **Server-side edits in the developer's worktree do not propagate live.** Vite client HMR works as usual because vite runs from the developer's checkout, but the server's `bun --watch` runs against the rsync target, which is frozen until the next `dev-multiuser.sh` invocation. To pick up a server change, stop the script (Ctrl+C) and re-run it; the rsync runs again.
- **`REPO_ROOT=/path/to/other/worktree` env override is the standard pre-merge-PR test pattern.** When verifying a PR branch other than the developer's primary worktree, set `REPO_ROOT` before invoking the script so it rsyncs the PR branch's code into the dev instance.
- The script's prologue documents this trade-off explicitly. Re-read it when in doubt.

## Sudo boundary: agent shell vs server shell

The developer's interactive shell (delegate-spawned or otherwise) runs as `ms2sato` (or whoever the developer is). The server side of `dev-multiuser.sh` runs as `agentconsole` via `sudo -u agentconsole`.

This means a delegated agent typically:

- **Cannot read** `/home/agentconsole/...` paths from its own shell — permission denied unless explicit group permissions allow it.
- **Cannot stop the multi-user dev server** without `sudo`. The `bash scripts/dev-multiuser.sh` parent process is owned by the developer (signalable from the agent's shell), but the `sudo -u agentconsole bun --watch` child is owned by root / agentconsole and survives parent termination. Killing the whole tree requires either the parent script's signal-handler propagation working cleanly or a follow-up `sudo kill` issued by the owner.
- **Must surface "need sudo" decisions to the Orchestrator or the owner** rather than attempting silent workarounds. The orchestrator skill rules forbid using `force` options without explicit approval, and this is the operational reason.

When a permission-denied error appears, do **not** suppress stderr (`2>/dev/null`) — it is the only way to distinguish "the file does not exist" from "the file exists but the calling user cannot read it." See `development-workflow-standards.md` "Diagnostic Command Error Suppression."

## Port layout reference

Default ports for the dev / production split on this host (and the convention in `dev-multiuser.sh`):

| Port | What | Notes |
|---|---|---|
| 8080 | Production agent-console instance | Hosts the orchestrator session; do not stop without owner approval. Restart re-deploys the latest merge. |
| 3457 | Dev backend (single-user or multi-user) | Only one dev instance can listen at a time. |
| 5173 | Dev frontend (vite) | Sibling of 3457. |

`ss -tlnp | grep -E ':3457|:5173|:8080'` is the canonical "what is running?" check.

## Multi-repo coexistence in the dev instance

The dev instance under `/var/lib/agent-console-dev/repositories/` can host more than one registered repository at a time (e.g., `agent-console`, `conteditor`, `es-rag`, …) and each can carry its own active worktrees and sessions. The orchestrator session's `list_repositories` call shows only the repositories registered in the **production** instance (port 8080); the dev instance's registry is independent.

Practical consequence: before stopping a running dev instance, check the running process tree for `sudo -u <user> ... AGENT_CONSOLE_SESSION_ID='...'` children. Each one is an active delegated session, possibly from a sibling repository the developer is also working on. Stopping the dev instance kills all of those sessions. The owner is the only party that knows which sessions are still load-bearing — confirm before sending SIGTERM.

## How to verify after a multi-user dev restart

Sequence the owner usually wants after applying a server-side fix:

1. Stop the running `dev-multiuser.sh` (Ctrl+C in its terminal, or the staged `sudo kill <pids>` if the parent script is already gone).
2. Confirm ports 3457 and 5173 are free (`ss -tlnp | grep -E ':3457|:5173'` returns nothing).
3. Re-launch with the appropriate `REPO_ROOT`: `REPO_ROOT=/path/to/wt-XXX bash scripts/dev-multiuser.sh`.
4. Wait for both ports to listen again, then reload the browser tab at `localhost:5173`. Vite HMR may have kept the page alive across the gap, but the backend has restarted, so any open WebSocket reconnects via the existing scrollback-restore path.

## Cross-references

- `scripts/dev.sh` and `scripts/dev-multiuser.sh` — canonical scripts (the prologues are required reading).
- `docker/README.md` — the Docker dev stack (AI-drivable multi-user environment) and the verification stack.
- `docs/multi-user-setup-guide.md` — operator-side setup, including the multi-repo-coexistence note.
- `.claude/skills/development-workflow-standards/development-workflow-standards.md` "Diagnostic Command Error Suppression" — the discipline that prevents misinterpreting permission denied as not-found inside this environment.
- `.claude/skills/orchestrator/core-responsibilities.md` "Delegation Prompt Mandatory Checklist" item 4 — environment constraint pre-disclosure for delegated agents.
- Sprint 2026-06-30 retrospective — the source incidents for each section.
