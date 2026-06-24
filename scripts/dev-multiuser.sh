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
# Source-code deployment:
#   The script rsyncs the current git checkout to
#   /home/agentconsole/agent-console-dev/ (owned by agentconsole). This
#   mirrors production's deploy pattern (`/home/agentconsole/agent-console/`)
#   so the service user can read the code without ACL grants on the
#   developer's home tree.
#
#   Trade-off: edits to the developer's worktree do NOT propagate to the
#   running server automatically. Re-run this script to re-sync. (Vite's
#   client-side HMR works as usual because vite runs from the developer's
#   worktree.)
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
#   - rsync installed
#
# Usage:
#   bash scripts/dev-multiuser.sh
#
# Stop with Ctrl+C; both processes terminate.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# REPO_ROOT defaults to the script's containing repo (the typical case where
# the developer cd-d into a single worktree and runs `bash scripts/...`).
# Overridable via env so a developer can deploy a different worktree's code
# without copying this script — useful for testing pre-merge PR branches:
#   REPO_ROOT=/path/to/other/worktree bash scripts/dev-multiuser.sh
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

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

# `id -nG` (no arg) queries the CURRENT shell's effective groups via
# getgroups(2), so it catches the "added to group but session not refreshed"
# case. `id -nG "$CURRENT_USER"` would consult passwd DB and pass even when
# the running shell does not yet have the group effective, leaving later
# permission failures unexplained. CodeRabbit Major on PR #868.
if ! id -nG | tr ' ' '\n' | grep -qx "$SHARED_GROUP"; then
  echo "ERROR: current shell session does not have '$SHARED_GROUP' as an effective group." >&2
  echo "  Either the user is not in the group yet, OR the user was added but the running" >&2
  echo "  shell session was started before the change took effect." >&2
  echo "  Fix: sudo gpasswd -a $CURRENT_USER $SHARED_GROUP" >&2
  echo "  Then start a NEW login session (or run 'newgrp $SHARED_GROUP' in this shell)." >&2
  exit 2
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "ERROR: rsync not found. Install with: sudo apt install -y rsync" >&2
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
# Resolve the service user's bun binary. We cannot reliably probe it from
# the developer's session: the binary typically lives in $SERVICE_HOME/.bun/
# (mode 700/755 on the user's home), so `[ -x ]` and even `stat` may fail
# for the developer. Using `sudo -n test` requires NOPASSWD which the
# developer rarely has against $SERVICE_USER, so a probe would either fail
# (false negative) or block on a password prompt (unfriendly).
#
# Pragmatic strategy: default to the production install path
# (`$SERVICE_HOME/.bun/bin/bun`) and let the user override with SERVICE_BUN.
# If the path is wrong at server-start time, the elevated `bun` invocation
# will fail with a clear "no such file" error, surfacing the misconfiguration.
SERVICE_BUN="${SERVICE_BUN:-$SERVICE_HOME/.bun/bin/bun}"
echo "[pre-flight] service user bun: $SERVICE_BUN (override with SERVICE_BUN=... if wrong)"

# --- 1. Idempotent dev data root setup (production-mirrored ownership) -----
echo "[1/4] Ensuring dev data root at $DEV_DATA_ROOT (owned by $SERVICE_USER:$SHARED_GROUP, mode 2775)..."
ensure_shared_dir() {
  local target="$1"
  if [ ! -d "$target" ]; then
    sudo install -d -o "$SERVICE_USER" -g "$SHARED_GROUP" -m 2775 "$target"
    echo "  created $target"
    return 0
  fi
  # Existing dir: repair ownership + mode if drifted. The 2775 setgid +
  # group-writable mode is the security contract that ms2sato accesses
  # files through (group membership + setgid inheritance). A stale 0755
  # or non-setgid silently breaks the production-mirrored ownership model.
  # CodeRabbit Major on PR #868.
  local owner_group mode
  owner_group="$(stat -c '%U:%G' "$target")"
  mode="$(stat -c '%a' "$target")"
  if [ "$owner_group" != "$SERVICE_USER:$SHARED_GROUP" ]; then
    echo "  repairing $target: owner $owner_group -> $SERVICE_USER:$SHARED_GROUP" >&2
    sudo chown "$SERVICE_USER:$SHARED_GROUP" "$target"
  fi
  if [ "$mode" != "2775" ]; then
    echo "  repairing $target: mode $mode -> 2775 (setgid + group-writable)" >&2
    sudo chmod 2775 "$target"
  fi
}
ensure_shared_dir "$DEV_DATA_ROOT"
ensure_shared_dir "$DEV_DATA_ROOT/source-repos"
ensure_shared_dir "$DEV_DATA_ROOT/repositories"
ensure_shared_dir "$DEV_DATA_ROOT/uploads"

# --- 2. Deploy source to a directory the service user owns (rsync) ---------
# Mirrors production's deploy pattern: production rsyncs to
# /home/agentconsole/agent-console; we rsync to
# /home/agentconsole/agent-console-dev so the production tree stays intact.
TARGET_HOME="${TARGET_HOME:-$SERVICE_HOME/agent-console-dev}"
echo "[2/5] Deploying source to $TARGET_HOME via rsync (as $SERVICE_USER)..."
sudo install -d -o "$SERVICE_USER" -g "$SHARED_GROUP" -m 0755 "$TARGET_HOME"
sudo rsync -a --delete \
  --chown="$SERVICE_USER:$SHARED_GROUP" \
  --exclude='/.git' \
  --exclude='/.git/' \
  --exclude='/node_modules' \
  --exclude='/packages/*/node_modules' \
  --exclude='/dist' \
  --exclude='/packages/*/dist' \
  --exclude='/.claude/worktrees' \
  --exclude='*.log' \
  "$REPO_ROOT/" "$TARGET_HOME/"
echo "  source rsync complete"

# --- 3. Ensure target's node_modules exist (bun install) -------------------
# Skipped only if a previous run left a complete install. bun install is
# idempotent + fast on no-change, so we run unconditionally for safety.
#
# PATH must include the service user's bun dir because the project's
# `preinstall` script invokes `bun scripts/check-bun-version.mjs` via the
# package manager's PATH lookup, and `bash -c` does not load login profiles.
echo "[3/5] Running bun install in $TARGET_HOME (as $SERVICE_USER)..."
# Pass TARGET_HOME / SERVICE_BUN via the environment (NOT interpolated into
# the bash -c string), then dereference them inside a single-quoted body.
# A path containing `'` would otherwise break the command and could execute
# unintended shell syntax under the service user. CodeRabbit Major on #868.
sudo -u "$SERVICE_USER" env \
  PATH="$SERVICE_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin" \
  TARGET_HOME="$TARGET_HOME" \
  SERVICE_BUN="$SERVICE_BUN" \
  bash -c 'cd "$TARGET_HOME" && "$SERVICE_BUN" install' 2>&1 | sed 's/^/  /'

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

# --- 5. Start client (vite, as developer, from the worktree) ---------------
# Vite runs against the developer's worktree (NOT $TARGET_HOME), so client
# edits propagate through HMR as usual. The vite dev server proxies API
# requests to localhost:$PORT (server below), so the client/server boundary
# is identical to production from the browser's perspective.
#
# Output piping: use process substitution so `$!` is the actual child PID
# (vite / bun), not the PID of the `sed` filter. With `cmd | sed &` bash's
# `$!` is the last process in the pipeline (sed), so a later `kill $!`
# would terminate only sed and leave the dev process orphaned. CodeRabbit
# Major on #868.
echo "[4/5] Starting vite client (as $CURRENT_USER, from worktree) on port $CLIENT_PORT..."
( cd "$REPO_ROOT/packages/client" && CLIENT_PORT="$CLIENT_PORT" bun run dev --port "$CLIENT_PORT" ) \
  > >(sed -u 's/^/[client] /') 2> >(sed -u 's/^/[client] /' >&2) &
VITE_PID=$!

# --- 6. Start server (bun, as service user, from rsync target) -------------
# Mirror production systemd unit env (see scripts/agent-console-multiuser.service.template).
# UMask 0002 is set via shell so setgid + sharedRepository=group inheritance works.
# NODE_ENV=development (vs production) so dev-only conveniences (verbose logs,
# HMR) remain available. AUTH_COOKIE_SECURE=false so cookies work over http.
# Server runs against $TARGET_HOME (NOT the worktree) -- edits to server code
# in the worktree do NOT propagate until you re-run this script. Vite's HMR
# only covers client-side; server is read at process start.
#
# Path safety: TARGET_HOME / SERVICE_BUN are passed via env (NOT interpolated
# into the bash -c string) to avoid command-injection on paths containing
# single quotes. CodeRabbit Major on #868.
echo "[5/5] Starting server (as $SERVICE_USER, from $TARGET_HOME) on port $PORT..."
sudo -u "$SERVICE_USER" env \
  PATH="$SERVICE_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin" \
  PORT="$PORT" \
  HOST="$HOST" \
  AUTH_MODE=multi-user \
  AGENT_CONSOLE_HOME="$DEV_DATA_ROOT" \
  AUTH_COOKIE_SECURE=false \
  NODE_ENV=development \
  TARGET_HOME="$TARGET_HOME" \
  SERVICE_BUN="$SERVICE_BUN" \
  bash -c 'umask 0002 && cd "$TARGET_HOME/packages/server" && "$SERVICE_BUN" --watch src/index.ts' \
  > >(sed -u 's/^/[server] /') 2> >(sed -u 's/^/[server] /' >&2) &
SERVER_PID=$!

echo ""
echo "Ready. Open http://localhost:$CLIENT_PORT in your browser."
echo "Login with your OS account (multi-user mode requires PAM auth)."
echo "Press Ctrl+C to stop."
echo ""

wait
