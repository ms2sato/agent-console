#!/usr/bin/env bash
#
# Tier-3 verification stack driver: systemd as PID 1 in a container, the
# multi-user setup script, the deploy script AS THE OPERATOR, the health
# checks, the #1690 readability-gate helper cases and the elevation smoke
# against the REAL unit's MainPID. Spec and measurements:
# docs/design/elevation-verification-tiers.md (Task 0). Tier table:
# tier 1 = unit/memfs, tier 2 = scripts/verify-multiuser-docker.sh (no
# systemd), tier 3 = THIS script, tier 4 = the production host, owner-run.
#
# ======================================================================
#  NEVER ON THE DOGFOOD HOST. This script runs on an ephemeral GitHub
#  runner (.github/workflows/verify-multiuser-systemd.yml) or on a personal
#  workstation whose only user is its owner. It refuses to run unless
#  AC_TIER3_RUNNER=github-hosted (set by the workflow from GitHub's own
#  `runner.environment` context -- `CI=true` alone is NOT accepted, any
#  self-hosted runner sets that) or AC_TIER3_HOST_OK=1 (the explicit
#  workstation opt-in) is set (Discipline 4 of
#  .claude/rules/os-environment-coupling.md, drafted in the note above).
#  A delegate on the dogfood host drives tier 3 by PUSHING A BRANCH, never
#  by running this script.
# ======================================================================
#
# The tier-3 boot set (measured on a GitHub ubuntu-latest runner ONLY; the
# workstation half is the owner's recipe in the note and is not yet measured):
#
#   CAP_SYS_ADMIN + host cgroup namespace + rw /sys/fs/cgroup bind
#   + tmpfs /run,/run/lock + container=docker + apparmor=unconfined
#   (seccomp = Docker's default profile; SYS_ADMIN is the only capability
#   ADDED on top of Docker's defaults; NO --privileged)
#
# It lives in docker/docker-compose.systemd.yml. This driver asserts the set
# boots (systemctl is-system-running = running|degraded, /proc/1/comm =
# systemd) and records `docker info`'s security options and cgroup version in
# the log. If the set stops booting, this script STOPS with the console text
# and exit 2 -- it never falls back to --privileged.
#
# Every step is a `docker compose exec --user <root|deployer|agentconsole|
# agentconsole:agent-console-users>`: the exec shape carries no elevation
# literal, and everything that elevates runs INSIDE the container from the
# repository's own scripts. Three inputs carry (or install) the elevation
# literal and are checked by the preflight below before docker is touched:
# the operator's rules file docker/deployer-elevation-rules, the Dockerfile
# COPY line that installs it, and the AC_TIER3_ELEVATE env value the
# workflow passes in (the helper cases' elevation prefix).
#
# Steps (each timed, printed as `STEP <name> <n>s`):
#   0. gate (AC_TIER3_RUNNER=github-hosted | AC_TIER3_HOST_OK=1) and the
#      rules-file preflight
#   1. host facts: docker info (security options, cgroup version), kernel
#   2. docker compose build (docker/Dockerfile.systemd, no app baked)
#   3. boot + assertion (is-system-running, /proc/1/comm, failed units)
#   4. setup --dry-run then --force, as root (--repo-source /src,
#      --add-user alice --add-user deployer); step 6b's skip is logged as
#      NOT EXERCISED (the image pins bun at the unified path)
#   5. cp -a /src -> the shared source-repos dir, as the service user
#   6. update-and-deploy-for-multiuser-ubuntu.sh as `deployer` (uid != 0, so
#      the script's own per-step self-elevation is what runs); expect exit 0
#   7. the deploy script's OWN post-deploy verification screen (Issue #1717:
#      V0 data-root-ownership, V1 unit-env-drift, V2 entry-path-readable, V3
#      mainpid-identity, V4 unit-active, V5 health, V6 journal-digest; V0
#      added by Issue #1754) is consumed, not re-implemented: seven
#      `  PASS  V<n> <name>` lines and `RESULT: 7 PASS`.
#      The facts behind them (MainPID/User/Group/ExecStart, /proc/<MainPID>/
#      exe read AS the unit's User+Group -- root in-container lacks
#      CAP_SYS_PTRACE and cannot read another uid's exe link, Task 0's root
#      readlink printed nothing --, /api/config, the journal) are still
#      printed for the log
#  7b. the #1688 drift arm: one template `Environment=` key is removed from
#      the live unit file (sed + daemon-reload -- a drop-in cannot unset ONE
#      key visibly to `systemctl show -p Environment`, see the function);
#      the deploy script, run again as `deployer`, must exit 1 on V1's FAIL
#      line naming the key BEFORE restarting (ActiveEnterTimestampMonotonic
#      unchanged, no `==> systemctl restart` line); `setup --force` must
#      re-render the unit (the key is back in `show -p Environment`); a
#      third deploy must exit 0 with the seven PASS lines again. V3's
#      DIFFERENT arm is NOT driven here (it needs a second bun binary); its
#      marker-to-verdict table is pinned at tier 1 instead
#      (scripts/__tests__/setup-multiuser-checks.test.mjs)
#  7c. the #1754 ownership-polarity arm: synthesizes a
#      repositories/<org>/<repo>/worktrees tree (this driver creates no
#      worktree of its own), re-owns it to the service user first (positive
#      control: a clean synthesized tree PASSes V0, proven via a direct
#      helper probe before any injection), then `chown deployer` on the org
#      dir alone (a walked position) -- deploy #4 must exit 1 on V0's FAIL
#      line naming that path BEFORE the restart (no V1-V6 line, no
#      `==> systemctl restart`); restoring ownership, deploy #5 must exit 0
#      with the seven PASS lines, V0's marker independently confirmed
#      OWNERSHIP_OK (the tree stays non-empty, never NO_TREES) via the same
#      direct probe. A non-walked control (repositories/<org>/<repo>/
#      templates, `chown deployer`) is created once and left mis-owned
#      through deploy #5: V0 still PASSes, with an INFO line naming it as
#      ignored (not walked).
#  7d. the #1762 restart-survival arm: seeds one session plus its FK
#      dependents (a repository_orchestrator_sessions designation and a
#      pending inbound_event_notifications row) directly against the
#      real data.db via `bun -e` + bun:sqlite, restarts the unit through
#      deploy #6 (the shipping saveAll() path), and reads the same rows
#      back: the session itself present (positive control -- not swept as
#      an orphan), its created_at unchanged / updated_at moved, and the
#      two dependents intact -- exactly what the pre-#1762 DELETE-all
#      saveAll() cascaded away.
#   8. the three #1690 helper cases, explicitly: (1) elevated (deployer +
#      AC_TIER3_ELEVATE) against the real bundle -> READABLE; (2) the same
#      call against a chmod 000 copy -> UNREADABLE, exit 1; (3) root with an
#      empty prefix against the real bundle -> pass
#   9. check-embedded-agent-elevation.ts as agentconsole:agent-console-users
#      (expect 0, Assertion 2 OK), as agentconsole with the WRONG primary gid
#      (expect exactly 2 naming User= and Group=, no FAIL line -- the
#      polarity), and again with EMBEDDED_AGENT_ENTRY_PATH (expect 0). A
#      smoke exit 2 is a FAIL, never a skip (verify-multiuser-docker.sh
#      --smokes convention).
#  10. writable-layer footprint (the honest per-run number), summary,
#      teardown (compose down; --keep leaves the container up)
#
# Usage (from repo root, on a runner / workstation only):
#   scripts/verify-multiuser-systemd.sh              # build + run + tear down
#   scripts/verify-multiuser-systemd.sh --keep       # leave the container up
#   scripts/verify-multiuser-systemd.sh --no-build   # reuse the existing image
#
# Exit codes (os-environment-coupling.md Discipline 1): 0 = every check
# passed; 1 = a check ran and the system is wrong; 2 = the stack could not
# run (gate refused, the rules file / its COPY line / AC_TIER3_ELEVATE
# missing, docker unavailable, the boot
# set did not boot).
#
# Requires: docker with compose v2 on the host. bun is NOT needed on the
# host -- every bun invocation happens inside the container.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.systemd.yml"
DOCKERFILE="${REPO_ROOT}/docker/Dockerfile.systemd"
WORKFLOW_FILE=".github/workflows/verify-multiuser-systemd.yml"
# The operator's rules file. Its CONTENT carries no elevation literal; only
# its install destination (the Dockerfile's COPY line) does.
RULES_FILE_REL="docker/deployer-elevation-rules"
RULES_FILE="${REPO_ROOT}/${RULES_FILE_REL}"
SERVICE="systemd"
UNIT="agent-console"
# The service user's copy of the checkout, i.e. the source-repo the deploy
# script builds from (AGENT_CONSOLE_APP_SOURCE_DIR's default).
SRC="/var/lib/agent-console/source-repos/agent-console"
DEPLOY_TARGET="/home/agentconsole/agent-console"
# AGENT_CONSOLE_DATA_ROOT's default -- the two trees V0 (7c) walks.
DATA_ROOT="/var/lib/agent-console"
UNIFIED_BUN="/usr/local/bin/bun"
UNIFIED_ENTRY="/usr/local/lib/agent-console/embedded-agent.js"
SMOKE="scripts/smoke/check-embedded-agent-elevation.ts"
HELPER="scripts/lib/setup-multiuser-checks.sh"

KEEP=0
BUILD=1
PASS=0
FAIL=0
STEP_T0=0
SUMMARY=""

usage() {
  sed -n '/^# Usage/,/^# Requires/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# expect <name> <command...>: run the command and fold its exit code into
# check(). Under `set -e` a failing test cannot be followed by `check $?`
# (errexit fires on the last command of an && list), so every assertion in
# this file goes through here or through an explicit `rc=0; ... || rc=$?`.
expect() {
  local name="$1"; shift
  local rc=0
  "$@" || rc=$?
  check "$name" "$rc"
}

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
# All in-container commands go through this one shape. `-T`: no tty for
# exec, so stdout/stderr can be captured and compared.
cexec() { compose exec -T "$@"; }

step_start() { STEP_T0=$(date +%s); echo; echo "=== $1 ==="; }
step_end() { echo "STEP $1 $(( $(date +%s) - STEP_T0 ))s"; }

check() { # check <name> <exit-code>
  if [ "$2" -eq 0 ]; then
    echo "  [PASS] $1"; PASS=$((PASS + 1))
  else
    echo "  [FAIL] $1"; FAIL=$((FAIL + 1))
  fi
  local line
  printf -v line '  %-6s %s\n' "$([ "$2" -eq 0 ] && echo PASS || echo FAIL)" "$1"
  SUMMARY="${SUMMARY}${line}"
}

# --- 0. gate + preflight ---------------------------------------------------

gate() {
  # `CI=true` is deliberately NOT accepted: any CI system or self-hosted
  # runner sets it, including one that could be registered on the dogfood
  # host. `runner.environment` is evaluated by GitHub itself and is
  # `github-hosted` only on an ephemeral GitHub runner; the workflow copies
  # it into AC_TIER3_RUNNER.
  if [ "${AC_TIER3_RUNNER:-}" = "github-hosted" ] || [ "${AC_TIER3_HOST_OK:-}" = "1" ]; then
    return 0
  fi
  cat >&2 <<EOF
verify-multiuser-systemd.sh: REFUSING TO RUN on this host.
  (seen: AC_TIER3_RUNNER='${AC_TIER3_RUNNER:-}' AC_TIER3_HOST_OK='${AC_TIER3_HOST_OK:-}'; accepted markers: AC_TIER3_RUNNER=github-hosted or AC_TIER3_HOST_OK=1)

  Tier 3 boots systemd as PID 1 with CAP_SYS_ADMIN, the host cgroup namespace,
  a writable host cgroup tree and an AppArmor opt-out -- root-equivalent on
  the host that lends them. Discipline 4 (verification tiers for
  elevation-coupled code; docs/design/elevation-verification-tiers.md, "The
  rule: never on the dogfood host") therefore confines tier 3 to ephemeral CI
  runners and personal workstations, and this gate makes that mechanical:
  the driver runs only when AC_TIER3_RUNNER=github-hosted (copied by the
  workflow from GitHub's own runner.environment context; CI=true alone is
  not accepted, any self-hosted runner sets that) or AC_TIER3_HOST_OK=1 (set
  by hand, on a workstation whose only user is its owner). Neither is set
  here. A delegate drives tier 3 by pushing a branch that
  .github/workflows/verify-multiuser-systemd.yml picks up, never by running
  this script on the dogfood host.

  What this gate is, honestly: it stops AMBIENT runs on the wrong host -- a
  delegate typing the command, an inherited variable, a CI=true that any
  self-hosted runner sets. It does not stop a workflow author who edits the
  env to the literal marker; that is an org-level runner-registration
  concern (no self-hosted runner exists today), not a shell-enforceable
  security boundary.
EOF
  exit 2
}

preflight() {
  local missing=0
  if [ ! -f "$RULES_FILE" ]; then
    echo "error: missing rules file: ${RULES_FILE_REL} (the operator's elevation rules file for 'deployer'; content per the design note's 'operator rule' ruling)" >&2
    missing=1
  fi
  # Anchored on a COPY instruction: the Dockerfile's own placeholder comment
  # names the file too, and a comment installs nothing.
  if ! grep -Eq '^COPY[[:space:]].*deployer-elevation-rules' "$DOCKERFILE"; then
    echo "error: missing install line: docker/Dockerfile.systemd does not install ${RULES_FILE_REL} (COPY into the elevation rules drop-in directory as 'deployer', chmod 0440, syntax check -- the shape docker/Dockerfile uses for the service user's rules)" >&2
    missing=1
  fi
  if [ -z "${AC_TIER3_ELEVATE:-}" ]; then
    echo "error: missing elevation prefix: AC_TIER3_ELEVATE is unset (the bare elevation command the #1690 helper cases pass as their elevation prefix; set it in ${WORKFLOW_FILE}'s step env, or in the environment on a workstation)" >&2
    missing=1
  fi
  if [ "$missing" -ne 0 ]; then
    echo "error: the deploy step runs as 'deployer' and the helper cases elevate as 'deployer'; without the item(s) above they cannot run. Not a stack failure: exit 2." >&2
    exit 2
  fi
  if ! command -v docker >/dev/null; then
    echo "error: docker not found on PATH (tier 3 needs docker with compose v2 on the host)" >&2
    exit 2
  fi
}

# --- 1. host facts ---------------------------------------------------------

host_facts() {
  step_start "1. host facts (measured on THIS runner only; not a workstation claim)"
  echo "  kernel: $(uname -r)"
  echo "  docker: $(docker version --format 'client={{.Client.Version}} server={{.Server.Version}}')"
  echo "  docker info: $(docker info --format 'cgroupdriver={{.CgroupDriver}} cgroupversion={{.CgroupVersion}} security={{.SecurityOptions}} storage={{.Driver}}')"
  echo "  /sys/fs/cgroup fstype: $(stat -fc %T /sys/fs/cgroup 2>/dev/null || echo unknown)"
  echo "  compose: $(docker compose version 2>/dev/null | head -1)"
  echo "  boot set: CAP_SYS_ADMIN + host cgroupns + rw /sys/fs/cgroup + tmpfs /run,/run/lock + container=docker + apparmor=unconfined (seccomp default, SYS_ADMIN the only added cap, no --privileged) -- see ${COMPOSE_FILE#"$REPO_ROOT"/}"
  step_end host_facts
}

# --- 2. build --------------------------------------------------------------

build_image() {
  step_start "2. docker compose build (docker/Dockerfile.systemd, no app baked)"
  if [ "$BUILD" -eq 1 ]; then
    compose build || { echo "error: image build failed" >&2; exit 2; }
  else
    echo "  --no-build: reusing the existing image"
  fi
  docker image inspect agent-console-systemd-verify --format '  IMAGE size_bytes={{.Size}} id={{.Id}} arch={{.Architecture}}'
  step_end build_image
}

# --- 3. boot + assertion ---------------------------------------------------

boot_wait() {
  local i st
  for i in $(seq 1 60); do
    st="$(cexec --user root "$SERVICE" systemctl is-system-running 2>/dev/null | tr -d '\r' || true)"
    case "$st" in running|degraded) echo "$st"; return 0 ;; esac
    sleep 1
  done
  echo "timeout(last='${st:-}')"
  return 1
}

boot_container() {
  step_start "3. boot: A+apparmor rung (the measured least-privilege set)"
  compose down --remove-orphans >/dev/null 2>&1 || true
  if ! compose up -d --no-build; then
    echo "error: compose up failed (the boot set was refused by this docker daemon?)" >&2
    exit 2
  fi
  local st rc=0
  st="$(boot_wait)" || rc=$?
  echo "  is-system-running=${st} after $(( $(date +%s) - STEP_T0 ))s"
  echo "  --- container state ---"
  docker inspect agent-console-systemd-verify --format '  status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} err={{.State.Error}}' || true
  if [ "$rc" -ne 0 ]; then
    echo "  --- console (docker compose logs, tail) ---"
    compose logs --tail 40 2>&1 | sed 's/^/  /' || true
    cat >&2 <<EOF
error: STOP -- the measured tier-3 boot set did not reach running|degraded on this runner.
  Do NOT fall back to --privileged. Report the console text above and the
  docker info line from step 1 (the runner image or its Docker daemon has
  changed since Task 0 measured this set); the ladder in
  docs/design/elevation-verification-tiers.md is the next rung to measure.
EOF
    exit 2
  fi
  local pid1
  pid1="$(cexec --user root "$SERVICE" cat /proc/1/comm | tr -d '\r' || true)"
  echo "  /proc/1/comm=${pid1}"
  expect "systemd is PID 1 and is-system-running=${st}" test "$pid1" = "systemd"
  echo "  --- inside: pid1 cgroup, systemd version, users, bun ---"
  cexec --user root "$SERVICE" sh -c 'cat /proc/1/cgroup; systemctl --version | head -1; id alice; id deployer; /usr/local/bin/bun --version' | sed 's/^/  /'
  echo "  --- failed units (expect none) ---"
  cexec --user root "$SERVICE" systemctl --failed --no-pager --no-legend | sed 's/^/  /' || true
  step_end boot
}

# --- 4. setup --------------------------------------------------------------

run_setup() {
  step_start "4a. setup --dry-run (as root)"
  expect "setup --dry-run exits 0" \
    cexec --user root -w /src "$SERVICE" bash scripts/setup-multiuser-for-ubuntu.sh --dry-run --repo-source /src --add-user alice --add-user deployer
  step_end setup_dry_run

  step_start "4b. setup --force (as root)"
  local out rc=0
  out="$(mktemp)"
  cexec --user root -w /src "$SERVICE" bash scripts/setup-multiuser-for-ubuntu.sh --force --repo-source /src --add-user alice --add-user deployer 2>&1 | tee "$out" || rc=${PIPESTATUS[0]}
  check "setup --force exits 0" "$rc"
  # Step 6b (copy the service user's ~/.bun/bin/bun to the unified path) and
  # the smoke's freshness check are NOT exercised in this image: bun is
  # pinned at the unified path by docker/Dockerfile.systemd and the service
  # user has no ~/.bun, so 6b warns and skips and step 7's fail-closed check
  # passes on the preinstalled binary. Stated here rather than hidden in the
  # setup output, per the Issue's checklist.
  if grep -q 'not found; skipping copy' "$out"; then
    echo "  NOT EXERCISED: setup step 6b (service-user ~/.bun/bin/bun copy) -- image pins bun at ${UNIFIED_BUN}; the freshness check in the smoke is skipped for the same reason"
  else
    echo "  NOTE: setup step 6b did not print its skip line (the image no longer pins bun at the unified path?)"
  fi
  rm -f "$out"
  echo "  --- post-setup facts ---"
  cexec --user root "$SERVICE" sh -c 'id agentconsole; getent group agent-console-users; stat -c "%U:%G %a %n" /var/lib/agent-console /var/lib/agent-console/source-repos /home/agentconsole /usr/local/bin/bun' | sed 's/^/  /'
  echo "  (no dist/index.js exists yet, so setup step 8 enables the unit without starting it -- the deploy's restart below is what starts it; the note's Issue (d) shape)"
  cexec --user root "$SERVICE" sh -c 'systemctl is-enabled agent-console; systemctl is-active agent-console' | sed 's/^/  unit after setup: /' || true
  step_end setup_force
}

# --- 5. source-repo copy ---------------------------------------------------

copy_source() {
  step_start "5. cp -a /src -> ${SRC} (as agentconsole)"
  expect "source-repo copy as the service user (cp -a + git rev-parse HEAD)" \
    cexec --user agentconsole "$SERVICE" sh -c "cp -a /src '${SRC}' && git -C '${SRC}' rev-parse HEAD"
  cexec --user root "$SERVICE" stat -c '  %U:%G %a %n' "$SRC" "$SRC/scripts"
  step_end copy_source
}

# --- 6. deploy as the operator ---------------------------------------------

# The deploy script's captured output, kept across sections 6 and 7 (section
# 7 consumes the verification screen it printed).
DEPLOY_OUT=""

run_deploy() {
  step_start "6. update-and-deploy-for-multiuser-ubuntu.sh as deployer (uid != 0: per-step self-elevation)"
  cexec --user deployer "$SERVICE" id | sed 's/^/  id: /'
  local rc=0
  DEPLOY_OUT="$(mktemp)"
  cexec --user deployer -w "$SRC" "$SERVICE" bash scripts/update-and-deploy-for-multiuser-ubuntu.sh 2>&1 | tee "$DEPLOY_OUT" || rc=${PIPESTATUS[0]}
  check "deploy script as deployer exits 0" "$rc"
  # The shipping-path form of #1690 case (1): the script's own readability
  # gate ran with a NON-EMPTY elevation prefix (the caller is not root) and
  # returned READABLE, or the script would have exited 1 before the restart.
  rc=0
  { grep -q '==> fail-closed check: unified entry path is readable' "$DEPLOY_OUT" \
    && grep -q '==> systemctl restart' "$DEPLOY_OUT"; } || rc=$?
  check "deploy's own #1690 gate ran as a non-root caller and reached the restart (shipping-path form of case 1)" "$rc"
  step_end deploy_as_deployer
}

# The seven checks of the deploy script's post-deploy verification (Issue
# #1717, V0 added by Issue #1754), by the label each prints on its screen
# line.
V_LABELS=(
  "V0 data-root-ownership"
  "V1 unit-env-drift"
  "V2 entry-path-readable"
  "V3 mainpid-identity"
  "V4 unit-active"
  "V5 health"
  "V6 journal-digest"
)

# assert_seven_pass <deploy-output-file> <prefix>: one check() per V label
# (`  PASS  <label>` present, anchored at line start so a FAIL line that
# quotes another check's name cannot satisfy it) plus the RESULT line.
assert_seven_pass() {
  local out="$1" prefix="$2" label rc
  for label in "${V_LABELS[@]}"; do
    rc=0
    grep -q "^  PASS  ${label}\$" "$out" || rc=$?
    check "${prefix}: screen has '  PASS  ${label}'" "$rc"
  done
  rc=0
  grep -q '^  RESULT: 7 PASS, 0 FAIL, 0 SKIP -> exit 0$' "$out" || rc=$?
  check "${prefix}: RESULT line is 7 PASS, 0 FAIL, 0 SKIP -> exit 0" "$rc"
}

# --- 7. post-deploy checks -------------------------------------------------

post_deploy_checks() {
  step_start "7. the deploy script's own post-deploy verification screen (V0-V6), consumed"
  # Issue #1717 (V0 added by #1754): the deploy script now prints the screen
  # this section used to re-implement (is-active, MainPID identity,
  # /api/config, journal digest). What tier 3 asserts is that the SHIPPING
  # PATH -- the deploy script run as the operator, its checks elevating
  # through the same prefix a real operator's would -- produced seven PASS
  # lines. The facts behind them are still printed below for the log,
  # unasserted.
  echo "  --- the screen (from section 6's output) ---"
  grep -E '^  (PASS|FAIL|SKIP)  V[0-6] |^        (WARN|INFO): |^  RESULT: ' "$DEPLOY_OUT" | sed 's/^/  /' || true
  assert_seven_pass "$DEPLOY_OUT" "deploy #1"
  local rc=0
  grep -q '==> Done.' "$DEPLOY_OUT" || rc=$?
  check "deploy #1: the script printed Done. after the screen" "$rc"
  # V1's own line is printed twice: once when it runs (before the restart)
  # and once on the final screen. The first occurrence must precede the
  # restart line, and the RESULT screen must follow it -- the static pin's
  # claim, observed on the real run.
  local v1_line restart_line result_line
  v1_line="$(grep -n '^  PASS  V1 unit-env-drift$' "$DEPLOY_OUT" | head -n 1 | cut -d: -f1)"
  restart_line="$(grep -n '==> systemctl restart' "$DEPLOY_OUT" | head -n 1 | cut -d: -f1)"
  result_line="$(grep -n '^  RESULT: ' "$DEPLOY_OUT" | head -n 1 | cut -d: -f1)"
  rc=0
  { [ -n "$v1_line" ] && [ -n "$restart_line" ] && [ -n "$result_line" ] \
    && [ "$v1_line" -lt "$restart_line" ] && [ "$restart_line" -lt "$result_line" ]; } || rc=$?
  check "deploy #1: V1 printed BEFORE the restart line, the RESULT screen after it" "$rc"
  rm -f "$DEPLOY_OUT"

  echo "  --- facts behind the screen (printed, not asserted here) ---"
  local pid
  cexec --user root "$SERVICE" systemctl show -p MainPID -p User -p Group -p ExecStart --no-pager "$UNIT" | sed 's/^/  /'
  cexec --user root "$SERVICE" systemctl show -p Environment --value "$UNIT" | tr ' ' '\n' | grep -E '^EMBEDDED_AGENT_' | sed 's/^/  Environment: /' || true
  pid="$(cexec --user root "$SERVICE" systemctl show -p MainPID --value "$UNIT" | tr -d '\r' || true)"
  # Read AS the unit's own User+Group: /proc/<pid>/exe is PTRACE_MODE_READ
  # gated, and in-container root has no CAP_SYS_PTRACE (Task 0's root-side
  # readlink printed nothing). The matching uid+gid is exactly the identity
  # V3 and the smoke's Assertion 2 use, and the mismatched-gid run in 9b is
  # its polarity.
  local exe
  exe="$(cexec --user agentconsole:agent-console-users "$SERVICE" readlink -f "/proc/${pid:-0}/exe" | tr -d '\r' || true)"
  echo "  /proc/${pid:-?}/exe (read as agentconsole:agent-console-users) = ${exe}"
  cexec --user root "$SERVICE" grep -E '^(Uid|Gid|Groups):' "/proc/${pid:-0}/status" | sed 's/^/  /' || true
  local cfg
  cfg="$(cexec --user root "$SERVICE" curl -sS -m 5 http://localhost:8080/api/config || true)"
  echo "  /api/config: ${cfg}"
  cexec --user root "$SERVICE" stat -c '  %U:%G %a %n' /usr/local/lib/agent-console "$UNIFIED_ENTRY" "${UNIFIED_ENTRY}.map"
  cexec --user root "$SERVICE" cat "${DEPLOY_TARGET}/.deploy-sha" | sed 's/^/  .deploy-sha: /'
  echo "  --- journal digest (last 80 lines, filtered) ---"
  cexec --user root "$SERVICE" journalctl -u "$UNIT" --no-pager -n 80 2>/dev/null \
    | grep -E 'Server starting|User mode initialized|Server listening|EMBEDDED_AGENT|"level":(40|50)' | cut -c1-200 | sed 's/^/  /' || true
  step_end post_deploy
}

# --- 7b. the #1688 drift arm ----------------------------------------------

drift_arm() {
  step_start "7b. #1688 drift arm: remove one template key from the live unit -> deploy refuses BEFORE restart -> setup --force re-renders -> deploy passes"
  local unit_file="/etc/systemd/system/${UNIT}.service"
  local ts_before ts_after env_now rc out
  ts_before="$(cexec --user root "$SERVICE" systemctl show -p ActiveEnterTimestampMonotonic --value "$UNIT" | tr -d '\r')"
  echo "  ActiveEnterTimestampMonotonic before the arm: ${ts_before}"

  # Inject the drift: delete ONE template `Environment=` line from the live
  # unit FILE and daemon-reload. Recorded here because the AC offered a
  # drop-in as the alternative and it does not work for this purpose: a
  # drop-in cannot unset one key visibly to `systemctl show -p Environment`
  # -- `UnsetEnvironment=` is applied at exec time and leaves the Environment
  # property (what V1 reads, drop-ins merged) unchanged, and an empty
  # `Environment=` in a drop-in resets EVERY key, not one. Editing the unit
  # file is also the shape #1688 found on the dogfood host (a unit rendered
  # before the key existed), just produced by subtraction instead of age.
  cexec --user root "$SERVICE" sh -c "sed -i '/^Environment=EMBEDDED_AGENT_ENTRY_PATH=/d' '${unit_file}' && systemctl daemon-reload"
  env_now="$(cexec --user root "$SERVICE" systemctl show -p Environment --value "$UNIT" | tr -d '\r')"
  rc=0
  case " ${env_now} " in *" EMBEDDED_AGENT_ENTRY_PATH="*) rc=1 ;; esac
  check "drift injected: EMBEDDED_AGENT_ENTRY_PATH absent from 'systemctl show -p Environment' after sed + daemon-reload" "$rc"
  expect "drift injected: the unit is still active (daemon-reload restarts nothing)" test "$(cexec --user root "$SERVICE" systemctl is-active "$UNIT" | tr -d '\r')" = "active"

  # Deploy #2 as the operator: must stop on V1 BEFORE the restart.
  echo "  --- deploy #2 (expect: V1 FAIL, exit 1, no restart) ---"
  out="$(mktemp)"
  rc=0
  cexec --user deployer -w "$SRC" "$SERVICE" bash scripts/update-and-deploy-for-multiuser-ubuntu.sh >"$out" 2>&1 || rc=$?
  grep -E '^  (PASS|FAIL|SKIP)  V[0-6] |^        |^  RESULT: |^Error: |^==> (systemctl restart|Done)' "$out" | cut -c1-220 | sed 's/^/  /' || true
  expect "drift: deploy #2 exits 1 (V1 FAIL, the worst code)" test "$rc" -eq 1
  expect "drift: V0 PASSes before V1's FAIL -- unaffected by the drift" grep -q '^  PASS  V0 data-root-ownership$' "$out"
  expect "drift: V1 FAIL line names EMBEDDED_AGENT_ENTRY_PATH" grep -q '^  FAIL  V1 unit-env-drift: .*EMBEDDED_AGENT_ENTRY_PATH' "$out"
  expect "drift: the canonical remedy (setup --dry-run then --force) is named" grep -q 'setup-multiuser-for-ubuntu.sh --dry-run' "$out"
  expect "drift: the bridge remedy (a .service.d drop-in) is named" grep -q 'service.d/\*.conf drop-in' "$out"
  expect "drift: the refusal names the single-writer rule (this script never renders the unit)" grep -q 'never renders the unit' "$out"
  local restarted=0
  grep -q '==> systemctl restart' "$out" && restarted=1
  check "drift: no '==> systemctl restart' line -- the deploy stopped before the restart" "$restarted"
  local v_after_v1=0
  grep -qE '^  (PASS|FAIL|SKIP)  V[2-6] ' "$out" && v_after_v1=1
  check "drift: no V2-V6 line -- nothing after V1 ran" "$v_after_v1"
  ts_after="$(cexec --user root "$SERVICE" systemctl show -p ActiveEnterTimestampMonotonic --value "$UNIT" | tr -d '\r')"
  echo "  ActiveEnterTimestampMonotonic after deploy #2: ${ts_after}"
  expect "drift: ActiveEnterTimestampMonotonic unchanged (${ts_before}) -- the unit was NOT restarted" test "$ts_after" = "$ts_before"
  expect "drift: the unit is still active after the refused deploy" test "$(cexec --user root "$SERVICE" systemctl is-active "$UNIT" | tr -d '\r')" = "active"
  rm -f "$out"

  # The canonical remedy V1 names: setup --force (same flags as section 4b)
  # re-renders the unit -- the setup script is its single writer.
  echo "  --- setup --force (the remedy V1 named) ---"
  out="$(mktemp)"
  rc=0
  cexec --user root -w /src "$SERVICE" bash scripts/setup-multiuser-for-ubuntu.sh --force --repo-source /src --add-user alice --add-user deployer >"$out" 2>&1 || rc=$?
  grep -E 'Step 7|Step 8|install -m 0644|already up to date|differs|daemon-reload|enable' "$out" | sed 's/^/  setup: /' || true
  check "drift: setup --force exits 0" "$rc"
  rm -f "$out"
  env_now="$(cexec --user root "$SERVICE" systemctl show -p Environment --value "$UNIT" | tr -d '\r')"
  rc=1
  case " ${env_now} " in *" EMBEDDED_AGENT_ENTRY_PATH="*) rc=0 ;; esac
  check "drift: EMBEDDED_AGENT_ENTRY_PATH present again in 'systemctl show -p Environment' (the unit was re-rendered)" "$rc"

  # Deploy #3: the ordinary path again, exit 0 with the seven PASS lines.
  echo "  --- deploy #3 (expect: exit 0, seven PASS lines) ---"
  out="$(mktemp)"
  rc=0
  cexec --user deployer -w "$SRC" "$SERVICE" bash scripts/update-and-deploy-for-multiuser-ubuntu.sh >"$out" 2>&1 || rc=$?
  grep -E '^  (PASS|FAIL|SKIP)  V[0-6] |^        (WARN|INFO): |^  RESULT: ' "$out" | cut -c1-220 | sed 's/^/  /' || true
  check "drift: deploy #3 exits 0" "$rc"
  assert_seven_pass "$out" "drift: deploy #3"
  ts_after="$(cexec --user root "$SERVICE" systemctl show -p ActiveEnterTimestampMonotonic --value "$UNIT" | tr -d '\r')"
  expect "drift: deploy #3 DID restart the unit (ActiveEnterTimestampMonotonic moved past ${ts_before})" test "$ts_after" != "$ts_before"
  rm -f "$out"
  step_end drift_arm
}

# --- 7c. the #1754 ownership-polarity arm ----------------------------------

ownership_polarity_arm() {
  step_start "7c. #1754 ownership-polarity arm: synthesize repositories/<org>/<repo>/worktrees -> misown the org dir -> deploy refuses BEFORE restart -> re-own -> deploy passes on a NON-EMPTY walked tree"
  # This driver creates no worktree of its own (the AC's "the org dir of the
  # worktree section 7 created" referred to scripts/verify-multiuser-docker.sh's
  # tier-2 section 7 -- a different container/stack; Architect-confirmed
  # correction), so 7c synthesizes its own tree directly.
  local org="wt-issue-1754" repo="repo"
  local org_dir="${DATA_ROOT}/repositories/${org}"
  local worktrees_dir="${org_dir}/${repo}/worktrees"
  local templates_dir="${org_dir}/${repo}/templates"
  local rc out probe_out

  cexec --user root "$SERVICE" install -d -m 2775 -o agentconsole -g agent-console-users \
    "${DATA_ROOT}/repositories" "$org_dir" "${org_dir}/${repo}" "$worktrees_dir"
  cexec --user root "$SERVICE" chown -R agentconsole:agent-console-users "$org_dir"

  # Positive control (Architect addition): a clean, correctly-owned
  # synthesized tree PASSes V0 (OWNERSHIP_OK) BEFORE any injection -- proven
  # via a direct helper probe (V0's own contract, not the deploy script's
  # sequencing, is what this proves), matching R5's unprivileged find (no
  # elevation prefix).
  probe_out="$(mktemp)"
  rc=0
  cexec --user deployer -w "$SRC" "$SERVICE" bash "$HELPER" data-root-ownership "$DATA_ROOT" agentconsole find >"$probe_out" 2>&1 || rc=$?
  local control_marker
  control_marker="$(head -n 1 "$probe_out" | tr -d '\r')"
  echo "  positive control: rc=${rc} marker=${control_marker}"
  expect "7c: positive control -- a clean synthesized tree PASSes V0 (OWNERSHIP_OK) before any injection" test "$rc" -eq 0 -a "$control_marker" = "OWNERSHIP_OK"
  rm -f "$probe_out"

  # The non-walked control: created once, left mis-owned through deploy #5.
  cexec --user root "$SERVICE" install -d -m 0755 "$templates_dir"
  cexec --user root "$SERVICE" chown deployer "$templates_dir"

  # Inject: misown the org dir itself (a walked position), non-recursive --
  # its children (repo/worktrees, still agentconsole-owned; templates_dir,
  # already deployer-owned above) are untouched by this single chown,
  # matching the restoration below.
  cexec --user root "$SERVICE" chown deployer "$org_dir"

  echo "  --- deploy #4 (expect: V0 FAIL naming ${org_dir}, exit 1, no restart) ---"
  out="$(mktemp)"
  rc=0
  cexec --user deployer -w "$SRC" "$SERVICE" bash scripts/update-and-deploy-for-multiuser-ubuntu.sh >"$out" 2>&1 || rc=$?
  grep -E '^  (PASS|FAIL|SKIP)  V[0-6] |^        |^  RESULT: |^Error: |^==> (systemctl restart|Done)' "$out" | cut -c1-220 | sed 's/^/  /' || true
  expect "7c: deploy #4 exits 1 (V0 FAIL, the worst code)" test "$rc" -eq 1
  expect "7c: V0 FAIL line names ${org_dir}" grep -qF "FAIL  V0 data-root-ownership: 1 walked directory(ies) under ${DATA_ROOT} not owned by agentconsole: ${org_dir}" "$out"
  expect "7c: the chown remedy line names ${org_dir}" grep -qF "chown -- agentconsole:agent-console-users ${org_dir}" "$out"
  local restarted=0
  grep -q '==> systemctl restart' "$out" && restarted=1
  check "7c: no '==> systemctl restart' line -- the deploy stopped before the restart" "$restarted"
  local v_after_v0=0
  grep -qE '^  (PASS|FAIL|SKIP)  V[1-6] ' "$out" && v_after_v0=1
  check "7c: no V1-V6 line -- nothing after V0 ran" "$v_after_v0"
  rm -f "$out"

  # Restore: the same non-recursive chown, so templates_dir (still
  # deployer-owned) is untouched.
  cexec --user root "$SERVICE" chown agentconsole:agent-console-users "$org_dir"

  echo "  --- deploy #5 (expect: exit 0, seven PASS lines) ---"
  out="$(mktemp)"
  rc=0
  cexec --user deployer -w "$SRC" "$SERVICE" bash scripts/update-and-deploy-for-multiuser-ubuntu.sh >"$out" 2>&1 || rc=$?
  grep -E '^  (PASS|FAIL|SKIP)  V[0-6] |^        (WARN|INFO): |^  RESULT: ' "$out" | cut -c1-220 | sed 's/^/  /' || true
  check "7c: deploy #5 exits 0" "$rc"
  assert_seven_pass "$out" "7c: deploy #5"
  expect "7c: V0's INFO line names the non-walked control as ignored" grep -qF "INFO: ignored (not walked): ${templates_dir}" "$out"
  rm -f "$out"

  # Marker confirmation (Architect addition): the tree stays non-empty, so
  # V0's PASS on deploy #5 is OWNERSHIP_OK, never OWNERSHIP_NO_TREES.
  probe_out="$(mktemp)"
  rc=0
  cexec --user deployer -w "$SRC" "$SERVICE" bash "$HELPER" data-root-ownership "$DATA_ROOT" agentconsole find >"$probe_out" 2>&1 || rc=$?
  local final_marker
  final_marker="$(head -n 1 "$probe_out" | tr -d '\r')"
  echo "  post-#5 probe: rc=${rc} marker=${final_marker}"
  expect "7c: post-#5 marker is OWNERSHIP_OK, not OWNERSHIP_NO_TREES (the tree stays)" test "$rc" -eq 0 -a "$final_marker" = "OWNERSHIP_OK"
  rm -f "$probe_out"

  # The non-walked control is STILL mis-owned -- nobody auto-fixed it.
  local templates_owner
  templates_owner="$(cexec --user root "$SERVICE" stat -c %U "$templates_dir" | tr -d '\r')"
  expect "7c: the non-walked control is still owned by deployer (nobody auto-fixed it)" test "$templates_owner" = "deployer"

  step_end ownership_polarity
}

# --- 7d. the #1762 restart-survival arm ------------------------------------

# Seeds one session plus its three FK dependents ([workers] is exercised
# elsewhere; the ones the boot-time saveAll() cascade-deleted before #1762)
# directly against the real data.db, restarts the unit through the shipping
# deploy path, then reads the same rows back. `bun -e` + bun:sqlite is the
# in-container DB tool (no sqlite3 CLI assumed).
#
# The seeded session is a `quick` session whose location_path is DATA_ROOT
# itself (guaranteed to exist in the container, and a quick session's
# recovery-state resolution never depends on data_scope/data_scope_slug --
# both are left NULL) so that SessionInitializationService.initializeSessions()
# takes the ordinary "path exists" branch into sessionsToSave, not the
# orphan-deletion branch. That is asserted explicitly, as a positive control,
# BEFORE the dependent-row assertions below -- a session lost to the orphan
# path would trivially fail the dependents too, for the wrong reason.
restart_survival_arm() {
  step_start "7d. #1762 restart-survival arm: designation + pending notification survive a real restart through the shipping saveAll() path"
  local seed_ts="2020-01-01T00:00:00.000Z"
  local seed_js read_js seed_out read_out rc

  seed_js='import { Database } from "bun:sqlite";
const db = new Database("/var/lib/agent-console/data.db");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA foreign_keys = ON");
db.query("INSERT INTO sessions (id, type, location_path, server_pid, created_at, updated_at, data_scope, data_scope_slug, paused_at, recovery_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("issue1762-session", "quick", "/var/lib/agent-console", null, "'"${seed_ts}"'", "'"${seed_ts}"'", null, null, null, "healthy");
db.query("INSERT INTO repositories (id, name, path) VALUES (?, ?, ?)").run("issue1762-repo", "issue1762-repo", "/tmp/issue1762-repo");
db.query("INSERT INTO repository_orchestrator_sessions (repository_id, session_id) VALUES (?, ?)").run("issue1762-repo", "issue1762-session");
db.query("INSERT INTO inbound_event_notifications (id, job_id, session_id, worker_id, handler_id, event_type, event_summary, status, created_at, notified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("issue1762-notif", "issue1762-job", "issue1762-session", "issue1762-worker", "issue1762-handler", "ci:completed", "tier3 7d seed", "pending", "'"${seed_ts}"'", null);
console.log("SEEDED");'

  seed_out="$(mktemp)"
  rc=0
  cexec --user agentconsole "$SERVICE" bun -e "$seed_js" >"$seed_out" 2>&1 || rc=$?
  cat "$seed_out" | sed 's/^/  seed: /'
  expect "7d: seed script exits 0 and prints SEEDED" bash -c "[ $rc -eq 0 ] && grep -q SEEDED '$seed_out'"
  rm -f "$seed_out"

  echo "  --- deploy #6 (the shipping restart path) ---"
  local out
  out="$(mktemp)"
  rc=0
  cexec --user deployer -w "$SRC" "$SERVICE" bash scripts/update-and-deploy-for-multiuser-ubuntu.sh >"$out" 2>&1 || rc=$?
  grep -E '^  (PASS|FAIL|SKIP)  V[0-6] |^        (WARN|INFO): |^  RESULT: ' "$out" | cut -c1-220 | sed 's/^/  /' || true
  check "7d: deploy #6 exits 0" "$rc"
  assert_seven_pass "$out" "7d: deploy #6"
  rm -f "$out"

  read_js='import { Database } from "bun:sqlite";
const db = new Database("/var/lib/agent-console/data.db");
const session = db.query("SELECT created_at, updated_at FROM sessions WHERE id = ?").get("issue1762-session");
if (!session) { console.log("SESSION_MISSING"); process.exit(0); }
console.log("SESSION_PRESENT created_at=" + session.created_at + " updated_at=" + session.updated_at);
const designation = db.query("SELECT COUNT(*) as n FROM repository_orchestrator_sessions WHERE repository_id = ? AND session_id = ?").get("issue1762-repo", "issue1762-session");
console.log("DESIGNATION_COUNT=" + designation.n);
const notif = db.query("SELECT status FROM inbound_event_notifications WHERE id = ?").get("issue1762-notif");
console.log("NOTIFICATION_STATUS=" + (notif ? notif.status : "MISSING"));'

  read_out="$(mktemp)"
  rc=0
  cexec --user agentconsole "$SERVICE" bun -e "$read_js" >"$read_out" 2>&1 || rc=$?
  cat "$read_out" | sed 's/^/  read-back: /'
  check "7d: read-back script exits 0" "$rc"

  # Positive control FIRST: the seeded session must still be present (not
  # swept into the orphan-deletion path) before the dependent-row
  # assertions below can mean anything.
  expect "7d: the seeded session is still present after the restart (not classified as an orphan)" grep -q '^SESSION_PRESENT ' "$read_out"
  expect "7d: session created_at is unchanged (${seed_ts})" grep -qF "created_at=${seed_ts}" "$read_out"
  expect "7d: session updated_at moved past the seed value (boot-time upsert touched it)" bash -c "grep -q '^SESSION_PRESENT ' '$read_out' && ! grep -qF 'updated_at=${seed_ts}' '$read_out'"

  # The polarity-bearing assertions: these are exactly what the pre-#1762
  # DELETE-all saveAll() cascades away, even though the session row above
  # survives either way (it is re-inserted with the same createdAt either
  # way -- only the OTHER tables' rows are the ones the cascade destroys).
  expect "7d: repository_orchestrator_sessions designation still exists (DESIGNATION_COUNT=1)" grep -qF 'DESIGNATION_COUNT=1' "$read_out"
  expect "7d: inbound_event_notifications row still exists with status=pending" grep -qF 'NOTIFICATION_STATUS=pending' "$read_out"
  rm -f "$read_out"

  step_end restart_survival
}

# --- 8. the three #1690 helper cases ---------------------------------------

helper_cases() {
  step_start "8. #1690 readability-gate helper cases (explicit)"
  local err rc
  err="$(mktemp)"

  # (1) elevated (non-root caller + the elevation prefix) against the real
  #     bundle -> READABLE, exit 0, no stderr.
  rc=0
  cexec --user deployer -w "$SRC" "$SERVICE" bash "$HELPER" assert-readable-by-unprivileged-user "$UNIFIED_ENTRY" "tier-3 case 1" "$AC_TIER3_ELEVATE" 2>"$err" || rc=$?
  echo "  case 1 (deployer + elevation prefix, real bundle): exit=${rc} stderr='$(tr -d '\r' <"$err" | head -c 300)'"
  expect "#1690 case 1: elevated against the real bundle -> READABLE (exit 0, no stderr)" test "$rc" -eq 0 -a ! -s "$err"
  rc=0
  cexec --user deployer -w "$SRC" "$SERVICE" bash "$HELPER" assert-readable-by-unprivileged-user "${UNIFIED_ENTRY}.map" "tier-3 case 1 (map)" "$AC_TIER3_ELEVATE" 2>"$err" || rc=$?
  expect "#1690 case 1: elevated against the real .map -> READABLE (exit 0, no stderr)" test "$rc" -eq 0 -a ! -s "$err"

  # (2) the same call against a chmod 000 copy -> UNREADABLE, exit 1, and
  #     the diagnostic names the unprivileged-user cause -- not the
  #     "probe could not run" cause, which is what separates a real
  #     permission verdict from a broken elevation (the #1690 defect shape).
  cexec --user root "$SERVICE" sh -c 'install -d -m 0755 /tmp/tier3-unreadable && install -m 0000 /usr/local/lib/agent-console/embedded-agent.js /tmp/tier3-unreadable/embedded-agent.js && stat -c "%U:%G %a %n" /tmp/tier3-unreadable/embedded-agent.js' | sed 's/^/  chmod 000 copy: /'
  rc=0
  cexec --user deployer -w "$SRC" "$SERVICE" bash "$HELPER" assert-readable-by-unprivileged-user /tmp/tier3-unreadable/embedded-agent.js "tier-3 case 2" "$AC_TIER3_ELEVATE" 2>"$err" || rc=$?
  echo "  case 2 (deployer + elevation prefix, chmod 000 copy): exit=${rc} stderr='$(tr -d '\r' <"$err" | head -c 300)'"
  local c2=0
  { [ "$rc" -eq 1 ] && grep -q 'is not readable by an unprivileged user' "$err" && ! grep -q 'could not run' "$err"; } || c2=$?
  check "#1690 case 2: chmod 000 copy -> UNREADABLE (exit 1, permission diagnostic, not 'could not run')" "$c2"

  # (3) root with an EMPTY prefix against the real bundle -> pass (the
  #     deploy-as-root invocation's shape, measured in Task 0).
  rc=0
  cexec --user root -w "$SRC" "$SERVICE" bash "$HELPER" assert-readable-by-unprivileged-user "$UNIFIED_ENTRY" "tier-3 case 3" 2>"$err" || rc=$?
  echo "  case 3 (root, empty prefix, real bundle): exit=${rc} stderr='$(tr -d '\r' <"$err" | head -c 300)'"
  expect "#1690 case 3: root with an empty prefix against the real bundle -> pass (exit 0, no stderr)" test "$rc" -eq 0 -a ! -s "$err"

  rm -f "$err"
  step_end helper_cases
}

# --- 9. the elevation smoke ------------------------------------------------

run_smoke_expect_pass() { # run_smoke_expect_pass <label> <user> <expect-line> [-e KEY=VAL ...]
  local label="$1" user="$2" expect_line="$3"
  shift 3
  local out err rc=0
  out="$(mktemp)"; err="$(mktemp)"
  echo "  --- ${label} ---"
  echo "  \$ compose exec -T --user ${user} -w ${SRC} $* ${SERVICE} bun ${SMOKE} alice"
  cexec --user "$user" -w "$SRC" "$@" "$SERVICE" bun "$SMOKE" alice >"$out" 2>"$err" || rc=$?
  if [ "$rc" -eq 2 ]; then
    echo "  exit=2 (could not run: bad usage / probe-launch failure / unmet precondition) -- reported as FAIL, never skipped"
  else
    echo "  exit=${rc}"
  fi
  grep -E 'OK    live|PASSED:|skipped:|spawnAsUser target' "$out" | sed 's/^/  /' || true
  if [ "$rc" -ne 0 ]; then
    echo "  ---- DIAGNOSTIC: stderr (last 30 lines) ----"; tail -n 30 "$err" | sed 's/^/    /'
    echo "  ---- DIAGNOSTIC: stdout (last 30 lines) ----"; tail -n 30 "$out" | sed 's/^/    /'
  fi
  local ok=0
  { [ "$rc" -eq 0 ] && grep -q "$expect_line" "$out"; } || ok=$?
  check "${label}: exit 0 and '${expect_line}'" "$ok"
  rm -f "$out" "$err"
}

run_smokes() {
  step_start "9a. smoke, right identity (User+Group) -> expect exit 0, Assertion 2 OK"
  cexec --user agentconsole:agent-console-users "$SERVICE" id | sed 's/^/  id: /'
  run_smoke_expect_pass "smoke (i) User+Group" agentconsole:agent-console-users \
    'OK    live agent-console.service process executes the configured EMBEDDED_AGENT_BUN_PATH' \
    -e EMBEDDED_AGENT_BUN_PATH="$UNIFIED_BUN"
  step_end smoke_right_identity

  step_start "9b. smoke, WRONG primary gid (User only) -> expect exactly exit 2 naming User= and Group=, no FAIL line (polarity)"
  # `--user agentconsole` alone gives primary gid = agentconsole's own group
  # with the shared group only supplementary -- the exact runner-fact #1688
  # measured on the dogfood host, and it comes for free from the exec shape.
  cexec --user agentconsole "$SERVICE" id | sed 's/^/  id: /'
  local out err rc=0
  out="$(mktemp)"; err="$(mktemp)"
  cexec --user agentconsole -w "$SRC" -e EMBEDDED_AGENT_BUN_PATH="$UNIFIED_BUN" "$SERVICE" bun "$SMOKE" alice >"$out" 2>"$err" || rc=$?
  echo "  exit=${rc}"
  tail -n 5 "$err" | cut -c1-300 | sed 's/^/  stderr: /'
  expect "smoke (ii) wrong gid: exit is exactly 2" test "$rc" -eq 2
  expect "smoke (ii) wrong gid: stderr names User= and Group=" grep -q "matching BOTH the unit's configured User= and Group=" "$err"
  local fail_line=0
  grep -q 'FAIL' "$out" "$err" && fail_line=1
  check "smoke (ii) wrong gid: no FAIL line (a permission gap, not a binaries-differ verdict)" "$fail_line"
  rm -f "$out" "$err"
  step_end smoke_wrong_gid

  step_start "9c. smoke, right identity + EMBEDDED_AGENT_ENTRY_PATH (#1668 cross-user pair) -> expect exit 0"
  run_smoke_expect_pass "smoke (iii) User+Group + ENTRY_PATH" agentconsole:agent-console-users \
    'OK    the real elevated subprocess was spawned with the configured EMBEDDED_AGENT_ENTRY_PATH' \
    -e EMBEDDED_AGENT_BUN_PATH="$UNIFIED_BUN" -e EMBEDDED_AGENT_ENTRY_PATH="$UNIFIED_ENTRY"
  step_end smoke_entry_path
}

# --- 10. footprint, summary, teardown --------------------------------------

footprint() {
  step_start "10. writable-layer footprint (the per-run number; the image itself bakes no app)"
  cexec --user root "$SERVICE" sh -c "df -h / | tail -1; du -sh ${DEPLOY_TARGET} /var/lib/agent-console 2>/dev/null" | sed 's/^/  /' || true
  echo "  --- failed units at the end (expect none) ---"
  cexec --user root "$SERVICE" systemctl --failed --no-pager --no-legend | sed 's/^/  /' || true
  step_end footprint
}

cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    echo "[info] --keep set; container agent-console-systemd-verify left running"
  else
    echo "[info] tearing down the stack (compose down)"
    local t0; t0=$(date +%s)
    compose down --remove-orphans >/dev/null 2>&1 || true
    echo "STEP teardown $(( $(date +%s) - t0 ))s"
  fi
}

main() {
  for arg in "$@"; do
    case "$arg" in
      --keep) KEEP=1 ;;
      --no-build) BUILD=0 ;;
      -h|--help) usage; exit 0 ;;
      *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
  done

  gate
  preflight
  # Everything from here on touches docker; the trap is armed only now so a
  # gate / preflight refusal never runs `compose down` against a stack it
  # did not start.
  trap cleanup EXIT
  local run_t0; run_t0=$(date +%s)

  host_facts
  build_image
  boot_container
  run_setup
  copy_source
  run_deploy
  post_deploy_checks
  drift_arm
  ownership_polarity_arm
  restart_survival_arm
  helper_cases
  run_smokes
  footprint

  echo
  echo "=================================================="
  echo "  tier-3 stack summary (runner-only measurement)"
  printf '%s' "$SUMMARY"
  echo "  NOT EXERCISED: setup step 6b + the smoke's freshness check (image pins bun at ${UNIFIED_BUN})"
  echo "  RESULT: ${PASS} passed, ${FAIL} failed, $(( $(date +%s) - run_t0 ))s"
  echo "=================================================="
  [ "$FAIL" -eq 0 ]
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
