#!/bin/bash
# PreToolUse hook for Claude Code. Even in --dangerously-skip-permissions
# mode, a permissionDecision: "deny" returned by a PreToolUse hook blocks
# the tool. We use this to mechanically reject catastrophic /
# credential-touching operations regardless of the agent's interactive
# confirmations.
#
# Policy: deny strong, ask minimal. This system spawns parallel agents that
# routinely git push and gh pr create; ask-prompts on those would defeat
# the platform's parallelism. Therefore the hook never returns "ask" — it
# either denies a known-dangerous pattern or stays out of the way.
#
# I/O contract:
#   stdin  : Claude Code PreToolUse JSON event
#            (tool_name + tool_input)
#   stdout : on deny, a single JSON object:
#            {"hookSpecificOutput": {
#               "hookEventName": "PreToolUse",
#               "permissionDecision": "deny",
#               "permissionDecisionReason": "<short reason>"}}
#   stderr : on fail-closed, a single human-readable error line
#   exit 0 : allow OR deny (deny is conveyed via stdout JSON)
#   exit 2 : fail-closed (jq missing, empty input, parse failure)

set -u

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

fail_closed() {
  printf 'enforce-permissions: %s (fail-closed)\n' "$1" >&2
  exit 2
}

# Emit deny verdict on stdout and exit 0 (Claude Code blocks the tool).
deny() {
  jq -nc --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# Quote-stripping normalization so 'r''m' / "r""m" collapse to rm before
# pattern matching. The normalized string is for *detection only*; the
# actual command Claude Code is about to run is unchanged.
normalize_quotes() {
  printf '%s' "$1" | tr -d "'" | tr -d '"'
}

# Extract the body of the *first* `bash -c "<body>"` (or 'sh -c "<body>"`)
# call so we can scan its inner command. If none, prints empty.
extract_bash_c_body() {
  printf '%s' "$1" | sed -nE "s/.*\\b(bash|sh)[[:space:]]+-c[[:space:]]+['\"]([^'\"]*)['\"].*/\\2/p"
}

# Produce the haystack we grep against: original + quote-stripped + bash -c
# body. Doing all three lets a single pattern match cover quote-bypass and
# bash -c wrapping.
build_haystack() {
  local cmd="$1"
  local stripped
  local inner
  stripped=$(normalize_quotes "$cmd")
  inner=$(extract_bash_c_body "$cmd")
  printf '%s\n%s\n%s\n' "$cmd" "$stripped" "$inner"
}

# Last whitespace-separated token in a string (for `git push ... <ref>`).
last_token() {
  printf '%s' "$1" | awk '{print $NF}'
}

# -----------------------------------------------------------------------------
# Fail-closed prerequisites
# -----------------------------------------------------------------------------

command -v jq >/dev/null 2>&1 || fail_closed "jq not found in PATH"

INPUT=$(cat)
[ -n "$INPUT" ] || fail_closed "empty stdin"

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) \
  || fail_closed "JSON parse failed"
[ -n "$TOOL_NAME" ] || fail_closed "tool_name missing in event"

# -----------------------------------------------------------------------------
# Bash: command-string inspection
# -----------------------------------------------------------------------------

if [ "$TOOL_NAME" = "Bash" ]; then
  CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) \
    || fail_closed "Bash command parse failed"

  HAY=$(build_haystack "$CMD")
  STRIPPED=$(normalize_quotes "$CMD")

  # --- Article-aligned core: catastrophic Unix verbs ---
  if printf '%s' "$HAY" | grep -qE '\brm[[:space:]]+(-[a-zA-Z]*[rRf]|--recursive|--force)'; then
    deny "rm with recursive/force flag is denied (alert-fatigue guard)"
  fi
  if printf '%s' "$HAY" | grep -qE '\bsudo\b'; then
    deny "sudo is denied"
  fi
  if printf '%s' "$HAY" | grep -qE '\bssh\b[[:space:]]'; then
    deny "ssh is denied"
  fi
  if printf '%s' "$HAY" | grep -qE '\bdd[[:space:]]+(if|of)='; then
    deny "dd with if=/of= is denied"
  fi
  if printf '%s' "$HAY" | grep -qE '\bkill[[:space:]]+(-9|-KILL)\b'; then
    deny "kill -9 is denied"
  fi

  # --- Credential-file touching (read OR write — both are leak vectors) ---
  # Note: \b is unreliable when the boundary is between two non-word chars
  # (e.g., space-then-dot before `.env`). Use explicit
  # (^|[^A-Za-z0-9_]) anchors so the pattern matches in real shells.
  if printf '%s' "$HAY" | grep -qE '(^|[^A-Za-z0-9_])(\.env(\.[A-Za-z0-9_-]+)?|\.aws/|\.ssh/|id_rsa[A-Za-z0-9_.-]*|\.gnupg/)'; then
    deny "operation references credential files (.env*, .aws/, .ssh/, id_rsa*, .gnupg/)"
  fi
  if printf '%s' "$HAY" | grep -qE '\.pem([^A-Za-z0-9_]|$)'; then
    deny "operation references *.pem credential file"
  fi

  # --- ~/.agent-console/ subtree wipes ---
  if printf '%s' "$HAY" | grep -qE '\b(rm|rmdir|find)\b[^|]*\.agent-console(/|\b)'; then
    deny "modifying ~/.agent-console/ via rm/rmdir/find is denied (production data dir)"
  fi

  # --- .git/{refs,HEAD,hooks} direct edits ---
  if printf '%s' "$HAY" | grep -qE '\.git/(refs|HEAD|hooks)([/[:space:]]|$)'; then
    if printf '%s' "$HAY" | grep -qE '(\brm\b|>>?[[:space:]]*[^|]*\.git/|\btee\b[^|]*\.git/|\bcp\b[^|]*\.git/|\bmv\b[^|]*\.git/)'; then
      deny "direct edits under .git/{refs,HEAD,hooks} are denied"
    fi
  fi

  # --- git push --force to main/master (and branch deletion) ---
  if printf '%s' "$STRIPPED" | grep -qE '^[[:space:]]*git[[:space:]]+push([[:space:]]|$)'; then
    if printf '%s' "$STRIPPED" | grep -qE '(^|[[:space:]])(-f|--force|--force-[a-z-]+)([[:space:]]|$)'; then
      LAST=$(last_token "$STRIPPED")
      if printf '%s' "$LAST" | grep -qE '^([A-Za-z0-9._-]+/)?(main|master)$'; then
        deny "git push --force to main/master is denied (per workflow.md gating)"
      fi
    fi
    # branch deletion :main / :master
    if printf '%s' "$STRIPPED" | grep -qE '(^|[[:space:]]):(main|master)([[:space:]]|$)'; then
      deny "git push deleting main/master is denied"
    fi
  fi

  exit 0
fi

# -----------------------------------------------------------------------------
# Read / Write / Edit: file_path inspection
# -----------------------------------------------------------------------------

if [ "$TOOL_NAME" = "Read" ] || [ "$TOOL_NAME" = "Write" ] || [ "$TOOL_NAME" = "Edit" ]; then
  FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null) \
    || fail_closed "${TOOL_NAME} file_path parse failed"

  # Credential-file paths (deny on any of Read/Write/Edit).
  if printf '%s' "$FILE_PATH" | grep -qE '(/|^)(\.env(\.[A-Za-z0-9_-]+)?|\.aws/|\.ssh/|\.gnupg/)|id_rsa[A-Za-z0-9_.-]*|\.pem$'; then
    deny "access to credential files is denied"
  fi

  # *.db direct write (Read is fine for diagnostics).
  if [ "$TOOL_NAME" != "Read" ] && printf '%s' "$FILE_PATH" | grep -qE '\.db$'; then
    deny "direct write to *.db files is denied (SQLite production data)"
  fi

  # .git/{refs,HEAD,hooks} writes.
  if [ "$TOOL_NAME" != "Read" ] && printf '%s' "$FILE_PATH" | grep -qE '(/|^)\.git/(refs|HEAD|hooks)(/|$)'; then
    deny "direct edits under .git/{refs,HEAD,hooks} are denied"
  fi

  exit 0
fi

# Unknown tool — out of scope, allow.
exit 0
