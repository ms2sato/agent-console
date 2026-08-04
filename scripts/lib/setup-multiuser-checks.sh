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

# Direct-invocation entry point for tests (Issue #1222): when this file is
# executed directly (not sourced), run assert_unified_bun_executable with
# the given argv. This lets scripts/__tests__/setup-multiuser-checks.test.mjs
# spawn this file as a plain executable (`spawnSync(LIB, [path])`) instead of
# building a `bash -c '...'` command string -- no shell ever parses a
# dynamic value, which is the structural (not merely argv-separated) fix for
# the CodeQL js/shell-command-injection-from-environment false positive that
# flagged the earlier `bash -c script bash "$LIB" "$path"` form (that form
# passed values as real, unparsed positional parameters and was already
# injection-safe, but CodeQL's taint analysis does not model that -- it
# flags any tainted value reaching a spawnSync call whose command is a shell
# interpreter, regardless of whether the value lands in the command string
# or a separate argv slot).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  assert_unified_bun_executable "$@"
fi
