#!/bin/sh
# Entrypoint for the dev stack (docker/docker-compose.yml).
#
# Stage 1 runs as root and only fixes mount ownership, then drops to the
# `agentconsole` service user via setpriv and re-executes itself (stage 2)
# to install dependencies and start the dev servers.
#
# Why a root stage is needed at all:
#   - Named volumes mounted over paths that do not exist in the image
#     (the node_modules mountpoints) are created root-owned; the service
#     user could not write to them otherwise.
#   - The repo bind mount at /app is owned by a HOST uid/gid. Its files are
#     group-writable (setgid dirs + the host's agent-console-users group),
#     but that group's NUMERIC gid on the host generally differs from the
#     gid the image assigned to its own agent-console-users group — so the
#     dropped process must additionally join the bind mount's numeric gid.
set -eu

APP_DIR=/app
SERVICE_USER=agentconsole
SERVICE_GROUP=agent-console-users

if [ "${1:-}" != "stage2" ]; then
  # ---- Stage 1 (root): mount fixups, then drop privileges ----------------
  for dir in \
    "$APP_DIR/node_modules" \
    "$APP_DIR/packages/client/node_modules" \
    "$APP_DIR/packages/server/node_modules" \
    "$APP_DIR/packages/shared/node_modules" \
    "$APP_DIR/packages/integration/node_modules" \
    /var/lib/agent-console; do
    chown "$SERVICE_USER:$SERVICE_GROUP" "$dir"
    chmod 2775 "$dir"
  done

  # Supplementary groups: everything the service user normally gets from
  # initgroups (most importantly `shadow`, required by pam_unix for OS
  # authentication) plus the bind mount's numeric gid for repo write access
  # (vite regenerates routeTree.gen.ts in the repo tree). sort -u dedupes
  # the repo gid when it happens to match a container group.
  REPO_GID="$(stat -c %g "$APP_DIR")"
  GROUP_LIST="$( { id -G "$SERVICE_USER" | tr ' ' '\n'; echo "$REPO_GID"; } | sort -un | paste -sd, -)"

  HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
  export HOME
  export USER="$SERVICE_USER" LOGNAME="$SERVICE_USER"
  # The image bakes BUN_INSTALL=/usr/local (bun's own install prefix at build
  # time, root-owned). bun install / bun x place their cache and temp dirs
  # under $BUN_INSTALL, which fails with AccessDenied for a non-root user —
  # point it at the service user's home instead.
  export BUN_INSTALL="$HOME/.bun"

  exec setpriv \
    --reuid "$SERVICE_USER" \
    --regid "$SERVICE_GROUP" \
    --groups "$GROUP_LIST" \
    sh "$APP_DIR/docker/dev-entrypoint.sh" stage2
fi

# ---- Stage 2 (agentconsole): install deps, run the dev servers -----------
# umask 0002 mirrors the production systemd unit and the verification CMD:
# server-created dirs under the shared data root must stay group-writable
# so per-user PTYs (alice / bob) can traverse into worktrees.
umask 0002
cd "$APP_DIR"

# The container's bun/glibc, not the host's, populates the node_modules
# volumes. Cheap no-op when the volumes are already in sync with bun.lock.
bun install --frozen-lockfile

# Same two processes as scripts/dev.sh, with one difference: vite must bind
# 0.0.0.0 so Docker's port mapping can reach it from the host browser.
# concurrently is a root devDependency; `bun x` runs its bin under bun (the
# image has no node).
exec bun x concurrently -n client,server -c cyan,yellow \
  "cd packages/client && bun run dev --port ${CLIENT_PORT:-5173} --host 0.0.0.0" \
  "cd packages/server && bun run dev"
