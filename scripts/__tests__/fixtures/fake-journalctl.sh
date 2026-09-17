#!/usr/bin/env bash
#
# Test fixture for scripts/__tests__/setup-multiuser-checks.test.mjs (Issue
# #1717): stands in for the `<journalctl-cmd>` argument of the post-deploy
# verification checks V4 (unit-active's attached diagnostics) and V6
# (journal-digest) in scripts/lib/setup-multiuser-checks.sh. Same static
# shape as fake-systemctl.sh; canned answers via environment variables:
#
#   FAKE_JOURNALCTL_FAIL=1  exit 1 with a diagnostic on stderr
#   FAKE_JOURNAL_LINES      the `-o cat` output to print (multi-line)
#   FAKE_ARGV_LOG           when set, this fixture's own argv is appended to
#                           that file, so a test can pin that `--since <ts>`
#                           and `-u <unit>` actually reached journalctl
set -eu
if [ -n "${FAKE_ARGV_LOG:-}" ]; then
  printf '%s\n' "$*" >>"$FAKE_ARGV_LOG"
fi
if [ "${FAKE_JOURNALCTL_FAIL:-0}" = "1" ]; then
  echo "fake-journalctl: No journal files were opened due to insufficient permissions (simulated)" >&2
  exit 1
fi
printf '%s\n' "${FAKE_JOURNAL_LINES:-}"
