#!/usr/bin/env bash
#
# Test fixture for scripts/__tests__/setup-multiuser-checks.test.mjs (Issue
# #1668). Creates a temp file that exists but is NOT readable (mode 0000),
# and asserts assert_readable_file fails closed on it. Same rationale as
# assert-not-executable-check.sh (Issue #1222) -- a static executable
# fixture, spawned directly with no `bash -c` command string built from JS,
# so CodeQL's js/shell-command-injection-from-environment query has no
# tainted value reaching a shell-interpreter sink to flag.
set -eu
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../lib/setup-multiuser-checks.sh
source "$SCRIPT_DIR/../../lib/setup-multiuser-checks.sh"

tmp="$(mktemp)"
chmod 0000 "$tmp"
trap 'rm -f "$tmp"' EXIT
assert_readable_file "$tmp" "unused hint"
