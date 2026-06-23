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
#
# Usage (from repo root):
#   scripts/verify-multiuser-docker.sh            # build + verify + tear down
#   scripts/verify-multiuser-docker.sh --keep     # leave the container running
#   scripts/verify-multiuser-docker.sh --no-build # reuse the existing image
#
# Requires: docker, bun (both on the host).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.yml"
PORT="${PORT:-8080}"
BASE_URL="http://localhost:${PORT}"
KEEP=0
BUILD_FLAG="--build"

for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --no-build) BUILD_FLAG="" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

cleanup() {
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
compose exec -T --user agentconsole agent-console sh -lc "
  set -e
  mkdir -p ${SOURCE_REPO_PATH}
  cd ${SOURCE_REPO_PATH}
  if [ ! -d .git ]; then
    git init -q -b main
    git config user.email 'agentconsole@example.com'
    git config user.name 'agentconsole'
    echo hello > README.md
    git add README.md
    git commit -q -m 'initial commit'
  fi
" >/dev/null 2>&1
source_repo_ok=$?
check "source repo bootstrapped inside container" "$source_repo_ok"

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
  for i in $(seq 1 30); do
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
echo "=================================================="
echo "  RESULT: ${PASS} passed, ${FAIL} failed"
echo "=================================================="
[ "$FAIL" -eq 0 ]
