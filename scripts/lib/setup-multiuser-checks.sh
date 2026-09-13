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

# assert_readable_file <path> <hint>
#
# Fails closed (Issue #1668): if <path> does not exist or is not readable,
# prints a diagnostic naming the path and <hint> (the remedy text) to stderr
# and returns 1. Returns 0 when <path> is readable. More general than
# assert_unified_bun_executable above -- it does not require the executable
# bit, because the embedded-agent entry file is `bun <entry>`'s script
# ARGUMENT, not a binary to be executed directly -- but the same fail-closed
# shape and caller-decides-when discipline: update-and-deploy-for-multiuser-
# ubuntu.sh calls this only for a real deploy, right before `systemctl
# restart`, after its own copy step has unconditionally run.
assert_readable_file() {
  local file_path="$1"
  local hint="$2"
  if [ ! -r "$file_path" ]; then
    echo "error: '$file_path' is missing or not readable -- $hint" >&2
    return 1
  fi
  return 0
}

# assert_readable_by_unprivileged_user <path> <hint>
#
# Fails closed (Issue #1668, Architect ruling): unlike assert_readable_file
# above, this probes readability from an UNPRIVILEGED user's view via
# `runuser -u nobody -- test -r <path>`, not the invoking process's own
# permission. This matters because the caller
# (update-and-deploy-for-multiuser-ubuntu.sh) runs this check as root (its
# own usage line: `sudo scripts/update-and-deploy-for-multiuser-ubuntu.sh`),
# and root bypasses DAC read checks (CAP_DAC_READ_SEARCH), including
# parent-directory traversal -- a plain `[ -r <path> ]` as root is true for
# ANY existing file regardless of actual permission bits, so
# assert_readable_file's own check can never fail for the exact defect
# Issue #1668 is about (a path unreachable to a non-root elevation-target
# user, even though root itself can always read it).
#
# `nobody` is guaranteed outside this project's shared group, so it
# represents the elevation target's (worst-case) view. `runuser` is
# root-only and needs no sudoers policy, matching the caller's own
# already-root context -- no additional privilege grant is required.
#
# Cannot be exercised by an unprivileged unit test (runuser itself needs
# root to switch to another user) -- do not fake it. Real-machine
# verification only.
assert_readable_by_unprivileged_user() {
  local file_path="$1"
  local hint="$2"
  # Guard BEFORE the probe (Architect ruling): without this, a missing
  # `runuser` binary makes the probe itself exit 127, which the fail-closed
  # branch below would misreport as "not readable by an unprivileged user"
  # -- true-sounding, but naming the wrong cause. The gate stays closed
  # either way; only the diagnostic changes.
  if ! command -v runuser >/dev/null; then
    echo "error: runuser (util-linux) not found -- required for the unprivileged readability gate" >&2
    return 1
  fi
  if ! runuser -u nobody -- test -r "$file_path"; then
    echo "error: '$file_path' is not readable by an unprivileged user (probed as 'nobody' via runuser -- any real elevation-target user hits the same wall) -- $hint" >&2
    return 1
  fi
  return 0
}

# Direct-invocation entry point for tests (Issue #1222, extended #1668): when
# this file is executed directly (not sourced), dispatch on an explicit
# subcommand name rather than argument count -- an arity-based dispatch is an
# implicit contract that breaks silently the day either function grows an
# optional argument, so the subcommand is spelled out instead. This lets
# scripts/__tests__/setup-multiuser-checks.test.mjs spawn this file as a
# plain executable (`spawnSync(LIB, [...])`) instead of building a
# `bash -c '...'` command string -- no shell ever parses a dynamic value,
# which is the structural (not merely argv-separated) fix for the CodeQL
# js/shell-command-injection-from-environment false positive that flagged
# the earlier `bash -c script bash "$LIB" "$path"` form (that form passed
# values as real, unparsed positional parameters and was already
# injection-safe, but CodeQL's taint analysis does not model that -- it
# flags any tainted value reaching a spawnSync call whose command is a shell
# interpreter, regardless of whether the value lands in the command string
# or a separate argv slot).
#
# The no-subcommand form (`spawnSync(LIB, [path])`) is preserved byte-for-byte
# for assert_unified_bun_executable so the pre-existing test in
# setup-multiuser-checks.test.mjs (Issue #1222) needs no change.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  case "${1:-}" in
    assert-readable-file)
      shift
      assert_readable_file "$@"
      ;;
    assert-readable-by-unprivileged-user)
      shift
      assert_readable_by_unprivileged_user "$@"
      ;;
    *)
      assert_unified_bun_executable "$@"
      ;;
  esac
fi
