#!/bin/bash
# scripts/dev-multiuser.sh
#
# Run dev server in multi-user mode with production-mirrored ownership.
#
# Unlike `scripts/dev.sh` (which runs the server as the developer as a
# single-user instance under $HOME/.agent-console-dev), this script runs the
# server as the production service user (agentconsole) with a production-
# mirrored data root (owned by agentconsole:agent-console-users, mode 2775,
# setgid). The developer (ms2sato or similar) accesses files through their
# membership in the shared group + setgid + sharedRepository=group, the
# same access path used in production.
#
# Path layout (mirrors production, with `-dev` suffix to avoid mixing data):
#   /var/lib/agent-console-dev/             agentconsole:agent-console-users 2775
#   /var/lib/agent-console-dev/source-repos/  same
#   /var/lib/agent-console-dev/repositories/  same
#   /var/lib/agent-console-dev/uploads/        same
#
# Source code: served from the current git checkout (worktree). The service
# user gets read-only ACL access so hot reload works without rsync.
#
# Ports: defaults match `scripts/dev.sh` (3457 / 5173) so the production
# instance on 8080 stays undisturbed. Only one dev instance can run at a
# time (single-user dev.sh OR this script, not both).
#
# Prerequisites (set up by scripts/setup-multiuser-for-ubuntu.sh on the host):
#   - `agentconsole` system user exists
#   - `agent-console-users` shared group exists
#   - current developer user is a member of agent-console-users
#   - sudoers config permits agentconsole -> developer-user without password
#   - agentconsole has bun installed (typically /home/agentconsole/.bun/bin/bun)
#   - acl package installed (`setfacl`)
#
# Usage:
#   bash scripts/dev-multiuser.sh
#
# Stop with Ctrl+C; both processes terminate.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Configurable defaults (override via env) -------------------------------
SERVICE_USER="${SERVICE_USER:-agentconsole}"
SHARED_GROUP="${SHARED_GROUP:-agent-console-users}"
DEV_DATA_ROOT="${DEV_DATA_ROOT:-/var/lib/agent-console-dev}"
PORT="${PORT:-3457}"
CLIENT_PORT="${CLIENT_PORT:-5173}"
HOST="${HOST:-0.0.0.0}"

# --- Pre-flight checks ------------------------------------------------------
echo ""
echo "============================================"
echo "  Dev (multi-user) Server Starting"
echo "--------------------------------------------"
echo "  Service user:   $SERVICE_USER"
echo "  Shared group:   $SHARED_GROUP"
echo "  Data root:      $DEV_DATA_ROOT"
echo "  Frontend:       http://localhost:$CLIENT_PORT"
echo "  Backend:        http://localhost:$PORT"
echo "  Source:         $REPO_ROOT"
echo "============================================"
echo ""

CURRENT_USER="$(whoami)"

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "ERROR: service user '$SERVICE_USER' not found." >&2
  echo "  Run scripts/setup-multiuser-for-ubuntu.sh first, or override SERVICE_USER=..." >&2
  exit 2
fi

if ! getent group "$SHARED_GROUP" >/dev/null; then
  echo "ERROR: shared group '$SHARED_GROUP' not found." >&2
  echo "  Run scripts/setup-multiuser-for-ubuntu.sh first." >&2
  exit 2
fi

if ! id -nG "$CURRENT_USER" | tr ' ' '\n' | grep -qx "$SHARED_GROUP"; then
  echo "ERROR: current user '$CURRENT_USER' is not in '$SHARED_GROUP' (checked via passwd DB)." >&2
  echo "  Fix: sudo gpasswd -a $CURRENT_USER $SHARED_GROUP" >&2
  echo "  Then start a NEW login session (or use 'newgrp $SHARED_GROUP') so the group is effective." >&2
  exit 2
fi

if ! command -v setfacl >/dev/null 2>&1; then
  echo "ERROR: setfacl not found. Install with: sudo apt install -y acl" >&2
  exit 2
fi

# Locate service user's bun. Production systemd unit sets:
#   PATH={{HOME}}/.bun/bin:/usr/local/bin:/usr/bin:/bin
# Mirror that lookup order.
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
if [ -z "$SERVICE_HOME" ]; then
  echo "ERROR: cannot resolve home dir for $SERVICE_USER." >&2
  exit 2
fi
SERVICE_BUN=""
for candidate in "$SERVICE_HOME/.bun/bin/bun" /usr/local/bin/bun /usr/bin/bun; do
  if [ -x "$candidate" ]; then SERVICE_BUN="$candidate"; break; fi
done
if [ -z "$SERVICE_BUN" ]; then
  echo "ERROR: bun not found in $SERVICE_USER's expected paths." >&2
  echo "  Looked at: $SERVICE_HOME/.bun/bin/bun, /usr/local/bin/bun, /usr/bin/bun" >&2
  echo "  Override with SERVICE_BUN=/path/to/bun" >&2
  exit 2
fi
echo "[pre-flight] service user bun: $SERVICE_BUN"

# --- 1. Idempotent dev data root setup (production-mirrored ownership) -----
echo "[1/4] Ensuring dev data root at $DEV_DATA_ROOT (owned by $SERVICE_USER:$SHARED_GROUP, mode 2775)..."
ensure_shared_dir() {
  local target="$1"
  if [ -d "$target" ]; then
    # Verify ownership; warn (not fail) if drifted.
    local owner_group
    owner_group="$(stat -c '%U:%G' "$target")"
    if [ "$owner_group" != "$SERVICE_USER:$SHARED_GROUP" ]; then
      echo "  WARN: $target is $owner_group (expected $SERVICE_USER:$SHARED_GROUP). Continuing." >&2
    fi
    return 0
  fi
  sudo install -d -o "$SERVICE_USER" -g "$SHARED_GROUP" -m 2775 "$target"
  echo "  created $target"
}
ensure_shared_dir "$DEV_DATA_ROOT"
ensure_shared_dir "$DEV_DATA_ROOT/source-repos"
ensure_shared_dir "$DEV_DATA_ROOT/repositories"
ensure_shared_dir "$DEV_DATA_ROOT/uploads"

# --- 2. ACL grant on worktree so the service user can read source code -----
echo "[2/4] Ensuring $SERVICE_USER can read $REPO_ROOT (ACL)..."
if ! sudo -u "$SERVICE_USER" test -r "$REPO_ROOT/package.json"; then
  echo "  granting ACL (one-time setup)..."
  sudo setfacl -R -m "u:$SERVICE_USER:rX" "$REPO_ROOT"
  sudo setfacl -R -d -m "u:$SERVICE_USER:rX" "$REPO_ROOT" 2>/dev/null || true
  echo "  ACL granted recursively (default ACL set so new files inherit)"
else
  echo "  already accessible"
fi

# --- 3. Cleanup handlers ---------------------------------------------------
SERVER_PID=""
VITE_PID=""
cleanup() {
  echo ""
  echo "[cleanup] stopping dev-multiuser processes..."
  if [ -n "$VITE_PID" ] && kill -0 "$VITE_PID" 2>/dev/null; then
    kill "$VITE_PID" 2>/dev/null || true
  fi
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    # The bun server is running under sudo -u; we need sudo to signal it.
    sudo kill "$SERVER_PID" 2>/dev/null || true
  fi
  # Wait briefly for graceful exit
  sleep 1
  exit 0
}
trap cleanup INT TERM EXIT

# --- 4. Start client (vite, as developer) ----------------------------------
echo "[3/4] Starting vite client (as $CURRENT_USER) on port $CLIENT_PORT..."
(cd "$REPO_ROOT/packages/client" && CLIENT_PORT="$CLIENT_PORT" bun run dev --port "$CLIENT_PORT") 2>&1 \
  | sed -u 's/^/[client] /' &
VITE_PID=$!

# --- 5. Start server (bun, as service user, multi-user env) ----------------
echo "[4/4] Starting server (as $SERVICE_USER) on port $PORT with multi-user env..."
# Mirror production systemd unit env (see scripts/agent-console-multiuser.service.template).
# UMask 0002 is set via shell so setgid + sharedRepository=group inheritance works.
# NODE_ENV=development (vs production) so dev-only conveniences (verbose logs,
# HMR) remain available. AUTH_COOKIE_SECURE=false so cookies work over http.
sudo -u "$SERVICE_USER" env \
  PATH="$SERVICE_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin" \
  PORT="$PORT" \
  HOST="$HOST" \
  AUTH_MODE=multi-user \
  AGENT_CONSOLE_HOME="$DEV_DATA_ROOT" \
  AUTH_COOKIE_SECURE=false \
  NODE_ENV=development \
  bash -c "umask 0002 && cd '$REPO_ROOT/packages/server' && '$SERVICE_BUN' --watch src/index.ts" 2>&1 \
  | sed -u 's/^/[server] /' &
SERVER_PID=$!

echo ""
echo "Ready. Open http://localhost:$CLIENT_PORT in your browser."
echo "Login with your OS account (multi-user mode requires PAM auth)."
echo "Press Ctrl+C to stop."
echo ""

wait
