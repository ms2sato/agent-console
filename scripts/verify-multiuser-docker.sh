#!/usr/bin/env bash
#
# One-command verification of Agent Console multi-user mode on Docker/Linux.
#
# Builds and starts the verification container (docker/Dockerfile), then checks:
#   1. /api/config reports authMode=multi-user
#   2. a protected route returns 401 without authentication
#   3. login with a wrong password is rejected (401)  -> proves pamtester runs
#   4. alice / bob log in successfully (200)           -> proves pamtester auth
#   5. PTY identity isolation: alice's terminal whoami => alice,
#                              bob's   terminal whoami => bob
#      (not the agentconsole service user) -> proves sudo -u <user> isolation
#   6. file upload as alice creates /tmp/agent-console-uploads-<uid>/ with
#      mode 2750 (setgid + group-rx) -> proves ensureUploadDir() applies
#      setgid on the real Linux filesystem (Issue #830 follow-up regression
#      for the JS-layer mode stripping in Bun fs.mkdir / fs.chmod).
#   7. worktree creation via the API is owned by the requesting user, not
#      the service account, and `git status` inside it as that user does
#      not report dubious ownership -> proves `git worktree add` routes
#      through runAsUser (Issue #838).
#   8. (Release 2, Issue #1842) shared1 is registered as a shared account and
#      bound to the check-7 repository via the DB-backed routes; a shared
#      WORKTREE session on that repository spawns its terminal as the
#      shared account (shared1) rather than the creating user, the session
#      row's created_by/initiated_by columns route to shared1/alice
#      respectively, a second user (bob) can list and write into the shared
#      session, and a QUICK session with shared:true is unconditionally
#      refused (400) -> proves the Shared Account is a genuine cross-user
#      execution identity bound per repository, not a global env-var switch
#      (Issue #1619, re-verified against Release 2's DB-backed runtime).
#   9. worker-restart branch rename runs as the SESSION'S SPAWN USER, not
#      the requester: (i) restart-with-branch on alice's own worktree
#      session, as alice, renames the branch on disk as alice; (iii) the
#      same restart call on a SHARED worktree session (spawn user shared1),
#      made by alice over HTTP, renames the branch on disk as shared1 --
#      proving the fix threads the session's spawn user through, not the
#      requester's identity (Issue #1622).
#  11b. (Issue #2094, source-repo-storage-model.md section 10 item 8) bare
#      source repositories on the real host: a repository is cloned bare
#      through the real clone path (served over git:// from inside the
#      container, so the run stays offline) next to a non-bare control, and
#      the on-disk shape (refspec, origin/HEAD, group-write directories), a
#      SECOND user's (bob's) worktree creation into alice's bare repository,
#      the phase-3 behaviour (no main worktree, no session at the bare path)
#      and a negative control (group-write removed -> bob's creation must
#      not produce a worktree) are asserted, plus the upstream HEAD pin, the
#      bare directory's owner (alice) and a failed-clone retry arm (no partial
#      directory left, same name cloneable again). Numbered 11b so that nothing
#      else is renumbered.
#
# --smokes additionally runs eight real-host smoke scripts
# (scripts/smoke/*.ts) inside the verification container, as the service
# user (agentconsole), against target user alice, using the workspace copy
# docker/Dockerfile bakes at /workspace (the smokes import production
# modules from packages/server/src/**, so the runtime bundle alone cannot
# host them):
#   - check-multiuser-pty-env.ts
#   - check-kill-as-user.ts
#   - check-file-viewer-elevated-read.ts
#   - check-login-shell-sentinel.ts
#   - check-orphan-sweep.ts
#   - check-delegated-ssh-auth-sock.ts
#   - check-embedded-agent-elevation.ts (default arm, AGENT_CONSOLE_MCP_AUTH=enforce)
#   - check-embedded-agent-elevation.ts --auth-mode warn (polarity arm, Issue #1738)
#   - check-embedded-agent-elevation.ts --turn (ONLY with --elevation-turn; BILLABLE, Issue #1675)
#   - check-embedded-agent-bash-env.ts
#   - check-run-process-elevated-group-kill.ts (default arm + --expect-leak polarity arm, Issue #1953)
#
# Not run here, real-host only: a `claude` login inside the container and
# therefore every billable smoke; vendor credentials (e.g. Bedrock) in a
# shared account's home and a shared session completing a real turn on
# them; the 1Password-socket-present branch of
# check-delegated-ssh-auth-sock.ts (the container exercises the
# socket-ABSENT branch, which is the expected path there); and the
# systemd unit's own environment. A smoke's exit code 2 is reported as a
# failure, not a skip.
#
# Usage (from repo root):
#   scripts/verify-multiuser-docker.sh            # build + verify + tear down
#   scripts/verify-multiuser-docker.sh --keep     # leave the container running
#   scripts/verify-multiuser-docker.sh --no-build # reuse the existing image
#   scripts/verify-multiuser-docker.sh --smokes   # also run the real-host smokes inside the container
#   scripts/verify-multiuser-docker.sh --smokes --elevation-turn
#                                                 # ...plus ONE billed real provider turn as alice
#                                                 # (key store: $ELEVATION_TURN_KEY_FILE, default
#                                                 # ~/.agent-console-dev/provider-keys.json, piped in,
#                                                 # never baked into the image)
#
# Requires: docker, bun (both on the host).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.verification.yml"
PORT="${PORT:-8080}"
BASE_URL="http://localhost:${PORT}"
KEEP=0
BUILD_FLAG="--build"
SMOKES=0
# --elevation-turn (BILLABLE, requires --smokes): additionally runs
# check-embedded-agent-elevation.ts --turn, one real provider turn as alice.
# The key store is read from ELEVATION_TURN_KEY_FILE on the HOST and piped
# into a 0600 file inside the container for the duration of that one smoke;
# it is never baked into the image and is removed afterwards.
ELEVATION_TURN=0
ELEVATION_TURN_KEY_FILE="${ELEVATION_TURN_KEY_FILE:-$HOME/.agent-console-dev/provider-keys.json}"
# Extra `compose exec` arguments for run_smoke (e.g. -e NAME=value); empty by default.
RUN_SMOKE_EXEC_ENV=()

for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --no-build) BUILD_FLAG="" ;;
    --smokes) SMOKES=1 ;;
    --elevation-turn) ELEVATION_TURN=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ "$ELEVATION_TURN" -eq 1 ] && [ "$SMOKES" -ne 1 ]; then
  echo "--elevation-turn requires --smokes" >&2
  exit 2
fi
if [ "$ELEVATION_TURN" -eq 1 ] && [ ! -f "$ELEVATION_TURN_KEY_FILE" ]; then
  echo "--elevation-turn: provider key store not found at ELEVATION_TURN_KEY_FILE=${ELEVATION_TURN_KEY_FILE}" >&2
  exit 2
fi

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

# Check 11b serves a repository over git:// from inside the container with a
# detached `git daemon`. The daemon is stopped by the PID it recorded in its
# own pid file (never by a name match), at the end of the check and again from
# cleanup() so an early exit does not leave it running in a --keep'd container.
GITD_2094_PID_FILE="/tmp/git-daemon-2094.pid"
GITD_2094_STARTED=0
stop_gitd_2094() {
  [ "$GITD_2094_STARTED" -eq 1 ] || return 0
  compose exec -T --user root agent-console sh -c \
    "if [ -f '${GITD_2094_PID_FILE}' ]; then kill \"\$(cat '${GITD_2094_PID_FILE}')\"; rm -f '${GITD_2094_PID_FILE}'; fi" \
    >/dev/null 2>&1 || true
  GITD_2094_STARTED=0
}

# Temp files created by check 11b (cookie jars hold session cookies). Each path
# is appended right after its mktemp; cleanup() removes them on any exit.
S11B_TMPFILES=()

cleanup() {
  local s11b_tmp
  for s11b_tmp in ${S11B_TMPFILES[@]+"${S11B_TMPFILES[@]}"}; do
    rm -f "$s11b_tmp"
  done
  stop_gitd_2094
  if [ "$KEEP" -eq 1 ]; then
    echo "[info] --keep set; container left running at ${BASE_URL}"
  else
    echo "[info] tearing down container"
    compose down --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

PASS=0
FAIL=0
check() { # check <name> <condition-exit-code>
  if [ "$2" -eq 0 ]; then
    echo "  [PASS] $1"; PASS=$((PASS + 1))
  else
    echo "  [FAIL] $1"; FAIL=$((FAIL + 1))
  fi
}

run_smoke() { # run_smoke <label> <script> [args...]
  # Used only by --smokes (section 12). Runs one scripts/smoke/<script>.ts
  # inside the container as the service user, against the workspace copy
  # baked at /workspace, and folds its result into the same PASS/FAIL
  # counters check() uses.
  local label="$1" script="$2"
  shift 2
  local smoke_out smoke_err smoke_rc
  smoke_out="$(mktemp)"
  smoke_err="$(mktemp)"
  echo "  --- ${label} ---"
  echo "  \$ compose exec -T --user agentconsole -w /workspace agent-console bun scripts/smoke/${script} $*"
  compose exec -T --user agentconsole -w /workspace ${RUN_SMOKE_EXEC_ENV[@]+"${RUN_SMOKE_EXEC_ENV[@]}"} agent-console \
    bun "scripts/smoke/${script}" "$@" >"$smoke_out" 2>"$smoke_err"
  # Captured directly, no pipe precedes this: docker compose exec propagates
  # the inner process's real exit code.
  smoke_rc=$?
  if [ "$smoke_rc" -eq 2 ]; then
    echo "  exit=${smoke_rc} (could not run: bad usage / probe-launch failure / unmet precondition)"
  else
    echo "  exit=${smoke_rc}"
  fi
  # Exit code 2 (could not run) is still non-zero here, so check() reports
  # it as FAIL, never PASS and never a silent skip.
  check "$label" "$smoke_rc"
  # A billed smoke's assertion lines are its evidence: print them on PASS too
  # (opt-in per call via RUN_SMOKE_SHOW_STDOUT=1; the free smokes stay quiet).
  if [ "${RUN_SMOKE_SHOW_STDOUT:-0}" = "1" ] && [ -s "$smoke_out" ]; then
    echo "  ---- ${label} stdout (its own OK/FAIL/PASSED/FAILED lines, and the --turn reply) ----"
    grep -E '^  (OK|FAIL) |^(PASSED|FAILED):|^  --turn reply:|^==> --turn|^  degenerate:' "$smoke_out" | sed 's/^/    /'
  fi
  if [ "$smoke_rc" -ne 0 ]; then
    # Always keep stdout's tail (the smoke's own OK/FAIL assertion lines and
    # PASSED/FAILED summary) on failure -- a crash during the smoke's own
    # cleanup (e.g. a teardown race) can exit non-zero with an EMPTY or
    # misleading stderr while every assertion already ran; discarding stdout
    # unconditionally destroyed exactly that evidence (Issue #1845's own
    # investigation lost it this way). stderr's tail is still printed
    # alongside when non-empty, never in place of stdout's.
    if [ -s "$smoke_out" ]; then
      # Smoke scripts interleave pino's own (verbose, JSON) logging into the
      # same stdout stream as their own OK/FAIL/PASSED/FAILED lines -- a
      # plain tail can be entirely pino noise, crowding out exactly the
      # assertion-level evidence this diagnostic exists to keep. Print the
      # smoke's own summary lines in full first (never truncated: there are
      # at most a few dozen assertions per smoke), then the tail for
      # surrounding context.
      if grep -qE '^  (OK|FAIL) |^(PASSED|FAILED):' "$smoke_out"; then
        echo "  ---- DIAGNOSTIC: ${label} stdout (its own OK/FAIL/PASSED/FAILED lines) ----"
        grep -E '^  (OK|FAIL) |^(PASSED|FAILED):' "$smoke_out" | sed 's/^/    /'
      fi
      echo "  ---- DIAGNOSTIC: ${label} stdout (last 30 lines) ----"
      tail -n 30 "$smoke_out" | sed 's/^/    /'
    fi
    if [ -s "$smoke_err" ]; then
      echo "  ---- DIAGNOSTIC: ${label} stderr (last 30 lines) ----"
      tail -n 30 "$smoke_err" | sed 's/^/    /'
    fi
    echo "  -------------------------------------------------"
  fi
  # printf -v (not `x="$(printf ...)"`) so the trailing newline survives --
  # command substitution strips it, which previously collapsed every
  # smoke's summary line onto one line.
  local summary_line
  printf -v summary_line '  %-38s exit=%s\n' "$label" "$smoke_rc"
  SMOKE_SUMMARY="${SMOKE_SUMMARY}${summary_line}"
  rm -f "$smoke_out" "$smoke_err"
}

echo "=== Building and starting the multi-user verification container ==="
# shellcheck disable=SC2086
compose up $BUILD_FLAG -d || { echo "compose up failed" >&2; exit 1; }

echo "=== Waiting for the server to become healthy ==="
ready=1
for i in $(seq 1 40); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/config" 2>/dev/null || true)"
  if [ "$code" = "200" ]; then ready=0; break; fi
  sleep 1
done
if [ "$ready" -ne 0 ]; then
  echo "[error] server did not become ready; recent logs:" >&2
  compose logs --tail 60 || true
  exit 1
fi

echo
echo "=== 1. /api/config authMode ==="
config_json="$(curl -s "${BASE_URL}/api/config")"
echo "  $config_json"
echo "$config_json" | grep -q '"authMode":"multi-user"'
check "authMode is multi-user" $?

echo
echo "=== 2. protected route requires auth ==="
code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/sessions/does-not-exist")"
echo "  GET /api/sessions/does-not-exist (unauthenticated) -> HTTP ${code}"
[ "$code" = "401" ]
check "unauthenticated request returns 401" $?

echo
echo "=== 3. wrong password is rejected (pamtester is running) ==="
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE_URL}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"definitely-wrong"}')"
echo "  POST /api/auth/login alice:<wrong> -> HTTP ${code}"
[ "$code" = "401" ]
check "wrong password returns 401" $?

echo
echo "=== 4. correct credentials authenticate (pamtester + shadow group) ==="
for u in alice bob; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE_URL}/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"${u}\",\"password\":\"${u}-password\"}")"
  echo "  POST /api/auth/login ${u}:<correct> -> HTTP ${code}"
  [ "$code" = "200" ]
  check "${u} login returns 200" $?
done

echo
echo "=== 5. PTY identity isolation (whoami over the worker WebSocket) ==="
bun "${REPO_ROOT}/docker/verify-client.ts" "$BASE_URL" alice alice-password alice /home/alice
check "alice terminal runs as alice" $?
bun "${REPO_ROOT}/docker/verify-client.ts" "$BASE_URL" bob bob-password bob /home/bob
check "bob terminal runs as bob" $?

echo
echo "=== 6. file upload as alice creates upload dir with mode 2750 (#830 regression) ==="
# Login as alice, capture the auth cookie, create a session + worker, send a
# multipart message with a small file attachment, then inspect the upload
# directory's mode inside the container. Verifies the production
# ensureUploadDir() path under AUTH_MODE=multi-user against the real Linux
# filesystem — the path the unit suite cannot exercise because fs/promises
# is mocked to memfs in workers.test.ts.
COOKIE_JAR="$(mktemp)"
ALICE_RESP="$(mktemp)"
SESSION_RESP="$(mktemp)"
WORKER_RESP="$(mktemp)"
MESSAGE_RESP="$(mktemp)"
UPLOAD_PAYLOAD="$(mktemp)"
echo "alice upload payload" > "$UPLOAD_PAYLOAD"

curl -s -o "$ALICE_RESP" -c "$COOKIE_JAR" -X POST "${BASE_URL}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"alice-password"}'

# Create a Quick Session in alice's HOME so the route does not have to
# traverse anywhere with restrictive perms.
session_code="$(curl -s -o "$SESSION_RESP" -w '%{http_code}' -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
  -X POST "${BASE_URL}/api/sessions" \
  -H 'Content-Type: application/json' \
  -d '{"type":"quick","locationPath":"/home/alice"}')"
echo "  POST /api/sessions (quick, /home/alice) -> HTTP ${session_code}"
session_id="$(grep -o '"id":"[^"]*"' "$SESSION_RESP" | head -n1 | cut -d'"' -f4)"
session_ok=1
[ "$session_code" = "201" ] && [ -n "$session_id" ] && session_ok=0
check "alice can create a session" "$session_ok"

if [ -n "$session_id" ]; then
  worker_code="$(curl -s -o "$WORKER_RESP" -w '%{http_code}' -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
    -X POST "${BASE_URL}/api/sessions/${session_id}/workers" \
    -H 'Content-Type: application/json' \
    -d '{"type":"terminal"}')"
  echo "  POST /api/sessions/<id>/workers (terminal) -> HTTP ${worker_code}"
  worker_id="$(grep -o '"id":"[^"]*"' "$WORKER_RESP" | head -n1 | cut -d'"' -f4)"
  worker_ok=1
  [ "$worker_code" = "201" ] && [ -n "$worker_id" ] && worker_ok=0
  check "alice can create a worker" "$worker_ok"

  if [ -n "$worker_id" ]; then
    message_code="$(curl -s -o "$MESSAGE_RESP" -w '%{http_code}' -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
      -X POST "${BASE_URL}/api/sessions/${session_id}/messages" \
      -F "toWorkerId=${worker_id}" \
      -F "content=hello from upload regression" \
      -F "files=@${UPLOAD_PAYLOAD};filename=upload-probe.txt;type=text/plain")"
    echo "  POST /api/sessions/<id>/messages (multipart with file) -> HTTP ${message_code}"
    message_ok=1
    [ "$message_code" = "201" ] && message_ok=0
    check "multipart message with file upload returns 201" "$message_ok"
  fi
fi

# Inspect the upload directory's mode inside the container. The server runs
# as `agentconsole` (uid resolved at runtime) so look it up via docker exec.
SERVER_UID="$(compose exec -T agent-console id -u 2>/dev/null | tr -d '\r' || true)"
echo "  server uid in container: ${SERVER_UID}"
UPLOAD_DIR="/tmp/agent-console-uploads-${SERVER_UID}"
UPLOAD_STAT="$(compose exec -T agent-console stat -c '%a:%G' "$UPLOAD_DIR" 2>/dev/null | tr -d '\r' || echo MISSING)"
echo "  stat ${UPLOAD_DIR} -> ${UPLOAD_STAT}"
upload_ok=1
[ "$UPLOAD_STAT" = "2750:agent-console-users" ] && upload_ok=0
check "upload dir is mode 2750 owned by agent-console-users (#830 setgid regression)" "$upload_ok"

rm -f "$COOKIE_JAR" "$ALICE_RESP" "$SESSION_RESP" "$WORKER_RESP" "$MESSAGE_RESP" "$UPLOAD_PAYLOAD"

# Precondition for check 7 and the clone arms: the container must honour the
# setup-script contract for the data root's source-repos directory (pre-created
# 2775, group agent-console-users; the server never shapes it). Recorded BEFORE
# check 7's bootstrap runs, so a directory created later by a login shell's
# umask cannot be mistaken for the image's.
SOURCE_REPOS_DIR="/var/lib/agent-console/source-repos"
SOURCE_REPOS_STAT="$(compose exec -T agent-console stat -c '%a:%G' "$SOURCE_REPOS_DIR" 2>/dev/null | tr -d '\r' || echo MISSING)"
echo "  stat ${SOURCE_REPOS_DIR} -> ${SOURCE_REPOS_STAT}"
source_repos_ok=1
[ "$SOURCE_REPOS_STAT" = "2775:agent-console-users" ] && source_repos_ok=0
check "7pre: source-repos is pre-created mode 2775 owned by agent-console-users (precondition, setup-script contract)" "$source_repos_ok"

echo
echo "=== 7. worktree creation runs as the requesting user (#838) ==="
# Verifies the umbrella #837 / Issue #838 fix: in multi-user mode, the server
# routes `git worktree add` through `runAsUser` so the resulting worktree
# files are owned by the requesting user. Without this fix, a subsequent
# `git status` inside the worktree (running as the user) would hit
# `fatal: detected dubious ownership in repository`.
#
# Bootstrap a small source repo inside the container (owned by `agentconsole`,
# matching the documented multi-user source-repo ownership). The server
# bootstraps `safe.directory` for alice via `runAsUser` so git accepts the
# server-owned source repo from alice's elevated context.
SOURCE_REPO_PATH="/var/lib/agent-console/source-repos/wt-issue-838"
# Bootstrap a multi-user-ready source repo: owned by agentconsole but
# configured with `core.sharedRepository=group` and group-writable `.git`
# so members of `agent-console-users` (alice) can write refs / lock files
# during `git worktree add`. This mirrors the operational expectation for
# multi-user source repos -- the umbrella design assumes the repo is
# either user-owned (#834 clone-as-user) or group-writable; this PR's
# mitigation A (safe.directory bootstrap) handles the OWNERSHIP check but
# not WRITABILITY. Production operator setups should apply equivalent
# config when adding source repos to a multi-user install.
compose exec -T --user agentconsole agent-console sh -lc "
  set -e
  mkdir -p ${SOURCE_REPO_PATH}
  cd ${SOURCE_REPO_PATH}
  if [ ! -d .git ]; then
    git init -q -b main --shared=group
    git config user.email 'agentconsole@example.com'
    git config user.name 'agentconsole'
    echo hello > README.md
    git add README.md
    git commit -q -m 'initial commit'
  fi
  # Ensure setgid on every directory so files inherit the shared group.
  find .git -type d -exec chmod g+rwxs '{}' +
  chmod -R g+rw .git
" >/dev/null 2>&1
source_repo_ok=$?
check "source repo bootstrapped inside container (shared=group)" "$source_repo_ok"

ALICE_COOKIE_JAR="$(mktemp)"
ALICE_LOGIN_RESP="$(mktemp)"
REPO_RESP="$(mktemp)"
WT_TASK_RESP="$(mktemp)"
WT_LIST_RESP="$(mktemp)"
GIT_STATUS_OUT="$(mktemp)"

curl -s -o "$ALICE_LOGIN_RESP" -c "$ALICE_COOKIE_JAR" -X POST "${BASE_URL}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"alice-password"}' >/dev/null

# Register the source repo as alice.
repo_code="$(curl -s -o "$REPO_RESP" -w '%{http_code}' -b "$ALICE_COOKIE_JAR" -c "$ALICE_COOKIE_JAR" \
  -X POST "${BASE_URL}/api/repositories" \
  -H 'Content-Type: application/json' \
  -d "{\"path\":\"${SOURCE_REPO_PATH}\"}")"
echo "  POST /api/repositories (path=${SOURCE_REPO_PATH}) -> HTTP ${repo_code}"
repo_id="$(grep -o '"id":"[^"]*"' "$REPO_RESP" | head -n1 | cut -d'"' -f4)"
repo_ok=1
[ "$repo_code" = "201" ] && [ -n "$repo_id" ] && repo_ok=0
check "alice can register source repo" "$repo_ok"

if [ -n "$repo_id" ]; then
  # Create a worktree from `main` via the API.
  task_id="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)"
  wt_code="$(curl -s -o "$WT_TASK_RESP" -w '%{http_code}' -b "$ALICE_COOKIE_JAR" -c "$ALICE_COOKIE_JAR" \
    -X POST "${BASE_URL}/api/repositories/${repo_id}/worktrees" \
    -H 'Content-Type: application/json' \
    -d "{\"taskId\":\"${task_id}\",\"mode\":\"custom\",\"branch\":\"issue-838-wt\",\"baseBranch\":\"main\",\"useRemote\":false,\"autoStartSession\":false}")"
  echo "  POST /api/repositories/<id>/worktrees -> HTTP ${wt_code}"
  wt_accept_ok=1
  [ "$wt_code" = "202" ] && wt_accept_ok=0
  check "worktree creation accepted (202)" "$wt_accept_ok"

  # Worktree creation is async; poll for the new path to appear in the list.
  WT_PATH=""
  for _ in $(seq 1 30); do
    sleep 1
    curl -s -o "$WT_LIST_RESP" -b "$ALICE_COOKIE_JAR" \
      "${BASE_URL}/api/repositories/${repo_id}/worktrees" >/dev/null
    WT_PATH="$(grep -o '"path":"[^"]*wt-[0-9]\{3\}-[a-z0-9]\{4\}"' "$WT_LIST_RESP" | head -n1 | cut -d'"' -f4)"
    if [ -n "$WT_PATH" ]; then break; fi
  done
  wt_listed_ok=1
  [ -n "$WT_PATH" ] && wt_listed_ok=0
  check "worktree appears in repo's worktree list" "$wt_listed_ok"
  if [ "$wt_listed_ok" -ne 0 ]; then
    echo "  ---- DIAGNOSTIC: server logs (last 60 lines) ----"
    compose logs --tail 60 agent-console 2>&1 | sed 's/^/    /' || true
    echo "  ---- DIAGNOSTIC: worktree list response ----"
    sed 's/^/    /' "$WT_LIST_RESP" || true
    echo "  -------------------------------------------------"
  fi

  if [ -n "$WT_PATH" ]; then
    # Worktree dir owner must be alice (root cause of #838). The owner field
    # is the primary signal; the safe.directory bootstrap is the secondary
    # mitigation that lets the user's git accept the server-owned SOURCE repo.
    WT_OWNER="$(compose exec -T agent-console stat -c '%U' "$WT_PATH" 2>/dev/null | tr -d '\r' || echo MISSING)"
    echo "  stat ${WT_PATH} -> owner=${WT_OWNER}"
    owner_ok=1
    [ "$WT_OWNER" = "alice" ] && owner_ok=0
    check "new worktree dir is owned by alice (Issue #838 root fix)" "$owner_ok"

    # Run `git status` AS alice (the shipping path: alice's PTY runs as alice
    # via sudo -i). With #838 in place, the worktree is owned by alice and
    # the safe.directory entry for the source repo is in alice's gitconfig,
    # so this should NOT report dubious ownership.
    compose exec -T --user alice agent-console sh -lc "git -C '${WT_PATH}' status" \
      > "$GIT_STATUS_OUT" 2>&1
    git_status_exit=$?
    echo "  git status (as alice) exit=${git_status_exit}; first line: $(head -n1 "$GIT_STATUS_OUT" | tr -d '\r')"
    git_status_ok=1
    if [ "$git_status_exit" -eq 0 ] && ! grep -q 'dubious ownership' "$GIT_STATUS_OUT"; then
      git_status_ok=0
    fi
    check "git status as alice does NOT report dubious ownership (#838 E2E)" "$git_status_ok"
  fi
fi

rm -f "$ALICE_COOKIE_JAR" "$ALICE_LOGIN_RESP" "$REPO_RESP" \
  "$WT_TASK_RESP" "$WT_LIST_RESP" "$GIT_STATUS_OUT"

echo
echo "=== 8. shared session runs as the shared account, DB registration + per-repository binding (#1619, Release 2 for #1842) ==="
# Verifies the Shared Account feature end to end on Release 2's DB-backed
# runtime (Issue #1619, re-expressed for #1842's cutover): alice registers
# shared1 as a shared account and binds the check-7 repository to it; a
# shared WORKTREE session created against that repository routes
# sessions.created_by to shared1 while sessions.initiated_by records alice;
# the resulting PTY spawns as shared1, not alice; and a second user (bob)
# can both list and write into the shared session -- proving shared1 is a
# genuine cross-user execution identity, not merely alice's own session
# under another label. The PTY-identity probe itself runs through a
# TERMINAL-type worker added to the session, not its own initial AGENT-type
# worker, because this container has no `claude` CLI login (see the inline
# comment just above the terminal-worker creation call below for the full
# rationale). The repository binding this check establishes (repo_id ->
# shared1) is also the precondition check 9(iii) below relies on.
#
# Release 2 retired the env var as a session-creation source entirely, so
# the OLD negative arm here (AGENT_CONSOLE_SHARED_USERNAME unset disables
# the feature) no longer applies -- registration and binding are DB-only
# now, independent of the env var. The negative arm below instead asserts
# the Release 2 rule that actually governs this path: a QUICK session can
# never be shared, unconditionally (Issue #1842 item 4), regardless of
# registration or binding state.
S8_COOKIE_JAR="$(mktemp)"
S8_ALICE_LOGIN_RESP="$(mktemp)"
S8_REGISTER_RESP="$(mktemp)"
S8_BIND_RESP="$(mktemp)"
S8_QUICK_RESP="$(mktemp)"
S8_WT_RESP="$(mktemp)"
S8_WT_LIST_RESP="$(mktemp)"
S8_BASELINE="$(mktemp)"
S8_AFTER="$(mktemp)"
S8_CLIENT_OUT="$(mktemp)"
S8_DB_OUT="$(mktemp)"
S8_TERM_RESP="$(mktemp)"

curl -s -o "$S8_ALICE_LOGIN_RESP" -c "$S8_COOKIE_JAR" -X POST "${BASE_URL}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"alice-password"}' >/dev/null

# Register shared1 as a shared account. Idempotent across repeated runs of
# this script against the same container: a second registration attempt
# returns 409 "already registered", which is an acceptable outcome here --
# this check only requires shared1 to BE registered afterward, not that
# this specific call created it.
s8_register_code="$(curl -s -o "$S8_REGISTER_RESP" -w '%{http_code}' -b "$S8_COOKIE_JAR" -c "$S8_COOKIE_JAR" \
  -X POST "${BASE_URL}/api/shared-accounts" \
  -H 'Content-Type: application/json' \
  -d '{"username":"shared1"}')"
echo "  POST /api/shared-accounts {username:shared1} -> HTTP ${s8_register_code}"
if [ "$s8_register_code" != "201" ] && [ "$s8_register_code" != "409" ]; then
  echo "  response body: $(cat "$S8_REGISTER_RESP")"
fi
s8_register_ok=1
{ [ "$s8_register_code" = "201" ] || [ "$s8_register_code" = "409" ]; } && s8_register_ok=0
check "shared1 is registered as a shared account (201, or 409 already-registered)" "$s8_register_ok"

# Bind the check-7 repository to shared1. Like check 8's own sub-checks
# below, a missing repo_id (check 7's own repository registration failed,
# already recorded as its own FAIL there) is recorded as an explicit FAIL
# here too, never silently skipped.
s8_bind_ok=1
if [ -n "$repo_id" ]; then
  s8_bind_code="$(curl -s -o "$S8_BIND_RESP" -w '%{http_code}' -b "$S8_COOKIE_JAR" -c "$S8_COOKIE_JAR" \
    -X PATCH "${BASE_URL}/api/repositories/${repo_id}" \
    -H 'Content-Type: application/json' \
    -d '{"sharedAccountUsername":"shared1"}')"
  echo "  PATCH /api/repositories/<id> {sharedAccountUsername:shared1} -> HTTP ${s8_bind_code}"
  if [ "$s8_bind_code" != "200" ]; then
    echo "  response body: $(cat "$S8_BIND_RESP")"
  fi
  [ "$s8_bind_code" = "200" ] && s8_bind_ok=0
else
  echo "  DIAGNOSTIC: repo_id from check 7 is empty; recording an explicit FAIL instead of skipping."
fi
check "repository is bound to shared1" "$s8_bind_ok"

# Negative arm (Release 2, Issue #1842 item 4): a QUICK session can never
# be shared, unconditionally -- registration and binding above make no
# difference to this call.
s8_quick_code="$(curl -s -o "$S8_QUICK_RESP" -w '%{http_code}' -b "$S8_COOKIE_JAR" -c "$S8_COOKIE_JAR" \
  -X POST "${BASE_URL}/api/sessions" \
  -H 'Content-Type: application/json' \
  -d '{"type":"quick","locationPath":"/home/alice","shared":true,"title":"verify-shared-quick-rejected"}')"
echo "  POST /api/sessions (quick, shared:true) -> HTTP ${s8_quick_code} (expect 400, Release 2)"
if [ "$s8_quick_code" != "400" ]; then
  echo "  response body: $(cat "$S8_QUICK_RESP")"
fi
s8_quick_ok=1
[ "$s8_quick_code" = "400" ] && s8_quick_ok=0
check "quick session with shared:true is rejected (400, Release 2)" "$s8_quick_ok"

# NOTE: unlike checks 6 and 7 above (which intentionally SKIP their
# dependent sub-checks -- absent from the PASS/FAIL counters -- when a
# prerequisite id is missing, and are deliberately left unchanged here),
# check 8's dependent sub-checks below are recorded as explicit FAILs
# rather than skipped. This is check 8's own documented contract (the
# --smokes "never a silent skip" guarantee in docker/README.md): a missing
# prerequisite must show up as a FAIL in the RESULT count, not vanish from
# it. Do not "harmonise" this back to the checks 6/7 skip shape.
shared_session_id=""
shared_worker_id=""
if [ -n "$repo_id" ]; then
  curl -s -b "$S8_COOKIE_JAR" "${BASE_URL}/api/repositories/${repo_id}/worktrees" \
    | grep -o '"path":"[^"]*"' | cut -d'"' -f4 | sort > "$S8_BASELINE"

  s8_task_id="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)"
  s8_wt_code="$(curl -s -o "$S8_WT_RESP" -w '%{http_code}' -b "$S8_COOKIE_JAR" -c "$S8_COOKIE_JAR" \
    -X POST "${BASE_URL}/api/repositories/${repo_id}/worktrees" \
    -H 'Content-Type: application/json' \
    -d "{\"taskId\":\"${s8_task_id}\",\"mode\":\"custom\",\"branch\":\"verify-shared-wt\",\"baseBranch\":\"main\",\"useRemote\":false,\"autoStartSession\":true,\"shared\":true}")"
  echo "  POST /api/repositories/<id>/worktrees (shared:true) -> HTTP ${s8_wt_code}"
  s8_wt_accept_ok=1
  [ "$s8_wt_code" = "202" ] && s8_wt_accept_ok=0
  check "shared worktree creation accepted (202)" "$s8_wt_accept_ok"

  S8_PATH=""
  for _ in $(seq 1 30); do
    sleep 1
    curl -s -o "$S8_WT_LIST_RESP" -b "$S8_COOKIE_JAR" \
      "${BASE_URL}/api/repositories/${repo_id}/worktrees" >/dev/null
    grep -o '"path":"[^"]*"' "$S8_WT_LIST_RESP" | cut -d'"' -f4 | sort > "$S8_AFTER"
    S8_PATH="$(comm -13 "$S8_BASELINE" "$S8_AFTER" | head -n1)"
    if [ -n "$S8_PATH" ]; then break; fi
  done
  s8_listed_ok=1
  [ -n "$S8_PATH" ] && s8_listed_ok=0
  check "shared worktree appears in repo's worktree list" "$s8_listed_ok"

  if [ -n "$S8_PATH" ]; then
    # Read the row inside the container as agentconsole, straight from the
    # SQLite file the server itself writes to.
    compose exec -T --user agentconsole -e S8_PATH="$S8_PATH" agent-console \
      bun -e '
        import { Database } from "bun:sqlite";
        const db = new Database(process.env.AGENT_CONSOLE_HOME + "/data.db", { readonly: true });
        const session = db.query("SELECT id, created_by, initiated_by FROM sessions WHERE location_path = ?").get(process.env.S8_PATH);
        console.log("SESSION_ID=" + (session ? session.id : ""));
        console.log("ROW_CREATED_BY=" + (session && session.created_by != null ? session.created_by : ""));
        console.log("ROW_INITIATED_BY=" + (session && session.initiated_by != null ? session.initiated_by : ""));
        const shared1 = db.query("SELECT id FROM users WHERE username = ?").get("shared1");
        console.log("SHARED1_ID=" + (shared1 ? shared1.id : ""));
        const aliceRow = db.query("SELECT id FROM users WHERE username = ?").get("alice");
        console.log("ALICE_ID=" + (aliceRow ? aliceRow.id : ""));
      ' > "$S8_DB_OUT" 2>&1
    s8_db_exit=$?
    sed 's/^/  /' "$S8_DB_OUT"

    shared_session_id="$(grep '^SESSION_ID=' "$S8_DB_OUT" | head -n1 | cut -d= -f2)"
    s8_row_created_by="$(grep '^ROW_CREATED_BY=' "$S8_DB_OUT" | head -n1 | cut -d= -f2)"
    s8_row_initiated_by="$(grep '^ROW_INITIATED_BY=' "$S8_DB_OUT" | head -n1 | cut -d= -f2)"
    s8_shared1_id="$(grep '^SHARED1_ID=' "$S8_DB_OUT" | head -n1 | cut -d= -f2)"
    s8_alice_id="$(grep '^ALICE_ID=' "$S8_DB_OUT" | head -n1 | cut -d= -f2)"

    s8_created_by_ok=1
    [ "$s8_db_exit" -eq 0 ] && [ -n "$s8_row_created_by" ] && [ "$s8_row_created_by" = "$s8_shared1_id" ] && s8_created_by_ok=0
    check "shared session row: created_by is shared1's users.id" "$s8_created_by_ok"

    s8_initiated_by_ok=1
    [ "$s8_db_exit" -eq 0 ] && [ -n "$s8_row_initiated_by" ] && [ "$s8_row_initiated_by" = "$s8_alice_id" ] && s8_initiated_by_ok=0
    check "shared session row: initiated_by is alice's users.id" "$s8_initiated_by_ok"

    # PTY-identity probe: a TERMINAL-type worker added to the shared
    # session, not the session's own initial AGENT-type worker (the
    # WORKER_ID the query above would have read). This container has no
    # `claude` CLI login, so the agent-type worker's PTY predictably exits
    # 127 ("command not found") and WorkerManager.detachPty resets its `pty`
    # back to null well within this check's own polling window -- a real
    # regression this rewrite exists to route around, confirmed by direct
    # instrumentation, not assumed. `activateAgentWorkerPty` and
    # `activateTerminalWorkerPty` resolve identity via the IDENTICAL
    # session.createdBy -> resolveSpawnUsername -> spawnPty chain, differing
    # only in the downstream command string -- so this substitution never
    # touches the binding/elevation logic under test (pre-pr-completeness.md
    # Q13 recorded proxy; see smoke-verification-embedded.md's "Shared-Account Binding
    # Smoke" section for the full writeup).
    if [ -n "$shared_session_id" ]; then
      s8_term_code="$(curl -s -o "$S8_TERM_RESP" -w '%{http_code}' -b "$S8_COOKIE_JAR" -c "$S8_COOKIE_JAR" \
        -X POST "${BASE_URL}/api/sessions/${shared_session_id}/workers" \
        -H 'Content-Type: application/json' \
        -d '{"type":"terminal"}')"
      echo "  POST /api/sessions/<id>/workers (terminal) -> HTTP ${s8_term_code}"
      if [ "$s8_term_code" = "201" ]; then
        shared_worker_id="$(grep -o '"id":"[^"]*"' "$S8_TERM_RESP" | head -n1 | cut -d'"' -f4)"
      else
        echo "  response body: $(cat "$S8_TERM_RESP")"
      fi
    fi
    s8_term_ok=1
    [ -n "$shared_worker_id" ] && s8_term_ok=0
    check "shared session: added a terminal worker for the PTY-identity probe" "$s8_term_ok"
  else
    echo "  ---- DIAGNOSTIC: server logs (last 60 lines) ----"
    compose logs --tail 60 agent-console 2>&1 | sed 's/^/    /' || true
    echo "  -------------------------------------------------"
    check "shared session row: created_by is shared1's users.id" 1
    check "shared session row: initiated_by is alice's users.id" 1
    check "shared session: added a terminal worker for the PTY-identity probe" 1
  fi
else
  echo "  DIAGNOSTIC: repo_id from check 7 is empty; recording explicit FAILs for check 8's worktree sub-checks instead of skipping."
  check "shared worktree creation accepted (202)" 1
  check "shared worktree appears in repo's worktree list" 1
  check "shared session row: created_by is shared1's users.id" 1
  check "shared session row: initiated_by is alice's users.id" 1
  check "shared session: added a terminal worker for the PTY-identity probe" 1
fi

if [ -n "$shared_session_id" ] && [ -n "$shared_worker_id" ]; then
  bun "${REPO_ROOT}/docker/verify-client.ts" "$BASE_URL" alice alice-password shared1 \
    --attach "$shared_session_id" "$shared_worker_id" 2>&1 | tee "$S8_CLIENT_OUT"
  # Use PIPESTATUS[0] (bun's exit code), not $?, which after a pipeline is
  # tee's exit code (always 0) and would silently record a failing
  # verify-client.ts run as PASS. Captured on the very next line: nothing
  # may run in between.
  s8_client_exit="${PIPESTATUS[0]}"
  check "shared session terminal runs as shared1" "$s8_client_exit"
  if [ "$s8_client_exit" -ne 0 ]; then
    echo "  ---- DIAGNOSTIC: server logs (last 60 lines) ----"
    compose logs --tail 60 agent-console 2>&1 | sed 's/^/    /' || true
    echo "  -------------------------------------------------"
  fi

  # bob logs in separately and lists sessions; the shared session must be
  # visible to him even though alice created it. There is no GET
  # /api/sessions collection route -- session listing is app-WS-only (the
  # sessions-sync frame on /ws/app) -- so this drives that surface via
  # verify-client.ts's --list-session mode instead of a curl GET. Do not
  # "restore" a curl here; it would 200 against the SPA catch-all and the
  # check would pass vacuously (see PR discussion, Issue #1619).
  bun "${REPO_ROOT}/docker/verify-client.ts" "$BASE_URL" bob bob-password --list-session "$shared_session_id"
  check "bob can list the shared session" $?

  bun "${REPO_ROOT}/docker/verify-client.ts" "$BASE_URL" bob bob-password shared1 \
    --attach "$shared_session_id" "$shared_worker_id"
  check "bob can write to the shared session PTY (whoami => shared1)" $?
else
  echo "  DIAGNOSTIC: shared_session_id or shared_worker_id is empty; recording explicit FAILs for the three dependent check-8 sub-checks instead of skipping them."
  check "shared session terminal runs as shared1" 1
  check "bob can list the shared session" 1
  check "bob can write to the shared session PTY (whoami => shared1)" 1
fi

rm -f "$S8_COOKIE_JAR" "$S8_ALICE_LOGIN_RESP" "$S8_REGISTER_RESP" "$S8_BIND_RESP" "$S8_QUICK_RESP" \
  "$S8_WT_RESP" "$S8_WT_LIST_RESP" "$S8_BASELINE" "$S8_AFTER" "$S8_CLIENT_OUT" "$S8_DB_OUT" "$S8_TERM_RESP"

echo
echo "=== 9. worker-restart branch rename uses the session's spawn user, not the requester (#1622) ==="
# Verifies the #1622 fix: WorkerLifecycleManager.renameSessionBranchIfRequested
# threads resolveSpawnUsername(session.createdBy) -- the SESSION'S SPAWN USER
# -- through getCurrentBranch/renameBranch, never the requesting auth user.
#
#   (i)   restart-with-branch as alice, on a worktree session alice owns.
#         This alone cannot distinguish a correct (session-spawn-user) fix
#         from a plausible-but-wrong (requester-identity) one -- for a
#         personal session the two identities are the same user.
#   (iii) restart-with-branch on a SHARED worktree session (spawn user
#         shared1), triggered over HTTP by alice. This is the identity-choice
#         discriminator: a requester-based fix would still try to run git as
#         alice against a worktree directory owned by shared1, hitting the
#         same "dubious ownership" class of error the original bug report
#         describes. Only a fix that resolves the SESSION's spawn user passes
#         this sub-check.
#
# (Sub-check (ii) -- rename via the session-edit route -- is deliberately not
# implemented: that route no longer accepts a `branch` field, and the code
# path it would have exercised was found dead and deleted, not fixed.)
#
# Both worktree sessions here are created with autoStartSession:true (no
# embeddedAgentId), which auto-creates a PTY `agent` worker via the default
# terminal agent. This works even though no real `claude` CLI is
# installed/authenticated in this container: PTY allocation and the login
# shell spawn happen independently of whether the exec'd agent command is
# actually runnable (any failure there would only appear in the PTY's own
# byte stream, never as an HTTP-level error) -- confirmed empirically against
# this image before writing this check. This mirrors what a real user does
# through the UI, and needs an `agent`-type worker because
# POST /workers/:workerId/restart requires the existing worker to be type
# 'agent' (see WorkerLifecycleManager.restartAgentWorker's early guards).
#
# Like check 8, this check's sub-checks are recorded as explicit FAILs (never
# silently skipped) when a prerequisite (worktree creation, session/worker
# lookup) is missing -- the same "no silent skip" contract check 8 documents.
S9_COOKIE_JAR="$(mktemp)"
S9_ALICE_LOGIN_RESP="$(mktemp)"
S9_WT_RESP="$(mktemp)"
S9_WT_LIST_RESP="$(mktemp)"
S9_BASELINE="$(mktemp)"
S9_AFTER="$(mktemp)"
S9_DB_OUT="$(mktemp)"
S9_RESTART_RESP="$(mktemp)"
S9_GIT_BRANCH_OUT="$(mktemp)"

curl -s -o "$S9_ALICE_LOGIN_RESP" -c "$S9_COOKIE_JAR" -X POST "${BASE_URL}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"alice-password"}' >/dev/null

# --- sub-check (i): restart-with-branch as alice, on alice's own session ---
if [ -n "$repo_id" ]; then
  curl -s -b "$S9_COOKIE_JAR" "${BASE_URL}/api/repositories/${repo_id}/worktrees" \
    | grep -o '"path":"[^"]*"' | cut -d'"' -f4 | sort > "$S9_BASELINE"

  s9i_task_id="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)"
  s9i_wt_code="$(curl -s -o "$S9_WT_RESP" -w '%{http_code}' -b "$S9_COOKIE_JAR" -c "$S9_COOKIE_JAR" \
    -X POST "${BASE_URL}/api/repositories/${repo_id}/worktrees" \
    -H 'Content-Type: application/json' \
    -d "{\"taskId\":\"${s9i_task_id}\",\"mode\":\"custom\",\"branch\":\"issue-1622-i\",\"baseBranch\":\"main\",\"useRemote\":false,\"autoStartSession\":true}")"
  echo "  POST /api/repositories/<id>/worktrees (i, autoStartSession) -> HTTP ${s9i_wt_code}"

  S9I_PATH=""
  for _ in $(seq 1 30); do
    sleep 1
    curl -s -o "$S9_WT_LIST_RESP" -b "$S9_COOKIE_JAR" \
      "${BASE_URL}/api/repositories/${repo_id}/worktrees" >/dev/null
    grep -o '"path":"[^"]*"' "$S9_WT_LIST_RESP" | cut -d'"' -f4 | sort > "$S9_AFTER"
    S9I_PATH="$(comm -13 "$S9_BASELINE" "$S9_AFTER" | head -n1)"
    if [ -n "$S9I_PATH" ]; then break; fi
  done
  s9i_listed_ok=1
  [ -n "$S9I_PATH" ] && s9i_listed_ok=0
  check "worktree #1622(i) appears in repo's worktree list" "$s9i_listed_ok"

  if [ -n "$S9I_PATH" ]; then
    docker compose -f "$COMPOSE_FILE" exec -T --user agentconsole -e S9I_PATH="$S9I_PATH" agent-console \
      bun -e '
        import { Database } from "bun:sqlite";
        const db = new Database(process.env.AGENT_CONSOLE_HOME + "/data.db", { readonly: true });
        const session = db.query("SELECT id FROM sessions WHERE location_path = ?").get(process.env.S9I_PATH);
        console.log("SESSION_ID=" + (session ? session.id : ""));
        if (session) {
          const worker = db.query("SELECT id FROM workers WHERE session_id = ? AND type = ?").get(session.id, "agent");
          console.log("WORKER_ID=" + (worker ? worker.id : ""));
        }
      ' > "$S9_DB_OUT" 2>&1
    s9i_session_id="$(grep '^SESSION_ID=' "$S9_DB_OUT" | head -n1 | cut -d= -f2)"
    s9i_worker_id="$(grep '^WORKER_ID=' "$S9_DB_OUT" | head -n1 | cut -d= -f2)"

    if [ -n "$s9i_session_id" ] && [ -n "$s9i_worker_id" ]; then
      s9i_restart_code="$(curl -s -o "$S9_RESTART_RESP" -w '%{http_code}' -b "$S9_COOKIE_JAR" -c "$S9_COOKIE_JAR" \
        -X POST "${BASE_URL}/api/sessions/${s9i_session_id}/workers/${s9i_worker_id}/restart" \
        -H 'Content-Type: application/json' \
        -d '{"branch":"issue-1622-i-renamed"}')"
      echo "  POST /workers/<id>/restart {branch} as alice (i) -> HTTP ${s9i_restart_code}"
      if [ "$s9i_restart_code" != "200" ]; then
        echo "  response body: $(cat "$S9_RESTART_RESP")"
      fi
      s9i_restart_ok=1
      [ "$s9i_restart_code" = "200" ] && s9i_restart_ok=0
      check "restart-with-branch as alice succeeds (#1622 i)" "$s9i_restart_ok"

      docker compose -f "$COMPOSE_FILE" exec -T --user alice agent-console sh -lc "git -C '${S9I_PATH}' branch --show-current" \
        > "$S9_GIT_BRANCH_OUT" 2>&1
      s9i_branch_now="$(tr -d '\r\n' < "$S9_GIT_BRANCH_OUT")"
      echo "  git branch --show-current as alice -> ${s9i_branch_now}"
      s9i_branch_ok=1
      [ "$s9i_branch_now" = "issue-1622-i-renamed" ] && s9i_branch_ok=0
      check "git branch --show-current as alice reflects the rename (#1622 i)" "$s9i_branch_ok"
    else
      echo "  DIAGNOSTIC: session/worker id missing for worktree #1622(i) (SESSION_ID='${s9i_session_id}' WORKER_ID='${s9i_worker_id}'); recording explicit FAILs instead of skipping."
      check "restart-with-branch as alice succeeds (#1622 i)" 1
      check "git branch --show-current as alice reflects the rename (#1622 i)" 1
    fi
  else
    echo "  ---- DIAGNOSTIC: server logs (last 60 lines) ----"
    compose logs --tail 60 agent-console 2>&1 | sed 's/^/    /' || true
    echo "  -------------------------------------------------"
    echo "  DIAGNOSTIC: worktree #1622(i) never appeared; recording explicit FAILs for its dependent sub-checks instead of skipping."
    check "restart-with-branch as alice succeeds (#1622 i)" 1
    check "git branch --show-current as alice reflects the rename (#1622 i)" 1
  fi
else
  echo "  DIAGNOSTIC: repo_id from check 7 is empty; recording explicit FAILs for check 9(i) instead of skipping."
  check "worktree #1622(i) appears in repo's worktree list" 1
  check "restart-with-branch as alice succeeds (#1622 i)" 1
  check "git branch --show-current as alice reflects the rename (#1622 i)" 1
fi

# --- sub-check (iii): shared-session rename via restart, triggered by alice ---
if [ -n "$repo_id" ]; then
  cp "$S9_AFTER" "$S9_BASELINE"

  s9iii_task_id="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)"
  s9iii_wt_code="$(curl -s -o "$S9_WT_RESP" -w '%{http_code}' -b "$S9_COOKIE_JAR" -c "$S9_COOKIE_JAR" \
    -X POST "${BASE_URL}/api/repositories/${repo_id}/worktrees" \
    -H 'Content-Type: application/json' \
    -d "{\"taskId\":\"${s9iii_task_id}\",\"mode\":\"custom\",\"branch\":\"issue-1622-iii\",\"baseBranch\":\"main\",\"useRemote\":false,\"autoStartSession\":true,\"shared\":true}")"
  echo "  POST /api/repositories/<id>/worktrees (iii, shared+autoStartSession) -> HTTP ${s9iii_wt_code}"

  S9III_PATH=""
  for _ in $(seq 1 30); do
    sleep 1
    curl -s -o "$S9_WT_LIST_RESP" -b "$S9_COOKIE_JAR" \
      "${BASE_URL}/api/repositories/${repo_id}/worktrees" >/dev/null
    grep -o '"path":"[^"]*"' "$S9_WT_LIST_RESP" | cut -d'"' -f4 | sort > "$S9_AFTER"
    S9III_PATH="$(comm -13 "$S9_BASELINE" "$S9_AFTER" | head -n1)"
    if [ -n "$S9III_PATH" ]; then break; fi
  done
  s9iii_listed_ok=1
  [ -n "$S9III_PATH" ] && s9iii_listed_ok=0
  check "worktree #1622(iii) appears in repo's worktree list" "$s9iii_listed_ok"

  if [ -n "$S9III_PATH" ]; then
    docker compose -f "$COMPOSE_FILE" exec -T --user agentconsole -e S9III_PATH="$S9III_PATH" agent-console \
      bun -e '
        import { Database } from "bun:sqlite";
        const db = new Database(process.env.AGENT_CONSOLE_HOME + "/data.db", { readonly: true });
        const session = db.query("SELECT id, created_by FROM sessions WHERE location_path = ?").get(process.env.S9III_PATH);
        console.log("SESSION_ID=" + (session ? session.id : ""));
        console.log("CREATED_BY=" + (session && session.created_by != null ? session.created_by : ""));
        if (session) {
          const worker = db.query("SELECT id FROM workers WHERE session_id = ? AND type = ?").get(session.id, "agent");
          console.log("WORKER_ID=" + (worker ? worker.id : ""));
        }
        const shared1 = db.query("SELECT id FROM users WHERE username = ?").get("shared1");
        console.log("SHARED1_ID=" + (shared1 ? shared1.id : ""));
      ' > "$S9_DB_OUT" 2>&1
    s9iii_session_id="$(grep '^SESSION_ID=' "$S9_DB_OUT" | head -n1 | cut -d= -f2)"
    s9iii_worker_id="$(grep '^WORKER_ID=' "$S9_DB_OUT" | head -n1 | cut -d= -f2)"
    s9iii_created_by="$(grep '^CREATED_BY=' "$S9_DB_OUT" | head -n1 | cut -d= -f2)"
    s9iii_shared1_id="$(grep '^SHARED1_ID=' "$S9_DB_OUT" | head -n1 | cut -d= -f2)"

    s9iii_fixture_ok=1
    [ -n "$s9iii_created_by" ] && [ "$s9iii_created_by" = "$s9iii_shared1_id" ] && s9iii_fixture_ok=0
    check "worktree #1622(iii) session's created_by is shared1's users.id (fixture sanity)" "$s9iii_fixture_ok"

    if [ -n "$s9iii_session_id" ] && [ -n "$s9iii_worker_id" ]; then
      s9iii_restart_code="$(curl -s -o "$S9_RESTART_RESP" -w '%{http_code}' -b "$S9_COOKIE_JAR" -c "$S9_COOKIE_JAR" \
        -X POST "${BASE_URL}/api/sessions/${s9iii_session_id}/workers/${s9iii_worker_id}/restart" \
        -H 'Content-Type: application/json' \
        -d '{"branch":"issue-1622-iii-renamed"}')"
      echo "  POST /workers/<id>/restart {branch} as alice, session runs as shared1 (iii) -> HTTP ${s9iii_restart_code}"
      if [ "$s9iii_restart_code" != "200" ]; then
        echo "  response body: $(cat "$S9_RESTART_RESP")"
      fi
      s9iii_restart_ok=1
      [ "$s9iii_restart_code" = "200" ] && s9iii_restart_ok=0
      check "shared-session restart-with-branch as alice succeeds (session runs as shared1) (#1622 iii)" "$s9iii_restart_ok"

      # The crux of this sub-check: read the branch as shared1, NOT alice.
      docker compose -f "$COMPOSE_FILE" exec -T --user shared1 agent-console sh -lc "git -C '${S9III_PATH}' branch --show-current" \
        > "$S9_GIT_BRANCH_OUT" 2>&1
      s9iii_branch_now="$(tr -d '\r\n' < "$S9_GIT_BRANCH_OUT")"
      echo "  git branch --show-current as shared1 -> ${s9iii_branch_now}"
      if [ "$s9iii_branch_now" != "issue-1622-iii-renamed" ]; then
        echo "  ---- DIAGNOSTIC: server logs (last 60 lines) ----"
        compose logs --tail 60 agent-console 2>&1 | sed 's/^/    /' || true
        echo "  -------------------------------------------------"
      fi
      s9iii_branch_ok=1
      [ "$s9iii_branch_now" = "issue-1622-iii-renamed" ] && s9iii_branch_ok=0
      check "git branch --show-current as shared1 reflects the rename (#1622 iii, identity-choice discriminator)" "$s9iii_branch_ok"
    else
      echo "  DIAGNOSTIC: session/worker id missing for worktree #1622(iii) (SESSION_ID='${s9iii_session_id}' WORKER_ID='${s9iii_worker_id}'); recording explicit FAILs instead of skipping."
      check "shared-session restart-with-branch as alice succeeds (session runs as shared1) (#1622 iii)" 1
      check "git branch --show-current as shared1 reflects the rename (#1622 iii, identity-choice discriminator)" 1
    fi
  else
    echo "  ---- DIAGNOSTIC: server logs (last 60 lines) ----"
    compose logs --tail 60 agent-console 2>&1 | sed 's/^/    /' || true
    echo "  -------------------------------------------------"
    echo "  DIAGNOSTIC: worktree #1622(iii) never appeared; recording explicit FAILs for its dependent sub-checks instead of skipping."
    check "worktree #1622(iii) session's created_by is shared1's users.id (fixture sanity)" 1
    check "shared-session restart-with-branch as alice succeeds (session runs as shared1) (#1622 iii)" 1
    check "git branch --show-current as shared1 reflects the rename (#1622 iii, identity-choice discriminator)" 1
  fi
else
  echo "  DIAGNOSTIC: repo_id from check 7 is empty; recording explicit FAILs for check 9(iii) instead of skipping."
  check "worktree #1622(iii) appears in repo's worktree list" 1
  check "worktree #1622(iii) session's created_by is shared1's users.id (fixture sanity)" 1
  check "shared-session restart-with-branch as alice succeeds (session runs as shared1) (#1622 iii)" 1
  check "git branch --show-current as shared1 reflects the rename (#1622 iii, identity-choice discriminator)" 1
fi

rm -f "$S9_COOKIE_JAR" "$S9_ALICE_LOGIN_RESP" "$S9_WT_RESP" "$S9_WT_LIST_RESP" \
  "$S9_BASELINE" "$S9_AFTER" "$S9_DB_OUT" "$S9_RESTART_RESP" "$S9_GIT_BRANCH_OUT"

echo
echo "=== 10. pull route reads the branch as the worktree's owning session's spawn user, not the requester (#1623) ==="
# Verifies the #1623 fix: the pull route's detached-HEAD guard and success
# message read resolve the owning session's spawn user (resolveSpawnUsername)
# and thread it into getCurrentBranch (and pullFastForward), rather than
# always reading/pulling as the requesting auth user. Same two-session
# construction as check 9: a shared worktree session (spawn user shared1)
# on the repository created at check 7 (repo_id), reachable over HTTP by
# alice. The discriminator here does not need a PTY `agent` worker (the
# pull route never looks at workers), so autoStartSession:true is kept only
# because worktree-creation-service.ts gates SESSION ROW creation on it
# (confirmed by reading `autoStartSession` in that file before writing this
# check) -- a session row is required for the route's
# `sessionManager.getAllSessions().find(...)` lookup to find an owner at all.
#
#   On main (pre-#1623): the pull route's getCurrentBranch call runs as the
#   server process user (agentconsole), hits "dubious ownership" against a
#   shared1-owned worktree directory, is swallowed into '(unknown)', and the
#   route answers 400 "Cannot pull in detached HEAD state" -- THIS 400 IS THE
#   BUG REPRODUCTION.
#   After the fix: the same call resolves shared1, passes the detached-HEAD
#   guard, and the route answers its ordinary fire-and-forget success
#   response, HTTP 202 with {"accepted":true} -- that positive shape is the
#   actual pass condition below, not merely the absence of the 400 (an
#   absence assertion would also PASS on an unrelated 500/404/409, which
#   would be a different failure, not evidence the fix worked). The pull
#   itself may still fail in the background for lack of a configured remote;
#   that background outcome is not asserted on here.
#
# Like checks 8/9, prerequisite failures are recorded as explicit FAILs
# (never silently skipped).
S10_COOKIE_JAR="$(mktemp)"
S10_ALICE_LOGIN_RESP="$(mktemp)"
S10_WT_RESP="$(mktemp)"
S10_WT_LIST_RESP="$(mktemp)"
S10_BASELINE="$(mktemp)"
S10_AFTER="$(mktemp)"
S10_DB_OUT="$(mktemp)"
S10_PULL_RESP="$(mktemp)"

curl -s -o "$S10_ALICE_LOGIN_RESP" -c "$S10_COOKIE_JAR" -X POST "${BASE_URL}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"alice-password"}' >/dev/null

if [ -n "$repo_id" ]; then
  curl -s -b "$S10_COOKIE_JAR" "${BASE_URL}/api/repositories/${repo_id}/worktrees" \
    | grep -o '"path":"[^"]*"' | cut -d'"' -f4 | sort > "$S10_BASELINE"

  s10_task_id="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)"
  s10_wt_code="$(curl -s -o "$S10_WT_RESP" -w '%{http_code}' -b "$S10_COOKIE_JAR" -c "$S10_COOKIE_JAR" \
    -X POST "${BASE_URL}/api/repositories/${repo_id}/worktrees" \
    -H 'Content-Type: application/json' \
    -d "{\"taskId\":\"${s10_task_id}\",\"mode\":\"custom\",\"branch\":\"issue-1623-pull\",\"baseBranch\":\"main\",\"useRemote\":false,\"autoStartSession\":true,\"shared\":true}")"
  echo "  POST /api/repositories/<id>/worktrees (shared+autoStartSession) -> HTTP ${s10_wt_code}"

  S10_PATH=""
  for _ in $(seq 1 30); do
    sleep 1
    curl -s -o "$S10_WT_LIST_RESP" -b "$S10_COOKIE_JAR" \
      "${BASE_URL}/api/repositories/${repo_id}/worktrees" >/dev/null
    grep -o '"path":"[^"]*"' "$S10_WT_LIST_RESP" | cut -d'"' -f4 | sort > "$S10_AFTER"
    S10_PATH="$(comm -13 "$S10_BASELINE" "$S10_AFTER" | head -n1)"
    if [ -n "$S10_PATH" ]; then break; fi
  done
  s10_listed_ok=1
  [ -n "$S10_PATH" ] && s10_listed_ok=0
  check "worktree #1623 appears in repo's worktree list" "$s10_listed_ok"

  if [ -n "$S10_PATH" ]; then
    # Bounded poll, same idiom as the worktree-list polling loop above:
    # the worktree can appear in git's list before the session row (with
    # created_by) is actually persisted server-side, since the two are
    # separate async steps. A single read right after the worktree-list
    # loop can race that gap and record a false FAIL ("session id
    # missing") without ever exercising the owner-resolution path this
    # check exists to test.
    s10_session_id=""
    s10_created_by=""
    s10_shared1_id=""
    for _ in $(seq 1 30); do
      sleep 1
      docker compose -f "$COMPOSE_FILE" exec -T --user agentconsole -e S10_PATH="$S10_PATH" agent-console \
        bun -e '
          import { Database } from "bun:sqlite";
          const db = new Database(process.env.AGENT_CONSOLE_HOME + "/data.db", { readonly: true });
          const session = db.query("SELECT id, created_by FROM sessions WHERE location_path = ?").get(process.env.S10_PATH);
          console.log("SESSION_ID=" + (session ? session.id : ""));
          console.log("CREATED_BY=" + (session && session.created_by != null ? session.created_by : ""));
          const shared1 = db.query("SELECT id FROM users WHERE username = ?").get("shared1");
          console.log("SHARED1_ID=" + (shared1 ? shared1.id : ""));
        ' > "$S10_DB_OUT" 2>&1
      s10_session_id="$(grep '^SESSION_ID=' "$S10_DB_OUT" | head -n1 | cut -d= -f2)"
      s10_created_by="$(grep '^CREATED_BY=' "$S10_DB_OUT" | head -n1 | cut -d= -f2)"
      s10_shared1_id="$(grep '^SHARED1_ID=' "$S10_DB_OUT" | head -n1 | cut -d= -f2)"
      if [ -n "$s10_session_id" ] && [ -n "$s10_created_by" ] && [ "$s10_created_by" = "$s10_shared1_id" ]; then
        break
      fi
    done

    s10_fixture_ok=1
    [ -n "$s10_created_by" ] && [ "$s10_created_by" = "$s10_shared1_id" ] && s10_fixture_ok=0
    check "worktree #1623 session's created_by is shared1's users.id (fixture sanity)" "$s10_fixture_ok"

    if [ "$s10_fixture_ok" -eq 0 ]; then
      s10_pull_task_id="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)"
      s10_pull_code="$(curl -s -o "$S10_PULL_RESP" -w '%{http_code}' -b "$S10_COOKIE_JAR" -c "$S10_COOKIE_JAR" \
        -X POST "${BASE_URL}/api/repositories/${repo_id}/worktrees/pull" \
        -H 'Content-Type: application/json' \
        -d "{\"worktreePath\":\"${S10_PATH}\",\"taskId\":\"${s10_pull_task_id}\"}")"
      echo "  POST /worktrees/pull on shared1-owned worktree, as alice -> HTTP ${s10_pull_code}"
      echo "  response body: $(cat "$S10_PULL_RESP")"

      s10_pull_ok=1
      if [ "$s10_pull_code" = "202" ] && grep -q '"accepted":true' "$S10_PULL_RESP"; then
        s10_pull_ok=0
      elif [ "$s10_pull_code" = "400" ] && grep -q 'Cannot pull in detached HEAD state' "$S10_PULL_RESP"; then
        echo "  BUG REPRODUCTION (expected on unmodified main, must be ABSENT after the #1623 fix): 400 Cannot pull in detached HEAD state"
      fi
      check "pull accepted (202 + accepted:true), not the pre-fix 400 'Cannot pull in detached HEAD state' (#1623)" "$s10_pull_ok"

      # Diagnostic signal (not machine-asserted): after the fix, the
      # server's own warn line for a swallowed getCurrentBranch failure on
      # THIS worktree's path should be absent. Grepping the log is a
      # secondary signal; the HTTP assertion above is the real one.
      S10_UNKNOWN_WARN_COUNT="$(compose logs --tail 200 agent-console 2>&1 | grep -F "$S10_PATH" | grep -c '(unknown)' || true)"
      echo "  DIAGNOSTIC: server log lines mentioning this worktree's path AND '(unknown)': ${S10_UNKNOWN_WARN_COUNT}"
    else
      echo "  DIAGNOSTIC: session row with created_by=shared1 did not appear within 30s for worktree #1623 (SESSION_ID='${s10_session_id}' CREATED_BY='${s10_created_by}' SHARED1_ID='${s10_shared1_id}'); recording explicit FAIL instead of skipping."
      check "pull accepted (202 + accepted:true), not the pre-fix 400 'Cannot pull in detached HEAD state' (#1623)" 1
    fi
  else
    echo "  ---- DIAGNOSTIC: server logs (last 60 lines) ----"
    compose logs --tail 60 agent-console 2>&1 | sed 's/^/    /' || true
    echo "  -------------------------------------------------"
    echo "  DIAGNOSTIC: worktree #1623 never appeared; recording explicit FAILs for its dependent sub-checks instead of skipping."
    check "worktree #1623 session's created_by is shared1's users.id (fixture sanity)" 1
    check "pull accepted (202 + accepted:true), not the pre-fix 400 'Cannot pull in detached HEAD state' (#1623)" 1
  fi
else
  echo "  DIAGNOSTIC: repo_id from check 7 is empty; recording explicit FAILs for check 10 instead of skipping."
  check "worktree #1623 appears in repo's worktree list" 1
  check "worktree #1623 session's created_by is shared1's users.id (fixture sanity)" 1
  check "pull accepted (202 + accepted:true), not the pre-fix 400 'Cannot pull in detached HEAD state' (#1623)" 1
fi

rm -f "$S10_COOKIE_JAR" "$S10_ALICE_LOGIN_RESP" "$S10_WT_RESP" "$S10_WT_LIST_RESP" \
  "$S10_BASELINE" "$S10_AFTER" "$S10_DB_OUT" "$S10_PULL_RESP"

echo
echo "=== 11. DELETE worktree route resolves the worktree's OWNER, not the requester (#1868) ==="
# Verifies the #1868 fix: the DELETE route resolves requestUsername via
# sessionManager.resolveWorktreeOwnerUsername(worktreePath) (the same
# owner-lookup #1869 established for getCurrentBranch/pull), falling back to
# the requester only when no session (live or paused) owns the path --
# rather than always threading authUser.username into
# worktreeService.removeWorktree / executeCleanupCommandIfConfigured / the
# open-PR check.
#
# PREMISE CORRECTION (2026-10-09, Architect ruling after a first Q12 run on
# this check's original design): this check originally measured the
# REMOVAL identity (directory-gone), expecting a permission failure
# pre-fix. Measured on unmodified main: 46/46 passed, including the
# removal. Root cause, confirmed by stat'ing the actual tree inside this
# container: every worktree / worktrees-parent / `.git/worktrees` directory
# is `<owner>:agent-console-users` mode 2775, and every multi-user operator
# -- including a shared account -- is REQUIRED to be a member of
# agent-console-users per docs/multi-user-setup-guide.md ~L1114-1118. Unix
# delete permission is governed by the CONTAINING directory's group-write
# bit, not by the deleted file's owner, so removal succeeds under EITHER
# identity in a correctly configured install -- there is no EACCES to
# reproduce here. The discriminator below is redesigned around the one
# thing in this write path that IS identity-sensitive and visible without
# `gh`: the repository's `cleanupCommand`, run via `executeHookCommand` as
# `requestUsername` with `cwd: worktreePath` -- an operator-authored
# command that must run as the worktree's OWNING account, not whichever
# human happened to click delete. The `gh`-auth half of the fix (open-PR
# check identity) remains pinned by the unit tests only -- this container
# has no `gh` binary to exercise it.
#
# The container has no `gh`, so both deletions below use ?force=true -- the
# open-PR check (gated by `!force`) is skipped by design, but
# `executeCleanupCommandIfConfigured` (worktree-deletion-service.ts step 6a)
# is NOT gated by `force` at all and always runs when a cleanupCommand is
# configured, confirmed by reading worktree-deletion-service.ts before
# writing this check rather than assumed.
#
#   (i) CONTROL: alice deletes her OWN (non-shared) worktree, force=true.
#       The cleanup-identity file must read "alice" whether the fix is
#       present or not -- resolving the owner lands on alice either way.
#   (ii) DISCRIMINATOR: alice deletes the shared1-owned worktree created on
#        the same repository (check 7/8's repo_id), force=true.
#        On main (pre-#1868): the cleanup command runs as the REQUESTER --
#        the identity file reads "alice". THIS IS THE BUG (the file's
#        actual content is pasted below, not predicted). After the fix: the
#        file reads "shared1".
#
# directory-gone / sessions-row-gone are kept as a positive control that
# the removal path itself completed -- NOT an identity discriminator (see
# the premise correction above).
#
# Like checks 8/9/10, prerequisite failures are recorded as explicit FAILs
# (never silently skipped).
S11_COOKIE_JAR="$(mktemp)"
S11_ALICE_LOGIN_RESP="$(mktemp)"
S11_OWN_WT_RESP="$(mktemp)"
S11_SHARED_WT_RESP="$(mktemp)"
S11_WT_LIST_RESP="$(mktemp)"
S11_BASELINE="$(mktemp)"
S11_AFTER_OWN="$(mktemp)"
S11_AFTER_SHARED="$(mktemp)"
S11_DB_OUT="$(mktemp)"
S11_OWN_DELETE_RESP="$(mktemp)"
S11_SHARED_DELETE_RESP="$(mktemp)"
S11_PATCH_RESP="$(mktemp)"
S11_IDENTITY_OUT="$(mktemp)"

# Written by the cleanup command below, as whichever identity actually ran
# it. AGENT_CONSOLE_HOME in this container is /var/lib/agent-console
# (mode 2775, docker/Dockerfile) -- used as a literal path rather than
# $AGENT_CONSOLE_HOME because `sudo -i` resets the elevated shell's env
# except the small `--preserve-env` allowlist (FORCE_COLOR only;
# elevation-args.ts), so the var would be empty inside the hook.
S11_IDENTITY_FILE="/var/lib/agent-console/cleanup-identity-1868.txt"

curl -s -o "$S11_ALICE_LOGIN_RESP" -c "$S11_COOKIE_JAR" -X POST "${BASE_URL}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"alice-password"}' >/dev/null

if [ -n "$repo_id" ]; then
  # Configure the discriminator: a cleanup command that records who ran it
  # into a location OUTSIDE the worktree being removed (the hook's cwd is
  # worktreePath, which is about to be deleted).
  s11_patch_code="$(curl -s -o "$S11_PATCH_RESP" -w '%{http_code}' -b "$S11_COOKIE_JAR" -c "$S11_COOKIE_JAR" \
    -X PATCH "${BASE_URL}/api/repositories/${repo_id}" \
    -H 'Content-Type: application/json' \
    -d "{\"cleanupCommand\":\"id -un > ${S11_IDENTITY_FILE}\"}")"
  echo "  PATCH /api/repositories/<id> {cleanupCommand} -> HTTP ${s11_patch_code}"
  s11_patch_ok=1
  [ "$s11_patch_code" = "200" ] && s11_patch_ok=0
  check "cleanupCommand configured for the identity discriminator (#1868)" "$s11_patch_ok"

  # Clear stale state from a prior invocation against this same --keep'd
  # container (each deletion below overwrites this file, but a leftover
  # from an earlier run must not produce a false PASS before the first
  # deletion of THIS run has actually written it).
  compose exec -T agent-console rm -f "$S11_IDENTITY_FILE" >/dev/null 2>&1 || true

  curl -s -b "$S11_COOKIE_JAR" "${BASE_URL}/api/repositories/${repo_id}/worktrees" \
    | grep -o '"path":"[^"]*"' | cut -d'"' -f4 | sort > "$S11_BASELINE"

  # --- (i) create alice's own (non-shared) worktree ---
  s11_own_task_id="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)"
  s11_own_wt_code="$(curl -s -o "$S11_OWN_WT_RESP" -w '%{http_code}' -b "$S11_COOKIE_JAR" -c "$S11_COOKIE_JAR" \
    -X POST "${BASE_URL}/api/repositories/${repo_id}/worktrees" \
    -H 'Content-Type: application/json' \
    -d "{\"taskId\":\"${s11_own_task_id}\",\"mode\":\"custom\",\"branch\":\"issue-1868-own\",\"baseBranch\":\"main\",\"useRemote\":false,\"autoStartSession\":true}")"
  echo "  POST /api/repositories/<id>/worktrees (alice's own) -> HTTP ${s11_own_wt_code}"

  S11_OWN_PATH=""
  for _ in $(seq 1 30); do
    sleep 1
    curl -s -o "$S11_WT_LIST_RESP" -b "$S11_COOKIE_JAR" \
      "${BASE_URL}/api/repositories/${repo_id}/worktrees" >/dev/null
    grep -o '"path":"[^"]*"' "$S11_WT_LIST_RESP" | cut -d'"' -f4 | sort > "$S11_AFTER_OWN"
    S11_OWN_PATH="$(comm -13 "$S11_BASELINE" "$S11_AFTER_OWN" | head -n1)"
    if [ -n "$S11_OWN_PATH" ]; then break; fi
  done
  s11_own_listed_ok=1
  [ -n "$S11_OWN_PATH" ] && s11_own_listed_ok=0
  check "worktree #1868(i) (alice's own) appears in repo's worktree list" "$s11_own_listed_ok"

  # Re-baseline so (ii)'s own comm -13 below does not also pick up (i)'s path.
  cp "$S11_AFTER_OWN" "$S11_BASELINE"

  # --- (ii) create the shared1-owned worktree ---
  s11_shared_task_id="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)"
  s11_shared_wt_code="$(curl -s -o "$S11_SHARED_WT_RESP" -w '%{http_code}' -b "$S11_COOKIE_JAR" -c "$S11_COOKIE_JAR" \
    -X POST "${BASE_URL}/api/repositories/${repo_id}/worktrees" \
    -H 'Content-Type: application/json' \
    -d "{\"taskId\":\"${s11_shared_task_id}\",\"mode\":\"custom\",\"branch\":\"issue-1868-shared\",\"baseBranch\":\"main\",\"useRemote\":false,\"autoStartSession\":true,\"shared\":true}")"
  echo "  POST /api/repositories/<id>/worktrees (shared1-owned) -> HTTP ${s11_shared_wt_code}"

  S11_SHARED_PATH=""
  for _ in $(seq 1 30); do
    sleep 1
    curl -s -o "$S11_WT_LIST_RESP" -b "$S11_COOKIE_JAR" \
      "${BASE_URL}/api/repositories/${repo_id}/worktrees" >/dev/null
    grep -o '"path":"[^"]*"' "$S11_WT_LIST_RESP" | cut -d'"' -f4 | sort > "$S11_AFTER_SHARED"
    S11_SHARED_PATH="$(comm -13 "$S11_BASELINE" "$S11_AFTER_SHARED" | head -n1)"
    if [ -n "$S11_SHARED_PATH" ]; then break; fi
  done
  s11_shared_listed_ok=1
  [ -n "$S11_SHARED_PATH" ] && s11_shared_listed_ok=0
  check "worktree #1868(ii) (shared1-owned) appears in repo's worktree list" "$s11_shared_listed_ok"

  if [ -n "$S11_OWN_PATH" ] && [ -n "$S11_SHARED_PATH" ]; then
    # Bounded poll for both session rows' created_by, same idiom as checks
    # 9/10 (worktree-list appearance races session-row persistence).
    s11_own_created_by=""
    s11_shared_created_by=""
    s11_alice_id=""
    s11_shared1_id=""
    for _ in $(seq 1 30); do
      sleep 1
      docker compose -f "$COMPOSE_FILE" exec -T --user agentconsole \
        -e S11_OWN_PATH="$S11_OWN_PATH" -e S11_SHARED_PATH="$S11_SHARED_PATH" agent-console \
        bun -e '
          import { Database } from "bun:sqlite";
          const db = new Database(process.env.AGENT_CONSOLE_HOME + "/data.db", { readonly: true });
          const own = db.query("SELECT created_by FROM sessions WHERE location_path = ?").get(process.env.S11_OWN_PATH);
          console.log("OWN_CREATED_BY=" + (own && own.created_by != null ? own.created_by : ""));
          const shared = db.query("SELECT created_by FROM sessions WHERE location_path = ?").get(process.env.S11_SHARED_PATH);
          console.log("SHARED_CREATED_BY=" + (shared && shared.created_by != null ? shared.created_by : ""));
          const alice = db.query("SELECT id FROM users WHERE username = ?").get("alice");
          console.log("ALICE_ID=" + (alice ? alice.id : ""));
          const shared1 = db.query("SELECT id FROM users WHERE username = ?").get("shared1");
          console.log("SHARED1_ID=" + (shared1 ? shared1.id : ""));
        ' > "$S11_DB_OUT" 2>&1
      s11_own_created_by="$(grep '^OWN_CREATED_BY=' "$S11_DB_OUT" | head -n1 | cut -d= -f2)"
      s11_shared_created_by="$(grep '^SHARED_CREATED_BY=' "$S11_DB_OUT" | head -n1 | cut -d= -f2)"
      s11_alice_id="$(grep '^ALICE_ID=' "$S11_DB_OUT" | head -n1 | cut -d= -f2)"
      s11_shared1_id="$(grep '^SHARED1_ID=' "$S11_DB_OUT" | head -n1 | cut -d= -f2)"
      if [ -n "$s11_own_created_by" ] && [ "$s11_own_created_by" = "$s11_alice_id" ] \
        && [ -n "$s11_shared_created_by" ] && [ "$s11_shared_created_by" = "$s11_shared1_id" ]; then
        break
      fi
    done

    s11_fixture_ok=1
    if [ -n "$s11_own_created_by" ] && [ "$s11_own_created_by" = "$s11_alice_id" ] \
      && [ -n "$s11_shared_created_by" ] && [ "$s11_shared_created_by" = "$s11_shared1_id" ]; then
      s11_fixture_ok=0
    fi
    check "worktree #1868 fixture sanity: own session's created_by=alice, shared session's created_by=shared1" "$s11_fixture_ok"

    if [ "$s11_fixture_ok" -eq 0 ]; then
      # Paths generated by worktree-creation-service.ts contain only
      # [A-Za-z0-9._/-]; the DELETE route's own split point is `/worktrees/`,
      # so only embedded slashes need percent-encoding to survive as part of
      # the trailing wildcard segment (matches client/api.ts's
      # encodeURIComponent(worktreePath) for this path shape).
      S11_OWN_PATH_ENC="$(printf '%s' "$S11_OWN_PATH" | sed 's/\//%2F/g')"
      S11_SHARED_PATH_ENC="$(printf '%s' "$S11_SHARED_PATH" | sed 's/\//%2F/g')"

      # --- (i) CONTROL: alice deletes her own worktree, force=true ---
      s11_own_delete_code="$(curl -s -o "$S11_OWN_DELETE_RESP" -w '%{http_code}' -b "$S11_COOKIE_JAR" -c "$S11_COOKIE_JAR" \
        -X DELETE "${BASE_URL}/api/repositories/${repo_id}/worktrees/${S11_OWN_PATH_ENC}?force=true")"
      echo "  DELETE own worktree as alice, force=true -> HTTP ${s11_own_delete_code}"
      echo "  response body: $(cat "$S11_OWN_DELETE_RESP")"

      s11_own_delete_ok=1
      [ "$s11_own_delete_code" = "200" ] && s11_own_delete_ok=0
      check "(i) CONTROL: delete own worktree as alice -> HTTP 200 (#1868)" "$s11_own_delete_ok"

      # Identity discriminator: read the cleanup-identity file written by
      # THIS deletion before the next deletion (ii) overwrites it.
      docker compose -f "$COMPOSE_FILE" exec -T agent-console cat "$S11_IDENTITY_FILE" > "$S11_IDENTITY_OUT" 2>&1
      s11_own_identity="$(tr -d '\r\n' < "$S11_IDENTITY_OUT")"
      echo "  cleanup-identity file after deleting alice's own worktree: '${s11_own_identity}' (expected: alice, both before and after the fix)"
      s11_own_identity_ok=1
      [ "$s11_own_identity" = "alice" ] && s11_own_identity_ok=0
      check "(i) CONTROL: cleanup command ran as alice (owner == requester) (#1868)" "$s11_own_identity_ok"

      # Positive control that the removal path itself completed (NOT an
      # identity discriminator -- see the premise correction above: Unix
      # delete permission comes from the containing directory's
      # group-write bit, so this passes under either identity).
      compose exec -T agent-console test -d "$S11_OWN_PATH" >/dev/null 2>&1
      s11_own_test_rc=$?
      s11_own_dir_gone_ok=1
      [ "$s11_own_test_rc" -ne 0 ] && s11_own_dir_gone_ok=0
      check "(i) CONTROL: own worktree directory is gone from disk (removal-path positive control) (#1868)" "$s11_own_dir_gone_ok"

      # --- (ii) DISCRIMINATOR: alice deletes the shared1-owned worktree, force=true ---
      s11_shared_delete_code="$(curl -s -o "$S11_SHARED_DELETE_RESP" -w '%{http_code}' -b "$S11_COOKIE_JAR" -c "$S11_COOKIE_JAR" \
        -X DELETE "${BASE_URL}/api/repositories/${repo_id}/worktrees/${S11_SHARED_PATH_ENC}?force=true")"
      echo "  DELETE shared1-owned worktree as alice, force=true -> HTTP ${s11_shared_delete_code}"
      echo "  response body: $(cat "$S11_SHARED_DELETE_RESP")"

      s11_shared_delete_ok=1
      [ "$s11_shared_delete_code" = "200" ] && s11_shared_delete_ok=0
      check "(ii) DISCRIMINATOR: delete shared1-owned worktree as alice -> HTTP 200 (#1868)" "$s11_shared_delete_ok"

      docker compose -f "$COMPOSE_FILE" exec -T agent-console cat "$S11_IDENTITY_FILE" > "$S11_IDENTITY_OUT" 2>&1
      s11_shared_identity="$(tr -d '\r\n' < "$S11_IDENTITY_OUT")"
      echo "  cleanup-identity file after deleting the shared1-owned worktree: '${s11_shared_identity}' (pre-fix baseline: pasted as measured, not predicted; post-fix expected: shared1)"
      if [ "$s11_shared_identity" != "shared1" ]; then
        echo "  BUG REPRODUCTION (expected on unmodified main, must be ABSENT after the #1868 fix): cleanup command ran as '${s11_shared_identity}' (the requester), not the worktree's owning account 'shared1'."
      fi

      s11_shared_identity_ok=1
      [ "$s11_shared_identity" = "shared1" ] && s11_shared_identity_ok=0
      check "(ii) DISCRIMINATOR: cleanup command ran as shared1 (the owner), not alice (the requester) (#1868)" "$s11_shared_identity_ok"

      # Positive control, same rationale as (i)'s above.
      compose exec -T agent-console test -d "$S11_SHARED_PATH" >/dev/null 2>&1
      s11_shared_test_rc=$?
      s11_shared_dir_gone_ok=1
      [ "$s11_shared_test_rc" -ne 0 ] && s11_shared_dir_gone_ok=0
      check "(ii) DISCRIMINATOR: shared1-owned worktree directory is gone from disk (removal-path positive control) (#1868)" "$s11_shared_dir_gone_ok"

      # Session row for the shared path must be gone too (deleteSession ran).
      docker compose -f "$COMPOSE_FILE" exec -T --user agentconsole \
        -e S11_SHARED_PATH="$S11_SHARED_PATH" agent-console \
        bun -e '
          import { Database } from "bun:sqlite";
          const db = new Database(process.env.AGENT_CONSOLE_HOME + "/data.db", { readonly: true });
          const count = db.query("SELECT COUNT(*) as n FROM sessions WHERE location_path = ?").get(process.env.S11_SHARED_PATH);
          console.log("ROW_COUNT=" + (count ? count.n : -1));
        ' > "$S11_DB_OUT" 2>&1
      s11_row_count="$(grep '^ROW_COUNT=' "$S11_DB_OUT" | head -n1 | cut -d= -f2)"
      echo "  sessions row count for shared1-owned worktree path after deletion: ${s11_row_count}"
      s11_row_gone_ok=1
      [ "$s11_row_count" = "0" ] && s11_row_gone_ok=0
      check "(ii) DISCRIMINATOR: sessions row for shared1-owned worktree path is gone (removal-path positive control) (#1868)" "$s11_row_gone_ok"
    else
      echo "  DIAGNOSTIC: fixture sanity (created_by alignment) did not settle within 30s (OWN_CREATED_BY='${s11_own_created_by}' SHARED_CREATED_BY='${s11_shared_created_by}' ALICE_ID='${s11_alice_id}' SHARED1_ID='${s11_shared1_id}'); recording explicit FAILs instead of skipping."
      check "(i) CONTROL: delete own worktree as alice -> HTTP 200 (#1868)" 1
      check "(i) CONTROL: cleanup command ran as alice (owner == requester) (#1868)" 1
      check "(i) CONTROL: own worktree directory is gone from disk (removal-path positive control) (#1868)" 1
      check "(ii) DISCRIMINATOR: delete shared1-owned worktree as alice -> HTTP 200 (#1868)" 1
      check "(ii) DISCRIMINATOR: cleanup command ran as shared1 (the owner), not alice (the requester) (#1868)" 1
      check "(ii) DISCRIMINATOR: shared1-owned worktree directory is gone from disk (removal-path positive control) (#1868)" 1
      check "(ii) DISCRIMINATOR: sessions row for shared1-owned worktree path is gone (removal-path positive control) (#1868)" 1
    fi
  else
    echo "  ---- DIAGNOSTIC: server logs (last 60 lines) ----"
    compose logs --tail 60 agent-console 2>&1 | sed 's/^/    /' || true
    echo "  -------------------------------------------------"
    echo "  DIAGNOSTIC: worktree #1868(i) or #1868(ii) never appeared; recording explicit FAILs for dependent sub-checks instead of skipping."
    check "worktree #1868 fixture sanity: own session's created_by=alice, shared session's created_by=shared1" 1
    check "(i) CONTROL: delete own worktree as alice -> HTTP 200 (#1868)" 1
    check "(i) CONTROL: cleanup command ran as alice (owner == requester) (#1868)" 1
    check "(i) CONTROL: own worktree directory is gone from disk (removal-path positive control) (#1868)" 1
    check "(ii) DISCRIMINATOR: delete shared1-owned worktree as alice -> HTTP 200 (#1868)" 1
    check "(ii) DISCRIMINATOR: cleanup command ran as shared1 (the owner), not alice (the requester) (#1868)" 1
    check "(ii) DISCRIMINATOR: shared1-owned worktree directory is gone from disk (removal-path positive control) (#1868)" 1
    check "(ii) DISCRIMINATOR: sessions row for shared1-owned worktree path is gone (removal-path positive control) (#1868)" 1
  fi

  # Unset the cleanupCommand so it does not leak into later checks/smokes
  # against this repository.
  curl -s -o /dev/null -b "$S11_COOKIE_JAR" -X PATCH "${BASE_URL}/api/repositories/${repo_id}" \
    -H 'Content-Type: application/json' -d '{"cleanupCommand":null}'
  compose exec -T agent-console rm -f "$S11_IDENTITY_FILE" >/dev/null 2>&1 || true
else
  echo "  DIAGNOSTIC: repo_id from check 7 is empty; recording explicit FAILs for check 11 instead of skipping."
  check "cleanupCommand configured for the identity discriminator (#1868)" 1
  check "worktree #1868(i) (alice's own) appears in repo's worktree list" 1
  check "worktree #1868(ii) (shared1-owned) appears in repo's worktree list" 1
  check "worktree #1868 fixture sanity: own session's created_by=alice, shared session's created_by=shared1" 1
  check "(i) CONTROL: delete own worktree as alice -> HTTP 200 (#1868)" 1
  check "(i) CONTROL: cleanup command ran as alice (owner == requester) (#1868)" 1
  check "(i) CONTROL: own worktree directory is gone from disk (removal-path positive control) (#1868)" 1
  check "(ii) DISCRIMINATOR: delete shared1-owned worktree as alice -> HTTP 200 (#1868)" 1
  check "(ii) DISCRIMINATOR: cleanup command ran as shared1 (the owner), not alice (the requester) (#1868)" 1
  check "(ii) DISCRIMINATOR: shared1-owned worktree directory is gone from disk (removal-path positive control) (#1868)" 1
  check "(ii) DISCRIMINATOR: sessions row for shared1-owned worktree path is gone (removal-path positive control) (#1868)" 1
fi

rm -f "$S11_COOKIE_JAR" "$S11_ALICE_LOGIN_RESP" "$S11_OWN_WT_RESP" "$S11_SHARED_WT_RESP" \
  "$S11_WT_LIST_RESP" "$S11_BASELINE" "$S11_AFTER_OWN" "$S11_AFTER_SHARED" "$S11_DB_OUT" \
  "$S11_OWN_DELETE_RESP" "$S11_SHARED_DELETE_RESP" "$S11_PATCH_RESP" "$S11_IDENTITY_OUT"

echo
echo "=== 11b. bare source repositories: clone path + second-user worktree (#2094) ==="
# Verifies, on the real Linux filesystem and the real clone path, what the
# unit suite cannot: that a repository cloned BARE by the phase-3 clone path
# (docs/design/source-repo-storage-model.md section 10 item 8)
#   (a) has the on-disk shape the server relies on (fetch refspec, origin/HEAD,
#       core.sharedRepository=group, group-write + setgid directories);
#   (b) accepts a worktree created by a SECOND user (bob, not the owner alice)
#       -- section 8's question: bob's `git worktree add` writes
#       <bare>/worktrees/<id>/ into alice's repository;
#   (c) has no main worktree in the API (phase 3) and refuses a session at its
#       path;
# each against a non-bare control cloned from the same URL in the same run,
# plus a NEGATIVE CONTROL: a third bare clone with the group-write bit
# removed, where bob's creation must NOT produce a worktree (without it, (b)
# cannot be told apart from "any user can write anything").
# Three further assertions: the upstream's HEAD is pinned to refs/heads/main
# (so the origin/HEAD assertion is meaningful), the bare clone's directory is
# owned by alice (the requesting user), and a RETRY arm (a deliberately failing
# bare clone leaves no directory behind, and the same name can then be cloned
# again successfully).
#
# The upstream is the check-7 repository, re-served over git:// by a detached
# `git daemon` INSIDE the container (root, loopback only), so the real clone
# path runs offline. `validateCloneInputs` accepts git:// and rejects http://,
# which is why this is not a static HTTP server. The daemon's pid is recorded
# in its own pid file and the daemon is stopped by that pid (stop_gitd_2094,
# also called from cleanup()).
#
# Fixed clone names (bare-2094 / nonbare-2094 / bare-2094-neg / bare-2094-retry): a re-run
# against a --keep'd container gets 409 name conflicts, recorded as FAILs
# with the response body printed -- never a skip.
#
# Like checks 8-11, a missing prerequisite is recorded as explicit FAILs,
# never silently skipped.
S11B_URL="git://127.0.0.1/upstream.git"
S11B_GITD_ROOT="/srv/gitd"
S11B_DAEMON_OK=1
S11B_CLONE_ID=""
S11B_WT_PATH=""
S11B_ALICE_JAR="$(mktemp)"; S11B_TMPFILES+=("$S11B_ALICE_JAR")
S11B_BOB_JAR="$(mktemp)"; S11B_TMPFILES+=("$S11B_BOB_JAR")
S11B_RESP="$(mktemp)"; S11B_TMPFILES+=("$S11B_RESP")
S11B_LIST="$(mktemp)"; S11B_TMPFILES+=("$S11B_LIST")
S11B_BASELINE="$(mktemp)"; S11B_TMPFILES+=("$S11B_BASELINE")
S11B_AFTER="$(mktemp)"; S11B_TMPFILES+=("$S11B_AFTER")
S11B_OUT="$(mktemp)"; S11B_TMPFILES+=("$S11B_OUT")

# First string value of "<key>" in a compact JSON file.
s11b_json_str() { # s11b_json_str <key> <file>
  grep -o "\"$1\":\"[^\"]*\"" "$2" | head -n1 | cut -d'"' -f4
}

# Run a command in the container as root; output only, CRs stripped (callers
# compare the text, so a failing command shows up as its error text).
s11b_root() {
  compose exec -T --user root agent-console "$@" 2>&1 | tr -d '\r'
}

# git as root against a repository owned by someone else; relies on root's
# global safe.directory '*' provisioned at the start of the prerequisites.
s11b_rootgit() { # s11b_rootgit <repo-path> <git args...>
  local p="$1"
  shift
  s11b_root git -C "$p" "$@"
}

# Registered repository's path, from GET /api/repositories/:id.
s11b_repo_path() { # s11b_repo_path <repo-id>
  curl -s -o "$S11B_OUT" -b "$S11B_ALICE_JAR" "${BASE_URL}/api/repositories/$1" >/dev/null
  s11b_json_str path "$S11B_OUT"
}

# Sorted worktree paths of a repository as seen by <jar>'s user.
s11b_wt_paths() { # s11b_wt_paths <jar> <repo-id> <outfile>
  curl -s -o "$S11B_LIST" -b "$1" "${BASE_URL}/api/repositories/$2/worktrees" >/dev/null
  grep -o '"path":"[^"]*"' "$S11B_LIST" | cut -d'"' -f4 | sort > "$3"
}

# Clone through the real route as alice; sets S11B_CLONE_ID (empty on failure).
s11b_clone() { # s11b_clone <label> <name> <extra-json-fields: empty or ,"bare":true>
  local label="$1" name="$2" extra="$3" code job_id status="" i ok
  S11B_CLONE_ID=""
  if [ "$S11B_DAEMON_OK" -ne 0 ]; then
    echo "  DIAGNOSTIC: the git:// server is not usable; recording explicit FAILs for the ${label} clone instead of skipping."
    check "${label}: clone request accepted (202 + jobId)" 1
    check "${label}: clone job succeeded" 1
    return 0
  fi
  code="$(curl -s -o "$S11B_RESP" -w '%{http_code}' -b "$S11B_ALICE_JAR" -c "$S11B_ALICE_JAR" \
    -X POST "${BASE_URL}/api/repositories/clone" \
    -H 'Content-Type: application/json' \
    -d "{\"url\":\"${S11B_URL}\",\"name\":\"${name}\"${extra}}")"
  echo "  POST /api/repositories/clone (${label}, name=${name}${extra}) -> HTTP ${code}"
  job_id="$(s11b_json_str jobId "$S11B_RESP")"
  ok=1
  [ "$code" = "202" ] && [ -n "$job_id" ] && ok=0
  if [ "$ok" -ne 0 ]; then
    echo "  response body: $(cat "$S11B_RESP")"
  fi
  check "${label}: clone request accepted (202 + jobId)" "$ok"
  if [ -n "$job_id" ]; then
    for i in $(seq 1 60); do
      sleep 1
      curl -s -o "$S11B_RESP" -b "$S11B_ALICE_JAR" "${BASE_URL}/api/repositories/clone/${job_id}" >/dev/null
      status="$(s11b_json_str status "$S11B_RESP")"
      if [ "$status" = "succeeded" ] || [ "$status" = "failed" ]; then break; fi
    done
    echo "  clone job ${job_id} (${label}) -> status=${status:-<none>} after ${i}s"
  fi
  ok=1
  [ "$status" = "succeeded" ] && ok=0
  if [ "$ok" -ne 0 ]; then
    echo "  clone job response (full): $(cat "$S11B_RESP")"
  else
    S11B_CLONE_ID="$(s11b_json_str repositoryId "$S11B_RESP")"
  fi
  check "${label}: clone job succeeded" "$ok"
}

# Bob creates a worktree in a repository registered by alice, and the four
# assertions of the AC are made on the result: owner, git status without
# "dubious ownership", the worktree's admin directory location and its owner.
# Sets S11B_WT_PATH.
s11b_bob_worktree() { # s11b_bob_worktree <label> <repo-id> <admin-dir-parent> <branch>
  local label="$1" repo_id="$2" admin_parent="$3" branch="$4" code ok i task_id
  local wt_owner status_rc admin_dir admin_owner
  S11B_WT_PATH=""
  if [ -z "$repo_id" ]; then
    echo "  DIAGNOSTIC: no repository id for ${label}; recording explicit FAILs for bob's worktree sub-checks instead of skipping."
    check "${label}: bob's worktree creation accepted (202)" 1
    check "${label}: bob's worktree appears in the repository's worktree list" 1
    check "${label}: bob's worktree dir is owned by bob" 1
    check "${label}: git status as bob exits 0 without 'dubious ownership'" 1
    check "${label}: bob's worktree admin dir is under ${admin_parent}/ (section 8)" 1
    check "${label}: bob's worktree admin dir is owned by bob (section 8)" 1
    return 0
  fi
  s11b_wt_paths "$S11B_BOB_JAR" "$repo_id" "$S11B_BASELINE"
  task_id="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)"
  code="$(curl -s -o "$S11B_RESP" -w '%{http_code}' -b "$S11B_BOB_JAR" -c "$S11B_BOB_JAR" \
    -X POST "${BASE_URL}/api/repositories/${repo_id}/worktrees" \
    -H 'Content-Type: application/json' \
    -d "{\"taskId\":\"${task_id}\",\"mode\":\"custom\",\"branch\":\"${branch}\",\"baseBranch\":\"main\",\"useRemote\":false,\"autoStartSession\":false}")"
  echo "  POST /api/repositories/<${label} id>/worktrees as bob (branch=${branch}) -> HTTP ${code}"
  ok=1
  [ "$code" = "202" ] && ok=0
  if [ "$ok" -ne 0 ]; then echo "  response body: $(cat "$S11B_RESP")"; fi
  check "${label}: bob's worktree creation accepted (202)" "$ok"

  for i in $(seq 1 30); do
    sleep 1
    s11b_wt_paths "$S11B_BOB_JAR" "$repo_id" "$S11B_AFTER"
    S11B_WT_PATH="$(comm -13 "$S11B_BASELINE" "$S11B_AFTER" | head -n1)"
    if [ -n "$S11B_WT_PATH" ]; then break; fi
  done
  ok=1
  [ -n "$S11B_WT_PATH" ] && ok=0
  check "${label}: bob's worktree appears in the repository's worktree list" "$ok"
  if [ -z "$S11B_WT_PATH" ]; then
    echo "  ---- DIAGNOSTIC: server logs (last 60 lines) ----"
    compose logs --tail 60 agent-console 2>&1 | sed 's/^/    /' || true
    echo "  -------------------------------------------------"
    check "${label}: bob's worktree dir is owned by bob" 1
    check "${label}: git status as bob exits 0 without 'dubious ownership'" 1
    check "${label}: bob's worktree admin dir is under ${admin_parent}/ (section 8)" 1
    check "${label}: bob's worktree admin dir is owned by bob (section 8)" 1
    return 0
  fi

  wt_owner="$(s11b_root stat -c '%U' "$S11B_WT_PATH")"
  echo "  stat ${S11B_WT_PATH} -> owner=${wt_owner}"
  ok=1
  [ "$wt_owner" = "bob" ] && ok=0
  check "${label}: bob's worktree dir is owned by bob" "$ok"

  compose exec -T --user bob agent-console sh -lc "git -C '${S11B_WT_PATH}' status" > "$S11B_OUT" 2>&1
  status_rc=$?
  echo "  git status (as bob) exit=${status_rc}; first line: $(head -n1 "$S11B_OUT" | tr -d '\r')"
  ok=1
  if [ "$status_rc" -eq 0 ] && ! grep -q 'dubious ownership' "$S11B_OUT"; then ok=0; fi
  check "${label}: git status as bob exits 0 without 'dubious ownership'" "$ok"

  # Section 8's question: where git put the worktree's administrative
  # directory (<repo>/worktrees/<id> for a bare repository,
  # <repo>/.git/worktrees/<id> for a non-bare one), asked of git itself rather
  # than guessed from the branch name (<id> follows the worktree directory's
  # basename), and who owns it.
  admin_dir="$(compose exec -T --user bob agent-console sh -lc "git -C '${S11B_WT_PATH}' rev-parse --absolute-git-dir" 2>/dev/null | tail -n1 | tr -d '\r')"
  echo "  git rev-parse --absolute-git-dir (as bob) -> ${admin_dir}"
  ok=1
  case "$admin_dir" in
    "${admin_parent}/"?*) ok=0 ;;
  esac
  check "${label}: bob's worktree admin dir is under ${admin_parent}/ (section 8)" "$ok"
  admin_owner="$(s11b_root stat -c '%U' "$admin_dir")"
  echo "  stat ${admin_dir} -> owner=${admin_owner}"
  ok=1
  [ -n "$admin_dir" ] && [ "$admin_owner" = "bob" ] && ok=0
  check "${label}: bob's worktree admin dir is owned by bob (section 8)" "$ok"
}

# --- prerequisites: git daemon in the image, upstream, daemon, positive control ---
# `git daemon` ships in Debian's `git` package as <exec-path>/git-daemon; the
# image has no `git-daemon-run`. Asked of the image itself rather than assumed.
compose exec -T agent-console sh -c 'test -x "$(git --exec-path)/git-daemon"' >/dev/null 2>&1
s11b_daemon_present_rc=$?
check "git daemon is available in the verification image" "$s11b_daemon_present_rc"

# The verification container's ROOT account reads repositories owned by
# agentconsole (the upstream clone below) and by alice (the on-disk assertions
# on her clones). Git refuses those with "dubious ownership", and a command-
# line `-c safe.directory=*` is NOT enough: the local-transport child
# (upload-pack) does not inherit it. So root is provisioned once, globally.
# This touches only root's ~/.gitconfig inside the disposable verification
# container; it is never applied to the server's accounts (alice, bob,
# agentconsole), whose own ownership handling is what checks 7-11 exercise.
compose exec -T --user root agent-console git config --global --add safe.directory '*' >"$S11B_OUT" 2>&1
s11b_safedir_rc=$?
if [ "$s11b_safedir_rc" -ne 0 ]; then
  echo "  git config output: $(tr -d '\r' < "$S11B_OUT")"
fi
check "container root is provisioned with safe.directory '*' (root reads agentconsole-/alice-owned repositories)" "$s11b_safedir_rc"

s11b_upstream_rc=1
s11b_started_rc=1
s11b_lsremote_rc=1
if [ "$s11b_daemon_present_rc" -eq 0 ] && [ "$s11b_safedir_rc" -eq 0 ]; then
  # The daemon serves ONLY this directory (--base-path + --export-all), on
  # loopback.
  compose exec -T --user root agent-console sh -c "
    set -e
    mkdir -p '${S11B_GITD_ROOT}'
    rm -f '${GITD_2094_PID_FILE}'
    git clone -q --bare '${SOURCE_REPO_PATH}' '${S11B_GITD_ROOT}/upstream.git'
  " >"$S11B_OUT" 2>&1
  s11b_upstream_rc=$?
  if [ "$s11b_upstream_rc" -ne 0 ]; then
    echo "  upstream clone output: $(tr -d '\r' < "$S11B_OUT")"
  fi
  check "check-7 repository re-cloned bare under ${S11B_GITD_ROOT} as the git:// upstream" "$s11b_upstream_rc"
fi
# Fixture pin. The check-7 repository's HEAD is detached by earlier checks
# (several branches share one commit), so a bare clone of it has no
# resolvable remote HEAD and `git remote set-head -a` cannot create
# refs/remotes/origin/HEAD in the clones made from it. Pinning the upstream's
# HEAD to refs/heads/main is what makes the origin/HEAD assertion below
# meaningful.
s11b_pin_rc=1
if [ "$s11b_upstream_rc" -eq 0 ]; then
  compose exec -T --user root agent-console \
    git -C "${S11B_GITD_ROOT}/upstream.git" symbolic-ref HEAD refs/heads/main >"$S11B_OUT" 2>&1
  s11b_pin_rc=$?
  if [ "$s11b_pin_rc" -ne 0 ]; then
    echo "  symbolic-ref output: $(tr -d '\r' < "$S11B_OUT")"
  fi
  check "git:// upstream HEAD is pinned to refs/heads/main" "$s11b_pin_rc"
fi
if [ "$s11b_upstream_rc" -eq 0 ] && [ "$s11b_pin_rc" -eq 0 ]; then
  compose exec -T --user root agent-console sh -c "
    git daemon --base-path='${S11B_GITD_ROOT}' --export-all --reuseaddr \
      --listen=127.0.0.1 --port=9418 --pid-file='${GITD_2094_PID_FILE}' --detach
  " >"$S11B_OUT" 2>&1
  s11b_started_rc=$?
  if [ "$s11b_started_rc" -eq 0 ]; then GITD_2094_STARTED=1; fi
  if [ "$s11b_started_rc" -ne 0 ]; then
    echo "  git daemon output: $(tr -d '\r' < "$S11B_OUT")"
  fi
  check "git daemon started on 127.0.0.1:9418" "$s11b_started_rc"
fi
if [ "$s11b_started_rc" -eq 0 ]; then
  # Positive control, before any API call: the upstream is reachable and
  # advertises main. A few tries because --detach returns before the listener
  # is necessarily accepting.
  for _ in $(seq 1 10); do
    s11b_root git ls-remote "$S11B_URL" > "$S11B_OUT" 2>&1
    if grep -q 'refs/heads/main' "$S11B_OUT"; then s11b_lsremote_rc=0; break; fi
    sleep 1
  done
  echo "  git ls-remote ${S11B_URL}: $(tr '\n' ' ' < "$S11B_OUT")"
  check "positive control: git ls-remote ${S11B_URL} advertises refs/heads/main" "$s11b_lsremote_rc"
fi
S11B_DAEMON_OK="$s11b_lsremote_rc"

# --- logins ---
s11b_alice_login="$(curl -s -o /dev/null -w '%{http_code}' -c "$S11B_ALICE_JAR" -X POST "${BASE_URL}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"alice-password"}')"
s11b_bob_login="$(curl -s -o /dev/null -w '%{http_code}' -c "$S11B_BOB_JAR" -X POST "${BASE_URL}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"bob","password":"bob-password"}')"
echo "  login alice -> HTTP ${s11b_alice_login}; bob -> HTTP ${s11b_bob_login}"
s11b_login_ok=1
[ "$s11b_alice_login" = "200" ] && [ "$s11b_bob_login" = "200" ] && s11b_login_ok=0
check "alice and bob are logged in for check 11b" "$s11b_login_ok"

# --- clones: bare subject, non-bare control ---
s11b_clone "bare" "bare-2094" ',"bare":true'
S11B_BARE_ID="$S11B_CLONE_ID"
s11b_clone "control" "nonbare-2094" ''
S11B_CTRL_ID="$S11B_CLONE_ID"

S11B_BARE_PATH=""
S11B_CTRL_PATH=""
[ -n "$S11B_BARE_ID" ] && S11B_BARE_PATH="$(s11b_repo_path "$S11B_BARE_ID")"
[ -n "$S11B_CTRL_ID" ] && S11B_CTRL_PATH="$(s11b_repo_path "$S11B_CTRL_ID")"
echo "  bare repository: id=${S11B_BARE_ID:-<none>} path=${S11B_BARE_PATH:-<none>}"
echo "  control repository: id=${S11B_CTRL_ID:-<none>} path=${S11B_CTRL_PATH:-<none>}"

# --- on-disk shape ---
if [ -n "$S11B_BARE_PATH" ]; then
  s11b_val="$(s11b_rootgit "$S11B_BARE_PATH" rev-parse --is-bare-repository)"
  echo "  bare: rev-parse --is-bare-repository -> ${s11b_val}"
  s11b_ok=1; [ "$s11b_val" = "true" ] && s11b_ok=0
  check "bare: git rev-parse --is-bare-repository = true" "$s11b_ok"

  s11b_val="$(s11b_rootgit "$S11B_BARE_PATH" config remote.origin.fetch)"
  echo "  bare: remote.origin.fetch -> ${s11b_val}"
  s11b_ok=1; [ "$s11b_val" = "+refs/heads/*:refs/remotes/origin/*" ] && s11b_ok=0
  check "bare: remote.origin.fetch = +refs/heads/*:refs/remotes/origin/*" "$s11b_ok"

  s11b_val="$(s11b_rootgit "$S11B_BARE_PATH" symbolic-ref refs/remotes/origin/HEAD)"
  echo "  bare: symbolic-ref refs/remotes/origin/HEAD -> ${s11b_val}"
  s11b_ok=1; [ "$s11b_val" = "refs/remotes/origin/main" ] && s11b_ok=0
  check "bare: refs/remotes/origin/HEAD = refs/remotes/origin/main" "$s11b_ok"

  s11b_val="$(s11b_rootgit "$S11B_BARE_PATH" config core.sharedRepository)"
  echo "  bare: core.sharedRepository -> ${s11b_val}"
  s11b_ok=1; [ "$s11b_val" = "group" ] && s11b_ok=0
  check "bare: core.sharedRepository = group" "$s11b_ok"

  # Directories only: git keeps loose objects read-only, so file modes are
  # deliberately not asserted.
  s11b_val="$(s11b_root sh -c 'find "$1" -type d ! -perm -g+ws | wc -l' _ "$S11B_BARE_PATH" | tr -d ' ')"
  echo "  bare: directories lacking group-write+setgid -> ${s11b_val}"
  s11b_ok=1; [ "$s11b_val" = "0" ] && s11b_ok=0
  check "bare: every directory is group-writable and setgid (find -perm -g+ws finds none lacking)" "$s11b_ok"

  s11b_val="$(s11b_root stat -c '%G' "$S11B_BARE_PATH")"
  echo "  bare: stat group -> ${s11b_val}"
  s11b_ok=1; [ "$s11b_val" = "agent-console-users" ] && s11b_ok=0
  check "bare: repository directory group is agent-console-users" "$s11b_ok"

  # The server reserves the clone target as the requesting user, so the
  # directory -- which for a bare repository IS the git dir -- belongs to the
  # user who cloned (alice), not to the service user.
  s11b_val="$(s11b_root stat -c '%U' "$S11B_BARE_PATH")"
  echo "  bare: stat owner -> ${s11b_val}"
  s11b_ok=1; [ "$s11b_val" = "alice" ] && s11b_ok=0
  check "bare: repository directory is owned by alice (the requesting user)" "$s11b_ok"
else
  echo "  DIAGNOSTIC: no bare repository path; recording explicit FAILs for its on-disk sub-checks instead of skipping."
  check "bare: git rev-parse --is-bare-repository = true" 1
  check "bare: remote.origin.fetch = +refs/heads/*:refs/remotes/origin/*" 1
  check "bare: refs/remotes/origin/HEAD = refs/remotes/origin/main" 1
  check "bare: core.sharedRepository = group" 1
  check "bare: every directory is group-writable and setgid (find -perm -g+ws finds none lacking)" 1
  check "bare: repository directory group is agent-console-users" 1
  check "bare: repository directory is owned by alice (the requesting user)" 1
fi
if [ -n "$S11B_CTRL_PATH" ]; then
  s11b_val="$(s11b_rootgit "$S11B_CTRL_PATH" rev-parse --is-bare-repository)"
  echo "  control: rev-parse --is-bare-repository -> ${s11b_val}"
  s11b_ok=1; [ "$s11b_val" = "false" ] && s11b_ok=0
  check "control: git rev-parse --is-bare-repository = false" "$s11b_ok"
else
  echo "  DIAGNOSTIC: no control repository path; recording an explicit FAIL instead of skipping."
  check "control: git rev-parse --is-bare-repository = false" 1
fi

# --- bob (second user) creates a worktree in alice's repositories ---
# Bare: git's admin directory is <bare>/worktrees/<id>; control: <repo>/.git/worktrees/<id>.
s11b_bob_worktree "bare" "$S11B_BARE_ID" "${S11B_BARE_PATH:-<bare path>}/worktrees" "bob-on-bare"
s11b_bob_worktree "control" "$S11B_CTRL_ID" "${S11B_CTRL_PATH:-<control path>}/.git/worktrees" "bob-on-control"

# --- phase-3 behaviour on the real host ---
# The listing must be a real, successful listing (pathStatus ok, a worktrees
# array) before a zero count of main worktrees means anything.
if [ -n "$S11B_BARE_ID" ]; then
  s11b_wt_paths "$S11B_ALICE_JAR" "$S11B_BARE_ID" "$S11B_AFTER"
  s11b_listing_ok=1
  grep -q '"worktrees":\[' "$S11B_LIST" && grep -q '"pathStatus":"ok"' "$S11B_LIST" && s11b_listing_ok=0
  s11b_main_count="$(grep -o '"isMain":true' "$S11B_LIST" | wc -l | tr -d ' ')"
  echo "  bare: worktree list pathStatus ok / worktrees array present -> rc=${s11b_listing_ok}; isMain:true entries -> ${s11b_main_count}"
  check "bare: GET worktrees is a successful listing (positive control for the count below)" "$s11b_listing_ok"
  s11b_ok=1; [ "$s11b_main_count" = "0" ] && s11b_ok=0
  check "bare: worktree list has NO entry with isMain true (phase 3)" "$s11b_ok"
else
  check "bare: GET worktrees is a successful listing (positive control for the count below)" 1
  check "bare: worktree list has NO entry with isMain true (phase 3)" 1
fi
if [ -n "$S11B_CTRL_ID" ]; then
  s11b_wt_paths "$S11B_ALICE_JAR" "$S11B_CTRL_ID" "$S11B_AFTER"
  s11b_main_count="$(grep -o '"isMain":true' "$S11B_LIST" | wc -l | tr -d ' ')"
  echo "  control: isMain:true entries -> ${s11b_main_count}"
  s11b_ok=1; [ "$s11b_main_count" = "1" ] && s11b_ok=0
  check "control: worktree list has exactly one entry with isMain true" "$s11b_ok"
else
  check "control: worktree list has exactly one entry with isMain true" 1
fi

# A session at the bare repository's own path is refused with the message
# session-manager.ts pins. The request is a worktree session whose
# locationPath is the repository path (CreateWorktreeSessionRequestSchema).
if [ -n "$S11B_BARE_ID" ] && [ -n "$S11B_BARE_PATH" ]; then
  s11b_sess_code="$(curl -s -o "$S11B_RESP" -w '%{http_code}' -b "$S11B_ALICE_JAR" -c "$S11B_ALICE_JAR" \
    -X POST "${BASE_URL}/api/sessions" \
    -H 'Content-Type: application/json' \
    -d "{\"type\":\"worktree\",\"repositoryId\":\"${S11B_BARE_ID}\",\"worktreeId\":\"bare-2094\",\"locationPath\":\"${S11B_BARE_PATH}\"}")"
  echo "  POST /api/sessions (worktree session at the bare path) -> HTTP ${s11b_sess_code}"
  echo "  response body: $(cat "$S11B_RESP")"
  s11b_ok=1
  if [ "$s11b_sess_code" = "400" ] && grep -q 'bare source repository has no working tree' "$S11B_RESP"; then s11b_ok=0; fi
  check "bare: a session at the bare path is refused (400, 'bare source repository has no working tree')" "$s11b_ok"
else
  check "bare: a session at the bare path is refused (400, 'bare source repository has no working tree')" 1
fi

# --- NEGATIVE CONTROL: group-write removed -> bob's creation must not work ---
# Without this arm the bare-side assertions above cannot be told apart from
# "any user can write anything". The third clone is made the same way, then
# every directory loses its group-write bit (and setgid) as root.
s11b_clone "negative control" "bare-2094-neg" ',"bare":true'
S11B_NEG_ID="$S11B_CLONE_ID"
S11B_NEG_PATH=""
[ -n "$S11B_NEG_ID" ] && S11B_NEG_PATH="$(s11b_repo_path "$S11B_NEG_ID")"
echo "  negative-control repository: id=${S11B_NEG_ID:-<none>} path=${S11B_NEG_PATH:-<none>}"
if [ -n "$S11B_NEG_ID" ] && [ -n "$S11B_NEG_PATH" ]; then
  s11b_root sh -c 'find "$1" -type d -exec chmod g-ws {} +' _ "$S11B_NEG_PATH" >/dev/null
  s11b_val="$(s11b_root sh -c 'find "$1" -type d ! -perm -g+ws | wc -l' _ "$S11B_NEG_PATH" | tr -d ' ')"
  echo "  negative control: directories lacking group-write+setgid after the chmod -> ${s11b_val}"
  # The instrument must see the removal: a non-zero count here is what makes
  # the zero count on the bare repository above mean something.
  s11b_ok=1; [ "$s11b_val" != "0" ] && [ -n "$s11b_val" ] && s11b_ok=0
  check "negative control: group-write removal took effect (the bare-side find would now count directories)" "$s11b_ok"

  s11b_wt_paths "$S11B_BOB_JAR" "$S11B_NEG_ID" "$S11B_BASELINE"
  s11b_task_id="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)"
  s11b_neg_code="$(curl -s -o "$S11B_RESP" -w '%{http_code}' -b "$S11B_BOB_JAR" -c "$S11B_BOB_JAR" \
    -X POST "${BASE_URL}/api/repositories/${S11B_NEG_ID}/worktrees" \
    -H 'Content-Type: application/json' \
    -d "{\"taskId\":\"${s11b_task_id}\",\"mode\":\"custom\",\"branch\":\"bob-on-neg\",\"baseBranch\":\"main\",\"useRemote\":false,\"autoStartSession\":false}")"
  echo "  POST /api/repositories/<negative id>/worktrees as bob -> HTTP ${s11b_neg_code}"
  echo "  response body: $(cat "$S11B_RESP")"
  # The expected failure shape (Architect AC): accepted (202), then the
  # worktree never appears. Any other synchronous code is reported as its own
  # FAIL here rather than folded into the absence check below.
  s11b_ok=1; [ "$s11b_neg_code" = "202" ] && s11b_ok=0
  check "negative control: bob's creation is accepted (202); the failure arrives asynchronously" "$s11b_ok"

  s11b_appeared=""
  for _ in $(seq 1 30); do
    sleep 1
    s11b_wt_paths "$S11B_BOB_JAR" "$S11B_NEG_ID" "$S11B_AFTER"
    s11b_appeared="$(comm -13 "$S11B_BASELINE" "$S11B_AFTER" | head -n1)"
    if [ -n "$s11b_appeared" ]; then break; fi
  done
  echo "  negative control: new worktree path after 30s -> '${s11b_appeared}'"
  s11b_ok=1; [ -z "$s11b_appeared" ] && s11b_ok=0
  check "negative control: bob's worktree NEVER appears in the list within 30s (group-write removed)" "$s11b_ok"

  s11b_admin_entries="$(s11b_root sh -c 'ls -A "$1/worktrees" 2>/dev/null | wc -l' _ "$S11B_NEG_PATH" | tr -d ' ')"
  echo "  negative control: entries in ${S11B_NEG_PATH}/worktrees -> ${s11b_admin_entries}"
  s11b_ok=1; [ "$s11b_admin_entries" = "0" ] && s11b_ok=0
  check "negative control: <repo>/worktrees has no entry" "$s11b_ok"

  # The error itself, as evidence of WHY nothing appeared (printed, not asserted).
  echo "  ---- negative control: server log lines naming the branch (last 40 matching) ----"
  compose logs --tail 400 agent-console 2>&1 | grep -F 'bob-on-neg' | tail -n 40 | sed 's/^/    /' || true
  echo "  -------------------------------------------------"

  # Leave the repository as the other checks expect to find directories.
  s11b_root sh -c 'find "$1" -type d -exec chmod g+ws {} +' _ "$S11B_NEG_PATH" >/dev/null || true
else
  echo "  DIAGNOSTIC: negative-control clone is missing; recording explicit FAILs for its sub-checks instead of skipping."
  check "negative control: group-write removal took effect (the bare-side find would now count directories)" 1
  check "negative control: bob's creation is accepted (202); the failure arrives asynchronously" 1
  check "negative control: bob's worktree NEVER appears in the list within 30s (group-write removed)" 1
  check "negative control: <repo>/worktrees has no entry" 1
fi

# --- RETRY ARM: a failed bare clone leaves nothing behind, so the name is reusable ---
# Placed after the negative control (and before the daemon is stopped, which
# the valid second clone needs): it shares no state with the arms above, and
# the fixed name bare-2094-retry keeps a --keep'd re-run's 409 visible like the
# other clone names. A deliberately failing bare clone (nothing is served at
# the URL) must reach status `failed`, the partial-clone cleanup must remove
# the target directory, and a SECOND clone with the same name and a valid URL
# must then be accepted (202, not 409) and succeed.
S11B_RETRY_NAME="bare-2094-retry"
S11B_RETRY_BAD_URL="git://127.0.0.1/does-not-exist.git"
s11b_retry_dir=""
[ -n "$S11B_BARE_PATH" ] && s11b_retry_dir="$(dirname "$S11B_BARE_PATH")/${S11B_RETRY_NAME}"
if [ "$S11B_DAEMON_OK" -eq 0 ] && [ -n "$s11b_retry_dir" ]; then
  s11b_retry_code="$(curl -s -o "$S11B_RESP" -w '%{http_code}' -b "$S11B_ALICE_JAR" -c "$S11B_ALICE_JAR" \
    -X POST "${BASE_URL}/api/repositories/clone" \
    -H 'Content-Type: application/json' \
    -d "{\"url\":\"${S11B_RETRY_BAD_URL}\",\"name\":\"${S11B_RETRY_NAME}\",\"bare\":true}")"
  echo "  POST /api/repositories/clone (retry arm, failing, url=${S11B_RETRY_BAD_URL}) -> HTTP ${s11b_retry_code}"
  s11b_retry_job="$(s11b_json_str jobId "$S11B_RESP")"
  s11b_ok=1; [ "$s11b_retry_code" = "202" ] && [ -n "$s11b_retry_job" ] && s11b_ok=0
  if [ "$s11b_ok" -ne 0 ]; then echo "  response body: $(cat "$S11B_RESP")"; fi
  check "retry: the failing bare clone request is accepted (202 + jobId)" "$s11b_ok"

  s11b_retry_status=""
  if [ -n "$s11b_retry_job" ]; then
    for s11b_i in $(seq 1 60); do
      sleep 1
      curl -s -o "$S11B_RESP" -b "$S11B_ALICE_JAR" "${BASE_URL}/api/repositories/clone/${s11b_retry_job}" >/dev/null
      s11b_retry_status="$(s11b_json_str status "$S11B_RESP")"
      if [ "$s11b_retry_status" = "succeeded" ] || [ "$s11b_retry_status" = "failed" ]; then break; fi
    done
    echo "  retry: failing clone job ${s11b_retry_job} -> status=${s11b_retry_status:-<none>} after ${s11b_i}s"
    # Printed once for the record: the job's error message.
    echo "  retry: failed clone job response (full): $(cat "$S11B_RESP")"
  fi
  s11b_ok=1; [ "$s11b_retry_status" = "failed" ] && s11b_ok=0
  check "retry: the failing bare clone job reaches status failed within 60s" "$s11b_ok"

  s11b_retry_exists="$(s11b_root sh -c 'if [ -e "$1" ]; then echo exists; else echo absent; fi' _ "$s11b_retry_dir")"
  echo "  retry: ${s11b_retry_dir} -> ${s11b_retry_exists}"
  s11b_ok=1; [ "$s11b_retry_exists" = "absent" ] && s11b_ok=0
  check "retry: the failed clone's target directory does not exist (partial-clone cleanup)" "$s11b_ok"

  s11b_clone "retry (same name, valid url)" "$S11B_RETRY_NAME" ',"bare":true'
else
  echo "  DIAGNOSTIC: the git:// server or the bare repository path is missing; recording explicit FAILs for the retry arm instead of skipping."
  check "retry: the failing bare clone request is accepted (202 + jobId)" 1
  check "retry: the failing bare clone job reaches status failed within 60s" 1
  check "retry: the failed clone's target directory does not exist (partial-clone cleanup)" 1
  check "retry (same name, valid url): clone request accepted (202 + jobId)" 1
  check "retry (same name, valid url): clone job succeeded" 1
fi

stop_gitd_2094
rm -f "$S11B_ALICE_JAR" "$S11B_BOB_JAR" "$S11B_RESP" "$S11B_LIST" "$S11B_BASELINE" "$S11B_AFTER" "$S11B_OUT"

if [ "$SMOKES" -eq 1 ]; then
  echo
  echo "=== 12. real-host smokes inside the container (--smokes, #1619) ==="
  SMOKE_SUMMARY=""

  # Orphans are only reaped when PID 1 is an init (compose `init: true`, Issue
  # #2210). Fail loudly here so the --require-reaped smoke below cannot be
  # satisfied by a stack that silently went back to bun as PID 1.
  pid1_comm="$(compose exec -T agent-console cat /proc/1/comm 2>/dev/null | tr -d '\r\n')"
  echo "  container PID 1: ${pid1_comm:-<unreadable>}"
  pid1_ok=1; [ "$pid1_comm" = "docker-init" ] && pid1_ok=0
  check "container PID 1 is docker-init (orphaned descendants are reaped)" "$pid1_ok"

  run_smoke "check-multiuser-pty-env" "check-multiuser-pty-env.ts" alice
  run_smoke "check-kill-as-user" "check-kill-as-user.ts" --require-reaped alice
  run_smoke "check-file-viewer-elevated-read" "check-file-viewer-elevated-read.ts" alice
  run_smoke "check-login-shell-sentinel" "check-login-shell-sentinel.ts" --elevated alice
  run_smoke "check-orphan-sweep" "check-orphan-sweep.ts" alice
  run_smoke "check-delegated-ssh-auth-sock" "check-delegated-ssh-auth-sock.ts" alice
  run_smoke "check-embedded-agent-elevation" "check-embedded-agent-elevation.ts" alice
  # Polarity arm (Issue #1738): same apparatus, AGENT_CONSOLE_MCP_AUTH=warn,
  # inverted E1 expectation (tokenless /mcp call accepted + exact warn line
  # logged). Both arms in one run is what measures that the default arm's
  # 401 is the gate's doing and not the environment's.
  run_smoke "check-embedded-agent-elevation:warn" "check-embedded-agent-elevation.ts" alice --auth-mode warn
  # Opt-in BILLABLE arm (Issue #1675): one real tool-using provider turn as
  # alice. Off unless --elevation-turn is passed; the default run stays free.
  if [ "$ELEVATION_TURN" -eq 1 ]; then
    TURN_KEY_IN_CONTAINER="/tmp/elevation-turn-provider-keys.json"
    # Piped over stdin so the file is created by the container user itself
    # (0600); nothing is mounted and nothing is baked into the image.
    compose exec -T --user agentconsole agent-console \
      sh -c "umask 077; cat > '${TURN_KEY_IN_CONTAINER}'" < "$ELEVATION_TURN_KEY_FILE"
    RUN_SMOKE_EXEC_ENV=(-e "PROVIDER_KEY_FILE=${TURN_KEY_IN_CONTAINER}")
    RUN_SMOKE_SHOW_STDOUT=1 run_smoke "check-embedded-agent-elevation:turn" "check-embedded-agent-elevation.ts" alice --turn
    RUN_SMOKE_EXEC_ENV=()
    compose exec -T --user agentconsole agent-console rm -f "${TURN_KEY_IN_CONTAINER}" >/dev/null 2>&1 || true
  fi
  run_smoke "check-embedded-agent-bash-env" "check-embedded-agent-bash-env.ts" alice
  # run_process elevated group kill (Issue #1953): killProcess takes a
  # backgrounded grandchild down with the shell. The polarity arm builds the
  # pre-fix spawn shape and asserts the grandchild SURVIVES, so the default
  # arm's pass is the fix's doing and not the environment's.
  run_smoke "check-run-process-elevated-group-kill" "check-run-process-elevated-group-kill.ts" alice
  run_smoke "check-run-process-elevated-group-kill:expect-leak" "check-run-process-elevated-group-kill.ts" alice --expect-leak
  # Shared-accounts Release 2 (Issue #1842): DB-backed set + per-repository
  # binding actually drive shared-session PTY spawn identity. alice/bob
  # double as the two target accounts here (already baked, already members
  # of agent-console-users -- see the scratch-repo chmod rationale in the
  # smoke's own header).
  run_smoke "check-shared-account-binding" "check-shared-account-binding.ts" alice bob

  echo
  echo "=== smoke summary (exit codes) ==="
  printf '%s' "$SMOKE_SUMMARY"
fi

echo
echo "=================================================="
echo "  RESULT: ${PASS} passed, ${FAIL} failed"
echo "=================================================="
[ "$FAIL" -eq 0 ]
