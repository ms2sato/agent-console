#!/usr/bin/env bash
#
# Provision a Shared Account OS user for Agent Console shared sessions.
#
# A Shared Account is a pure execution identity: shared orchestrator sessions
# run as this account via the service user's privilege elevation (see
# docs/design/shared-orchestrator-session.md). Humans authenticate as
# themselves; the account itself never logs in, so its password is locked.
#
# Steps (each idempotent):
#   1. Verify the shared group exists (created by setup-multiuser-for-ubuntu.sh).
#   2. Create the account if missing (regular account with a real home and a
#      real login shell — NOT --system: it is an execution identity, not a
#      daemon). If it exists, verify/repair its login shell and home.
#   3. Lock the account password.
#   4. Add the account to the shared group.
#   5. Print operator next steps (server env, vendor credentials, sshd note,
#      post-setup smoke verification).
#
# This script does NOT touch sudoers (the installed `(ALL,!root)` rule already
# covers any non-root elevation target), does NOT add the account to the
# `shadow` group, does NOT write into any other user's home, and does NOT edit
# sshd_config (.claude/rules/os-environment-coupling.md Discipline 2).
#
# Usage:
#   sudo scripts/setup-shared-account.sh <username>
#   sudo scripts/setup-shared-account.sh <username> --group <name> --shell <path>
#   scripts/setup-shared-account.sh <username> --dry-run   # preview, no root needed
#
# Idempotent: a second invocation with the same arguments is a no-op.
#
# Environment overrides:
#   AGENT_CONSOLE_SERVICE_GROUP — default group name (overridden by --group).
#
# Documentation: docs/design/shared-orchestrator-session.md

set -euo pipefail

DEFAULT_GROUP="${AGENT_CONSOLE_SERVICE_GROUP:-agent-console-users}"
DEFAULT_SHELL="/bin/bash"

# POSIX username regex (login name): start with a letter or underscore, then
# letters / digits / hyphen / underscore, max 31 chars total.
USERNAME_REGEX='^[a-z_][a-z0-9_-]{0,30}$'

# Login shells the deployed sudoers template permits as elevation targets.
# The elevation helper invokes `sudo -u <user> -i sh -c '...'`, which runs the
# target's login shell; scripts/sudoers-agent-console.template only allows
# these four paths. Any other shell (zsh, fish, ...) would make every elevated
# invocation for this account be denied by sudoers.
ALLOWED_SHELLS=(/bin/sh /bin/bash /usr/bin/sh /usr/bin/bash)

err() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: setup-shared-account.sh <username> [--group <name>] [--shell <path>] [--dry-run]

  username        Shared Account OS user to provision (e.g. project-sa).
  --group <name>  Shared group to join (default: agent-console-users, or
                  $AGENT_CONSOLE_SERVICE_GROUP if set). Must already exist.
  --shell <path>  Login shell (default: /bin/bash). Must be one of
                  /bin/sh, /bin/bash, /usr/bin/sh, /usr/bin/bash — the only
                  shells the sudoers rule permits for elevation targets.
  --dry-run       Print all actions; do not modify the system (no root needed).
  -h, --help      Show this help and exit.
EOF
}

if [ "$#" -lt 1 ]; then
  usage >&2
  exit 2
fi

USERNAME=""
GROUP_NAME=""
SHELL_PATH=""
DRY_RUN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --group)
      [ "$#" -ge 2 ] || err "--group requires an argument"
      GROUP_NAME="$2"
      shift 2
      ;;
    --shell)
      [ "$#" -ge 2 ] || err "--shell requires an argument"
      SHELL_PATH="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    -*)
      err "unknown flag: $1"
      ;;
    *)
      if [ -z "$USERNAME" ]; then
        USERNAME="$1"
        shift
      else
        err "unexpected positional argument: $1"
      fi
      ;;
  esac
done

[ -n "$USERNAME" ] || { usage >&2; exit 2; }
GROUP_NAME="${GROUP_NAME:-$DEFAULT_GROUP}"
SHELL_PATH="${SHELL_PATH:-$DEFAULT_SHELL}"

# Validate identifiers.
if ! echo "$USERNAME" | grep -Eq "$USERNAME_REGEX"; then
  err "invalid username '$USERNAME' (must match $USERNAME_REGEX)"
fi
if ! echo "$GROUP_NAME" | grep -Eq "$USERNAME_REGEX"; then
  err "invalid group name '$GROUP_NAME' (must match $USERNAME_REGEX)"
fi

# Validate the login shell against the sudoers allowlist.
shell_allowed() {
  local candidate="$1" s
  for s in "${ALLOWED_SHELLS[@]}"; do
    if [ "$candidate" = "$s" ]; then
      return 0
    fi
  done
  return 1
}
if ! shell_allowed "$SHELL_PATH"; then
  err "login shell '$SHELL_PATH' is not permitted: the sudoers rule installed by \
setup-multiuser-for-ubuntu.sh (scripts/sudoers-agent-console.template) only allows \
${ALLOWED_SHELLS[*]} as elevation targets' login shells. The elevation helper invokes \
the target account's login shell, so any other shell (zsh, fish, ...) would make every \
elevated invocation for this account be denied by sudoers."
fi

# Require root for real runs; dry-run works unprivileged.
if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  err "this script must be run as root (sudo scripts/setup-shared-account.sh $USERNAME), or use --dry-run to preview"
fi

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

echo "Agent Console shared-account setup"
echo "----------------------------------"
echo "  username     : $USERNAME"
echo "  shared group : $GROUP_NAME"
echo "  login shell  : $SHELL_PATH"
echo "  dry run      : $([ "$DRY_RUN" -eq 1 ] && echo yes || echo no)"

# ---------------------------------------------------------------------------
# Step 1 — precondition: shared group must exist
# ---------------------------------------------------------------------------

heading "Step 1/4 — shared group '$GROUP_NAME'"
if getent group "$GROUP_NAME" >/dev/null 2>&1; then
  echo "    group '$GROUP_NAME' exists."
else
  err "group '$GROUP_NAME' does not exist; run scripts/setup-multiuser-for-ubuntu.sh first"
fi

# ---------------------------------------------------------------------------
# Step 2 — create the account (or verify existing state)
# ---------------------------------------------------------------------------

heading "Step 2/4 — account '$USERNAME'"
if getent passwd "$USERNAME" >/dev/null 2>&1; then
  echo "    user '$USERNAME' already exists; verifying shell and home"
  CURRENT_SHELL="$(getent passwd "$USERNAME" | cut -d: -f7)"
  if shell_allowed "$CURRENT_SHELL"; then
    echo "    login shell is '$CURRENT_SHELL' (allowed); no change."
  else
    echo "    login shell is '$CURRENT_SHELL' (NOT allowed by the sudoers rule); fixing to '$SHELL_PATH'"
    run usermod -s "$SHELL_PATH" "$USERNAME"
  fi
  CURRENT_HOME="$(getent passwd "$USERNAME" | cut -d: -f6)"
  if [ -d "$CURRENT_HOME" ]; then
    echo "    home directory '$CURRENT_HOME' exists."
  else
    err "user '$USERNAME' has home '$CURRENT_HOME' but the directory does not exist; create it (e.g. 'mkhomedir_helper $USERNAME' or 'install -d -o $USERNAME -g $USERNAME -m 0750 $CURRENT_HOME') and re-run"
  fi
else
  # A regular account, NOT --system: it needs a real home directory (vendor
  # credentials live there) and a real login shell (the elevation helper
  # invokes it). It is an execution identity, not a daemon.
  run useradd --create-home --shell "$SHELL_PATH" "$USERNAME"
fi

# ---------------------------------------------------------------------------
# Step 3 — lock the password
# ---------------------------------------------------------------------------
#
# The account is a pure execution identity: humans authenticate as themselves,
# elevation into this account is NOPASSWD via the service user's sudoers rule,
# and no password login should ever be possible.

heading "Step 3/4 — lock password for '$USERNAME'"
if [ "$DRY_RUN" -eq 1 ] && ! getent passwd "$USERNAME" >/dev/null 2>&1; then
  echo "    (dry-run) user does not exist yet; would lock after creation"
  run usermod -L "$USERNAME"
elif PASSWD_STATUS="$(passwd -S "$USERNAME" 2>/dev/null | awk '{print $2}')" && [ "$PASSWD_STATUS" = "L" ]; then
  echo "    password is already locked; skipping."
else
  run usermod -L "$USERNAME"
fi

# ---------------------------------------------------------------------------
# Step 4 — shared group membership
# ---------------------------------------------------------------------------

heading "Step 4/4 — membership in '$GROUP_NAME'"
if [ "$DRY_RUN" -eq 1 ] && ! getent passwd "$USERNAME" >/dev/null 2>&1; then
  echo "    (dry-run) user does not exist yet; would add to '$GROUP_NAME' after creation"
  run usermod -aG "$GROUP_NAME" "$USERNAME"
elif id -nG "$USERNAME" 2>/dev/null | tr ' ' '\n' | grep -Fxq "$GROUP_NAME"; then
  echo "    '$USERNAME' is already a member of '$GROUP_NAME'."
else
  run usermod -aG "$GROUP_NAME" "$USERNAME"
fi

# ---------------------------------------------------------------------------
# Summary + next steps (informational only; nothing below is executed)
# ---------------------------------------------------------------------------

echo ""
echo "Done. Next steps (manual):"
echo ""
echo "1. Configure the server (create first, configure second — this script"
echo "   handles the ordering; the server fails fast at startup if the OS"
echo "   account named below is missing):"
echo "     Set AGENT_CONSOLE_SHARED_USERNAME=$USERNAME on the server's systemd"
echo "     unit (an Environment= line in /etc/systemd/system/agent-console.service"
echo "     or the secrets EnvironmentFile), then:"
echo "       sudo systemctl daemon-reload && sudo systemctl restart agent-console"
echo ""
echo "2. Configure LLM vendor credentials in the account's OWN home (this"
echo "   script does not write secrets — they are the operator's to place)."
echo "   For AWS Bedrock, for example:"
echo "     - export lines in /home/$USERNAME/.profile — NOT ~/.bashrc: the"
echo "       elevated inner shell is dash and never reads .bashrc"
echo "     - /home/$USERNAME/.aws/credentials, mode 0600, owned by $USERNAME"
echo ""
echo "3. (Recommended, optional) Block SSH login for the account by adding"
echo "     DenyUsers $USERNAME"
echo "   to /etc/ssh/sshd_config and reloading sshd. This script deliberately"
echo "   does NOT edit sshd_config (no unilateral modification of OS state"
echo "   outside the project's scope; .claude/rules/os-environment-coupling.md)."
echo ""
echo "4. Post-setup verification (run as the bootstrap's service user,"
echo "   default 'agentconsole'):"
echo "     sudo -u agentconsole bun scripts/smoke/check-multiuser-pty-env.ts $USERNAME"
echo "     sudo -u agentconsole bun scripts/smoke/check-login-shell-sentinel.ts --elevated $USERNAME"
echo ""
if [ "$DRY_RUN" -eq 1 ]; then
  echo "(dry run; no system state was modified)"
fi
