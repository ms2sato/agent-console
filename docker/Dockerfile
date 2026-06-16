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

# --- Service user (runs the server process; non-root) ---
# Added to the `shadow` group so pam_unix can read /etc/shadow and verify any
# user's password in-process. Without this, a non-root caller falls back to the
# unix_chkpwd helper, which only permits verifying the caller's OWN password —
# so every login would 401. (Discovered via this verification environment;
# documented in docs/multi-user-setup-guide.md.)
RUN useradd --create-home --shell /usr/sbin/nologin agentconsole \
 && usermod -aG shadow agentconsole

# --- sudoers: allow the service user to launch login shells as other users ---
COPY docker/sudoers-agentconsole /etc/sudoers.d/agentconsole
RUN chmod 0440 /etc/sudoers.d/agentconsole \
 && visudo -cf /etc/sudoers.d/agentconsole

# --- Test OS users with known passwords (VERIFICATION ONLY) ---
# Passwords are intentionally well-known; this image must never be exposed.
#
# Home dirs are set to 0711 (traversable but not readable by others). The server
# spawns `sudo -u <user> -i` with the session's working directory as the PTY
# cwd, and the forked child performs chdir(cwd) WHILE STILL the service user
# (before sudo switches to the target user). Debian's default HOME_MODE=0700
# would deny that chdir and the spawn fails with "PTY spawn failed". 0711 lets
# the service user enter the directory without exposing its contents. This
# mirrors the real-deployment requirement documented in
# docs/multi-user-setup-guide.md ("service user must be able to enter session
# working directories").
RUN useradd --create-home --shell /bin/bash alice \
 && useradd --create-home --shell /bin/bash bob \
 && echo 'alice:alice-password' | chpasswd \
 && echo 'bob:bob-password' | chpasswd \
 && chmod 0711 /home/alice /home/bob

# --- Application bundle ---
WORKDIR /app
COPY --from=builder /app/dist ./dist
# Install the native bun-pty binary for this platform into the dist bundle.
RUN cd dist && bun install

# Data directory (DB, jwt-secret, worker output) owned by the service user.
ENV AGENT_CONSOLE_HOME=/home/agentconsole/.agent-console
RUN mkdir -p "${AGENT_CONSOLE_HOME}" \
 && chown -R agentconsole:agentconsole "${AGENT_CONSOLE_HOME}" /app/dist

# Server configuration.
# NOTE: NODE_ENV is intentionally left UNSET. In production NODE_ENV=production
# makes the auth cookie `secure`, which is dropped over plain HTTP — fine behind
# TLS but it would break the localhost HTTP verification done here.
ENV AUTH_MODE=multi-user \
    PORT=8080 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info

# Run from inside dist/ so bun-pty resolves its native library relative to the
# bundle's node_modules (the documented standalone layout: `cd dist && bun start`).
WORKDIR /app/dist
USER agentconsole
EXPOSE 8080
CMD ["bun", "index.js"]
