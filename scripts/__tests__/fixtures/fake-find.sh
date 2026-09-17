#!/usr/bin/env bash
#
# Test fixture for scripts/__tests__/setup-multiuser-checks.test.mjs (Issue
# #1754): stands in for the `<find-cmd>` argument of data_root_ownership (V0)
# in scripts/lib/setup-multiuser-checks.sh. Static executable spawned via the
# lib (no `bash -c` string built from JS), like every fixture here; canned
# answers come from environment variables the test sets on the child process:
#
#   FAKE_FIND_LINES        newline-separated absolute paths to print on
#                          stdout (unset/empty prints nothing)
#   FAKE_FIND_FAIL=1       exit 1 immediately with a stderr line, no stdout
#                          (find itself could not run)
#   FAKE_FIND_FAIL_AFTER=1 print FAKE_FIND_LINES, THEN exit 1 with a stderr
#                          line -- a real permission error surfacing after
#                          real hits (e.g. a wt-* dir descended into despite
#                          the -prune group)
#   FAKE_FIND_ARGV_OUT     when set, this fixture's own argv (one token per
#                          line) is appended to the named file, so a test can
#                          assert the exact argv shape data_root_ownership
#                          builds (both start points, -maxdepth 5, the
#                          -prune group preceding the -type d ! -user
#                          predicate, ! -user <svc>)
set -eu
if [ -n "${FAKE_FIND_ARGV_OUT:-}" ]; then
  printf '%s\n' "$@" >>"$FAKE_FIND_ARGV_OUT"
fi
if [ "${FAKE_FIND_FAIL:-0}" = "1" ]; then
  echo "fake-find: permission denied (simulated)" >&2
  exit 1
fi
if [ -n "${FAKE_FIND_LINES:-}" ]; then
  printf '%s\n' "$FAKE_FIND_LINES"
fi
if [ "${FAKE_FIND_FAIL_AFTER:-0}" = "1" ]; then
  echo "fake-find: permission denied after hits (simulated)" >&2
  exit 1
fi
exit 0
