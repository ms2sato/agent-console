# Multi-User Mode Verification on Docker

This directory contains a **verification environment** for Agent Console's
multi-user mode (`AUTH_MODE=multi-user`). It runs the already-implemented
multi-user feature on real Debian Linux so we can confirm two things that cannot
be exercised on macOS dev machines:

1. **OS authentication** via `pamtester` (the Linux credential path).
2. **Per-user PTY identity isolation** via `sudo -u <user> -i` — each logged-in
   user's terminals and agents run under their own OS identity, not the service
   user.

> This is **not** a production deployment recipe. Production should run under
> systemd behind TLS — see [`../docs/multi-user-setup-guide.md`](../docs/multi-user-setup-guide.md).

## What's in here

| File | Purpose |
|------|---------|
| `Dockerfile` | Two-stage build: build the `dist/` bundle, then a runtime image with `pamtester`, `sudo`, a non-root `agentconsole` service user, and two test users (`alice`, `bob`). |
| `docker-compose.yml` | Starts the server in `AUTH_MODE=multi-user` on host port `8080`. |
| `sudoers-agentconsole` | Grants the service user permission to launch login shells as any non-root user. |
| `verify-client.ts` | Drives the real shipping path (login → session → terminal worker → WS) and asserts `whoami` inside the PTY. |
| `../scripts/verify-multiuser-docker.sh` | One-command orchestrator: build, start, run all checks, report. |

## Running the verification

From the repository root (requires `docker` and `bun` on the host):

```bash
scripts/verify-multiuser-docker.sh
```

This builds the image, starts the container, runs every check, prints a
pass/fail summary, and tears the container down. Useful flags:

- `--keep` — leave the container running afterwards (inspect at http://localhost:8080).
- `--no-build` — reuse the already-built image.
- `PORT=9090 scripts/verify-multiuser-docker.sh` — map a different host port.

### What it checks

1. `GET /api/config` reports `"authMode":"multi-user"`.
2. An unauthenticated request to a protected route returns `401`.
3. Login with a wrong password returns `401` (proves `pamtester` is actually running).
4. `alice` / `bob` log in successfully (`200`).
5. **Identity isolation**: `alice`'s terminal `whoami` prints `alice`, `bob`'s
   prints `bob` — never the `agentconsole` service user.

## Test credentials (verification only)

| User | Password | Role |
|------|----------|------|
| `agentconsole` | _(none, `nologin`)_ | service user that runs the server |
| `alice` | `alice-password` | test end user |
| `bob` | `bob-password` | test end user |

These passwords are intentionally well-known. **Never expose this image**; it
exists solely for local verification.

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
- **`0711` test home directories** — the PTY spawn helper `chdir`s into the
  session's working directory _as the service user_ before `sudo` switches to
  the target user. Debian's default `0700` home would deny that `chdir` and the
  spawn fails with "PTY spawn failed". The image sets the test homes to `0711`
  (traversable, not readable). This is an operational workaround; the root-cause
  fix is tracked in
  [issue #802](https://github.com/ms2sato/agent-console/issues/802).

## Building behind a blocked Docker Hub

The default `BUN_BASE` (`oven/bun:1.3.8`) is a directly-pullable fixed tag, so a
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

The in-image step normalizes bun to `BUN_VERSION` (default `1.3.8`) regardless of
the base tag, so an older cached base still produces a `>= 1.3.5` runtime. bun
itself is fetched from `bun.sh` and npm packages from the npm registry — neither
goes through Docker Hub.

## Notes / limitations

- **HTTP, not HTTPS.** `NODE_ENV` is left unset on purpose. In production
  (`NODE_ENV=production`) the auth cookie is marked `secure` and would be
  dropped over plain HTTP. TLS is mandatory in real deployments.
- **No static UI in this image.** The bundled login UI is only served when
  `NODE_ENV=production`; verification here is API/WebSocket-driven. To click
  through the browser UI you need `NODE_ENV=production` + TLS.
- **arm64/amd64**: the image builds natively for the host architecture; the
  `bun-pty` native module is installed inside the runtime stage to match.
