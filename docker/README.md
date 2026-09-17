# Multi-User Mode on Docker (dev + verification)

This directory contains two Docker Compose stacks built from the **same
image** (`docker/Dockerfile`). The image provides the OS layer that
multi-user mode needs — `pamtester`, `sudo`, the non-root `agentconsole`
service user, the `agent-console-users` shared group, and two test users
(`alice`, `bob`) with known passwords. The stacks differ only in how the
application runs:

| Stack | Compose file | What runs | When to use |
|------|---------------|-----------|-------------|
| **Dev** (default) | `docker-compose.yml` | vite + `bun --watch` against the **bind-mounted repo** (HMR, live server reload) | Daily multi-user development and debugging. `docker` group membership is enough to start/restart/inspect it — no privilege elevation. **Browser QA through this stack is currently blocked**: the vite `/ws` proxy hangs inside a container (Issue [#1211](https://github.com/ms2sato/agent-console/issues/1211), root-caused to a Bun-engine issue, not fixable by vite config). Use the **Verification** stack or `scripts/dev-multiuser.sh` for WS-dependent QA until that's resolved upstream. |
| **Verification** | `docker-compose.verification.yml` | The **built `dist/` bundle**, baked into the image, production-like | CI E2E (`scripts/verify-multiuser-docker.sh`) and pre-release verification of the standalone bundle. Tier 2 of `.claude/rules/os-environment-coupling.md` Discipline 4 (no systemd; `docker` group only, no privilege flag). |
| **Systemd (tier 3)** | `docker-compose.systemd.yml` | `docker/Dockerfile.systemd`: systemd as PID 1, no application baked, driven by `scripts/verify-multiuser-systemd.sh` | The setup script, the deploy script (as the operator), unit render + drift detection, `MainPID` identity — the "systemd unit's own environment" residue this file's Verification stack cannot reach. **Ephemeral CI runner or a personal workstation ONLY, never the dogfood host** — see [Systemd stack (tier 3)](#systemd-stack-tier-3) below. |

Both stacks use distinct project names, container names, volumes, and host
ports, so they can run **side by side**.

> Neither stack is a production deployment recipe. Production runs under
> systemd behind TLS — see [`../docs/multi-user-setup-guide.md`](../docs/multi-user-setup-guide.md).

## What's in here

| File | Purpose |
|------|---------|
| `Dockerfile` | Two-stage build: build the `dist/` bundle, then a runtime image with `pamtester`, `sudo`, the `agentconsole` service user, and test users. Shared by both stacks. |
| `docker-compose.yml` | **Dev stack**: repo bind mount + dev servers, host ports `5173`/`3457` (env-configurable). |
| `docker-compose.verification.yml` | **Verification stack**: runs the baked bundle in `AUTH_MODE=multi-user` on host port `8080`. |
| `dev-entrypoint.sh` | Dev-stack entrypoint: fixes volume-mountpoint ownership as root, drops to `agentconsole`, runs `bun install`, starts vite + server. |
| `sudoers-agentconsole` | Grants the service user permission to launch login shells as any non-root user. |
| `verify-client.ts` | Drives the real shipping path (login → session → terminal worker → WS) and asserts `whoami` inside the PTY; also supports `--attach` (probe an already-existing session/worker) and `--list-session` (assert a session is visible via the app WebSocket's `sessions-sync` frame). |
| `tsconfig.json` | Scopes `verify-client.ts` to a Bun-specific type environment (no `DOM` lib), so the global `WebSocket` binding resolves to Bun's `headers`-accepting constructor overload instead of the DOM one. Type-checked as `typecheck:docker` (`tsc -p docker`), which the root `typecheck` script runs as part of `bun run typecheck` — no separate invocation to remember. It borrows Bun's ambient type declarations from `packages/server`'s installed `@types/bun` via `typeRoots`, since `docker/` is not its own workspace member and has no `node_modules` of its own. |
| `../scripts/verify-multiuser-docker.sh` | One-command verification orchestrator: build, start, run all checks, report. |
| `Dockerfile.systemd` | Tier-3 image: systemd as PID 1, no application and no service-user elevation rules baked (the setup script installs both at container runtime); the operator's rules file (`deployer-elevation-rules` below) IS baked, since the deploy script's self-elevation contract is what tier 3 exists to verify. See [Systemd stack (tier 3)](#systemd-stack-tier-3). |
| `docker-compose.systemd.yml` | **Systemd stack**: boots `Dockerfile.systemd` with the least-privilege flag set measured in `docs/design/elevation-verification-tiers.md`'s Task 0. |
| `deployer-elevation-rules` | The operator's passwordless elevation rule (`deployer ALL=(ALL:ALL) NOPASSWD: ALL`), installed into the tier-3 image at build time so the deploy script's per-step self-elevation contract (#1690) can be verified for real. |
| `../scripts/verify-multiuser-systemd.sh` | Tier-3 driver: setup `--dry-run`/`--force` as root, deploy as the operator, the #1688 drift arm, the three #1690 helper cases, and `check-embedded-agent-elevation.ts` against the real unit's `MainPID`. Refuses to run unless `AC_TIER3_RUNNER=github-hosted` or `AC_TIER3_HOST_OK=1` is set — never on the dogfood host. |

## Dev stack

### Quick start

From the repository root:

```bash
docker compose -f docker/docker-compose.yml up --build -d
```

First start builds the image (minutes) and runs a full `bun install` inside
the container; subsequent starts reuse both. Wait for the health check:

```bash
docker compose -f docker/docker-compose.yml ps          # healthy?
curl -s http://localhost:3457/api/config                # {"authMode":"multi-user",...}
```

Then open `http://localhost:5173` and log in as a test user (see
[Test credentials](#test-credentials-verification-only) below).

### Host ports

Container-internal ports are fixed (vite `5173`, API server `3457`); the
host-side mapping is env-configurable so the stack coexists with other
repos' dev servers:

| Env var | Default | Maps to |
|---------|---------|---------|
| `DEV_CLIENT_PORT` | `5173` | vite dev server (open this in the browser) |
| `DEV_SERVER_PORT` | `3457` | API server (direct `curl` debugging) |

```bash
DEV_CLIENT_PORT=15173 DEV_SERVER_PORT=13457 \
  docker compose -f docker/docker-compose.yml up -d
```

Both ports bind to loopback only — the image ships known test credentials
and must never be reachable from the LAN.

### How it works

- The repo is bind-mounted at `/app`, so **vite HMR and the server's
  `bun --watch` pick up host-side edits immediately** — no rsync step, no
  image rebuild (contrast with `scripts/dev-multiuser.sh`, where server code
  is a frozen rsync snapshot).
- `node_modules` are **container-side named volumes** (host installs are not
  binary-compatible: bun-pty is a native module). The container runs its own
  `bun install --frozen-lockfile` on every start — a no-op when nothing
  changed.
- The server runs as the `agentconsole` service user with real in-container
  privilege elevation, so logging in as `alice`/`bob` genuinely exercises
  the `shouldElevateForUser` path (PTYs spawn under the test user's own OS
  identity).
- Dev data (DB, jwt-secret, worktrees) lives in the `dev-data` volume at
  `/var/lib/agent-console` and persists across `down`/`up`.

Named volumes (all under the `agent-console-dev` compose project):
`root-node-modules`, `client-node-modules`, `server-node-modules`,
`shared-node-modules`, `integration-node-modules`,
`embedded-agent-node-modules`, `dev-data`. Remove them with
`docker compose -f docker/docker-compose.yml down -v` for a from-scratch
start.

### Driving the stack as an AI agent

Everything below needs only `docker` group membership — no elevation, no
password prompt:

```bash
COMPOSE="docker compose -f docker/docker-compose.yml"

$COMPOSE up -d                        # start (or apply compose changes)
$COMPOSE restart agent-console-dev    # restart both dev servers
$COMPOSE logs --tail 100 -f           # tail vite + server logs
$COMPOSE exec agent-console-dev sh    # shell inside the container (agentconsole)
$COMPOSE exec -T agent-console-dev id # one-off command
$COMPOSE down                         # stop (dev data volume survives)
```

Notes:

- Server code changes are picked up live by `bun --watch`; client changes by
  vite HMR. A restart is only needed when dependencies or env/compose config
  change.
- `exec` lands as the container's initial user (root); use
  `$COMPOSE exec -u agentconsole agent-console-dev sh` to inspect as the
  service user, or `-u alice` for a test user's view.
- If the checkout had no `node_modules` directories when the stack first
  started, Docker creates empty root-owned placeholder dirs on the host at
  the volume mountpoints (`node_modules`, `packages/*/node_modules`). They
  are harmless shadows; a later host-side `bun install` replaces them.
- Files the container writes into the repo bind mount (in practice only
  `packages/client/src/routeTree.gen.ts`, which is gitignored) appear on the
  host owned by the container's uid but group-writable via the repo group,
  so host-side work is unaffected.

### Dev stack vs `scripts/dev-multiuser.sh`

| | Docker dev stack | `dev-multiuser.sh` |
|---|---|---|
| Needs host privilege elevation | No (docker group only) | Yes (interactive password) |
| Server code propagation | Live (`bun --watch` on bind mount) | Frozen rsync snapshot; re-run to re-sync |
| Login accounts | Baked test users (`alice`/`bob`) | Real host OS accounts |
| Data root | `dev-data` volume (container) | `/var/lib/agent-console-dev` (host) |
| Exercises host-specific quirks (sudoers, PAM config, PATH) | No — container OS only | Yes |

Use the Docker stack for autonomous debugging and multi-user flow QA; use
`dev-multiuser.sh` when the behavior under test depends on the real host's
OS configuration.

## Verification stack

From the repository root (requires `docker` and `bun` on the host):

```bash
scripts/verify-multiuser-docker.sh
```

This builds the image, starts the container, runs every check, prints a
pass/fail summary, and tears the container down. Useful flags:

- `--keep` — leave the container running afterwards (inspect at http://localhost:8080).
- `--no-build` — reuse the already-built image.
- `--smokes` — also run the repository's real-host smoke scripts inside the container (see [below](#real-host-smokes-inside-the-container)).
- `PORT=9090 scripts/verify-multiuser-docker.sh` — map a different host port.

Manual start:

```bash
docker compose -f docker/docker-compose.verification.yml up --build -d
```

### What it checks

1. `GET /api/config` reports `"authMode":"multi-user"`.
2. An unauthenticated request to a protected route returns `401`.
3. Login with a wrong password returns `401` (proves `pamtester` is actually running).
4. `alice` / `bob` log in successfully (`200`).
5. **Identity isolation**: `alice`'s terminal `whoami` prints `alice`, `bob`'s
   prints `bob` — never the `agentconsole` service user.
6. File upload creates the upload dir with mode `2750` (setgid regression, #830).
7. Worktree creation runs as the requesting user (#838).
8. **Shared Account**: a shared session (`shared: true`) created by `alice`
   spawns its terminal as the shared account (`shared1`), not `alice`, so the
   PTY's `whoami` prints `shared1`; the session row's `created_by` is
   `shared1`'s `users.id` while `initiated_by` is `alice`'s; and `bob`,
   logged in separately, both sees the session in the app WebSocket's
   `sessions-sync` frame and can type into its PTY. This is the
   shared-session feature's only automated coverage.

   The negative arm is exercised the same way: running with
   `AGENT_CONSOLE_SHARED_USERNAME=` (explicitly empty) turns the feature
   off — the compose file uses the `${VAR-default}` no-colon form, so an
   empty host value passes through unchanged — and check 8 then fails
   visibly with `HTTP 400` and the server's "Shared sessions are not
   enabled on this server." body:

   ```bash
   AGENT_CONSOLE_SHARED_USERNAME= scripts/verify-multiuser-docker.sh --no-build
   ```

9. **Worker-restart branch rename uses the session's spawn user, not the
   requester** (Issue #1622): `POST /workers/:workerId/restart` with a
   `branch` field runs `git branch --show-current` / `git branch -m` as
   `resolveSpawnUsername(session.createdBy)` -- the session's spawn user --
   never the authenticated caller. Two sub-checks, both driving the same
   restart endpoint against a fresh worktree session (created with
   `autoStartSession: true`, which auto-creates a PTY `agent` worker via the
   default terminal agent -- this works with no real `claude` CLI installed,
   since PTY allocation succeeds independently of whether the exec'd agent
   command is actually runnable):
   - **(i)**: restart-with-branch as `alice`, on a worktree session `alice`
     owns -- verifies the fix in the ordinary case.
   - **(iii)**: the identity-choice discriminator. A worktree session created
     with `shared: true` runs as the shared account (`shared1`), but `alice`
     triggers its restart over HTTP. Only a fix that resolves the
     *session's* spawn user (not the requester's) passes: a requester-based
     fix would still try to run git as `alice` against a worktree directory
     owned by `shared1`, hitting the same "dubious ownership" class of error
     the original bug report describes. The check reads the renamed branch
     back **as `shared1`**, not `alice`.

   (Sub-check (ii) -- rename via the session-edit route -- was scoped out:
   that route no longer accepts a `branch` field, and the code path it would
   have exercised was found dead and deleted, not fixed.)

### Real-host smokes inside the container

```bash
scripts/verify-multiuser-docker.sh --smokes
```

Combinable with `--keep` and `--no-build`. In addition to the checks above,
`--smokes` runs the repository's seven real-host smoke scripts
(`scripts/smoke/check-*.ts`) *inside* the verification container, as the
service user (`agentconsole`), against target user `alice`:

- `check-multiuser-pty-env.ts`
- `check-kill-as-user.ts`
- `check-login-shell-sentinel.ts --elevated`
- `check-orphan-sweep.ts`
- `check-delegated-ssh-auth-sock.ts`
- `check-embedded-agent-elevation.ts`
- `check-embedded-agent-bash-env.ts`

Each of these smokes states its own requirement as "run as a user with
elevation privilege for `<target-user>`, where `<target-user>` is a real OS
user with a login shell" — a requirement this image has had all along
(`agentconsole` plus the elevation rules file, and `alice` / `bob`). The
flag turns seven owner-only post-deploy checks into a command anyone can
rerun after a release.

Each smoke's exit code is printed as it runs, and the run ends with a
`smoke summary (exit codes)` block. Exit code `2` means "could not run"
(bad usage / unmet precondition) and is reported as a FAIL with the
smoke's stderr tail — never as a pass and never as a silent skip.

**Named by tier, not by residue list** (`.claude/rules/os-environment-coupling.md`
Discipline 4): this image and its `--smokes` run are **tier 2** — the seven
real-host smokes, PTY / elevation isolation, uploads, worktrees, and shared
sessions, needing the `docker` group only, no privilege flag. What tier 2
cannot reach is the systemd unit's own environment (setup script, deploy
script, unit render + drift detection, `MainPID` identity) — that is
**tier 3**, the systemd stack below, run on an ephemeral CI runner or a
personal workstation only, never the dogfood host. **Tier 4** is the
production host, owner-run, once per deploy: the billable smokes (there is
no `claude` login inside this container, so every billable smoke stays on
the dogfood host), vendor credentials (e.g. Bedrock) in a shared account's
home and a shared session actually completing a turn on them, and the
1Password-socket-*present* branch of `check-delegated-ssh-auth-sock.ts`
(this container exercises the socket-*absent* branch, which is that
script's expected path here).

`--smokes` is also the reason this image is roughly 2 GB — see
[Notes / limitations](#notes--limitations).

## Systemd stack (tier 3)

`docker-compose.systemd.yml` boots `Dockerfile.systemd` — systemd as PID 1,
least privilege (`--cap-add SYS_ADMIN --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw
--tmpfs /run --tmpfs /run/lock -e container=docker --security-opt apparmor=unconfined`,
measured in `docs/design/elevation-verification-tiers.md`'s Task 0; `--privileged`
was never reached) — and is driven end to end by
[`scripts/verify-multiuser-systemd.sh`](../scripts/verify-multiuser-systemd.sh):
the multi-user setup script (`--dry-run` then `--force`), the deploy script run
as the operator (`deployer`, per its own passwordless elevation rule baked into
the image), the #1688 unit-drift arm, the three #1690 readability-gate helper
cases, and `check-embedded-agent-elevation.ts` against the real unit's live
`MainPID`.

```bash
scripts/verify-multiuser-systemd.sh
```

**Never run a container of this image on the dogfood host.** Booting systemd
as PID 1 needs `CAP_SYS_ADMIN` plus a writable host cgroup tree in the host
cgroup namespace plus an AppArmor opt-out — root-equivalent on the host that
lends them. The driver refuses to run unless `AC_TIER3_RUNNER=github-hosted`
(set by `.github/workflows/verify-multiuser-systemd.yml` from GitHub's own
`runner.environment` context) or `AC_TIER3_HOST_OK=1` (an explicit workstation
opt-in) is set; `CI=true` is deliberately NOT accepted, since any self-hosted
runner sets it too. See `.claude/rules/os-environment-coupling.md` Discipline 4
and `docs/design/elevation-verification-tiers.md` ("The rule: never on the
dogfood host") for the full rationale.

## Test credentials (verification only)

| User | Password | Role |
|------|----------|------|
| `agentconsole` | _(none, `nologin`)_ | service user that runs the server |
| `alice` | `alice-password` | test end user |
| `bob` | `bob-password` | test end user |
| `shared1` | `shared1-password` | Shared Account (execution identity for shared sessions) |

In production, [`scripts/setup-shared-account.sh`](../scripts/setup-shared-account.sh)
LOCKS this account's password, because the account never logs in itself.
This verification image gives it a known password instead, so the stack's
own checks (see [What it checks](#what-it-checks), item 8) can exercise it
directly — safe only because the image is loopback-only and already ships
well-known credentials.

These passwords are intentionally well-known. **Never expose either stack
beyond loopback**; they exist solely for local development and verification.

## Why these OS pieces are required

- **`pamtester`** — `MultiUserMode.validateLinux()` shells out to
  `pamtester login <user> authenticate`. Without it installed, every login
  returns `401`.
- **`agentconsole` in the `shadow` group** — a *non-root* caller of `pam_unix`
  can only verify another user's password if it can read `/etc/shadow`
  directly. Without `shadow`-group membership, `pam_unix` falls back to the
  `unix_chkpwd` helper, which only permits verifying the *caller's own*
  password — so every login would `401`. This requirement was discovered
  through this verification environment and is documented in the setup guide.
- **sudoers** — `MultiUserMode.spawnSudoPty()` runs `sudo -u <user> -i sh -c`.
  The `agentconsole` user is granted `NOPASSWD` shell access to any non-root
  user, and nothing else.
- **`0700` test home directories** — the test users' homes use the OS default
  `0700` (private to the owner). Historically the PTY spawn helper `chdir`ed into
  the session's working directory _as the service user_ before `sudo` switched to
  the target user, so a `0700` home denied that `chdir` and the spawn failed with
  "PTY spawn failed". This was fixed in
  [#806](https://github.com/ms2sato/agent-console/pull/806): the pre-exec `chdir`
  now lands on a neutral `/`, and the real `cd` happens in the inner shell that
  runs as the target user — so a default `0700` home spawns successfully with no
  permission change. Keeping the test homes at `0700` makes this image a
  permanent regression guard for that fix; the CI E2E job
  ([#808](https://github.com/ms2sato/agent-console/issues/808)) fails the build
  if the `0700` path ever breaks again.

## Building behind a blocked Docker Hub

The default `BUN_BASE` (`oven/bun:1.3.14`) is a directly-pullable fixed tag, so a
clean environment with normal Docker Hub access builds with no extra flags:

```bash
docker build -f docker/Dockerfile -t agent-console-multiuser-verify .
```

If your environment can reach general networks (apt, npm, bun.sh) but **cannot
pull from Docker Hub's registry** (a common corporate/proxy situation where
`docker pull` hangs at "resolve image config"), build from a base image you
already have cached and disable BuildKit so it never round-trips the registry:

```bash
DOCKER_BUILDKIT=0 docker build \
  --build-arg BUN_BASE=oven/bun:1.3.4 \
  -f docker/Dockerfile -t agent-console-multiuser-verify .
```

The in-image step normalizes bun to `BUN_VERSION` (default `1.3.14`) regardless of
the base tag, so an older cached base still produces a `>= 1.3.14` runtime. bun
itself is fetched from `bun.sh` and npm packages from the npm registry — neither
goes through Docker Hub.

## Notes / limitations

- **HTTP, not HTTPS.** `NODE_ENV` is left unset on purpose. With
  `NODE_ENV=production` the auth cookie is marked `Secure`, which a browser only
  sends in a secure context (HTTPS, or `http://localhost`). A network-exposed
  plain-HTTP deployment therefore needs TLS; a localhost / SSH-port-forward
  deployment does not. See the guide's
  [TLS, `NODE_ENV`, and secure contexts](../docs/multi-user-setup-guide.md#tls-node_env-and-secure-contexts).
- **No static UI in the verification image.** The bundled login UI is only
  served when `NODE_ENV=production` (the same flag that makes the cookie
  `Secure`); verification is API/WebSocket-driven. The **dev stack does not
  have this limitation** — vite serves the full UI, so browser login QA
  belongs there.
- **arm64/amd64**: the image builds natively for the host architecture; the
  `bun-pty` native module is installed inside the runtime stage to match.
- **Image size**: roughly 2 GB, up from about 0.9 GB before `--smokes`
  existed. The runtime stage bakes the builder stage's whole workspace at
  `/workspace` on top of the served `dist/` bundle, because the
  `--smokes` scripts import production modules from `packages/server/src/**`
  and need the workspace's `bun install` — the `dist/` bundle alone can't
  provide that. The cheaper alternative, a host-side `node_modules`
  bind-mounted in, isn't available here either, for the same reason the dev
  stack uses container-side named volumes instead of a bind mount (see
  [How it works](#how-it-works)): `bun-pty` is a native module built against
  the container's own glibc. Accepted as a trade-off for a local
  verification image that is explicitly not a production deployment recipe.
