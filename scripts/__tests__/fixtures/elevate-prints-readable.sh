#!/usr/bin/env bash
#
# Test fixture for scripts/__tests__/setup-multiuser-checks.test.mjs (Issue
# #1690). Stands in for the `<elevate>` prefix argument of
# assert_readable_by_unprivileged_user -- when this file's path is passed as
# the third argument, the function runs it as a command prefix instead of a
# real elevation command, so the whole `<elevate> runuser -u nobody -- sh -c
# '...'` chain is replaced by this single fixture regardless of the
# arguments it was actually invoked with (visible below: they are ignored).
# This fakes the MECHANISM at the seam Issue #1690 introduces, without
# needing real root or a real `runuser` -- the thing #1673 said "cannot be
# faked in a unit test".
#
# This one simulates: the elevation step succeeded, `runuser` ran, and the
# inner `test -r` was true.
echo READABLE
