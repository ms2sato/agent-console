#!/bin/bash
# Smoke test: verify multi-user PTY env propagation on the deployed host.
#
# Run after every deploy that touches a privilege-elevation code path
# (packages/server/src/services/user-mode.ts, env-filter.ts, or
# scripts/setup-multiuser-for-ubuntu.sh). Unit tests cover the inner-command
# string shape, but only this on-host smoke can confirm what env the elevated
# user actually sees -- which depends on distro sudo defaults, sudoers config,
# and the target user's login shell init.
#
# Usage:
#   sudo -u agentconsole bash scripts/smoke/check-multiuser-pty-env.sh <target-user>
#
# Exit codes:
#   0  all checks passed
#   1  one or more assertions failed (details on stderr)
#   2  bad usage / cannot run
#
# Sync contract: this script reconstructs the sudo argv + inner shell command
# shape from packages/server/src/services/user-mode.ts:spawnSudoPty +
# buildEnvExportString. If you change the spawn argv or the color-env keys,
# update this script in the same PR (the production code's
# buildEnvExportString comment links here).
#
# Issue #866 motivated this v1; future smoke checks (claude binary executable
# as target user, repo path readable, ...) land as sibling scripts under
# scripts/smoke/ when their motivating bugs surface.

set -u

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <target-user>" >&2
  exit 2
fi
TARGET_USER="$1"

if ! id "$TARGET_USER" >/dev/null 2>&1; then
  echo "target user not found: $TARGET_USER" >&2
  exit 2
fi

# Mirror buildEnvExportString's whitelist: the 3 color env vars that sudo
# strips and login shell init does not restore.
INNER_COMMAND="cd / && export TERM='xterm-256color' COLORTERM='truecolor' FORCE_COLOR='3'; env"

# Mirror spawnSudoPty's argv.
PROBE_OUTPUT=$(sudo -u "$TARGET_USER" --preserve-env=FORCE_COLOR -i sh -c "$INNER_COMMAND" 2>&1)
PROBE_STATUS=$?

if [ "$PROBE_STATUS" -ne 0 ]; then
  echo "PROBE FAILED: sudo invocation exited $PROBE_STATUS" >&2
  echo "$PROBE_OUTPUT" >&2
  exit 1
fi

FAIL_COUNT=0

assert_present() {
  local pattern="$1"
  local label="$2"
  if echo "$PROBE_OUTPUT" | grep -qE "^${pattern}$"; then
    echo "  OK    ${label}"
  else
    echo "  FAIL  ${label} -- expected line matching: ^${pattern}\$" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

assert_absent() {
  local pattern="$1"
  local label="$2"
  if echo "$PROBE_OUTPUT" | grep -qE "^${pattern}"; then
    local match
    match=$(echo "$PROBE_OUTPUT" | grep -E "^${pattern}" | head -1)
    echo "  FAIL  ${label} -- unexpected leak: ${match}" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
  else
    echo "  OK    ${label}"
  fi
}

echo "==> color env (whitelist injected from buildEnvExportString)"
assert_present "TERM=xterm-256color" "TERM"
assert_present "COLORTERM=truecolor" "COLORTERM"
assert_present "FORCE_COLOR=3" "FORCE_COLOR"

echo "==> elevated user natural env (from sudo -i login shell init)"
assert_present "USER=${TARGET_USER}" "USER matches target"
assert_present "LOGNAME=${TARGET_USER}" "LOGNAME matches target"
assert_present "HOME=/home/${TARGET_USER}" "HOME under target's home"
assert_present "PATH=.+" "PATH is set"
assert_present "SHELL=.+" "SHELL is set"

echo "==> no bun-server env leak (agentconsole's vars must NOT appear here)"
# The negative test: if bun server's env had leaked (e.g., via
# getCleanChildProcessEnv pre-#866), PATH would include agentconsole-only
# entries. We probe by asserting the target's HOME bin appears in PATH
# (positive proxy for "PATH is the target user's, not agentconsole's"). A
# strict negative test for agentconsole-specific paths would require knowing
# what agentconsole's PATH looks like; that varies by distro.
TARGET_PATH=$(echo "$PROBE_OUTPUT" | grep -E "^PATH=" | head -1)
if echo "$TARGET_PATH" | grep -qE "(^PATH=|:)/home/${TARGET_USER}(/[^:]*)?(:|$)"; then
  echo "  OK    PATH includes /home/${TARGET_USER} (target user's tree)"
else
  echo "  WARN  PATH does not include /home/${TARGET_USER} -- this is OK if the" >&2
  echo "        target user has no per-user bin directory configured, but if" >&2
  echo "        claude was installed under ${TARGET_USER}'s home (typical npm" >&2
  echo "        global / nvm setup), claude will fail to resolve. Verify by" >&2
  echo "        running: sudo -u ${TARGET_USER} -i which claude" >&2
fi

echo
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAILED: ${FAIL_COUNT} assertion(s) failed" >&2
  exit 1
fi
echo "PASSED: all multi-user PTY env smoke checks passed"
exit 0
