#!/usr/bin/env bash
#
# Test fixture for scripts/__tests__/setup-multiuser-checks.test.mjs (Issue
# #1690). See elevate-prints-readable.sh for the general rationale: a
# fixture standing in for the `<elevate>` prefix argument of
# assert_readable_by_unprivileged_user, ignoring its own arguments.
#
# This one simulates: the elevation step itself was refused (a credential
# problem, a policy denial, a non-interactive terminal) before `runuser` or
# the inner `test -r` ever ran -- no marker on stdout, a diagnostic on
# stderr, non-zero exit. This is the exact misattribution class Issue
# #1690 fixes: the pre-fix code read only the exit code and reported "not
# readable by an unprivileged user", which was never true here -- the
# readability check never even ran.
echo "elevate-fails-silently: elevation refused (simulated)" >&2
exit 1
