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
    *)
      assert_unified_bun_executable "$@"
      ;;
  esac
fi
