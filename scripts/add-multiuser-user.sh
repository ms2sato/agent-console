#!/usr/bin/env bash
#
# Add an existing OS user to the Agent Console shared group so they can access
# shared data (worktrees, repositories, etc.) in multi-user mode.
#
# Usage:
#   sudo scripts/add-multiuser-user.sh <username>
#   sudo scripts/add-multiuser-user.sh <username> --group <group-name>
#
# Idempotent: a second invocation with the same arguments is a no-op.
#
# Environment overrides:
#   AGENT_CONSOLE_SERVICE_GROUP — default group name (overridden by --group).

set -euo pipefail

DEFAULT_GROUP="${AGENT_CONSOLE_SERVICE_GROUP:-agent-console-users}"

# POSIX username regex (login name): start with a letter or underscore, then
# letters / digits / hyphen / underscore, max 31 chars total.
USERNAME_REGEX='^[a-z_][a-z0-9_-]{0,30}$'

err() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: add-multiuser-user.sh <username> [--group <group-name>]

  username        OS user to add to the shared group (must already exist).
  --group <name>  Group name (default: agent-console-users, or
                  $AGENT_CONSOLE_SERVICE_GROUP if set).
EOF
}

if [ "$#" -lt 1 ]; then
  usage >&2
  exit 2
fi

USERNAME=""
GROUP_NAME=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --group)
      [ "$#" -ge 2 ] || err "--group requires an argument"
      GROUP_NAME="$2"
      shift 2
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

# Validate identifiers.
if ! echo "$USERNAME" | grep -Eq "$USERNAME_REGEX"; then
  err "invalid username '$USERNAME' (must match $USERNAME_REGEX)"
fi
if ! echo "$GROUP_NAME" | grep -Eq "$USERNAME_REGEX"; then
  err "invalid group name '$GROUP_NAME' (must match $USERNAME_REGEX)"
fi

# Existence checks.
if ! getent passwd "$USERNAME" >/dev/null 2>&1; then
  err "user '$USERNAME' does not exist on this host"
fi
if ! getent group "$GROUP_NAME" >/dev/null 2>&1; then
  err "group '$GROUP_NAME' does not exist; run scripts/setup-multiuser-for-ubuntu.sh first"
fi

# Idempotency check — is the user already a member of the group?
if id -nG "$USERNAME" | tr ' ' '\n' | grep -Fxq "$GROUP_NAME"; then
  echo "==> '$USERNAME' is already a member of '$GROUP_NAME'; nothing to do."
  exit 0
fi

echo "==> Adding '$USERNAME' to group '$GROUP_NAME'"
usermod -aG "$GROUP_NAME" "$USERNAME"

# Verify.
if id -nG "$USERNAME" | tr ' ' '\n' | grep -Fxq "$GROUP_NAME"; then
  echo "==> '$USERNAME' is now a member of '$GROUP_NAME'."
  echo ""
  echo "Note: '$USERNAME' must log out and back in (or start a fresh session)"
  echo "for the new group membership to take effect."
else
  err "usermod completed but '$USERNAME' is not a member of '$GROUP_NAME'"
fi
