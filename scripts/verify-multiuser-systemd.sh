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
#  CI=true or AC_TIER3_HOST_OK=1 is set (Discipline 4 of
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
#   (seccomp = Docker's default profile; no other capability; NO --privileged)
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
#   0. gate (CI=true | AC_TIER3_HOST_OK=1) and the rules-file preflight
#   1. host facts: docker info (security options, cgroup version), kernel
#   2. docker compose build (docker/Dockerfile.systemd, no app baked)
#   3. boot + assertion (is-system-running, /proc/1/comm, failed units)
#   4. setup --dry-run then --force, as root (--repo-source /src,
#      --add-user alice --add-user deployer); step 6b's skip is logged as
#      NOT EXERCISED (the image pins bun at the unified path)
#   5. cp -a /src -> the shared source-repos dir, as the service user
#   6. update-and-deploy-for-multiuser-ubuntu.sh as `deployer` (uid != 0, so
#      the script's own per-step self-elevation is what runs)
#   7. is-active, MainPID/User/Group/ExecStart, /proc/<MainPID>/exe read AS
#      the unit's User+Group (root in-container lacks CAP_SYS_PTRACE and
#      cannot read another uid's exe link -- Task 0's root readlink printed
#      nothing), /api/config authMode, journal digest
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
# NO drift arm here (Issue #1688 lands with Issue (b) of the note).
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
  if [ "${CI:-}" = "true" ] || [ "${AC_TIER3_HOST_OK:-}" = "1" ]; then
    return 0
  fi
  cat >&2 <<'EOF'
verify-multiuser-systemd.sh: REFUSING TO RUN on this host.

  Tier 3 boots systemd as PID 1 with CAP_SYS_ADMIN, the host cgroup namespace,
  a writable host cgroup tree and an AppArmor opt-out -- root-equivalent on
  the host that lends them. Discipline 4 (verification tiers for
  elevation-coupled code; docs/design/elevation-verification-tiers.md, "The
  rule: never on the dogfood host") therefore confines tier 3 to ephemeral CI
  runners and personal workstations, and this gate makes that mechanical:
  the driver runs only when CI=true (a GitHub runner) or AC_TIER3_HOST_OK=1
  (set by hand, on a workstation whose only user is its owner). Neither is
  set here. A delegate drives tier 3 by pushing a branch that
  .github/workflows/verify-multiuser-systemd.yml picks up, never by running
  this script on the dogfood host.
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
  echo "  boot set: CAP_SYS_ADMIN + host cgroupns + rw /sys/fs/cgroup + tmpfs /run,/run/lock + container=docker + apparmor=unconfined (seccomp default, no --privileged) -- see ${COMPOSE_FILE#"$REPO_ROOT"/}"
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
  echo "  (the unit is expected to crash-loop here until the first deploy: dist/index.js does not exist yet -- Issue (d) of the note, not this stack's concern)"
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

run_deploy() {
  step_start "6. update-and-deploy-for-multiuser-ubuntu.sh as deployer (uid != 0: per-step self-elevation)"
  cexec --user deployer "$SERVICE" id | sed 's/^/  id: /'
  local out rc=0
  out="$(mktemp)"
  cexec --user deployer -w "$SRC" "$SERVICE" bash scripts/update-and-deploy-for-multiuser-ubuntu.sh 2>&1 | tee "$out" || rc=${PIPESTATUS[0]}
  check "deploy script as deployer exits 0" "$rc"
  # The shipping-path form of #1690 case (1): the script's own readability
  # gate ran with a NON-EMPTY elevation prefix (the caller is not root) and
  # returned READABLE, or the script would have exited 1 before the restart.
  rc=0
  { grep -q '==> fail-closed check: unified entry path is readable' "$out" \
    && grep -q '==> systemctl restart' "$out"; } || rc=$?
  check "deploy's own #1690 gate ran as a non-root caller and reached the restart (shipping-path form of case 1)" "$rc"
  rc=0
  { grep -q "/api/auth/me OK" "$out" && grep -q '==> Done.' "$out"; } || rc=$?
  check "deploy's health probe printed OK and the script printed Done." "$rc"
  rm -f "$out"
  step_end deploy_as_deployer
}

# --- 7. post-deploy checks -------------------------------------------------

post_deploy_checks() {
  step_start "7. unit active, MainPID identity, health, journal digest"
  local active pid
  active="$(cexec --user root "$SERVICE" systemctl is-active "$UNIT" | tr -d '\r' || true)"
  echo "  is-active=${active}"
  expect "systemctl is-active ${UNIT} = active" test "$active" = "active"
  cexec --user root "$SERVICE" systemctl show -p MainPID -p User -p Group -p ExecStart --no-pager "$UNIT" | sed 's/^/  /'
  cexec --user root "$SERVICE" systemctl show -p Environment --value "$UNIT" | tr ' ' '\n' | grep -E '^EMBEDDED_AGENT_' | sed 's/^/  Environment: /' || true
  pid="$(cexec --user root "$SERVICE" systemctl show -p MainPID --value "$UNIT" | tr -d '\r' || true)"
  echo "  MAINPID=${pid}"
  expect "MainPID > 0" test "${pid:-0}" -gt 0
  # Read AS the unit's own User+Group: /proc/<pid>/exe is PTRACE_MODE_READ
  # gated, and in-container root has no CAP_SYS_PTRACE (Task 0's root-side
  # readlink printed nothing). The matching uid+gid is exactly the identity
  # the smoke's Assertion 2 needs, and the mismatched-gid run below is its
  # polarity.
  local exe
  exe="$(cexec --user agentconsole:agent-console-users "$SERVICE" readlink -f "/proc/${pid}/exe" | tr -d '\r' || true)"
  echo "  /proc/${pid}/exe (read as agentconsole:agent-console-users) = ${exe}"
  expect "MainPID executes the unified bun ${UNIFIED_BUN}" test "$exe" = "$UNIFIED_BUN"
  cexec --user root "$SERVICE" grep -E '^(Uid|Gid|Groups):' "/proc/${pid}/status" | sed 's/^/  /' || true
  local cfg
  cfg="$(cexec --user root "$SERVICE" curl -sS -m 5 http://localhost:8080/api/config || true)"
  echo "  /api/config: ${cfg}"
  expect "/api/config reports authMode=multi-user" grep -q '"authMode":"multi-user"' <<<"$cfg"
  cexec --user root "$SERVICE" stat -c '  %U:%G %a %n' /usr/local/lib/agent-console "$UNIFIED_ENTRY" "${UNIFIED_ENTRY}.map"
  cexec --user root "$SERVICE" cat "${DEPLOY_TARGET}/.deploy-sha" | sed 's/^/  .deploy-sha: /'
  echo "  --- journal digest (last 80 lines, filtered) ---"
  local journal
  journal="$(cexec --user root "$SERVICE" journalctl -u "$UNIT" --no-pager -n 80 || true)"
  echo "$journal" | grep -E 'Server starting|User mode initialized|Server listening|EMBEDDED_AGENT|"level":(40|50)' | cut -c1-200 | sed 's/^/  /' || true
  expect "journal has 'Server listening'" grep -q 'Server listening' <<<"$journal"
  expect "journal has 'User mode initialized' with authMode multi-user" grep -q '"authMode":"multi-user".*User mode initialized' <<<"$journal"
  local bun_warn=0
  grep -q '"level":40.*EMBEDDED_AGENT_BUN_PATH' <<<"$journal" && bun_warn=1
  check "journal has NO EMBEDDED_AGENT_BUN_PATH warning (unit bun == embedded-agent bun)" "$bun_warn"
  step_end post_deploy
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
  helper_cases
  run_smokes
  footprint

  echo
  echo "=================================================="
  echo "  tier-3 stack summary (runner-only measurement)"
  printf '%s' "$SUMMARY"
  echo "  NOT EXERCISED: setup step 6b + the smoke's freshness check (image pins bun at ${UNIFIED_BUN})"
  echo "  NOT HERE: the #1688 drift arm (Issue (b) of the note)"
  echo "  RESULT: ${PASS} passed, ${FAIL} failed, $(( $(date +%s) - run_t0 ))s"
  echo "=================================================="
  [ "$FAIL" -eq 0 ]
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
