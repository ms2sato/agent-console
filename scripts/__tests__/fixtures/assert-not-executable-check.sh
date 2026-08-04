#!/usr/bin/env bash
#
# Test fixture for scripts/__tests__/setup-multiuser-checks.test.mjs (Issue
# #1222). Creates a temp file that exists but is NOT executable, and asserts
# assert_unified_bun_executable fails closed on it. A static executable
# fixture (spawned directly, `spawnSync(FIXTURE, [])`, no `bash -c`) rather
# than a `bash -c` script string built from JS -- CodeQL's
# js/shell-command-injection-from-environment query flags ANY tainted value
# reaching a spawnSync call whose command is a shell interpreter, even one
# passed as a real, unparsed positional parameter rather than embedded in
# the command string. A fully static fixture file has no such value to flag.
set -eu
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../lib/setup-multiuser-checks.sh
source "$SCRIPT_DIR/../../lib/setup-multiuser-checks.sh"

tmp="$(mktemp)"
chmod 0644 "$tmp"
trap 'rm -f "$tmp"' EXIT
assert_unified_bun_executable "$tmp"
