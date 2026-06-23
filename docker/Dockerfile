# Multi-user verification image for Agent Console (AUTH_MODE=multi-user).
#
# Purpose: run the already-implemented multi-user mode on a real Linux box so we
# can verify OS authentication (pamtester) and per-user PTY identity isolation
# (sudo -u <user>) end to end. This is a VERIFICATION environment, not a
# production deployment recipe — production should use systemd + TLS (see
# docs/multi-user-setup-guide.md).
#
# Base image: oven/bun (Debian). Both stages share the same base so the bun-pty
# native module installed in the runtime stage matches the runtime glibc.
#
# The default BUN_BASE is a directly-pullable fixed tag so a clean environment
# (CI, another machine) can `docker build` this without any local cache. The
# in-image step below normalizes bun to BUN_VERSION (>= 1.3.5, required by
# Bun.Terminal and the repo's preinstall gate), so you may override BUN_BASE
# with an older locally-cached base when registry pulls are unavailable, e.g.:
#   DOCKER_BUILDKIT=0 docker build --build-arg BUN_BASE=oven/bun:1.3.4 ...
# See docker/README.md ("Building behind a blocked Docker Hub").

ARG BUN_BASE=oven/bun:1.3.8
ARG BUN_VERSION=1.3.8

# ===== Stage 1: build the standalone dist bundle =====
FROM ${BUN_BASE} AS builder
ARG BUN_VERSION

ENV DEBIAN_FRONTEND=noninteractive \
    BUN_INSTALL=/usr/local
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
 && bun --version

WORKDIR /app
COPY . .
# Full install (dev deps are needed for the client/server build). The preinstall
# bun-version gate and the minimumReleaseAge supply-chain gate both run here.
RUN bun install --frozen-lockfile
# Produces /app/dist/{index.js, package.json, public/}.
RUN bun run build

# ===== Stage 2: runtime as the non-root service user =====
FROM ${BUN_BASE} AS runtime
ARG BUN_VERSION

ENV DEBIAN_FRONTEND=noninteractive \
    BUN_INSTALL=/usr/local

# Runtime OS dependencies:
# - sudo:          the server spawns PTYs via `sudo -u <user> -i`
# - pamtester:     Linux OS-credential validation (MultiUserMode.validateLinux)
# - libpam-modules / login: provide /etc/pam.d/login + pam_unix/unix_chkpwd
# - passwd:        useradd/chpasswd for creating test users
# - git:           agents/worktrees expect git on PATH
# - procps:        ps/whoami diagnostics inside the container
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl unzip ca-certificates \
      sudo pamtester libpam-modules libpam-runtime login passwd git procps \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
 && bun --version \
 && test -f /etc/pam.d/login

# --- Shared system group (Issue #830) ---
# In multi-user mode the data root lives at a system-wide path
# (/var/lib/agent-console) owned <service-user>:agent-console-users mode 2775
# so the per-user PTY (running as the logged-in user) can traverse into
# worktrees. Every interactive user joins this group; the service user is
# also a member.
RUN groupadd --system agent-console-users

# --- Service user (runs the server process; non-root) ---
# Primary group = agent-console-users (Issue #830) so that at runtime the
# server's primary gid IS the shared group, matching what `Group=<shared-group>`
# does on the systemd unit on a real host. The upload-buffer multi-user
# contract in packages/server/src/routes/workers.ts compares the upload dir's
# gid against `process.getgid()`; primary group = shared group makes that
# comparison pass under Docker too.
#
# Added to the `shadow` group as a supplementary group so pam_unix can read
# /etc/shadow and verify any user's password in-process. Without this, a
# non-root caller falls back to the unix_chkpwd helper, which only permits
# verifying the caller's OWN password — so every login would 401.
# (Discovered via this verification environment; documented in
# docs/multi-user-setup-guide.md.)
RUN useradd --create-home --shell /usr/sbin/nologin --gid agent-console-users agentconsole \
 && usermod -aG shadow agentconsole

# --- sudoers: allow the service user to launch login shells as other users ---
COPY docker/sudoers-agentconsole /etc/sudoers.d/agentconsole
RUN chmod 0440 /etc/sudoers.d/agentconsole \
 && visudo -cf /etc/sudoers.d/agentconsole

# --- Test OS users with known passwords (VERIFICATION ONLY) ---
# Passwords are intentionally well-known; this image must never be exposed.
#
# Home dirs are left at 0700 — the OS default (Debian/Ubuntu HOME_MODE) and the
# most restrictive, private-to-the-owner mode. This is the permanent regression
# guard for #806: before that fix the PTY spawn ran chdir(session cwd) WHILE
# STILL the service user (before sudo switched to the target user), so a 0700
# home it did not own denied the chdir and the spawn failed with "PTY spawn
# failed". #806 fixed it by performing the pre-exec chdir into a neutral,
# always-traversable cwd (`/`) and deferring the `cd` into the session directory
# to the inner shell that runs AS the target user. Keeping the test homes at the
# default 0700 means the CI E2E job permanently exercises that fixed path so a
# regression resurfaces as a failing build (issue #808).
#
# Test users are added to agent-console-users so the multi-user shared-root
# layout (Issue #830) is exercised in this verification environment.
RUN useradd --create-home --shell /bin/bash alice \
 && useradd --create-home --shell /bin/bash bob \
 && echo 'alice:alice-password' | chpasswd \
 && echo 'bob:bob-password' | chpasswd \
 && chmod 0700 /home/alice /home/bob \
 && usermod -aG agent-console-users alice \
 && usermod -aG agent-console-users bob

# --- Application bundle ---
WORKDIR /app
COPY --from=builder /app/dist ./dist
# Install the native bun-pty binary for this platform into the dist bundle.
RUN cd dist && bun install

# Data directory (DB, jwt-secret, worker output, worktrees).
# Issue #830: in multi-user mode, the data root lives at /var/lib/agent-console
# owned agentconsole:agent-console-users mode 2775 (setgid + group-writable)
# so per-user PTYs can traverse into worktrees. The bootstrap script does
# this on a real host; here we replicate it inline.
ENV AGENT_CONSOLE_HOME=/var/lib/agent-console
RUN install -d -o agentconsole -g agent-console-users -m 2775 "${AGENT_CONSOLE_HOME}" \
 && chown -R agentconsole:agent-console-users /app/dist

# Server configuration.
# NOTE: NODE_ENV is intentionally left UNSET. NODE_ENV=production makes the auth
# cookie `secure` by default; AUTH_COOKIE_SECURE, when set, takes precedence over
# that NODE_ENV fallback. A `secure` cookie is dropped over plain HTTP — fine
# behind TLS but it would break the localhost HTTP verification done here.
# AUTH_COOKIE_SECURE is also left unset, so the NODE_ENV fallback applies.
ENV AUTH_MODE=multi-user \
    PORT=8080 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info

# Run from inside dist/ so bun-pty resolves its native library relative to the
# bundle's node_modules (the documented standalone layout: `cd dist && bun start`).
WORKDIR /app/dist
# Issue #830: `USER agentconsole` (no explicit `:group`) so Docker calls
# initgroups() on container start and loads agentconsole's supplementary
# groups — most importantly the `shadow` group required by pam_unix to read
# /etc/shadow for OS authentication. agentconsole's PRIMARY group is
# `agent-console-users` (set by the useradd `--gid` above), so
# `process.getgid()` returns the shared group's gid, satisfying the
# upload-buffer multi-user contract in packages/server/src/routes/workers.ts.
# Using `USER agentconsole:agent-console-users` here would override the gid
# AND skip initgroups() — supplementary groups would be lost, pam_unix would
# lose shadow access, and every login would 401 (CI reproduction: PR #831).
USER agentconsole
EXPOSE 8080
# Set umask=0002 to match the production systemd unit
# (scripts/agent-console-multiuser.service.template's `UMask=0002`). Without
# this, server-created dirs inside the shared data root (e.g., the
# `worktrees/` parent dir created by WorktreeService.createWorktree) land
# at mode 0755 -- the group lacks write permission, and a non-server user
# running `git worktree add` via runAsUser cannot create the worktree
# leading directories. Production systemd already handles this; the
# verification image must mirror it. (Issue #838 E2E regression.)
CMD ["sh", "-c", "umask 0002 && exec bun index.js"]
