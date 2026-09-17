#!/usr/bin/env bash
#
# Test fixture for scripts/__tests__/setup-multiuser-checks.test.mjs (Issue
# #1717): runs scripts/lib/setup-multiuser-checks.sh's subcommand dispatcher
# under `set -o pipefail`, the option the production caller
# (update-and-deploy-for-multiuser-ubuntu.sh, `set -euo pipefail`) sources
# the lib with. The lib file itself sets no shell options, so spawning it
# directly cannot reproduce pipefail-only behaviour -- an early-exiting
# `grep -q` at the end of a pipeline SIGPIPEs its upstream stage (status
# 141) once the input exceeds the pipe buffer, and only under pipefail does
# that status become the pipeline's. Same static-executable shape as every
# fixture here (spawned directly, no `bash -c` string built from JS).
set -eu
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash -o pipefail "$SCRIPT_DIR/../../lib/setup-multiuser-checks.sh" "$@"
