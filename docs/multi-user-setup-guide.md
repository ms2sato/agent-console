# Multi-User Shared Setup Guide

This guide walks through setting up Agent Console in multi-user mode, where multiple OS users on the same machine share a single server instance. Each user works with their own HOME directory, file permissions, SSH keys, and environment — as if they were logged in directly.

> **Note**: Multi-user mode requires `AUTH_MODE=multi-user`. The default mode (`AUTH_MODE=none`) is single-user and requires no additional setup.

## How It Works

In multi-user mode, Agent Console runs as a dedicated **service user** (`agentconsole`). When a user logs in via the browser, the server spawns PTY processes (terminals, AI agents) as that user via `sudo -u <user>`. This means:

- Each user's processes run under their own OS identity
- File permissions, SSH keys, and API keys work naturally
- No user needs root access
- The service user itself cannot be logged into directly

```
Browser (User: alice) ──> Agent Console Server (agentconsole)
                              │
                              ├── sudo -u alice sh -c '...'   (Alice's terminal)
                              ├── sudo -u alice sh -c '...'   (Alice's agent)
                              └── sudo -u bob sh -c '...'     (Bob's terminal)
```

## Prerequisites

- Agent Console installed and working in single-user mode first (verify with `AUTH_MODE=none`)
- [Bun](https://bun.com) **≥ 1.3.5** (required by `Bun.Terminal`; enforced by the repo's preinstall check)
- Root or sudo access on the server machine (for initial setup only)
- Linux (Ubuntu/Debian, RHEL/Fedora, etc.) or macOS
- **Linux only:** the `pamtester` package must be installed (see [Step 0](#step-0-install-pamtester-linux-only)). Without it, **every login returns 401.**

> **Want to try multi-user mode without a Linux machine?** A ready-made Docker
> verification environment lives in [`docker/`](../docker/README.md). It builds a
> Debian image (`oven/bun`) with `pamtester`, the service user, sudoers, and two test users,
> then verifies authentication and per-user PTY isolation with a single command
> (`scripts/verify-multiuser-docker.sh`). Use it to see the whole setup working
> before reproducing it on a real host.

## Quick Setup with the Bootstrap Script (Linux)

For Ubuntu / Debian hosts, the canonical happy path is the one-shot bootstrap
script `scripts/setup-multiuser-for-ubuntu.sh` (Issue
[#830](https://github.com/ms2sato/agent-console/issues/830)). It performs all
the prerequisite steps below — pamtester install, service user, shared group,
sudoers, data root, application install, systemd unit — as a single idempotent
operation.

```bash
# 1. Clone the repo wherever the operator wants it (the script installs the
#    application under the service user's HOME).
git clone https://github.com/ms2sato/agent-console.git
cd agent-console

# 2. Run the bootstrap script. Defaults: service user 'agentconsole',
#    shared group 'agent-console-users', data root '/var/lib/agent-console',
#    source-repos dir '<data-root>/source-repos', port 8080. Override with
#    --port, --user, --group, --data-root, --source-repos-dir, etc.
sudo scripts/setup-multiuser-for-ubuntu.sh --port 8080 \
  --add-user alice --add-user bob

# 3. Open the URL printed at the end. Default: http://<host>:8080/
```

The script is **idempotent**: a second invocation with the same parameters is
a no-op. To preview what it would do without modifying the system, pass
`--dry-run`:

```bash
sudo scripts/setup-multiuser-for-ubuntu.sh --dry-run
```

To add more users to the shared group after the initial setup, use the
companion helper:

```bash
sudo scripts/add-multiuser-user.sh <username>
```

The sections that follow describe the underlying steps the bootstrap script
performs. Read them when troubleshooting or when adapting the setup to a
non-Ubuntu host.

## Manual Setup (what the bootstrap script does, step by step)

The remaining Step 0 through Step 4 sections explain what
`setup-multiuser-for-ubuntu.sh` does internally. On a supported Ubuntu /
Debian host they are not normally followed by hand; they are provided so the
behaviour of the script is fully transparent and so the setup can be
reproduced on other distributions.

### Step 0: Install pamtester (Linux only)

On Linux, Agent Console validates OS credentials by shelling out to
`pamtester login <user> authenticate`. This binary is **not** part of the OS
authentication implementation but a hard runtime dependency of it — if it is
missing, `MultiUserMode` cannot validate any password and **all logins fail with
401**.

```bash
# Debian / Ubuntu
sudo apt-get install -y pamtester

# RHEL / Fedora (EPEL)
sudo dnf install -y pamtester
```

`pamtester` authenticates against the `login` PAM service, so `/etc/pam.d/login`
must exist (it does on any standard desktop/server install; minimal container
images may need the `login` / `libpam-modules` packages).

> **macOS** uses `dscl -authonly` instead and does **not** require `pamtester`.

### Step 1: Create the Service User

The service user (`agentconsole`) runs the server process. It is a system account with a HOME directory but no login shell.

### Linux

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin agentconsole
# Required on Linux: let the service user verify other users' passwords (see below)
sudo usermod -aG shadow agentconsole
```

What each flag does:
- `--system` — Creates a system account (low UID range, hidden from login screen)
- `--create-home` — Creates `/home/agentconsole` for config and database storage
- `--shell /usr/sbin/nologin` — Prevents direct SSH or console login

#### Why the `shadow` group is required (Linux)

This is the single most common reason multi-user login fails with **every login
returning 401 despite correct passwords**, so it is worth understanding.

When the server validates a password it runs `pamtester` as the **non-root**
service user. `pam_unix` (the module that checks Unix passwords) verifies a
password one of two ways:

1. **In-process** — if it can read `/etc/shadow` directly. Only `root` and
   members of the `shadow` group can read `/etc/shadow`.
2. **Via the `unix_chkpwd` helper** — used when the caller cannot read
   `/etc/shadow`. For security, `unix_chkpwd` lets a non-root caller verify
   **only its own** password, and refuses to check any other user's.

So a non-root service user that is **not** in the `shadow` group can never
validate another user's password — every login fails. Adding `agentconsole` to
the `shadow` group lets `pam_unix` take path (1) and validate any user's
password in-process.

> **Security trade-off**: `shadow`-group membership lets the service user read
> all password hashes. This is inherent to non-root OS authentication on Linux.
> The alternative is running the server as `root`, which is worse. Keep the
> service account locked down (`nologin` shell, no other privileges) accordingly.

> **macOS** does not need this — it authenticates via `dscl -authonly`, which
> does not require reading `/etc/shadow`.

Verify:

```bash
# User exists
id agentconsole
# Output: uid=999(agentconsole) gid=999(agentconsole) groups=999(agentconsole)

# HOME directory exists
ls -la /home/agentconsole
# Output: drwxr-xr-x 2 agentconsole agentconsole 4096 ... .

# Cannot login directly
sudo -u agentconsole bash
# Output: "This account is currently not available." (expected)
```

### macOS

macOS does not have `useradd`. Use `dscl` (Directory Service command line) and `dseditgroup`:

```bash
# Find an available UID in the system range (below 500)
# Check existing system UIDs first:
dscl . -list /Users UniqueID | sort -nk2 | tail -5

# Pick an unused UID (e.g., 400). Then:
sudo dscl . -create /Users/agentconsole
sudo dscl . -create /Users/agentconsole UniqueID 400
sudo dscl . -create /Users/agentconsole PrimaryGroupID 400
sudo dscl . -create /Users/agentconsole UserShell /usr/bin/false
sudo dscl . -create /Users/agentconsole NFSHomeDirectory /var/agentconsole
sudo dscl . -create /Users/agentconsole RealName "Agent Console Service"

# Create the home directory
sudo mkdir -p /var/agentconsole
sudo chown agentconsole:staff /var/agentconsole

# Create the group
sudo dseditgroup -o create -i 400 agentconsole

# Hide from login screen
sudo dscl . -create /Users/agentconsole IsHidden 1
```

Verify:

```bash
id agentconsole
# Output: uid=400(agentconsole) gid=400(agentconsole) ...

ls -la /var/agentconsole
# Output: drwxr-xr-x  2 agentconsole  staff  64 ... .
```

### Step 2: Configure sudoers

The service user needs permission to run shells as other users. This is the **only privilege** it gets — no root access.

### Create the sudoers file

Always use `visudo` to edit sudoers files. Direct editing can lock you out of sudo if there is a syntax error.

```bash
sudo visudo -f /etc/sudoers.d/agentconsole
```

Add the following line:

```
agentconsole ALL=(ALL,!root) NOPASSWD: /bin/sh, /bin/bash, /bin/zsh
```

What this means:
- `agentconsole` — This rule applies to the `agentconsole` user
- `ALL=` — On any host (standard for single-machine setups)
- `(ALL,!root)` — Can run commands as any user **except root**
- `NOPASSWD:` — Without entering a password (the service user has no password)
- `/bin/sh, /bin/bash, /bin/zsh` — Only these specific commands are allowed

> **Security note**: The `!root` exclusion prevents the service user from escalating to root. If your users use other shells (e.g., fish, tcsh), add them to the list.

Verify:

```bash
# Test: can run shell as a regular user
sudo -u agentconsole sudo -u $(whoami) /bin/sh -c 'whoami'
# Output: your username

# Test: cannot run shell as root
sudo -u agentconsole sudo -u root /bin/sh -c 'whoami'
# Output: "Sorry, user agentconsole is not allowed to execute ..."
```

### Step 3: Install Agent Console for the Service User

Install Agent Console in the service user's home directory. The exact steps depend on your installation method, but the key is that the `agentconsole` user must be able to run the server binary.

```bash
# Example: clone the repository
sudo -u agentconsole git clone https://github.com/ms2sato/agent-console.git /home/agentconsole/agent-console

# Install dependencies
cd /home/agentconsole/agent-console
sudo -u agentconsole bun install

# Build
sudo -u agentconsole bun run build
```

> **Note**: `sudo -u agentconsole` runs the command as the service user. Since the service user has `/usr/sbin/nologin` as its shell, you may need to use `sudo -u agentconsole -s /bin/sh -c '...'` or `sudo -u agentconsole bash -c '...'` for multi-command sequences.

**Copy the bun binary to a globally-reachable path (Issue #1221).** The
embedded-agent worker spawns `bun <entry>` inside an elevated, non-interactive
login shell (`sudo -u <target-user> -i sh -c '...'`). On Ubuntu that inner
shell is dash, which does not source `.bashrc` — a user-local
`~/.bun/bin/bun` install is therefore NOT resolvable by bare command name
inside that shell (see
[`.claude/rules/os-environment-coupling.md`](../.claude/rules/os-environment-coupling.md)).
Copy — not symlink — the service user's own bun binary to `/usr/local/bin/bun`
so every elevation-target user can reach it. Copying from the service user's
own bun (rather than an operator's) keeps it in sync with the version the
server process itself runs:

```bash
sudo install -m 0755 /home/agentconsole/.bun/bin/bun /usr/local/bin/bun
```

Re-run this step whenever you `bun upgrade` the service user's bun install,
so the copy does not drift out of version sync with the server process.
`scripts/setup-multiuser-for-ubuntu.sh` performs this copy automatically on
every invocation.

### Step 4: Configure the Service (Linux)

Create a systemd unit file so the server starts automatically and restarts on failure.

Render the unit from the bundled template at `scripts/agent-console-multiuser.service.template`:

```bash
sudo bash -c '
sed -e "s|{{HOME}}|/home/agentconsole|g" \
    -e "s|{{BUN_PATH}}|/home/agentconsole/.bun/bin/bun|g" \
    -e "s|{{PORT}}|8080|g" \
    -e "s|{{AUTH_COOKIE_SECURE}}|false|g" \
    /home/agentconsole/agent-console/scripts/agent-console-multiuser.service.template \
    > /etc/systemd/system/agent-console.service
'
```

Adjust the four placeholder values for your environment:

- `{{HOME}}` — the service user's home directory (typically `/home/agentconsole`). If you installed Agent Console under a different path, update `{{HOME}}` so both `WorkingDirectory` and the `PATH` environment entry resolve correctly.
- `{{BUN_PATH}}` — the absolute path to the `bun` executable for the service user (typically `/home/agentconsole/.bun/bin/bun`). Run `sudo -u agentconsole which bun` to confirm.
- `{{PORT}}` — the TCP port the server listens on (e.g. `8080`).
- `{{AUTH_COOKIE_SECURE}}` — `true` or `false`. Set to `true` if all access is over HTTPS or via `http://localhost`; set to `false` for plain-HTTP access on a trusted network. See [TLS, `NODE_ENV`, and secure contexts](#tls-node_env-and-secure-contexts).

> `NODE_ENV=production` is set unconditionally by the template and enables the
> web UI. The auth cookie's `Secure` attribute is controlled separately by
> `AUTH_COOKIE_SECURE` above. `EMBEDDED_AGENT_BUN_PATH=/usr/local/bin/bun` is
> also set unconditionally by the template — it must match the destination
> path used for the bun-binary copy step above.

> **Note**: A separate per-user systemd template
> (`scripts/agent-console.service.template`) exists for single-user
> deployments that run under `systemctl --user`. The multi-user template
> here is for system-wide deployments that run as the `agentconsole` service
> user and spawn per-user PTYs via `sudo -u <user>`.

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable agent-console
sudo systemctl start agent-console
```

Check status:

```bash
sudo systemctl status agent-console
# Should show "active (running)"

# View logs
sudo journalctl -u agent-console -f
```

### macOS (launchd)

Create a launchd plist:

```bash
sudo tee /Library/LaunchDaemons/com.agentconsole.server.plist > /dev/null << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agentconsole.server</string>
    <key>UserName</key>
    <string>agentconsole</string>
    <key>WorkingDirectory</key>
    <string>/var/agentconsole/agent-console</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/bun</string>
        <string>run</string>
        <string>start</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>AUTH_MODE</key>
        <string>multi-user</string>
        <key>PORT</key>
        <string>8080</string>
        <key>HOST</key>
        <string>0.0.0.0</string>
    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/var/agentconsole/agent-console.log</string>
    <key>StandardErrorPath</key>
    <string>/var/agentconsole/agent-console.err</string>
</dict>
</plist>
EOF

sudo launchctl load /Library/LaunchDaemons/com.agentconsole.server.plist
```

## Step 5: User Account Requirements

Each user who accesses Agent Console needs:

1. **An OS user account** — Standard user account on the machine. No special groups or permissions needed.
2. **A home directory** — For storing SSH keys, API keys, shell configuration, etc.
3. **A shell** — One of the shells listed in the sudoers rule (`/bin/sh`, `/bin/bash`, `/bin/zsh`).

Users do **not** need:
- sudo access
- Knowledge of the `agentconsole` service user
- Any Agent Console-specific setup in their account

Their existing environment (`.bashrc`, `.zshrc`, SSH keys, git config, API keys) works automatically because PTY processes run as their user via `sudo -u <user> -i`, which loads their login shell profile.

### Default `0700` home directories work as-is

User home directories at the OS default mode `0700` (Debian/Ubuntu
`HOME_MODE 0700`, private to the owner) work with **no permission change**.

When the server starts a PTY it spawns `sudo -u <user> -i` for the session's
working directory. The privileged spawn performs its pre-exec `chdir` into a
neutral, always-traversable directory (`/`) while still the service user, and
the real `cd` into the session's working directory happens in the inner login
shell that already runs **as the target user**. The service user therefore never
needs to enter another user's private directory — the target user can always
enter their own home — so you do not need to loosen home permissions for
multi-user mode. Worktree directories created by the server are owned by the
service user and likewise need no change.

## Step 6: Verify the Setup

After starting the server, check the following:

```bash
# 1. Server is running
curl http://localhost:8080/api/config
# Should return JSON with "authMode": "multi-user"

# 2. Login works (replace with a real OS user/password)
curl -X POST http://localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username": "alice", "password": "alice-password"}'
# Should return user info and set auth cookie

# 3. PTY processes run as the correct user
# (Log in via browser, open a terminal worker, run `whoami`)
# Output should be the logged-in user's username, not "agentconsole"
```

> For an automated, end-to-end version of these three checks (plus per-user PTY
> isolation), run the Docker verification: `scripts/verify-multiuser-docker.sh`
> (see [`docker/README.md`](../docker/README.md)).

## Iterative Updates (after the initial setup)

After the bootstrap script has completed once, ongoing source-code updates and
restarts are performed by `scripts/update-and-deploy-for-multiuser-ubuntu.sh`.
The script assumes the source-repo at `${AGENT_CONSOLE_DATA_ROOT}/source-repos/agent-console`
has already been advanced to the target ref (the orchestrator-driven update
cycle: fetch + checkout + this script).

```bash
# Default invocation (matches bootstrap defaults: agentconsole / port 8080).
sudo scripts/update-and-deploy-for-multiuser-ubuntu.sh

# Overrides (env vars; CLI flags not supported):
sudo AGENT_CONSOLE_PORT=9000 \
     AGENT_CONSOLE_SERVICE_USER=ac-svc \
     scripts/update-and-deploy-for-multiuser-ubuntu.sh
```

The full list of override env vars is documented in the script's top comment.
The script does not perform `git pull` itself — sync the source-repo to the
intended commit before invoking, and confirm via the printed HEAD line in the
script's `==> Pre-check` step before the build proceeds.

## Multiple Repositories on the Same Instance

A single multi-user (production or dev) instance can host more than one
registered repository at the same time. Each repository keeps its own
`source-repos/<repo-name>` directory under `AGENT_CONSOLE_DATA_ROOT` and its
own `repositories/<owner>/<repo>/worktrees/<...>` tree, and sessions for each
repository run side by side from the shared `agentconsole` server process.

Operator implications:

- When inspecting the running process tree (`ps -ef | grep AGENT_CONSOLE_SESSION_ID`)
  before stopping or restarting an instance, expect to see active delegated
  sessions for any of the registered repositories — not just the one whose
  worktree the operator was using most recently. Stopping the instance
  terminates all of them.
- The dev instance's repository registry is independent of the production
  instance's registry. A repository registered against
  `/var/lib/agent-console-dev/` is not visible from the production server on
  port 8080, and vice versa.
- The Orchestrator's `list_repositories` MCP call returns only the registry of
  the instance the calling session is hosted on. To inventory the other
  instance, query that instance's UI or its `source-repos/` directory
  directly on disk.

The Sprint 2026-06-30 retrospective surfaced this as implicit knowledge: a
running `dev-multiuser.sh` was found to host sessions from a sibling
repository the agent had no prior visibility into, which complicated a
restart proposal. Documenting the multi-repo property up front avoids
that surprise.

## GitHub Webhook Setup (multi-user)

For inbound GitHub webhook configuration on the systemd instance — including the
`EnvironmentFile=-` pattern that survives the deploy script's `rsync --delete` —
see the README's
[GitHub Webhook Integration → Multi-user mode (Ubuntu / systemd) recipe](../README.md#multi-user-mode-ubuntu--systemd-recipe).

The short version: place the secret under
`/home/<service-user>/.config/agent-console/secrets.env` (outside the deploy
target), reference it from the systemd unit with `EnvironmentFile=-`, then
`systemctl daemon-reload && systemctl restart agent-console.service`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_MODE` | `none` | `none` for single-user, `multi-user` for multi-user mode |
| `PORT` | `3457` | Server port. `3457` is the dev fallback; pick any port for production (this guide uses `8080`). |
| `HOST` | `0.0.0.0` | Bind address. Defaults to all interfaces; set to `127.0.0.1` to restrict to localhost. |
| `AGENT_CONSOLE_HOME` | `~/.agent-console` (single-user); `/var/lib/agent-console` (multi-user, Issue [#830](https://github.com/ms2sato/agent-console/issues/830)) | Config and database directory. The SQLite database is `<AGENT_CONSOLE_HOME>/data.db`; the JWT signing secret is `<AGENT_CONSOLE_HOME>/jwt-secret` (auto-generated, mode 0600, on first start). Under multi-user, the bootstrap script sets this explicitly on the systemd unit. |
| `NODE_ENV` | _(unset)_ | Set to `production` for browser-based deployments: it enables the web UI **and**, by default, marks the auth cookie `Secure`. The `Secure` cookie then needs a secure context — HTTPS, or `http://localhost` — see [TLS, `NODE_ENV`, and secure contexts](#tls-node_env-and-secure-contexts). |
| `AUTH_COOKIE_SECURE` | _(unset)_ | Tri-state override for the auth cookie's `Secure` attribute, decoupling it from `NODE_ENV`. Unset → follows `NODE_ENV` (default); `false` → never `Secure` (for trusted-network plain-HTTP deployments); `true` → always `Secure`. Invalid values fail fast at startup. See [Plain HTTP on a trusted network](#plain-http-on-a-trusted-network-auth_cookie_secure). |
| `PTY_PROVIDER` | _(unset; server default `bun-terminal`)_ | Override for the PTY backend. Valid values: `bun-terminal` (default; the `Bun.spawn({ terminal: ... })` provider, Bun ≥ 1.3.5) or `bun-pty` (the bun-pty native shared library). Stage 2 (Issue [#827](https://github.com/ms2sato/agent-console/issues/827)) flipped the compiled default to `bun-terminal`; `bun-pty` remains selectable for one release as a rollback escape hatch, with Stage 3 (Issue [#828](https://github.com/ms2sato/agent-console/issues/828)) removing it. The backend migration was evaluated under Issue [#824](https://github.com/ms2sato/agent-console/issues/824). The bootstrap script exposes this as `--pty-provider <name>` (or env `AGENT_CONSOLE_PTY_PROVIDER`); when unset, the rendered systemd unit omits the entry entirely so the server falls back to its compiled default. Invalid values are rejected at bootstrap time before any system state is touched. |
| `AGENT_CONSOLE_MCP_AUTH` | _(unset)_ | Mode for missing-MCP-token handling: `off`, `warn`, or `enforce`. Unset resolves to `warn` for every `AUTH_MODE`, including multi-user (Sprint 2026-07-16; see Issue #1107 for the enforce-by-default restoration path). See [MCP authentication mode](#mcp-authentication-mode-agent_console_mcp_auth) below — most deployments should leave this unset. |
| `EMBEDDED_AGENT_BUN_PATH` | `bun` | Absolute path (or bare command name) used to invoke `bun` when spawning the embedded-agent worker's loop subprocess. Default `bun` resolves via PATH, correct for single-user/dev where the spawned process shares the server's shell environment. Multi-user mode MUST set this to an absolute path (e.g. `/usr/local/bin/bun`) because the subprocess runs inside an elevated, non-interactive login shell that does not source `.bashrc` and cannot resolve a user-local `~/.bun/bin/bun` by bare name (Issue #1221; see [`.claude/rules/os-environment-coupling.md`](../.claude/rules/os-environment-coupling.md)). `scripts/setup-multiuser-for-ubuntu.sh` sets this automatically. |

The full list of server variables is defined in
[`packages/server/src/lib/server-config.ts`](../packages/server/src/lib/server-config.ts).

## TLS, `NODE_ENV`, and secure contexts

For browser access there are **two independent concerns**. Conflating them leads
to the wrong conclusion that "a trusted private network means plain HTTP is
fine" — it is not.

**Concern 1 — confidentiality (don't send passwords in the clear).** OS
passwords are POSTed to `/api/auth/login`. The transport carrying them must be
private. This is satisfied by **either** TLS (HTTPS) **or** an already-trusted
network path: a VPN / zero-trust overlay (e.g. Cloudflare WARP), an SSH tunnel,
or pure loopback. On such a network, TLS is not required *for confidentiality*.

**Concern 2 — the `Secure` cookie / browser secure context.** A single flag,
`NODE_ENV=production`, controls two coupled behaviors:

- The auth cookie is issued with the `Secure` attribute. By default this follows
  `NODE_ENV === 'production'`, but it can be decoupled with the
  `AUTH_COOKIE_SECURE` override (see [Plain HTTP on a trusted
  network](#plain-http-on-a-trusted-network-auth_cookie_secure) below).
- The bundled web UI is served only in production (`index.ts` gates static file
  serving on `isProduction`). With `NODE_ENV` unset the server exposes the
  API/WebSocket but **not** the login UI.

Because any browser deployment needs `NODE_ENV=production` (for the UI), the
cookie is `Secure` by default, and a browser sends a `Secure` cookie **only to a
secure context**: an `https://` origin, or `http://localhost` / `http://127.0.0.1`.
This is decided purely by the URL's scheme and host — **it does not matter how
safe the network is**. A WARP-protected `http://<internal-host>:<port>` still
drops the cookie and login fails — unless you explicitly relax the requirement
with `AUTH_COOKIE_SECURE=false` (see below).

### Decision table

| How the browser reaches the server | Confidentiality | `Secure` cookie sent? | Works? |
|---|---|---|---|
| `https://<host>` (TLS terminated anywhere — internal CA, Cloudflare, reverse proxy) | ✅ TLS | ✅ (https origin) | ✅ |
| `http://localhost:<port>` (directly, or a forward/tunnel that makes the origin appear as localhost) | ✅ loopback/tunnel | ✅ (localhost = secure context) | ✅ |
| `http://<non-localhost host>:<port>` plain HTTP — **even on WARP/VPN/internal LAN** | ✅ if on a trusted net | ❌ dropped | ❌ login fails |
| `http://<non-localhost host>:<port>` plain HTTP **with `AUTH_COOKIE_SECURE=false`** — only on a trusted net | ✅ if on a trusted net | ➖ sent without `Secure` | ✅ |

So on a trusted private network you have three valid options: terminate TLS to
get an `https://` origin; have each member reach the server as
`http://localhost:<port>` (e.g. a per-machine port-forward from the host/VM, or
`ssh -L <port>:localhost:<port> <host>`); **or**, when the network itself is
already trusted, set `AUTH_COOKIE_SECURE=false` so the cookie is issued without
`Secure` and plain-HTTP non-localhost logins work (see below). Without that
override, pointing browsers at a plain-HTTP non-localhost URL does **not** work,
regardless of how private the network is.

### Plain HTTP on a trusted network (`AUTH_COOKIE_SECURE`)

When members access the server directly at `http://<internal-host>:<port>` over a
network that is already private (e.g. Cloudflare WARP, a VPN, or a zero-trust
overlay), confidentiality is covered by the network layer, but the browser still
drops the `Secure` auth cookie, so login never persists. To support this topology,
set `AUTH_COOKIE_SECURE=false`: the auth cookie is then issued **without** the
`Secure` attribute, and plain-HTTP logins work.

```bash
# Trusted private network, plain HTTP, no app-level TLS:
NODE_ENV=production AUTH_MODE=multi-user AUTH_COOKIE_SECURE=false <start command>
```

`AUTH_COOKIE_SECURE` is tri-state:

| Value | Effect |
|---|---|
| _(unset, default)_ | `Secure` follows `NODE_ENV` — `Secure` in production, not otherwise. No change from historical behavior. |
| `false` | Cookie issued **without** `Secure`, regardless of `NODE_ENV`. |
| `true` | Cookie **always** `Secure`, regardless of `NODE_ENV`. |

Any other value fails fast at startup. When `AUTH_COOKIE_SECURE=false` is combined
with `NODE_ENV=production`, the server emits a loud startup warning naming the risk.

> **⚠️ Only on a genuinely trusted network.** Disabling `Secure` means the session
> cookie is transmitted over plain HTTP, so any untrusted segment on the path
> enables session hijacking. Use it only where the network layer (WARP/VPN/overlay)
> already guarantees confidentiality — never on the public internet or an untrusted
> LAN.

When you do terminate TLS, do it in front of Agent Console (reverse proxy such as
nginx/Caddy, or a load balancer), forward both the HTTP routes and the WebSocket
upgrade (`/ws/*`), and set `APP_URL`/`HOST` accordingly.

> **Not empirically verified here.** The Docker verification in this repo uses a
> non-browser client with `NODE_ENV` unset, so the `NODE_ENV=production` +
> `Secure` cookie + browser path (whether `https` or `http://localhost`) was not
> exercised. The above reflects the documented browser secure-context behavior
> (W3C Secure Contexts treats loopback as potentially trustworthy) — confirm it
> in your own browser before relying on it for a deployment.

## Troubleshooting

### Every login returns 401, even with correct passwords (Linux)

Two causes, both on the server side:

1. **`pamtester` is not installed.** The Linux credential check shells out to
   `pamtester`; if it is missing, `MultiUserMode` cannot validate any password.
   Install it (see [Step 0](#step-0-install-pamtester-linux-only)) and confirm
   `/etc/pam.d/login` exists.
2. **The service user is not in the `shadow` group.** A non-root service user
   cannot verify other users' passwords without `shadow`-group membership (see
   [Why the `shadow` group is required](#why-the-shadow-group-is-required-linux)).
   Fix and restart the service:

   ```bash
   sudo usermod -aG shadow agentconsole
   sudo systemctl restart agent-console   # group change applies to a fresh process
   ```

The server log shows `pamtester: Authentication failure` followed by
`Login failed: invalid credentials` in both cases.

### "PTY spawn failed" after a successful login

This usually points to a PTY spawn-path regression or a sudoers / config
mismatch — **not** to home-directory permissions. A user's default `0700` home
is supported and needs no change; see
[Default `0700` home directories work as-is](#default-0700-home-directories-work-as-is).
Check that the service user's sudoers entry grants `NOPASSWD` login-shell access
to the target user and that the server log shows the `sudo -u <user> -i` command
it attempted.

### "This account is currently not available" when testing sudo

This is expected. The `agentconsole` user has `nologin` as its shell. Use `sudo -u agentconsole -s /bin/sh -c '...'` to run commands as the service user.

### "Sorry, user agentconsole is not allowed to execute..."

The sudoers configuration is missing or incorrect. Check:

```bash
sudo visudo -c -f /etc/sudoers.d/agentconsole
# Should say "parsed OK"

cat /etc/sudoers.d/agentconsole
# Should contain the agentconsole rule
```

### PTY processes run as `agentconsole` instead of the logged-in user

Verify that `AUTH_MODE=multi-user` is set in the server's environment. In `none` mode, all PTY processes run as the server process user.

### User's shell profile is not loaded

Make sure `sudo -u <user> -i` works for the target user. The `-i` flag creates a login shell, which loads the user's profile. Test:

```bash
sudo -u agentconsole sudo -u alice -i sh -c 'echo $HOME && echo $SHELL'
# Should show Alice's home directory and shell
```

### Permission denied on user's files

Verify the PTY process is running as the correct user:

```bash
# In a terminal worker, run:
whoami     # Should show the logged-in user
id         # Should show the user's UID and groups
ls -la ~   # Should be accessible
```

## Source Repo Group-Writability (Linux multi-user)

When `git worktree add` runs as the requesting user (Issue #838 / PR #843),
two things must be true for it to succeed against a source repo owned by
the service user (`agentconsole`):

1. The user's gitconfig must trust the source repo path. The server
   bootstraps this automatically (`git config --global --add safe.directory
   <repoPath>`, mitigation A from Issue #838); operators do not need to
   configure it.
2. The user must be able to **write** to `.git/refs/`, `.git/packed-refs`,
   etc. (Issue #838's mitigation C — group writability).
   **As of Issue #845, `registerRepository` automatically applies this
   configuration in multi-user mode** at repository-registration time. The
   server runs the equivalent of the four commands below as the service
   user, idempotently (re-registering a configured repo is a no-op):

```bash
# Applied automatically by the server in multi-user mode (Issue #845).
git -C <repo-path> config core.sharedRepository group
find <repo-path>/.git -type d -exec chmod g+rwxs {} +
chmod -R g+rw <repo-path>/.git
chgrp -R agent-console-users <repo-path>/.git
```

### Manual fallback (operator step)

The auto-apply step requires the server process (`agentconsole`) to either
own the repo or be in its group. When neither holds — e.g., the repo was
cloned by a different operator account whose primary group differs — the
auto-apply logs a `WARN` (with the exact remediation commands embedded)
and proceeds with registration. Apply the same commands manually as a
privileged user:

```bash
sudo -u agentconsole bash -lc 'cd <repo-path> && git config core.sharedRepository group'
sudo find <repo-path>/.git -type d -exec chmod g+rwxs {} +
sudo chmod -R g+rw <repo-path>/.git
sudo chgrp -R agent-console-users <repo-path>/.git
```

### Pre-#845 source repos

Source repos registered before Issue #845 landed retain the registration
record but were not touched by the auto-apply step. Two options:

- **Re-register**: unregister and re-register through the UI (or
  `DELETE /api/repositories/:id` + `POST /api/repositories`) to trigger the
  new auto-apply.
- **Run the manual fallback commands** above once per affected repo.

When [Issue #834](https://github.com/ms2sato/agent-console/issues/834)
(clone-as-user) lands, repos cloned via the in-app flow are owned by the
requesting user directly and neither the auto-apply nor the manual fallback
is required.

## Shared source-repos directory (Linux multi-user)

The bootstrap script (`scripts/setup-multiuser-for-ubuntu.sh`) creates an
empty shared directory at `${DATA_ROOT}/source-repos` (default
`/var/lib/agent-console/source-repos`) during Step 5, owned
`<service-user>:<shared-group>` with mode `2775` (setgid + group-writable).
This is the recommended location for cloning source repositories that
multiple OS users will share through Agent Console (Issue
[#833](https://github.com/ms2sato/agent-console/issues/833)).

### Why a shared location

The alternatives are operationally fragile:

- **An interactive user's `~/dev/<repo>`** works only when that home is
  world-traversable; it usually is not, and other interactive users in the
  shared group cannot read it.
- **An ad-hoc system path** (e.g., `/srv/repos/...`) works if perms are set
  by hand, but every operator invents their own convention.
- **The data root itself** is conflated with the worktree subtree that
  agent-console manages, making manual operator action there risky.

Cloning into `${DATA_ROOT}/source-repos` gives every interactive group
member and the service user a consistent place to read, fetch, and update
refs.

### Recommended clone procedure

The operator's interactive user (e.g., `alice`) must be in the
`agent-console-users` group **before** cloning so newly created files
inherit the shared group via the directory's setgid bit:

```bash
# Verify group membership first.
id -nG alice | tr ' ' '\n' | grep -Fxq agent-console-users \
  || sudo scripts/add-multiuser-user.sh alice  # then re-login

cd /var/lib/agent-console/source-repos

# Either: set the umask for this one shell so new files are 0664 / dirs 0775
( umask 0002 && git clone <upstream-url> <repo-name> )

# Or: let git apply the equivalent permission policy per-repo
git clone --config core.sharedRepository=group <upstream-url> <repo-name>
```

The `umask 0002` / `--config core.sharedRepository=group` step matters
because default umask `0022` produces files at mode `0644` — the service
user can read them, but the `git fetch` / ref-update path will not be able
to refresh `.git/refs/*` after the first push from another group member.

After the clone, register the absolute path through the UI's "Register
Repository" form (or `POST /api/repositories`). At registration time the
server runs the same `core.sharedRepository=group` + group-writable `.git`
configuration automatically (Issue #845 / PR #848) — see [Source Repo
Group-Writability (Linux multi-user)](#source-repo-group-writability-linux-multi-user)
for what gets applied and the manual fallback when the server cannot apply
it itself.

### Customizing the location

Operators who prefer a different absolute path can pass
`--source-repos-dir <path>` to the bootstrap script (or set
`AGENT_CONSOLE_SOURCE_REPOS_DIR`). The script applies the same owner /
group / mode and is idempotent. If a different layout already exists,
re-run with `--force` to reconcile owner / group / mode drift.

```bash
sudo scripts/setup-multiuser-for-ubuntu.sh --source-repos-dir /srv/agent-console-repos
```

## Migrating Pre-#838 Worktrees (Linux multi-user)

Issue #838 changes worktree creation so the resulting files are owned by the
requesting user (not the service user). New worktrees created after the
upgrade are owned correctly automatically; **existing worktrees created
before the upgrade remain owned by the service user** and will continue to
trigger `fatal: detected dubious ownership in repository` when the user runs
any git command inside them.

The fix is a one-time `chown` per pre-existing worktree. For each affected
worktree path:

```bash
sudo chown -R <user>:agent-console-users \
  /var/lib/agent-console/repositories/<org>/<repo>/worktrees/wt-NNN-XXXX
```

`<user>` is the OS username of the person who originally created the
worktree. If the session is still listed in the Agent Console UI, the
worktree row's owner can be inferred from the session's creator; otherwise
ask the user who has been working in that worktree.

After the chown, the user can run `git status` inside the worktree from
their PTY without further configuration. No restart of the server is
required.

This documentation-based migration is intentional: production multi-user
installs at the time of #838 had a small number of pre-existing worktrees
(per the bootstrap-script-era setup window), so a per-path operator step
costs less than a database-aware migration script. A scripted variant can
be added later if installs in the wild accumulate many pre-#838 worktrees.

## Embedded-Agent Credentials (provider keys, MCP tokens)

Applies to deployments using [EmbeddedAgentWorker](glossary.md#embeddedagentworker)
(Agent Console's own in-process LLM-loop worker type, as opposed to a
terminal `AgentWorker` like Claude Code). Skip this section if you only use
terminal agents and never configure an `EmbeddedAgentDefinition`.

### `provider-keys.json` (LLM provider API keys)

`EmbeddedAgentDefinition.provider.apiKeyRef` names entries in
`<AGENT_CONSOLE_HOME>/provider-keys.json` (mode `0600`, owned by the service
user), shape:

```json
{
  "my-openai-key": "sk-...",
  "my-local-endpoint-key": "..."
}
```

v1 management is **manual editing only** — there is no UI or API for writing
this file. After creating or updating it:

```bash
sudo -u agentconsole touch /var/lib/agent-console/provider-keys.json
sudo -u agentconsole chmod 600 /var/lib/agent-console/provider-keys.json
sudo -u agentconsole $EDITOR /var/lib/agent-console/provider-keys.json
```

A dangling `apiKeyRef` (missing file, missing entry, or non-string value)
fails embedded-agent activation with an explicit error — it never silently
falls back to a keyless request. Keyless local endpoints (e.g. a same-host
Ollama server) do not need an entry here at all.

**Multi-user trust boundary (read before enabling a keyed provider in
multi-user mode).** A server-wide key delivered into a per-user subprocess is
readable by that OS user — stdin delivery prevents *incidental* leaks (argv,
env, other users), not exfiltration by the process's own user. v1 therefore
treats provider keys as **shared with every user permitted to run embedded
agents**; the definition-ownership rules controlling who can *configure*
agents do not control who can *read a key* once a worker runs as them.
Deployments that cannot accept this must not enable keyed providers in
multi-user mode until per-user keys (a post-v1 feature) land — keyless local
endpoints are unaffected.

### MCP authentication mode (`AGENT_CONSOLE_MCP_AUTH`)

Every agent process (embedded or terminal) that calls the built-in MCP server
carries a per-worker bearer token binding its calls to a verified session
identity (see [MCP Caller Token](glossary.md#mcp-caller-token)). The
`AGENT_CONSOLE_MCP_AUTH` env var controls how a MISSING token is treated:

| Value | Behavior |
|-------|----------|
| `off` | Tokenless calls proceed unchecked (pre-#878 behavior). |
| `warn` | Tokenless calls proceed, with a log line. **Default for every `AUTH_MODE`**, including multi-user, since Sprint 2026-07-16 (see Issue #1107). |
| `enforce` | Tokenless calls are rejected. Briefly the default for multi-user (`AUTH_MODE=multi-user`) starting at Phase 4; reverted to `warn` in Sprint 2026-07-16. Opt in explicitly with `AGENT_CONSOLE_MCP_AUTH=enforce`. |

A presented-but-mismatched token (the caller's verified identity does not
own the claimed session) is **always** rejected, regardless of this setting
— only the *missing-token* case is mode-dependent.

Multi-user deployments do not need to set this variable — `warn` is the
default regardless of `AUTH_MODE`, and it still logs tokenless callers for
observability. The deployment model this project currently targets is a
team-of-trust, where the ops cost of `enforce` (existing-session token
re-delivery, Claude Code `headersHelper` per-OS-user wiring, a full dogfood
pass) outweighs the safety benefit today. Operators that want stricter
enforcement can set `AGENT_CONSOLE_MCP_AUTH=enforce` explicitly once every
agent path (embedded-agent via stdin `init`, terminal-agent via the token
file below, including `headersHelper` wiring per target user) carries a
token — see [Terminal-agent MCP token file](#terminal-agent-mcp-token-file-multi-user-mode)
below. Restoring `enforce` as the multi-user default is tracked in Issue
[#1107](https://github.com/ms2sato/agent-console/issues/1107).

### Terminal-agent MCP token file (multi-user mode)

In multi-user mode, the server mints an MCP token for each terminal-agent
(`AgentWorker`, e.g. Claude Code) PTY at activation, writes it to a
user-owned `0600` file at `<target-user-home>/.agent-console/mcp-tokens/<workerId>.token`,
and passes only the file **path** to the spawned process via the
`AGENT_CONSOLE_MCP_TOKEN_FILE` env var — never the raw token via argv, an
elevation-embedded env var, or PTY-injected bytes (all three leak into
world-readable `/proc/<pid>/cmdline`, or into the persisted-and-broadcast
worker output stream). The file is deleted on the same events that revoke
the in-memory token: worker exit, kill, or delete.

**Operator setup: wiring the token into Claude Code's MCP client.** The
`AGENT_CONSOLE_MCP_TOKEN_FILE` env var only gets the token bytes onto the
target user's filesystem; Claude Code's own MCP client configuration still
needs to attach them as an `Authorization: Bearer <token>` header on its
`/mcp` HTTP requests. Claude Code's HTTP-transport `mcpServers` config
supports a `headersHelper` mechanism — a script Claude Code invokes to
produce dynamic header values (re-invoked on demand, e.g. after a rejected
request) — confirmed present in the installed CLI (verified directly against
the `claude` binary; consult Claude Code's own MCP documentation for the
exact `headersHelper` config schema, since it is not exposed via `claude mcp
add`'s CLI flags and may evolve across CLI releases). Configure it, per
target user, to read `AGENT_CONSOLE_MCP_TOKEN_FILE` and return
`{"Authorization": "Bearer <file contents>"}`. Until this is configured for a
given user, that user's terminal-agent MCP calls are tokenless; under the
current `warn` default (see above) they are merely logged and still succeed,
but a terminal agent's MCP-dependent tools (`delegate_to_worktree`,
`run_process`, `send_session_message`, etc.) return an authentication error
for that account once an operator opts into `AGENT_CONSOLE_MCP_AUTH=enforce`
(fail-closed, by design) — a terminal agent still starts normally and runs
either way. Functional verification of this wiring (the helper actually
reads the file and the header reaches `/mcp`, not just mechanism presence in
the CLI binary) is tracked as a prerequisite for Issue
[#1107](https://github.com/ms2sato/agent-console/issues/1107) (restoring
`enforce` as the multi-user default), not as a gate on general multi-user
support.

## Post-deploy Verification (smoke tests)

Run after every deploy that touches a privilege-elevation code path
(`packages/server/src/services/user-mode.ts`, `env-filter.ts`, or
`scripts/setup-multiuser-for-ubuntu.sh`). Unit tests cover the inner-command
string shape, but only an on-host smoke can confirm what env the elevated
user actually sees -- which depends on distro `sudo` defaults, sudoers
config, and the target user's login shell init.

### PTY env propagation check

```bash
sudo -u agentconsole bun scripts/smoke/check-multiuser-pty-env.ts <target-user>
```

Replace `<target-user>` with an OS user authorized in `/etc/sudoers.d/agent-console`
(any of the interactive users the multi-user deployment supports).

What it verifies (against the **real** machine -- real `sudo`, real sudoers,
real login shell init, real OS env):

- The color env (`TERM=xterm-256color`, `COLORTERM=truecolor`, `FORCE_COLOR=3`)
  reaches the inner shell. Without these, chalk-based CLIs (Claude Code, etc.)
  render in plain white.
- The elevated user's natural login env (`PATH`, `HOME`, `USER`, `LOGNAME`,
  `SHELL`) is correctly populated by `sudo -i`'s shell init -- NOT overridden
  by the service-account user's env.
- The target user's PATH includes their own home tree (typical for npm global
  or nvm setups where claude is installed under the user's home).

Exit codes:

- `0` -- all assertions passed
- `1` -- one or more assertions failed (details on stderr)
- `2` -- bad usage (missing target-user argument) or the smoke could not run
  (target user not in passwd, no home directory field, etc.). Distinct from `1`
  so operators can tell apart "the smoke ran and found a real problem" vs "the
  smoke could not even start".

The script imports `buildElevationArgs` directly from
`packages/server/src/services/elevation-args.ts`, the same helper production
uses in `MultiUserMode.spawnSudoPty`. Drift between what production sends to
`sudo` and what the smoke verifies is impossible by construction -- adding a
new env contribution in the helper propagates to both paths automatically.

The motivating regression (Issue #866) was a case where the service-account
user's `PATH` leaked into the elevated session and broke `claude` resolution
with `sh: 1: claude: Permission denied`. Future smoke checks land as sibling
scripts under `scripts/smoke/`.

### Login-shell sentinel protocol check

Agent workers launch through a login shell that first echoes a one-shot
sentinel line, then execs an interactive shell into which the worker-manager
injects the agent command. This smoke spawns a **real** PTY running a real
login shell, waits for the sentinel, injects a probe command, and asserts the
observable end state.

Direct mode (runs as the current user -- no elevation):

```bash
bun scripts/smoke/check-login-shell-sentinel.ts
```

Elevated mode (runs the target user's login shell through the elevation chain):

```bash
sudo -u agentconsole bun scripts/smoke/check-login-shell-sentinel.ts --elevated <target-user>
```

What it verifies (against the **real** login shell):

- The sentinel line is emitted exactly once, before the interactive shell.
- Command injection after the sentinel gate runs as the expected user
  (`whoami` matches the current user in direct mode, `<target-user>` under
  elevation).
- `PATH` is populated by login-shell init and (WARN-only) includes the user's
  own home tree.
- Negative: no probe output leaks before the gate, and the sentinel string
  never reappears after the gate.

Exit codes:

- `0` -- all assertions passed
- `1` -- the protocol ran but an assertion failed (the system is wrong)
- `2` -- bad usage, or the probe could not run at all. In `--elevated` mode
  this is how an unmet precondition surfaces (elevation not permitted, a
  password is required, or the target user cannot log in) -- distinct from `1`
  so operators can tell apart "found a real problem" vs "could not run".

Like the PTY env check, this script imports the production command builders
(`buildDirectSentinelShellCommand` / `buildElevatedSentinelCommand` from
`packages/server/src/services/sentinel-spawn-command.ts`) and the production
`bunPtyProvider`, so the spawn shape it exercises cannot drift from what
`SingleUserMode` / `MultiUserMode` actually spawn.

### Embedded-agent elevation check

Run before claiming multi-user support for
[EmbeddedAgentWorker](glossary.md#embeddedagentworker). It spawns the real
embedded-agent loop as a real second OS user via the production `spawnAsUser`,
with `AUTH_MODE=multi-user` and `AGENT_CONSOLE_MCP_AUTH=enforce` forced on,
against a real `/mcp` endpoint running in `enforce` mode:

```bash
sudo -u agentconsole bun scripts/smoke/check-embedded-agent-elevation.ts <target-user>
```

What it verifies:

- The embedded-agent package resolves via the **package-resolution** path
  (`Bun.resolveSync('@agent-console/embedded-agent/package.json', ...)`), not
  the dev-only source-tree fallback — this is the one thing only a
  real-deploy-layout smoke can catch, since a dev checkout would silently
  exercise the fallback too.
- The loop completes its `init` handshake and reaches the `ready` state
  against the real, `enforce`-mode `/mcp` endpoint — proving `enforce` mode
  (see [MCP authentication mode](#mcp-authentication-mode-agent_console_mcp_auth)
  above; opt-in only since Sprint 2026-07-16, tracked by Issue #1107) does
  not break the already-working embedded-agent token delivery.
- Negative: neither the MCP bearer token nor the provider API key appear in
  `/proc/<pid>/cmdline` or `/proc/<pid>/environ` of the elevated subprocess,
  with an "actually executed" guard so a silently-skipped check (process
  already exited, `/proc` unreadable) reports as a failure, not a pass.
- (Issue #1221) When `EMBEDDED_AGENT_BUN_PATH` is configured as an absolute
  path, the version reported by `${EMBEDDED_AGENT_BUN_PATH} --version` matches
  the running server process's own bun version — guarding against the
  embedded-agent subprocess drifting to a different bun binary than the
  server (see the follow-up Issue referenced from PR #1221's fix for the
  structural version-alignment gap this points at).

Exit codes: `0` all assertions passed, `1` an assertion failed (the system is
wrong), `2` bad usage or the smoke could not run (missing target-user
argument, target user unknown, spawn-launch failure, or — new in Issue #1221 —
`EMBEDDED_AGENT_BUN_PATH` configured to an absolute path that does not exist
on disk, meaning the bun-binary copy step from the setup guide/script has not
been applied yet).

Passing the current process user as `<target-user>` runs in a degenerate
same-user mode where `spawnAsUser` bypasses elevation (target equals the
server user) — this still exercises everything except the actual OS-boundary
crossing, useful for a quick non-elevated sanity check before running the
real cross-user version.

### Embedded-agent Bash env non-leakage check

Run before claiming multi-user support for the `Bash` builtin tool
([Built-in tools](design/embedded-agent-worker.md#built-in-tools-fast-follow),
FF-1b). Unlike the elevation check above, this smoke drives a full scripted
turn — a stub provider requests a `Bash` tool call (`env`), the loop executes
it as the real target OS user, and the result is fed back for a final
answer:

```bash
sudo -u agentconsole bun scripts/smoke/check-embedded-agent-bash-env.ts <target-user>
```

What it verifies:

- The `Bash` tool actually runs as the real target OS user — the captured
  `env` output's `USER=`/`LOGNAME=` line matches `<target-user>`, not the
  server-process user.
- Negative: no `AGENT_CONSOLE_*`-prefixed environment variable appears in the
  captured output — proof that `buildBashEnv`'s strip
  (`packages/embedded-agent/src/tools/env-cleaner.ts`) survives the real
  `spawnAsUser` -> login-shell-init -> loop-subprocess -> Bash-child chain,
  not just a direct in-process unit test call. The check is line-anchored
  (`AGENT_CONSOLE_<KEY>=`), not a bare substring match, so it does not
  false-positive on an ambient `SUDO_COMMAND` env var that may legitimately
  contain the literal text "AGENT_CONSOLE_" from the elevation invocation's
  own command line.
- Negative: the provider's fake API key does not appear in the captured
  output either.
- A silently-skipped assertion (the Bash tool-result event never observed) is
  treated as a failure, not a pass.

Exit codes: `0` all assertions passed, `1` an assertion failed (the system is
wrong), `2` bad usage or the smoke could not run (missing target-user
argument, target user unknown, spawn-launch failure).

Passing the current process user as `<target-user>` runs in a degenerate
same-user mode where `spawnAsUser` bypasses elevation — this still exercises
the full Bash tool-call round trip except the actual OS-boundary crossing.

### Elevated orphan-worker kill check

Run after every deploy that touches
`packages/server/src/services/privilege-elevation.ts`'s `killAsUser` or
`SessionInitializationService.killOrphanWorkers` (Issue #1197 Part A). Prior
to this helper, a server restart could not actually terminate an orphaned
worker PID that was spawned as a different OS user in multi-user mode —
`process.kill` raises `EPERM` for a cross-user PID, and (before the
companion `isProcessAlive` fix) that `EPERM` was misread as "already dead",
so the orphan was silently left running forever:

```bash
sudo -u agentconsole bun scripts/smoke/check-kill-as-user.ts <target-user>
```

What it verifies (against the **real** machine — real `sudo`, real target
process):

- `spawnAsUser` launches a real, long-lived `sleep` as `<target-user>`, and
  the smoke captures that process's own PID (not the outer `sudo`/`sh`
  wrapper PID `subprocess.pid` would report when elevated).
- `killAsUser` sends a real elevated `SIGTERM` to that PID and the process
  actually terminates (polled via `/proc/<pid>` existence, bounded to 5s).
- Negative: a second, unrelated `sleep` process spawned as the same target
  user survives the `killAsUser` call against the first one — proof the
  helper signals exactly the targeted PID (`kill -s <SIG> -- <pid>`), not
  something broader like a name-based `pkill`.

This smoke does NOT exercise `killAsUser`'s SIGTERM → SIGKILL fallback
orchestration (that lives in the caller,
`SessionInitializationService.killOrphanWorkers`, and is covered by unit
tests with an injected fake) or `isProcessAlive`'s ESRCH/EPERM distinction
(covered by `packages/server/src/lib/__tests__/process-utils.test.ts`,
which spies on `process.kill` directly and needs no second OS user).

Exit codes: `0` all assertions passed, `1` an assertion failed (the system
is wrong), `2` bad usage or the smoke could not run (missing target-user
argument, spawn-launch failure).

Passing the current process user as `<target-user>` runs in a degenerate
same-user mode where `spawnAsUser` / `killAsUser` bypass elevation — this
still exercises the full mechanism (spawn, PID capture, kill, negative
assertion) except the actual `sudo` OS-user-boundary crossing. Unlike the
smokes above, this degenerate mode does not require `AUTH_MODE=multi-user`
to be meaningful — the elevation bypass is evaluated independently of it,
based solely on whether `<target-user>` equals the server-process user.

### SESSION_ID marker orphan-process sweep

Run after every deploy that touches
`packages/server/src/services/orphan-process-sweeper.ts` or
`SessionInitializationService.sweepSessionProcesses` (Issue #1197 Part B).
`killOrphanWorkers` (Part A, checked above) only kills processes tracked via
a session's persisted `worker.pid` — the direct PTY wrapper process. A
worker's detached descendant processes (a `bun run dev` child, an MCP
subprocess, ...) are never in that PID set and leak forever across server
restarts. Every worker process already carries
`AGENT_CONSOLE_SESSION_ID=<sessionId>` in its environment, inherited by
every descendant; the sweep scans `/proc/[pid]/environ` for that marker,
tree-wide, and kills anything matching regardless of whether it was ever
tracked as a `worker.pid`:

```bash
sudo -u agentconsole bun scripts/smoke/check-orphan-sweep.ts <target-user>
```

What it verifies (against the **real** machine — real `sudo`, real
`/proc/<pid>/environ` read permissions, real target processes):

- `spawnAsUser` launches a real, long-lived `sleep` as `<target-user>` with
  `AGENT_CONSOLE_SESSION_ID=<generated-session-id>` set in its environment
  (the same marker every real worker process carries in production).
- `sweepOrphanProcesses` runs the marker-scan-and-kill script AS
  `<target-user>` — a real cross-user `/proc/<pid>/environ` read, which the
  server process itself cannot do directly — and actually terminates the
  marked process (polled via `/proc/<pid>` existence, bounded to 8s).
- Negative: a second, real process spawned as the same target user WITHOUT
  the marker survives the sweep — proof the sweep matches on the exact
  `SESSION_ID` record, not a broader name-based or substring match.

This smoke's distinct value versus Part A's `check-kill-as-user.ts` is
proving the marker-based **discovery** mechanism works end-to-end against
real `sudo` / real `/proc` read permissions — Part A never reads `environ`,
it only signals an already-known pid. This smoke does NOT exercise the
TERM → SIGKILL escalation path for a marked process that ignores SIGTERM
(covered by the real-process tests in
`packages/server/src/services/__tests__/orphan-process-sweeper.test.ts`,
which drive the sweep script directly via `Bun.spawn`, same-user, no
elevation needed to exercise the script's own grace/escalation logic) or
`SessionInitializationService.sweepSessionProcesses`'s best-effort
wrapping (covered by unit tests with an injected fake).

Exit codes: `0` all assertions passed, `1` an assertion failed (the system
is wrong), `2` bad usage or the smoke could not run (missing target-user
argument, spawn-launch failure, or a bounded phase exceeding its deadline).

Passing the current process user as `<target-user>` runs in a degenerate
same-user mode where `spawnAsUser` / `sweepOrphanProcesses` bypass
elevation — this still exercises the full mechanism (spawn, marker match,
kill, negative assertion) except the actual `sudo` OS-user-boundary
crossing and the cross-user `/proc/<pid>/environ` read permission.

### PTY master fd leak check

Run after every deploy that touches `packages/server/src/lib/pty-provider.ts`
or `packages/server/src/services/worker-manager.ts`'s `detachPty` (unlike the
other smokes above, this one is not privilege-elevation-specific -- it
verifies a resource-lifecycle contract of the default `bunTerminalProvider`):

```bash
bun run check:pty-fd-leak
```

What it verifies: `bunTerminalProvider` wraps `Bun.spawn({ terminal: ... })`,
whose returned `Bun.Terminal` handle owns the PTY master fd (`/dev/ptmx`).
Bun's native binding appears to release the fd via a GC finalizer once the
`Bun.Terminal` wrapper becomes unreachable, but production `InternalPtyWorker`
objects stay reachable (referenced via session/worker maps) for the life of
the worker, so incidental GC is not a reliable release path -- only an
explicit `Bun.Terminal.close()` call deterministically releases it.
`BunTerminalPtyAdapter.dispose()` performs that release and is wired into
both the adapter's own
`subprocess.exited`-triggered exit path and `WorkerManager.detachPty` (a
backstop for the case where a killed PTY's exit was never confirmed within
the kill timeout). The smoke runs 100 spawn/kill cycles through the
production `bunTerminalProvider` and asserts that both the process's own
ptmx-fd count (`/proc/self/fd`) and the kernel-wide allocated-pty counter
(`/proc/sys/kernel/pty/nr`) are flat (non-increasing) across the run,
confirming the master fd is actually released rather than merely
believed-released. See Issue #1196.

Exit codes: `0` all assertions passed, `1` an assertion failed (a leak was
observed), `2` bad usage / cannot run (non-Linux; the check depends on
`/proc`).

This smoke is scoped to `bunTerminalProvider` (the default `PTY_PROVIDER`).
The legacy native `bunPtyProvider` (`PTY_PROVIDER=bun-pty`) has a
similar-shaped leak on natural process exit, but rather than a standalone
fix, `bun-pty` itself is slated for full removal (Issue #828), which deletes
the leaky code path entirely -- out of scope here.

## Local Multi-User Dev Mode

`scripts/dev-multiuser.sh` (also runnable as `bun run dev:multiuser`) starts
a hot-reloading dev instance that **mirrors production multi-user ownership**
without touching the production data root. Unlike `bun run dev`
(single-user, runs as the developer under `~/.agent-console-dev`), this
script runs the server as the production service user (`agentconsole`) with
a parallel `/var/lib/agent-console-dev` data root.

Use this when:

- Verifying a feature that depends on the privilege-elevation chain
  (`runAsUser`, shared-group ownership, setgid inheritance,
  `sharedRepository=group`, server-side `safe.directory`).
- Iterating on UI code while preserving production-mirrored server-side
  ownership semantics. The developer's worktree is rsynced to
  `/home/agentconsole/agent-console-dev/` so the service user has its own
  source tree (mirroring production's `/home/agentconsole/agent-console/`).
  Client-side HMR (vite) works against the worktree as usual; server-side
  edits require re-running this script to re-sync.

### Prerequisites (one-time)

`scripts/setup-multiuser-for-ubuntu.sh` must have run on the host to create
the service user (`agentconsole`), the shared group (`agent-console-users`),
the sudoers configuration, and install the production systemd unit. The dev
script reuses all of these. In addition the developer's user must be a
member of the shared group:

```bash
sudo gpasswd -a $(whoami) agent-console-users
# start a NEW login session (or use `newgrp agent-console-users`) so the
# group is effective in the running shell
```

`rsync` must be installed (standard on most distros; `sudo apt install -y rsync`
if missing).

### Path layout

```text
/var/lib/agent-console-dev/              agentconsole:agent-console-users  drwxrwsr-x (2775)
/var/lib/agent-console-dev/source-repos/  same -- cloned repos land here
/var/lib/agent-console-dev/repositories/  same -- per-repo worktrees
/var/lib/agent-console-dev/uploads/        same -- uploaded files
```

Created idempotently on each run via `sudo install -d`, owned by
`agentconsole:agent-console-users` with mode `2775` (setgid + group-writable).
The developer accesses files through their membership in
`agent-console-users` plus setgid + `sharedRepository=group` -- the **same**
access path used in production.

### Ports

Default `3457` (server) / `5173` (client) mirror `bun run dev`. The
production systemd instance on `8080` is untouched. Only one dev instance
can run at a time (single-user `bun run dev` OR `bun run dev:multiuser`,
not both).

### How it works

1. **Pre-flight:** validate service user, shared group, current shell's
   effective group membership (caught via `id -nG` no-arg), `rsync`
   availability, and locate the service user's `bun` binary.
2. **Data root setup (idempotent):** ensure `/var/lib/agent-console-dev/`
   subtree exists with `agentconsole:agent-console-users` ownership and
   mode `2775`. Subsequent runs verify ownership AND mode; drifted entries
   (e.g., `0755` from a previous manual touch) are repaired in-place.
3. **Source rsync to service-user target:** `sudo rsync -a --delete
   --chown=agentconsole:agent-console-users` copies the worktree to
   `/home/agentconsole/agent-console-dev/`, owned by the service user.
   Excludes `node_modules`, `dist`, `.git`, `.claude/worktrees` (target gets
   its own node_modules via `bun install`). The developer's home directory
   permissions are NEVER modified.
4. **`bun install` in target** (as `agentconsole`): ensures the service user
   has its own dependency tree (correct platform binaries, matches what
   `agentconsole` can exec).
5. **Start vite client** (as the developer, from the worktree, port 5173).
6. **Start server** (as `agentconsole`, from the target, port 3457) with env
   mirroring the production systemd unit (`AUTH_MODE=multi-user`,
   `AGENT_CONSOLE_HOME=/var/lib/agent-console-dev`,
   `AUTH_COOKIE_SECURE=false`, `NODE_ENV=development`, `UMask=0002` via
   shell, `PATH=$SERVICE_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin`).
7. **Cleanup on Ctrl+C** — both processes terminate.

### Iteration loop

- **Client edits** (anything under `packages/client/`) propagate to the
  running UI via vite HMR. No re-run needed.
- **Server / shared edits** (anything under `packages/server/` or
  `packages/shared/`) require **re-running this script** to re-rsync into
  `$TARGET_HOME`. The re-sync is fast (rsync only transfers changed files);
  the server's `bun --watch` then restarts.

### Comparison: single-user dev vs multi-user dev

| | `bun run dev` (single) | `bun run dev:multiuser` |
|---|---|---|
| Server runs as | developer (current user) | `agentconsole` |
| Data root | `$HOME/.agent-console-dev` | `/var/lib/agent-console-dev` |
| Data owner | developer | `agentconsole:agent-console-users` (mode 2775 setgid) |
| `AUTH_MODE` | unset (single) | `multi-user` |
| PAM auth on login | bypassed | required |
| Privilege elevation (`runAsUser`) | bypassed | active |
| `sharedRepository=group` applied | no | yes (`#845`) |
| Server-side `safe.directory` bootstrap (`#853`) | no | yes |
| Use when | iterating on UI / logic | testing features that depend on multi-user semantics |

### Configurable overrides

```bash
SERVICE_USER=otheruser \
SHARED_GROUP=other-shared \
DEV_DATA_ROOT=/var/lib/agent-console-dev-alt \
TARGET_HOME=/home/otheruser/agent-console-dev \
PORT=3458 CLIENT_PORT=5174 \
bun run dev:multiuser
```

`SERVICE_BUN=/path/to/bun` overrides the auto-detected bun binary location
when it lives outside the production-mirrored search path
(`$SERVICE_HOME/.bun/bin/bun`, `/usr/local/bin/bun`, `/usr/bin/bun`).
