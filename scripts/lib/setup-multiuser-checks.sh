#!/usr/bin/env bash
#
# Pure, side-effect-free check functions shared by
# scripts/setup-multiuser-for-ubuntu.sh and its tests (Issue #1222).
#
# Split out of the main script so the fail-closed provisioning guard can be
# unit-tested directly (sourced by scripts/__tests__/setup-multiuser-checks.test.mjs)
# without requiring root or the rest of the script's argument parsing / step
# execution. Functions here must not read globals from the caller and must
# not have side effects beyond inspecting the filesystem and printing to
# stderr -- they are library functions, not steps.

# assert_unified_bun_executable <path>
#
# Fails closed (Issue #1222 Ruling 2): if <path> does not exist or is not
# executable, prints a diagnostic naming the path and the remedy to stderr
# and returns 1. Returns 0 when <path> is executable. Callers are
# responsible for deciding WHEN to invoke this (setup-multiuser-for-ubuntu.sh
# only calls it for a real, non-dry-run unit install -- a --dry-run preview
# on a fresh host, before Step 6b has actually copied the binary, must not
# fail here).
assert_unified_bun_executable() {
  local bun_path="$1"
  if [ ! -x "$bun_path" ]; then
    echo "error: unified bun binary '$bun_path' is missing or not executable -- refusing to install a systemd unit whose ExecStart cannot start (Issue #1222). Ensure Step 6b (embedded-agent bun binary copy) completed, or copy it manually: sudo install -m 0755 <service-user-bun> $bun_path" >&2
    return 1
  fi
  return 0
}
