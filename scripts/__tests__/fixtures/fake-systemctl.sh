#!/usr/bin/env bash
#
# Test fixture for scripts/__tests__/setup-multiuser-checks.test.mjs (Issue
# #1717): stands in for the `<systemctl-cmd>` argument of the post-deploy
# verification checks V1 (unit-env-drift), V3 (mainpid-identity) and V4
# (unit-active) in scripts/lib/setup-multiuser-checks.sh. A static
# executable spawned via the lib (no `bash -c` string built from JS), like
# every fixture here; the canned answers come from environment variables the
# test sets on the child process:
#
#   FAKE_SYSTEMCTL_FAIL=1     every subcommand exits 1 with a diagnostic on
#                             stderr (systemctl present but unable to answer)
#   FAKE_SYSTEMCTL_NO_STATE=1 `is-active` prints nothing and exits 1 (the
#                             "no state" cannot-run branch of V4)
#   FAKE_LOADSTATE            `show` LoadState= (default: loaded)
#   FAKE_ENVIRONMENT          `show` Environment= value, the space-separated
#                             KEY=VALUE token list a real `systemctl show`
#                             prints (drop-ins already merged)
#   FAKE_EXECSTART            `show` ExecStart= value (the `{ path=... }` form)
#   FAKE_MAINPID / FAKE_USER / FAKE_GROUP
#                             `show` MainPID= / User= / Group= (defaults:
#                             552 / agentconsole / agent-console-users)
#   FAKE_ACTIVE_STATE         `is-active` output (default: active); exits 0
#                             for active, 3 otherwise, like the real one
#
# `show` prints every property it knows regardless of the `-p` selection: the
# lib reads each property by its `NAME=` prefix, so the extra lines are
# harmless, and keeping the fixture ignorant of `-p` parsing keeps it short.
set -eu
if [ "${FAKE_SYSTEMCTL_FAIL:-0}" = "1" ]; then
  echo "fake-systemctl: failed (simulated)" >&2
  exit 1
fi
case "${1:-}" in
  show)
    echo "LoadState=${FAKE_LOADSTATE:-loaded}"
    echo "Environment=${FAKE_ENVIRONMENT:-}"
    echo "ExecStart=${FAKE_EXECSTART:-}"
    echo "MainPID=${FAKE_MAINPID:-552}"
    echo "User=${FAKE_USER:-agentconsole}"
    echo "Group=${FAKE_GROUP:-agent-console-users}"
    ;;
  is-active)
    if [ "${FAKE_SYSTEMCTL_NO_STATE:-0}" = "1" ]; then
      echo "fake-systemctl: System has not been booted with systemd (simulated)" >&2
      exit 1
    fi
    state="${FAKE_ACTIVE_STATE:-active}"
    echo "$state"
    [ "$state" = "active" ] && exit 0
    exit 3
    ;;
  status)
    for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
      echo "fake-systemctl status line $i"
    done
    ;;
  *)
    echo "fake-systemctl: unexpected subcommand '${1:-}'" >&2
    exit 1
    ;;
esac
