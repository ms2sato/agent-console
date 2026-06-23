#!/usr/bin/env bash
#
# One-shot multi-user bootstrap for Agent Console on Ubuntu / Debian.
#
# Performs the steps from docs/multi-user-setup-guide.md as a single
# idempotent operation:
#
#   1. Install pamtester via apt (Linux credential validation hard dependency).
#   2. Create the service user (--system, --create-home, --shell /usr/sbin/nologin).
#      Add to the `shadow` group so pam_unix can verify users' passwords.
#   3. Create the shared system group; add the service user and any
#      operator-specified login users.
#   4. Install the sudoers fragment from the canonical template at
#      scripts/sudoers-agent-console.template. Print the rendered file,
#      validate with `visudo -cf`, then `install -m 0440 -o root -g root`.
#   5. Create the data root (default /var/lib/agent-console) with
#      <service-user>:<shared-group> mode 2775.
#   6. Clone (or rsync) the application into the service user's home;
#      `bun install --production`.
#   7. Render the systemd unit from scripts/agent-console-multiuser.service.template
#      with UMask=0002, AUTH_MODE=multi-user, AGENT_CONSOLE_HOME=<data-root>.
#   8. `systemctl daemon-reload && systemctl enable --now agent-console`.
#
# Idempotency: a second invocation with the same parameters is a no-op
# (existing user / group / dir / unit / sudoers are detected and re-verified).
# If a parameter differs from existing state, abort unless --force.
#
# Usage:
#   sudo scripts/setup-multiuser-for-ubuntu.sh                      # defaults
#   sudo scripts/setup-multiuser-for-ubuntu.sh --port 9000
#   sudo scripts/setup-multiuser-for-ubuntu.sh --add-user alice --add-user bob
#   sudo scripts/setup-multiuser-for-ubuntu.sh --dry-run            # preview
#
# CLI flags > env vars > built-in defaults. Env vars:
#   AGENT_CONSOLE_SERVICE_USER, AGENT_CONSOLE_SERVICE_GROUP,
#   AGENT_CONSOLE_DATA_ROOT, AGENT_CONSOLE_PORT,
#   AGENT_CONSOLE_AUTH_COOKIE_SECURE, AGENT_CONSOLE_INITIAL_USERS
#   (whitespace-separated list of usernames; equivalent to repeated --add-user),
#   AGENT_CONSOLE_PTY_PROVIDER (opt-in PTY backend override; unset = server
#   default; valid values: 'bun-pty' | 'bun-terminal'; Issues #832 / #824).
#
# Documentation: docs/multi-user-setup-guide.md

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults + parameter parsing
# ---------------------------------------------------------------------------

DEFAULT_SERVICE_USER="agentconsole"
DEFAULT_SERVICE_GROUP="agent-console-users"
DEFAULT_DATA_ROOT="/var/lib/agent-console"
DEFAULT_PORT="8080"
DEFAULT_AUTH_COOKIE_SECURE="false"

SERVICE_USER="${AGENT_CONSOLE_SERVICE_USER:-$DEFAULT_SERVICE_USER}"
SERVICE_GROUP="${AGENT_CONSOLE_SERVICE_GROUP:-$DEFAULT_SERVICE_GROUP}"
DATA_ROOT="${AGENT_CONSOLE_DATA_ROOT:-$DEFAULT_DATA_ROOT}"
PORT="${AGENT_CONSOLE_PORT:-$DEFAULT_PORT}"
AUTH_COOKIE_SECURE="${AGENT_CONSOLE_AUTH_COOKIE_SECURE:-$DEFAULT_AUTH_COOKIE_SECURE}"
# Opt-in PTY backend override. Unset (default) -> rendered unit omits the env
# entry entirely and the server falls back to its compiled default ('bun-pty').
# Set to 'bun-terminal' to dogfood the Bun.spawn-based provider before the
# stage-2 default flip (Issues #832 / #824 / #827). The macOS deploy script
# (update-and-deploy-for-mac.sh) provides the analogous slot.
PTY_PROVIDER="${AGENT_CONSOLE_PTY_PROVIDER:-}"

# Initial users: env var holds a whitespace-separated list; CLI --add-user
# extends it (repeatable).
INITIAL_USERS=()
if [ -n "${AGENT_CONSOLE_INITIAL_USERS:-}" ]; then
  # shellcheck disable=SC2206
  INITIAL_USERS=(${AGENT_CONSOLE_INITIAL_USERS})
fi

DRY_RUN=0
FORCE=0
REPO_SOURCE=""  # optional path or URL; defaults to upstream clone

# POSIX-conventional login name regex.
USERNAME_REGEX='^[a-z_][a-z0-9_-]{0,30}$'

err() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: setup-multiuser-for-ubuntu.sh [options]

Options:
  --user <name>          Service user (default: agentconsole)
  --group <name>         Shared group (default: agent-console-users)
  --data-root <path>     Data root (default: /var/lib/agent-console)
  --port <num>           Server port (default: 8080)
  --cookie-secure <bool> AUTH_COOKIE_SECURE (true|false, default: false)
  --pty-provider <name>  Opt-in PTY backend override (bun-pty|bun-terminal).
                         Unset (default) leaves the rendered unit without a
                         PTY_PROVIDER entry; the server uses its compiled
                         default ('bun-pty'). Used for dogfooding the
                         alternative provider (Issues #832 / #824).
  --add-user <username>  OS user to add to the shared group (repeatable)
  --repo-source <ref>    Local path or git URL to install from
                         (default: https://github.com/ms2sato/agent-console.git)
  --force                Overwrite existing state that conflicts with the
                         requested parameters (use with caution)
  --dry-run              Print all actions; do not modify the system
  -h, --help             Show this help and exit

Environment overrides (env vars are used when the matching flag is omitted):
  AGENT_CONSOLE_SERVICE_USER, AGENT_CONSOLE_SERVICE_GROUP,
  AGENT_CONSOLE_DATA_ROOT, AGENT_CONSOLE_PORT,
  AGENT_CONSOLE_AUTH_COOKIE_SECURE, AGENT_CONSOLE_INITIAL_USERS,
  AGENT_CONSOLE_PTY_PROVIDER
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --user)
      [ "$#" -ge 2 ] || err "--user requires an argument"
      SERVICE_USER="$2"; shift 2 ;;
    --group)
      [ "$#" -ge 2 ] || err "--group requires an argument"
      SERVICE_GROUP="$2"; shift 2 ;;
    --data-root)
      [ "$#" -ge 2 ] || err "--data-root requires an argument"
      DATA_ROOT="$2"; shift 2 ;;
    --port)
      [ "$#" -ge 2 ] || err "--port requires an argument"
      PORT="$2"; shift 2 ;;
    --cookie-secure)
      [ "$#" -ge 2 ] || err "--cookie-secure requires an argument"
      AUTH_COOKIE_SECURE="$2"; shift 2 ;;
    --pty-provider)
      [ "$#" -ge 2 ] || err "--pty-provider requires an argument"
      PTY_PROVIDER="$2"; shift 2 ;;
    --add-user)
      [ "$#" -ge 2 ] || err "--add-user requires an argument"
      INITIAL_USERS+=("$2"); shift 2 ;;
    --repo-source)
      [ "$#" -ge 2 ] || err "--repo-source requires an argument"
      REPO_SOURCE="$2"; shift 2 ;;
    --force)
      FORCE=1; shift ;;
    --dry-run)
      DRY_RUN=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      err "unknown argument: $1" ;;
  esac
done

# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------

if ! echo "$SERVICE_USER" | grep -Eq "$USERNAME_REGEX"; then
  err "invalid --user '$SERVICE_USER' (must match $USERNAME_REGEX)"
fi
if ! echo "$SERVICE_GROUP" | grep -Eq "$USERNAME_REGEX"; then
  err "invalid --group '$SERVICE_GROUP' (must match $USERNAME_REGEX)"
fi
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  err "invalid --port '$PORT' (must be an integer in [1, 65535])"
fi
case "$AUTH_COOKIE_SECURE" in
  true|false) ;;
  *) err "invalid --cookie-secure '$AUTH_COOKIE_SECURE' (must be 'true' or 'false')" ;;
esac
# PTY_PROVIDER is opt-in: unset = no env entry in the rendered unit (server
# default). When set, must match one of the values accepted by
# packages/server/src/lib/server-config.ts:117-123.
if [ -n "$PTY_PROVIDER" ]; then
  case "$PTY_PROVIDER" in
    bun-pty|bun-terminal) ;;
    *) err "invalid --pty-provider '$PTY_PROVIDER' (must be 'bun-pty' or 'bun-terminal')" ;;
  esac
fi
case "$DATA_ROOT" in
  /*) ;;
  *) err "invalid --data-root '$DATA_ROOT' (must be an absolute path)" ;;
esac
if echo "$DATA_ROOT" | grep -q '\.\.'; then
  err "invalid --data-root '$DATA_ROOT' (path traversal pattern '..' not allowed)"
fi
DATA_ROOT_PARENT="$(dirname "$DATA_ROOT")"
if [ ! -d "$DATA_ROOT_PARENT" ]; then
  err "parent directory '$DATA_ROOT_PARENT' of --data-root does not exist"
fi
for u in "${INITIAL_USERS[@]+"${INITIAL_USERS[@]}"}"; do
  if ! echo "$u" | grep -Eq "$USERNAME_REGEX"; then
    err "invalid --add-user '$u' (must match $USERNAME_REGEX)"
  fi
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SUDOERS_TEMPLATE="$SCRIPT_DIR/sudoers-agent-console.template"
SYSTEMD_TEMPLATE="$SCRIPT_DIR/agent-console-multiuser.service.template"
SUDOERS_TARGET="/etc/sudoers.d/agent-console"
SYSTEMD_TARGET="/etc/systemd/system/agent-console.service"

if [ ! -f "$SUDOERS_TEMPLATE" ]; then
  err "missing template: $SUDOERS_TEMPLATE"
fi
if [ ! -f "$SYSTEMD_TEMPLATE" ]; then
  err "missing template: $SYSTEMD_TEMPLATE"
fi

require_root() {
  if [ "$DRY_RUN" -eq 1 ]; then
    return 0
  fi
  if [ "$(id -u)" -ne 0 ]; then
    err "this script must be run as root (use the sudoers-allowed wrapper or run as root)"
  fi
}

run() {
  # Print + run, unless --dry-run.
  echo "+ $*"
  if [ "$DRY_RUN" -eq 0 ]; then
    "$@"
  fi
}

heading() {
  echo ""
  echo "==> $*"
}

# Render the systemd unit to stdout from the template.
render_systemd_unit() {
  local service_home
  service_home="$(getent passwd "$SERVICE_USER" 2>/dev/null | cut -d: -f6 || true)"
  # During --dry-run before the user is created, fall back to a synthetic
  # /home path so the rendered output is still inspectable.
  if [ -z "$service_home" ]; then
    service_home="/home/$SERVICE_USER"
  fi
  local bun_path
  bun_path="$service_home/.bun/bin/bun"
  # PTY_PROVIDER opt-in slot (Issue #832). When set, replace the placeholder
  # comment with a real Environment= entry. When unset, delete the placeholder
  # line so the rendered unit stays byte-equivalent with prior installs (which
  # had no PTY_PROVIDER handling at all) -- preserves the unit-comparison
  # idempotency check at the install step.
  local pty_provider_sed
  if [ -n "$PTY_PROVIDER" ]; then
    pty_provider_sed="s|^# PTY_PROVIDER_BLOCK_PLACEHOLDER\$|Environment=PTY_PROVIDER=$PTY_PROVIDER|"
  else
    pty_provider_sed="/^# PTY_PROVIDER_BLOCK_PLACEHOLDER\$/d"
  fi
  sed \
    -e "s|{{SERVICE_USER}}|$SERVICE_USER|g" \
    -e "s|{{SERVICE_GROUP}}|$SERVICE_GROUP|g" \
    -e "s|{{HOME}}|$service_home|g" \
    -e "s|{{BUN_PATH}}|$bun_path|g" \
    -e "s|{{DATA_ROOT}}|$DATA_ROOT|g" \
    -e "s|{{PORT}}|$PORT|g" \
    -e "s|{{AUTH_COOKIE_SECURE}}|$AUTH_COOKIE_SECURE|g" \
    -e "$pty_provider_sed" \
    "$SYSTEMD_TEMPLATE"
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------

echo "Agent Console multi-user bootstrap"
echo "----------------------------------"
echo "  service user        : $SERVICE_USER"
echo "  shared group        : $SERVICE_GROUP"
echo "  data root           : $DATA_ROOT"
echo "  port                : $PORT"
echo "  AUTH_COOKIE_SECURE  : $AUTH_COOKIE_SECURE"
if [ -n "$PTY_PROVIDER" ]; then
  echo "  PTY_PROVIDER        : $PTY_PROVIDER"
else
  echo "  PTY_PROVIDER        : (unset, server default)"
fi
if [ "${#INITIAL_USERS[@]}" -gt 0 ]; then
  echo "  initial users       : ${INITIAL_USERS[*]}"
else
  echo "  initial users       : (none)"
fi
echo "  dry run             : $([ "$DRY_RUN" -eq 1 ] && echo yes || echo no)"
echo "  force               : $([ "$FORCE" -eq 1 ] && echo yes || echo no)"
echo ""

require_root

# ---------------------------------------------------------------------------
# Step 1 — pamtester
# ---------------------------------------------------------------------------

heading "Step 1/8 — apt + pamtester"
if command -v pamtester >/dev/null 2>&1; then
  echo "    pamtester is already installed; skipping."
else
  if ! command -v apt-get >/dev/null 2>&1; then
    err "apt-get not available; this script targets Debian / Ubuntu"
  fi
  run apt-get update
  run apt-get install -y --no-install-recommends pamtester
fi

# ---------------------------------------------------------------------------
# Step 2 — service user
# ---------------------------------------------------------------------------

heading "Step 2/8 — service user '$SERVICE_USER'"
if getent passwd "$SERVICE_USER" >/dev/null 2>&1; then
  echo "    user '$SERVICE_USER' already exists; verifying group membership"
else
  run useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
# Add to `shadow` group so pam_unix can validate users' passwords without root.
if id -nG "$SERVICE_USER" 2>/dev/null | tr ' ' '\n' | grep -Fxq "shadow"; then
  echo "    '$SERVICE_USER' is already in the 'shadow' group."
else
  run usermod -aG shadow "$SERVICE_USER"
fi

# ---------------------------------------------------------------------------
# Step 3 — shared group + initial users
# ---------------------------------------------------------------------------

heading "Step 3/8 — shared group '$SERVICE_GROUP'"
if getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
  echo "    group '$SERVICE_GROUP' already exists."
else
  run groupadd --system "$SERVICE_GROUP"
fi
# Ensure the service user is in the shared group.
if id -nG "$SERVICE_USER" 2>/dev/null | tr ' ' '\n' | grep -Fxq "$SERVICE_GROUP"; then
  echo "    '$SERVICE_USER' is already a member of '$SERVICE_GROUP'."
else
  run usermod -aG "$SERVICE_GROUP" "$SERVICE_USER"
fi
# Optional initial users.
for u in "${INITIAL_USERS[@]+"${INITIAL_USERS[@]}"}"; do
  if ! getent passwd "$u" >/dev/null 2>&1; then
    echo "    warning: --add-user '$u' does not exist on this host; skipping" >&2
    continue
  fi
  if id -nG "$u" | tr ' ' '\n' | grep -Fxq "$SERVICE_GROUP"; then
    echo "    '$u' is already a member of '$SERVICE_GROUP'."
  else
    run usermod -aG "$SERVICE_GROUP" "$u"
  fi
done

# ---------------------------------------------------------------------------
# Step 4 — sudoers
# ---------------------------------------------------------------------------

heading "Step 4/8 — sudoers fragment at $SUDOERS_TARGET"
RENDERED_SUDOERS="$(sed "s|{{SERVICE_USER}}|$SERVICE_USER|g" "$SUDOERS_TEMPLATE")"
echo "    Target path : $SUDOERS_TARGET"
echo "    Target owner: root:root  Mode: 0440"
echo "    --- Rendered content (start) ---"
echo "$RENDERED_SUDOERS"
echo "    --- Rendered content (end) ---"

# Always validate syntax via visudo -cf, regardless of dry-run.
TMP_SUDOERS="$(mktemp -t agent-console-sudoers.XXXXXX)"
trap 'rm -f "$TMP_SUDOERS"' EXIT
echo "$RENDERED_SUDOERS" > "$TMP_SUDOERS"
chmod 0440 "$TMP_SUDOERS" || true
if ! visudo -cf "$TMP_SUDOERS"; then
  err "sudoers syntax validation failed; refusing to install"
fi
echo "    visudo syntax check: OK"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "    --dry-run: skipping sudoers installation"
else
  # Idempotency: compare to existing file content, install only if different.
  if [ -f "$SUDOERS_TARGET" ] && diff -q "$TMP_SUDOERS" "$SUDOERS_TARGET" >/dev/null 2>&1; then
    echo "    $SUDOERS_TARGET is already up to date."
  else
    if [ -f "$SUDOERS_TARGET" ] && [ "$FORCE" -eq 0 ]; then
      err "$SUDOERS_TARGET exists and differs from the rendered template; re-run with --force to overwrite"
    fi
    run install -m 0440 -o root -g root "$TMP_SUDOERS" "$SUDOERS_TARGET"
    # Re-verify final state.
    FINAL_MODE="$(stat -c '%a' "$SUDOERS_TARGET")"
    FINAL_OWNER="$(stat -c '%U:%G' "$SUDOERS_TARGET")"
    echo "    installed: mode=$FINAL_MODE owner=$FINAL_OWNER"
    if [ "$FINAL_MODE" != "440" ] || [ "$FINAL_OWNER" != "root:root" ]; then
      err "post-install verification failed: expected mode=440 owner=root:root"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Step 5 — data root
# ---------------------------------------------------------------------------

heading "Step 5/8 — data root $DATA_ROOT"
if [ -d "$DATA_ROOT" ]; then
  CURRENT_OWNER="$(stat -c '%U:%G' "$DATA_ROOT" 2>/dev/null || echo unknown)"
  CURRENT_MODE="$(stat -c '%a' "$DATA_ROOT" 2>/dev/null || echo unknown)"
  EXPECTED_OWNER="$SERVICE_USER:$SERVICE_GROUP"
  echo "    $DATA_ROOT exists (owner=$CURRENT_OWNER mode=$CURRENT_MODE)"
  if [ "$CURRENT_OWNER" != "$EXPECTED_OWNER" ] || [ "$CURRENT_MODE" != "2775" ]; then
    if [ "$FORCE" -eq 0 ]; then
      if [ "$DRY_RUN" -eq 1 ]; then
        echo "    (would abort: $DATA_ROOT has owner/mode drift; re-run with --force to repair)"
      else
        err "$DATA_ROOT has owner/mode drift (expected owner=$EXPECTED_OWNER mode=2775); re-run with --force to repair"
      fi
    else
      run chown "$EXPECTED_OWNER" "$DATA_ROOT"
      run chmod 2775 "$DATA_ROOT"
    fi
  fi
else
  run install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 2775 "$DATA_ROOT"
fi

# ---------------------------------------------------------------------------
# Step 6 — application install
# ---------------------------------------------------------------------------

heading "Step 6/8 — application install"
SERVICE_HOME="$(getent passwd "$SERVICE_USER" 2>/dev/null | cut -d: -f6 || true)"
if [ -z "$SERVICE_HOME" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    SERVICE_HOME="/home/$SERVICE_USER"
    echo "    (dry-run) assuming service user HOME is $SERVICE_HOME"
  else
    err "could not resolve HOME for '$SERVICE_USER'"
  fi
fi
APP_DIR="$SERVICE_HOME/agent-console"
if [ -d "$APP_DIR/.git" ] || [ -f "$APP_DIR/package.json" ]; then
  echo "    application already present at $APP_DIR; skipping clone"
  echo "    (run 'cd $APP_DIR && git pull && bun install --production' to update)"
else
  if [ -n "$REPO_SOURCE" ]; then
    # Local checkout or explicit URL.
    if [ -d "$REPO_SOURCE" ]; then
      echo "    copying from local path: $REPO_SOURCE"
      run install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0755 "$APP_DIR"
      run rsync -a --delete --exclude=node_modules --exclude='.git' \
        "$REPO_SOURCE/" "$APP_DIR/"
      run chown -R "$SERVICE_USER:$SERVICE_GROUP" "$APP_DIR"
    else
      echo "    cloning from: $REPO_SOURCE"
      run sudo -u "$SERVICE_USER" git clone "$REPO_SOURCE" "$APP_DIR"
    fi
  else
    DEFAULT_REPO_URL="https://github.com/ms2sato/agent-console.git"
    echo "    cloning from default upstream: $DEFAULT_REPO_URL"
    run sudo -u "$SERVICE_USER" git clone "$DEFAULT_REPO_URL" "$APP_DIR"
  fi
  # Skip bun install during dry-run since the app may not exist yet.
  if [ "$DRY_RUN" -eq 0 ]; then
    if ! sudo -u "$SERVICE_USER" -- bash -lc 'command -v bun' >/dev/null 2>&1; then
      echo "    warning: 'bun' not on PATH for $SERVICE_USER; install bun then re-run" >&2
    else
      run sudo -u "$SERVICE_USER" -- bash -lc "cd '$APP_DIR' && bun install --production"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Step 7 — systemd unit
# ---------------------------------------------------------------------------

heading "Step 7/8 — systemd unit at $SYSTEMD_TARGET"
RENDERED_UNIT="$(render_systemd_unit)"
echo "    --- Rendered unit (start) ---"
echo "$RENDERED_UNIT"
echo "    --- Rendered unit (end) ---"
TMP_UNIT="$(mktemp -t agent-console-unit.XXXXXX)"
trap 'rm -f "$TMP_SUDOERS" "$TMP_UNIT"' EXIT
echo "$RENDERED_UNIT" > "$TMP_UNIT"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "    --dry-run: skipping unit installation"
else
  if [ -f "$SYSTEMD_TARGET" ] && diff -q "$TMP_UNIT" "$SYSTEMD_TARGET" >/dev/null 2>&1; then
    echo "    $SYSTEMD_TARGET is already up to date."
  else
    if [ -f "$SYSTEMD_TARGET" ] && [ "$FORCE" -eq 0 ]; then
      err "$SYSTEMD_TARGET exists and differs from the rendered template; re-run with --force to overwrite"
    fi
    run install -m 0644 -o root -g root "$TMP_UNIT" "$SYSTEMD_TARGET"
  fi
fi

# ---------------------------------------------------------------------------
# Step 8 — daemon-reload + enable
# ---------------------------------------------------------------------------

heading "Step 8/8 — systemctl daemon-reload + enable --now"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "    --dry-run: skipping systemctl"
else
  run systemctl daemon-reload
  run systemctl enable --now agent-console
fi

# ---------------------------------------------------------------------------
# Final summary
# ---------------------------------------------------------------------------

echo ""
echo "Done. Verification commands:"
echo ""
if [ "$DRY_RUN" -eq 0 ]; then
  echo "  sudo systemctl status agent-console --no-pager"
  echo "  sudo journalctl -u agent-console -f"
fi
echo "  curl -fsS http://localhost:$PORT/api/config"
echo ""
echo "Add additional users with:"
echo "  sudo scripts/add-multiuser-user.sh <username>"
echo ""
if [ "$DRY_RUN" -eq 1 ]; then
  echo "(dry run; no system state was modified)"
fi
