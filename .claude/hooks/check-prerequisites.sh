#!/bin/bash
# SessionStart hook: verify external prerequisites before the agent enters
# its main loop.
#
# Why this exists: PreToolUse hooks (e.g. enforce-permissions.sh) hard-block
# the agent when a runtime dependency is missing. If jq is absent, the
# fail-closed branch fires on EVERY Bash/Read/Write/Edit and the agent
# cannot self-recover (it cannot run `which jq`, cannot read docs, cannot
# call any tool). Surfacing the diagnostic at SessionStart turns a silent
# deadlock into an actionable error before the first tool call.
#
# Behaviour:
#   - jq present: exit 0 silently
#   - jq absent : exit 1, print actionable diagnostic to stderr (binary
#                 name, dependent script, install one-liners per platform)
#
# Implementation note: the diagnostic uses `printf` (a bash builtin) rather
# than `cat <<EOF`, so the message is still emitted when PATH is empty or
# does not contain coreutils — exactly the deadlock scenario this hook
# exists to surface.

set -u

if command -v jq >/dev/null 2>&1; then
  exit 0
fi

printf '%s\n' \
  'check-prerequisites: jq is required by .claude/hooks/enforce-permissions.sh but was not found on PATH.' \
  'Without jq, the PreToolUse hook fail-closes on every Bash/Read/Write/Edit and the agent cannot run.' \
  '' \
  'Install jq:' \
  '  brew install jq        # macOS (Homebrew)' \
  '  apt-get install jq     # Debian/Ubuntu' \
  '  dnf install jq         # Fedora / RHEL 8+' \
  '  yum install jq         # RHEL 7 / older' \
  '  pacman -S jq           # Arch Linux' \
  '' \
  'Then start a new session.' >&2

exit 1
