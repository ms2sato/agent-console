# Multi-user verification image for Agent Console (AUTH_MODE=multi-user).
#
# Purpose: run the already-implemented multi-user mode on a real Linux box so we
# can verify OS authentication (pamtester) and per-user PTY identity isolation
# (sudo -u <user>) end to end. This is a VERIFICATION environment, not a
# production deployment recipe — production should use systemd + TLS (see
# docs/multi-user-setup-guide.md).
#
# Base image: a dated Debian slim tag (no bun in it). All stages share the same
# base so the bun-pty native module installed in the runtime stage matches the
# runtime glibc. The tag is pinned to the patch/date, not to a digest.
#
# Bun is NOT taken from the oven/bun image (a new Bun release would otherwise
# have to wait for that image to be published) and is NOT installed with the
# `curl | bash` installer. The `bun-fetch` stage downloads the release zip of
# the version listed in docker/bun-sha256.txt and stops the build unless the zip
# hashes to the SHA256 written in that file (the repository, not the download
# server, is the source of truth). Only the verified binary is copied into the
# other stages, so the final image carries no curl and no unzip.
#
# To upgrade Bun, change two files: the repo-root .bun-version and
# docker/bun-sha256.txt (procedure in that file).
# scripts/__tests__/bun-version-pins.test.mjs fails if they disagree. The
# version must also be >= the floor in scripts/check-bun-version.mjs.
# See docker/README.md ("Building behind a blocked Docker Hub").

ARG DEBIAN_BASE=debian:trixie-20261027-slim

# ===== Stage 0: download and verify bun (never reaches the final image) =====
FROM ${DEBIAN_BASE} AS bun-fetch
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY docker/bun-sha256.txt docker/fetch-bun.sh /tmp/
RUN sh /tmp/fetch-bun.sh /tmp/bun-sha256.txt /out

# ===== Shared base: debian slim + the verified bun =====
FROM ${DEBIAN_BASE} AS bun-base
ENV DEBIAN_FRONTEND=noninteractive \
    BUN_INSTALL_BIN=/usr/local/bin \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bun-node-fallback-bin
COPY --from=bun-fetch /out/bun /usr/local/bin/bun
COPY --from=bun-fetch /out/bun-version /usr/local/share/bun-version
# Same layout the oven/bun image has: `bunx`, and a `node` fallback that is bun
# itself (scripts that shell out to `node` keep working without a node install).
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx \
 && mkdir -p /usr/local/bun-node-fallback-bin \
 && ln -s /usr/local/bin/bun /usr/local/bun-node-fallback-bin/node \
 && test "$(bun --version)" = "$(cat /usr/local/share/bun-version)"

# ===== Stage 1: build the standalone dist bundle =====
FROM bun-base AS builder
# ca-certificates: `bun install` talks to the npm registry over HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
# Full install (dev deps are needed for the client/server build). The preinstall
# bun-version gate and the minimumReleaseAge supply-chain gate both run here.
RUN bun install --frozen-lockfile
# Produces /app/dist/{index.js, package.json, public/}.
RUN bun run build

# ===== Stage 2: runtime as the non-root service user =====
FROM bun-base AS runtime

# Runtime OS dependencies:
# - sudo:          the server spawns PTYs via `sudo -u <user> -i`
# - pamtester:     Linux OS-credential validation (MultiUserMode.validateLinux)
# - libpam-modules / login: provide /etc/pam.d/login + pam_unix/unix_chkpwd
# - passwd:        useradd/chpasswd for creating test users
# - git:           agents/worktrees expect git on PATH
# - procps:        ps/whoami diagnostics inside the container
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      sudo pamtester libpam-modules libpam-runtime login passwd git procps \
 && rm -rf /var/lib/apt/lists/* \
 && test "$(bun --version)" = "$(cat /usr/local/share/bun-version)" \
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
#
# shared1 is the Shared Account (Issue #1619): a pure execution identity that
# the verification checks register and bind through the DB-backed shared
# account API. (docker/docker-compose.verification.yml still sets the retired
# AGENT_CONSOLE_SHARED_USERNAME, but only to exercise its startup warning.)
# Shared sessions spawn their PTY as this account while the authenticated
# human remains the initiator -- see docs/design/shared-orchestrator-session.md.
# It needs a real login shell (/bin/bash) because the elevation rules file
# only permits /bin/sh, /bin/bash, /usr/bin/sh, /usr/bin/bash as elevation
# targets, and it joins agent-console-users so it can traverse the shared
# data root.
#
# Deliberate divergence from production: scripts/setup-shared-account.sh LOCKS
# the shared account's password because the account itself never logs in.
# This verification image gives it a known password instead, so the stack's
# own checks can exercise the account directly; that is safe only because
# this image is loopback-only and already ships intentionally well-known
# credentials.
RUN useradd --create-home --shell /bin/bash alice \
 && useradd --create-home --shell /bin/bash bob \
 && useradd --create-home --shell /bin/bash shared1 \
 && echo 'alice:alice-password' | chpasswd \
 && echo 'bob:bob-password' | chpasswd \
 && echo 'shared1:shared1-password' | chpasswd \
 && chmod 0700 /home/alice /home/bob /home/shared1 \
 && usermod -aG agent-console-users alice \
 && usermod -aG agent-console-users bob \
 && usermod -aG agent-console-users shared1

# --- Application bundle ---
WORKDIR /app
COPY --from=builder /app/dist ./dist
# Install the native bun-pty binary for this platform into the dist bundle.
RUN cd dist && bun install

# Data directory (DB, jwt-secret, worker output, worktrees).
# Issue #830: in multi-user mode, the data root lives at /var/lib/agent-console
# owned agentconsole:agent-console-users mode 2775 (setgid + group-writable)
# so per-user PTYs can traverse into worktrees. The bootstrap script does
# this on a real host; here we replicate it inline, including the
# `source-repos` directory (same owner, group and 2775 mode as the setup
# script gives it): clones are reserved as the requesting user, so the
# directory must already be group-writable and setgid; the server never shapes it.
ENV AGENT_CONSOLE_HOME=/var/lib/agent-console
RUN install -d -o agentconsole -g agent-console-users -m 2775 "${AGENT_CONSOLE_HOME}" "${AGENT_CONSOLE_HOME}/source-repos" \
 && chown -R agentconsole:agent-console-users /app/dist

# --- Workspace copy for scripts/verify-multiuser-docker.sh --smokes (Issue #1619) ---
# Why: `scripts/verify-multiuser-docker.sh --smokes` runs the repo's real-host
# smoke scripts (scripts/smoke/check-*.ts) inside this container as
# agentconsole; they import production source modules from
# packages/server/src/** and rely on the workspace `bun install` the builder
# stage already performed. The runtime bundle in /app/dist alone cannot
# satisfy them.
#
# The builder's /app is copied wholesale (source tree + node_modules + the
# built dist/) because the workspace's node_modules links are all RELATIVE
# (packages/server/node_modules/hono -> ../../../node_modules/.bun/...), so
# relocating the tree to /workspace keeps every resolution intact.
#
# /workspace is the build context minus .dockerignore -- what that file
# excludes is what does not reach the image, so .dockerignore is now a
# runtime-image concern, not only a build-cache one.
#
# Cost: this roughly doubles the image size (the install store is ~1 GB).
# Accepted deliberately -- this is a local verification image, never a
# production deployment recipe, and the alternative (bind-mounting a host
# node_modules) is unusable because bun-pty is a native module built for the
# container's own glibc.
#
# /workspace/dist is a harmless duplicate of the served bundle; the smokes
# never read it. resolveEmbeddedAgentEntryPath keys off the *running
# module's* directory (import.meta.dir), which for a smoke is
# /workspace/packages/server/src/services, so the workspace-package
# resolution branch is the one exercised -- exactly what
# check-embedded-agent-elevation.ts asserts.
COPY --from=builder --chown=agentconsole:agent-console-users /app /workspace

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
