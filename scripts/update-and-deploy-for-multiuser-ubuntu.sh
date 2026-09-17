#!/usr/bin/env bash
#
# Update-and-deploy Agent Console in multi-user mode on Ubuntu / Debian.
#
# Counterpart to scripts/setup-multiuser-for-ubuntu.sh: setup performs the
# one-shot bootstrap, this script performs the iterative redeploy after
# source updates (the typical orchestrator-driven update cycle).
#
# Steps:
#   1. Pre-check: print the source-repo HEAD so the operator confirms the
#      build will use the intended commit. (The orchestrator is responsible
#      for syncing the source-repo to the target ref before invoking this
#      script; this script does NOT git pull on its own.) The HEAD SHA is
#      also captured here for the deployed-commit marker (step 5) and
#      re-verified unchanged after build and after rsync, aborting before
#      either the deploy or the marker write on a mismatch -- a concurrent
#      push to the source repo mid-deploy must not produce a marker that
#      records a revision rsync never actually copied.
#   2. bun install (all deps) @ source-repo so build tooling is present.
#   3. NODE_ENV=production bun run build @ source-repo.
#   4. rsync source-repo -> deploy target (excludes node_modules + .git).
#   5. Write the deployed-commit marker (.deploy-sha) into the deploy target,
#      using the SHA captured in step 1 (not a fresh read at this point).
#   6. Copy dist/embedded-agent.js (+ .map) from the deploy target -- the
#      point where the SHA-recheck above has already verified it's correct,
#      not a second independent read from the source repo -- to a unified,
#      world-traversable location every elevation-target OS user can reach
#      (see the "embedded-agent entry path" comment at UNIFIED_ENTRY_PATH
#      below). Unconditional on every deploy, no hash/mtime gate.
#   7. bun install --production @ deploy target (runtime deps only).
#   8. Fail-closed readability check on the unified entry path, immediately
#      before restarting the service -- refuses to restart into a unit whose
#      EMBEDDED_AGENT_ENTRY_PATH would point at a file step 6 did not
#      actually provision.
#   9. V1 unit-env-drift (Issue #1688), still BEFORE the restart and
#      fail-closed: every `Environment=KEY=` in
#      scripts/agent-console-multiuser.service.template must be present in
#      the live unit's effective environment, or the deploy stops here
#      naming the missing key(s) and both remedies. This script never
#      renders the unit -- scripts/setup-multiuser-for-ubuntu.sh is its
#      single writer; V1 only detects that a re-render is due.
#      Then systemctl restart <service> + status snapshot.
#  10. Post-deploy verification V2-V6 (Issue #1717; the spec is the
#      "Post-deploy verification -- checks enumerated" table in
#      docs/design/elevation-verification-tiers.md): entry-path readability,
#      MainPID binary identity, unit active, /api/config health, journal
#      digest. One line per check, PASS / FAIL / SKIP, then a six-line
#      screen (V1 included) and the worst code as this script's exit:
#        0  every check PASSed
#        1  at least one FAIL (a check ran and the system is wrong)
#        2  at least one SKIP (a check could not run) and no FAIL
#      Every check runs even after a failure, so the screen is complete.
#      The checks themselves live in lib/setup-multiuser-checks.sh (V1-V6
#      subcommands, fixture-tested); this script only sequences them.
#
# Contract: run this script as the operator's own login user -- do NOT
# invoke it with a top-level sudo. Every privileged step below elevates
# itself individually (`sudo -u "${SERVICE_USER}"` for service-user
# actions, plain `sudo` for root-level actions such as the entry-path copy
# and `systemctl restart`) -- see the per-step comments. (Issue #1690: an
# earlier revision of this header claimed both things at once -- "run as
# your login user" here, a `sudo`-prefixed invocation in Usage below -- and
# the fail-closed readability gate was built on the stale half, assuming
# the whole script already ran as root; the operator's first real run
# proved otherwise.)
#
# Usage:
#   scripts/update-and-deploy-for-multiuser-ubuntu.sh
#
# Env overrides (CLI flags not supported; override via env vars):
#   AGENT_CONSOLE_SERVICE_USER       Service user owning source + target.
#                                    Default: agentconsole
#   AGENT_CONSOLE_DATA_ROOT          Shared data root.
#                                    Default: /var/lib/agent-console
#   AGENT_CONSOLE_APP_SOURCE_DIR     Build source directory.
#                                    Default: ${AGENT_CONSOLE_DATA_ROOT}/source-repos/agent-console
#   AGENT_CONSOLE_DEPLOY_TARGET_DIR  rsync deploy target.
#                                    Default: /home/${AGENT_CONSOLE_SERVICE_USER}/agent-console
#   AGENT_CONSOLE_SERVICE_NAME       systemd unit to restart.
#                                    Default: agent-console.service
#   AGENT_CONSOLE_PORT               Port the V5 health check probes
#                                    (GET http://localhost:<port>/api/config).
#                                    Default: 8080
#
# Example with overrides:
#   AGENT_CONSOLE_PORT=9000 AGENT_CONSOLE_SERVICE_USER=ac-svc \
#     scripts/update-and-deploy-for-multiuser-ubuntu.sh
#
# Prerequisites (set up by scripts/setup-multiuser-for-ubuntu.sh):
#   - service user exists with the configured home directory
#   - sudoers fragment permits root -> service user without password
#   - source-repo cloned at ${AGENT_CONSOLE_APP_SOURCE_DIR}, owned by service user
#   - systemd unit installed and enabled
#
# Documentation: docs/multi-user-setup-guide.md

set -euo pipefail

SERVICE_USER="${AGENT_CONSOLE_SERVICE_USER:-agentconsole}"
DATA_ROOT="${AGENT_CONSOLE_DATA_ROOT:-/var/lib/agent-console}"
SRC="${AGENT_CONSOLE_APP_SOURCE_DIR:-${DATA_ROOT}/source-repos/agent-console}"
DST="${AGENT_CONSOLE_DEPLOY_TARGET_DIR:-/home/${SERVICE_USER}/agent-console}"
SERVICE_NAME="${AGENT_CONSOLE_SERVICE_NAME:-agent-console.service}"
PORT="${AGENT_CONSOLE_PORT:-8080}"

# Elevation prefix for the probes that need root themselves (the
# unprivileged-readability gate below, via `runuser`; and the post-deploy
# verification's V2 / V3 `runuser` reads and V4 / V6 journal reads, which
# receive it as an explicit argument) but that this script does not
# otherwise require at the top level (see the Contract note above -- every
# OTHER privileged step elevates per-command already). Empty when
# already root (a supported, if unusual, invocation); the same bare,
# interactive-capable form every other elevated step in this script uses
# otherwise -- not a non-interactive flag, so an expired credential cache
# mid-deploy re-prompts instead of failing the gate outright.
ELEVATE=""
if [ "$(id -u)" -ne 0 ]; then
  ELEVATE="sudo"
fi

# Unified, world-traversable location for the bundled embedded-agent
# subprocess entry: resolveEmbeddedAgentEntryPath()'s own "bundle sibling"
# branch resolves dist/embedded-agent.js inside the deploy target
# (/home/<service-user>/agent-console/dist/), which is unreachable to any
# OTHER elevation-target OS user even though the file itself is
# world-readable -- the same class of bug the unified bun-binary path fixes
# for the `bun` binary itself (see scripts/setup-multiuser-for-ubuntu.sh's
# UNIFIED_BUN_PATH). Deliberately NOT derived from that unified bun path's
# directory -- a language-runtime binary and an application bundle file are
# different physical resources that happen to share a reachability
# requirement, and conventionally live in different FHS locations
# (/usr/local/bin vs. /usr/local/lib/<project>/).
#
# This same literal is duplicated in scripts/setup-multiuser-for-ubuntu.sh
# (its systemd unit template's Environment=EMBEDDED_AGENT_ENTRY_PATH= line;
# no cross-script shared-constant mechanism exists in this codebase --
# scripts/__tests__/setup-multiuser-for-ubuntu.test.mjs pins the rendered
# unit's value so the two cannot silently drift apart).
UNIFIED_ENTRY_PATH="/usr/local/lib/agent-console/embedded-agent.js"
UNIFIED_ENTRY_MAP_PATH="${UNIFIED_ENTRY_PATH}.map"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/setup-multiuser-checks.sh
source "$SCRIPT_DIR/lib/setup-multiuser-checks.sh"

# The unit template V1 reads its key set from -- the same file the setup
# script renders the unit from, read here only ever for its `Environment=`
# key names and its ExecStart placeholder (this script never renders it).
UNIT_TEMPLATE="$SCRIPT_DIR/agent-console-multiuser.service.template"

# --- post-deploy verification runner (Issue #1717) --------------------------
#
# verify_check <label> <lib-function> <args...>
#
# Runs one V check from lib/setup-multiuser-checks.sh, prints its screen line
# (`  PASS  <label>` / `  FAIL  <label>: <reason>` / `  SKIP  <label>: cannot
# run: <reason>`) plus any annotation / diagnostic lines the check wrote to
# stderr, indented beneath it, and folds the verdict into the counters the
# final screen and exit code are built from. Returns the check's own code
# (0 / 1 / 2) so a caller that must stop on it (V1, before the restart) can;
# the post-restart callers deliberately ignore it (`|| true`) so every check
# runs and the screen is complete. The check's stdout (marker + detail
# lines) is kept in VERIFY_LAST_STDOUT for the one caller that parses it
# (V1's live EMBEDDED_AGENT_BUN_PATH value, handed to V3).
VERIFY_SCREEN=""
VERIFY_PASS=0
VERIFY_FAIL=0
VERIFY_SKIP=0
VERIFY_LAST_STDOUT=""
verify_check() {
  local label="$1"
  shift
  local out err rc=0
  out="$(mktemp)"
  err="$(mktemp)"
  "$@" >"$out" 2>"$err" || rc=$?
  VERIFY_LAST_STDOUT="$(cat "$out")"
  local line
  case "$rc" in
    0)
      line="  PASS  ${label}"
      VERIFY_PASS=$((VERIFY_PASS + 1))
      ;;
    1)
      line="  FAIL  ${label}: $(head -n 1 "$err")"
      VERIFY_FAIL=$((VERIFY_FAIL + 1))
      ;;
    *)
      line="  SKIP  ${label}: cannot run: $(head -n 1 "$err" | sed 's/^cannot run: //')"
      VERIFY_SKIP=$((VERIFY_SKIP + 1))
      ;;
  esac
  echo "$line"
  # On PASS every stderr line is an annotation (WARN: / INFO:); otherwise the
  # first line is already on the verdict line and the rest is diagnostics.
  if [ "$rc" -eq 0 ]; then
    sed 's/^/        /' "$err"
  else
    tail -n +2 "$err" | sed 's/^/        /'
  fi
  VERIFY_SCREEN="${VERIFY_SCREEN}${line}"$'\n'
  rm -f "$out" "$err"
  return "$rc"
}

# The worst code observed: 1 if any check FAILed; else 2 if any could not
# run; else 0 (docs/design/elevation-verification-tiers.md's convention,
# from os-environment-coupling.md Discipline 1). FAIL outranks SKIP because
# "the system is wrong" is the stronger statement.
verify_exit_code() {
  if [ "$VERIFY_FAIL" -gt 0 ]; then
    echo 1
  elif [ "$VERIFY_SKIP" -gt 0 ]; then
    echo 2
  else
    echo 0
  fi
}

verify_print_screen() {
  local code
  code="$(verify_exit_code)"
  echo ""
  echo "==> Post-deploy verification"
  printf '%s' "$VERIFY_SCREEN"
  echo "  RESULT: ${VERIFY_PASS} PASS, ${VERIFY_FAIL} FAIL, ${VERIFY_SKIP} SKIP -> exit ${code}"
  if [ "$VERIFY_FAIL" -gt 0 ]; then
    echo "  (a FAIL line means the check ran and the system is wrong; its reason and remedy are on that line and beneath it above)"
  elif [ "$VERIFY_SKIP" -gt 0 ]; then
    echo "  (a SKIP line means the check could not run -- a missing tool or a refused elevation, not a verdict about the unit; fix what it names and re-run this script)"
  fi
}

echo "==> Config"
echo "    SERVICE_USER : ${SERVICE_USER}"
echo "    APP_SOURCE   : ${SRC}"
echo "    DEPLOY_TARGET: ${DST}"
echo "    SERVICE_NAME : ${SERVICE_NAME}"
echo "    PORT         : ${PORT}"
echo ""

echo "==> Pre-check: source-repo HEAD"
sudo -u "${SERVICE_USER}" -- git -C "${SRC}" log --oneline -1

# Captured BEFORE build/rsync and re-verified after each, so the marker
# never records a revision other than the one actually built and copied
# (a concurrent push to the source repo mid-deploy would otherwise leave
# the marker pointing at a SHA rsync never saw).
DEPLOYED_SHA="$(sudo -u "${SERVICE_USER}" -- git -C "${SRC}" rev-parse HEAD)"

echo ""
echo "==> 1/6 bun install (all deps, build needs dev tooling) @ source-repo"
sudo -u "${SERVICE_USER}" bash -lc '
  export PATH=$HOME/.bun/bin:$PATH
  cd -- "$1" && bun install
' _ "${SRC}"

echo ""
echo "==> 2/6 NODE_ENV=production bun run build @ source-repo"
sudo -u "${SERVICE_USER}" bash -lc '
  export PATH=$HOME/.bun/bin:$PATH
  cd -- "$1" && NODE_ENV=production bun run build
' _ "${SRC}"

CURRENT_SHA="$(sudo -u "${SERVICE_USER}" -- git -C "${SRC}" rev-parse HEAD)"
if [ "${CURRENT_SHA}" != "${DEPLOYED_SHA}" ]; then
  echo "Error: source HEAD changed during build (${DEPLOYED_SHA} -> ${CURRENT_SHA}). Aborting before deploy." >&2
  exit 1
fi

echo ""
echo "==> 3/6 rsync source-repo -> deploy target (excludes node_modules, .git)"
sudo -u "${SERVICE_USER}" rsync -a --delete \
  --exclude=node_modules \
  --exclude='.git' \
  "${SRC}/" "${DST}/"

CURRENT_SHA="$(sudo -u "${SERVICE_USER}" -- git -C "${SRC}" rev-parse HEAD)"
if [ "${CURRENT_SHA}" != "${DEPLOYED_SHA}" ]; then
  echo "Error: source HEAD changed during deploy (${DEPLOYED_SHA} -> ${CURRENT_SHA}). Aborting before marker write." >&2
  exit 1
fi

echo ""
echo "==> 4/6 write deployed-commit marker (.deploy-sha)"
# Written into the deploy target (not the source) so it survives the next
# rsync --delete; rewritten fresh every deploy. Uses the SHA captured at the
# top of this script (DEPLOYED_SHA), not a fresh read here -- the
# HEAD-unchanged checks above are what make that captured value trustworthy
# at this point.
DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
sudo -u "${SERVICE_USER}" bash -lc 'printf "%s\n%s\n" "$1" "$2" > "$3/.deploy-sha"' _ "${DEPLOYED_SHA}" "${DEPLOYED_AT}" "${DST}"

echo ""
echo "==> 5/6 copy dist/embedded-agent.js (+ .map) to unified entry path"
# Source is the DEPLOY TARGET, post-rsync, post-SHA-recheck (the point where
# the check above has already verified it's the intended revision) -- not a
# second independent read from the source repo, folded in immediately after
# the marker write above rather than opening a new independent race window.
# Copied unconditionally on every deploy (matches rsync -a's own semantics
# and the .deploy-sha marker's own "rewritten fresh every deploy"
# precedent) -- no hash/mtime gate. Run as root (plain sudo, no -u) so this
# can read from the deploy target regardless of its own directory
# permissions and write to the root-owned /usr/local/lib/agent-console/
# destination.
#
# The parent directory's mode is set EXPLICITLY, not left to `install -D`
# (CodeRabbit + Architect review on this PR): `install -D` derives a missing
# parent's mode from the caller's umask, and leaves an ALREADY-EXISTING
# parent's mode untouched entirely -- either way, a root umask other than
# the conventional 022 (or a directory that predates this step with a
# stricter mode) silently produces a non-traversable
# /usr/local/lib/agent-console/, and the file's own `-m0644` cannot
# compensate for that. `install -d -m0755 <dir>` sets the mode
# unconditionally on the final path component whether or not it already
# existed (GNU coreutils), which is what actually makes the destination
# reachable by every elevation-target OS user -- the fail-closed check
# below is the PROOF that traversal actually holds, not a restatement of
# this step's intent.
sudo install -d -m0755 "$(dirname "${UNIFIED_ENTRY_PATH}")"
sudo install -Dm0644 "${DST}/dist/embedded-agent.js" "${UNIFIED_ENTRY_PATH}"
sudo install -Dm0644 "${DST}/dist/embedded-agent.js.map" "${UNIFIED_ENTRY_MAP_PATH}"

echo ""
echo "==> 6/6 bun install --production @ deploy target (runtime deps only)"
sudo -u "${SERVICE_USER}" bash -lc '
  export PATH=$HOME/.bun/bin:$PATH
  cd -- "$1" && bun install --production
' _ "${DST}"

echo ""
echo "==> fail-closed check: unified entry path is readable by an elevation-target user before restart"
# Mirrors assert_unified_bun_executable's fail-closed discipline (Issue
# #1222) for the entry path (Issue #1668): refuses to restart into a unit
# whose EMBEDDED_AGENT_ENTRY_PATH would point at a file no OTHER
# elevation-target user can actually read.
#
# Deliberately NOT assert_readable_file (Architect + CodeRabbit review on
# this PR): a ROOT-side check bypasses DAC read checks (CAP_DAC_READ_SEARCH)
# including parent-directory traversal -- a plain `[ -r <path> ]` as root is
# true for ANY existing file regardless of its actual permission bits, so it
# could never fail for the exact defect Issue #1668 is about.
# assert_readable_by_unprivileged_user probes via `runuser -u nobody`, an
# unprivileged user outside this project's shared group, so it actually
# exercises the same traversal path a real elevation-target user hits --
# but this script itself runs as the operator's own login user (see the
# Contract note at the top), not as root, so the probe elevates itself for
# this one call via ${ELEVATE} (Issue #1690).
#
# Always runs after the unconditional copy + explicit directory-mode step
# above (unlike the bun-binary check, this script has no --dry-run preview
# mode to skip for), so on a normal successful deploy this can never
# legitimately fail -- it exists to catch a partial/interrupted copy or an
# unexpected parent-directory mode, not a first-run bootstrap ordering gap.
#
# Gates BOTH files copied in step 5/6, not just the entry point (Architect
# ruling): the .map file is the second half of that same copy, and a
# partial copy that dropped it is exactly the kind of interruption this
# check exists to catch.
assert_readable_by_unprivileged_user "${UNIFIED_ENTRY_PATH}" \
  "step 5/6 (copy dist/embedded-agent.js to the unified entry path) did not complete, or /usr/local/lib/agent-console/ is not world-traversable -- re-run this script" \
  "${ELEVATE}" || exit 1
assert_readable_by_unprivileged_user "${UNIFIED_ENTRY_MAP_PATH}" \
  "step 5/6 (copy dist/embedded-agent.js.map to the unified entry path) did not complete, or /usr/local/lib/agent-console/ is not world-traversable -- re-run this script" \
  "${ELEVATE}" || exit 1

echo ""
echo "==> V1 (fail-closed, before restart): live unit environment vs the template"
# Issue #1688: the ONLY verification check that runs BEFORE the restart, and
# the only one this script stops on. A template `Environment=KEY=` missing
# from the live unit's effective environment means the unit predates a
# template change and was never re-rendered (on the dogfood host: no
# EMBEDDED_AGENT_BUN_PATH / EMBEDDED_AGENT_ENTRY_PATH line at all, so the
# bundle copied in step 5/6 would never have been used). Restarting into
# such a unit deploys code the unit cannot run correctly, so the deploy
# refuses here -- the build and rsync above have already run, but the
# running server keeps executing the previous deploy until a restart
# happens. This script does NOT re-render the unit (single writer =
# scripts/setup-multiuser-for-ubuntu.sh, run with --dry-run then --force);
# V1 only names the drift and the remedies. `systemctl show` needs no
# elevation, so no prefix is passed. ExecStart drifting from the unified bun
# is a WARN here (exit 0); V3 below is where that becomes a hard FAIL.
V1_RC=0
verify_check "V1 unit-env-drift" unit_env_drift "${UNIT_TEMPLATE}" "${SERVICE_NAME}" systemctl || V1_RC=$?
if [ "${V1_RC}" -ne 0 ]; then
  verify_print_screen
  echo "" >&2
  echo "Error: refusing to restart ${SERVICE_NAME} -- V1 did not pass (see the line above). No restart was performed: the unit keeps running the previous deploy. Apply the named remedy, then re-run this script." >&2
  exit "${V1_RC}"
fi
# V1's single read of the live environment is passed down to V3: the value
# the embedded agent will actually spawn, not the template's placeholder.
CONFIGURED_BUN="$(printf '%s\n' "${VERIFY_LAST_STDOUT}" | sed -n 's/^EMBEDDED_AGENT_BUN_PATH=//p' | head -n 1)"

echo ""
echo "==> systemctl restart ${SERVICE_NAME}"
# Captured IMMEDIATELY before the restart -- never after -- in the journal's
# own local-time, second-precision form, so V6's `journalctl --since` reads
# this incarnation's boot and nothing older.
RESTART_SINCE="$(date '+%Y-%m-%d %H:%M:%S')"
sudo systemctl restart "${SERVICE_NAME}"
sleep 2
# `status` exits non-zero for a unit that is not active; the verification
# below is what reports that (V4), so the snapshot must not abort the script.
sudo systemctl status "${SERVICE_NAME}" --no-pager | head -10 || true

echo ""
echo "==> Post-deploy verification V2-V6 (after restart)"
# Every check runs regardless of the previous one's verdict (`|| true`), so
# the screen is complete; the exit code is computed from the counters after
# all six. Each elevating check receives ${ELEVATE} explicitly (the #1690
# shape): V2's `runuser -u nobody` probe, V3's `runuser -u <User> -g
# <Group>` identity read, and the journal reads in V4's diagnostics and V6
# (the system journal is root / adm / systemd-journal readable only, and the
# operator account is not assumed to be in either group). `systemctl show` /
# `is-active` and the health probe need no elevation.
verify_check "V2 entry-path-readable" entry_path_readable "${UNIFIED_ENTRY_PATH}" "${UNIFIED_ENTRY_MAP_PATH}" "${ELEVATE}" || true
verify_check "V3 mainpid-identity" mainpid_identity "${SERVICE_NAME}" "${CONFIGURED_BUN}" "${ELEVATE}" systemctl || true
verify_check "V4 unit-active" unit_active "${SERVICE_NAME}" systemctl journalctl "${ELEVATE}" || true
# V5 is the wait point after the restart: it polls /api/config up to 10 x 1 s
# before deciding, so V6 after it reads a settled boot rather than racing it.
verify_check "V5 health" health "${PORT}" 10 curl || true
verify_check "V6 journal-digest" journal_digest "${SERVICE_NAME}" "${RESTART_SINCE}" journalctl "${ELEVATE}" || true

verify_print_screen
VERIFY_EXIT="$(verify_exit_code)"

echo ""
echo "==> Done."
exit "${VERIFY_EXIT}"
