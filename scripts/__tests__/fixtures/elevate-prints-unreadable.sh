#!/usr/bin/env bash
#
# Test fixture for scripts/__tests__/setup-multiuser-checks.test.mjs (Issue
# #1690). See elevate-prints-readable.sh for the general rationale: a
# fixture standing in for the `<elevate>` prefix argument of
# assert_readable_by_unprivileged_user, ignoring its own arguments.
#
# This one simulates: the elevation step succeeded, `runuser` ran, and the
# inner `test -r` was false (the real gate this check exists for).
echo UNREADABLE
