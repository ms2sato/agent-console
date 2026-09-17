#!/usr/bin/env bash
#
# Test fixture for scripts/__tests__/setup-multiuser-checks.test.mjs (Issue
# #1717): stands in for the `<elevate>` prefix argument of the post-deploy
# verification check V3 (mainpid-identity) in
# scripts/lib/setup-multiuser-checks.sh -- the same seam the elevate-*.sh
# fixtures fake for assert_readable_by_unprivileged_user (Issue #1690). The
# check invokes it as `<elevate> runuser -u <User> -g <Group> --
# <configured-bun> <identity-entry> <MainPID> <configured-bun>`; this fixture
# ignores that chain and prints what the real one would have, driven by
# environment variables:
#
#   FAKE_IDENTITY_MARKER  the marker to print on stdout (SAME / DIFFERENT /
#                         UNRESOLVABLE:self / UNRESOLVABLE:configured /
#                         UNRESOLVABLE:bare); empty or unset prints nothing
#                         (the "no marker" cannot-run shape)
#   FAKE_ELEVATE_REFUSE=1 print nothing, a diagnostic on stderr, exit 1 (the
#                         elevation step itself was refused)
#   FAKE_ARGV_LOG         when set, this fixture's own argv is appended to
#                         that file, so a test can pin the exec shape (the
#                         `-u <User> -g <Group>` pair and the entry path)
set -eu
if [ -n "${FAKE_ARGV_LOG:-}" ]; then
  printf '%s\n' "$*" >>"$FAKE_ARGV_LOG"
fi
if [ "${FAKE_ELEVATE_REFUSE:-0}" = "1" ]; then
  echo "fake-elevate-identity: elevation refused (simulated)" >&2
  exit 1
fi
if [ -n "${FAKE_IDENTITY_MARKER:-}" ]; then
  echo "${FAKE_IDENTITY_MARKER}"
fi
