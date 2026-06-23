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
> `AUTH_COOKIE_SECURE` above.

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

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_MODE` | `none` | `none` for single-user, `multi-user` for multi-user mode |
| `PORT` | `3457` | Server port. `3457` is the dev fallback; pick any port for production (this guide uses `8080`). |
| `HOST` | `0.0.0.0` | Bind address. Defaults to all interfaces; set to `127.0.0.1` to restrict to localhost. |
| `AGENT_CONSOLE_HOME` | `~/.agent-console` (single-user); `/var/lib/agent-console` (multi-user, Issue [#830](https://github.com/ms2sato/agent-console/issues/830)) | Config and database directory. The SQLite database is `<AGENT_CONSOLE_HOME>/data.db`; the JWT signing secret is `<AGENT_CONSOLE_HOME>/jwt-secret` (auto-generated, mode 0600, on first start). Under multi-user, the bootstrap script sets this explicitly on the systemd unit. |
| `NODE_ENV` | _(unset)_ | Set to `production` for browser-based deployments: it enables the web UI **and**, by default, marks the auth cookie `Secure`. The `Secure` cookie then needs a secure context — HTTPS, or `http://localhost` — see [TLS, `NODE_ENV`, and secure contexts](#tls-node_env-and-secure-contexts). |
| `AUTH_COOKIE_SECURE` | _(unset)_ | Tri-state override for the auth cookie's `Secure` attribute, decoupling it from `NODE_ENV`. Unset → follows `NODE_ENV` (default); `false` → never `Secure` (for trusted-network plain-HTTP deployments); `true` → always `Secure`. Invalid values fail fast at startup. See [Plain HTTP on a trusted network](#plain-http-on-a-trusted-network-auth_cookie_secure). |
| `PTY_PROVIDER` | _(unset; server default `bun-pty`)_ | Opt-in override for the PTY backend. Valid values: `bun-pty` (default) or `bun-terminal` (the `Bun.spawn({ terminal: ... })` provider; Bun ≥ 1.3.5). Used to dogfood the alternative backend before the stage-2 default flip (Issues [#824](https://github.com/ms2sato/agent-console/issues/824) / [#827](https://github.com/ms2sato/agent-console/issues/827)). The bootstrap script exposes this as `--pty-provider <name>` (or env `AGENT_CONSOLE_PTY_PROVIDER`); when unset, the rendered systemd unit omits the entry entirely so the server falls back to its compiled default. Invalid values are rejected at bootstrap time before any system state is touched. |

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
