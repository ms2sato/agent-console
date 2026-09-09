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
#   8. a shared session (shared: true) spawns its terminal as the shared
#      account (shared1) rather than the creating user, the session row's
#      created_by/initiated_by columns route to shared1/alice respectively,
#      and a second user (bob) can list and write into the shared session
#      -> proves the Shared Account is a genuine cross-user execution
#      identity (Issue #1619).
#   9. worker-restart branch rename runs as the SESSION'S SPAWN USER, not
#      the requester: (i) restart-with-branch on alice's own worktree
#      session, as alice, renames the branch on disk as alice; (iii) the
#      same restart call on a SHARED worktree session (spawn user shared1),
#      made by alice over HTTP, renames the branch on disk as shared1 --
#      proving the fix threads the session's spawn user through, not the
#      requester's identity (Issue #1622).
#
# --smokes additionally runs seven real-host smoke scripts
# (scripts/smoke/*.ts) inside the verification container, as the service
# user (agentconsole), against target user alice, using the workspace copy
# docker/Dockerfile bakes at /workspace (the smokes import production
# modules from packages/server/src/**, so the runtime bundle alone cannot
# host them):
#   - check-multiuser-pty-env.ts
#   - check-kill-as-user.ts
#   - check-login-shell-sentinel.ts
#   - check-orphan-sweep.ts
#   - check-delegated-ssh-auth-sock.ts
#   - check-embedded-agent-elevation.ts
#   - check-embedded-agent-bash-env.ts
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

for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --no-build) BUILD_FLAG="" ;;
    --smokes) SMOKES=1 ;;
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

run_smoke() { # run_smoke <label> <script> [args...]
  # Used only by --smokes (section 9). Runs one scripts/smoke/<script>.ts
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
  compose exec -T --user agentconsole -w /workspace agent-console \
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
  if [ "$smoke_rc" -ne 0 ]; then
    if [ -s "$smoke_err" ]; then
      echo "  ---- DIAGNOSTIC: ${label} stderr (last 30 lines) ----"
      tail -n 30 "$smoke_err" | sed 's/^/    /'
    else
      echo "  ---- DIAGNOSTIC: ${label} stdout (last 30 lines, stderr was empty) ----"
      tail -n 30 "$smoke_out" | sed 's/^/    /'
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
echo "=== 8. shared session runs as the shared account (#1619) ==="
# Verifies the Shared Account feature end to end (Issue #1619): a session
# created with shared:true routes sessions.created_by to the shared OS
# account (shared1, provisioned by docker/Dockerfile) while
# sessions.initiated_by records the creating user (alice); the resulting PTY
# spawns as shared1, not alice; and a second user (bob) can both list and
# write into the shared session -- proving shared1 is a genuine cross-user
# execution identity, not merely alice's own session under another label.
#
# Step 1 also doubles as the negative arm: with AGENT_CONSOLE_SHARED_USERNAME
# unset/empty (AGENT_CONSOLE_SHARED_USERNAME= scripts/verify-multiuser-docker.sh
# --no-build), the create call is refused with HTTP 400 and the response
# body ("Shared sessions are not enabled on this server.") is echoed below so
# that refusal is visible in the run log.
S8_COOKIE_JAR="$(mktemp)"
S8_ALICE_LOGIN_RESP="$(mktemp)"
S8_SESSION_RESP="$(mktemp)"
S8_CLIENT_OUT="$(mktemp)"
S8_DB_OUT="$(mktemp)"

curl -s -o "$S8_ALICE_LOGIN_RESP" -c "$S8_COOKIE_JAR" -X POST "${BASE_URL}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"alice-password"}' >/dev/null

# alice creates a shared session directly over HTTP; this is the create-time
# assertion (including the negative arm above). The session created here is
# used only for this assertion -- step 2 creates its own shared session via
# verify-client.ts and the remaining sub-checks use that one, so each
# sub-check stays independent.
s8_create_code="$(curl -s -o "$S8_SESSION_RESP" -w '%{http_code}' -b "$S8_COOKIE_JAR" -c "$S8_COOKIE_JAR" \
  -X POST "${BASE_URL}/api/sessions" \
  -H 'Content-Type: application/json' \
  -d '{"type":"quick","locationPath":"/home/shared1","shared":true,"title":"verify-shared"}')"
echo "  POST /api/sessions (shared:true) -> HTTP ${s8_create_code}"
if [ "$s8_create_code" != "201" ]; then
  echo "  response body: $(cat "$S8_SESSION_RESP")"
fi
s8_create_ok=1
[ "$s8_create_code" = "201" ] && s8_create_ok=0
check "alice can create a shared session (201)" "$s8_create_ok"

# The session verify-client.ts creates here is the one every remaining
# sub-check uses.
bun "${REPO_ROOT}/docker/verify-client.ts" "$BASE_URL" alice alice-password shared1 /home/shared1 \
  --shared --print-ids 2>&1 | tee "$S8_CLIENT_OUT"
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

shared_session_id="$(grep '^SESSION_ID=' "$S8_CLIENT_OUT" | head -n1 | cut -d= -f2)"
shared_worker_id="$(grep '^WORKER_ID=' "$S8_CLIENT_OUT" | head -n1 | cut -d= -f2)"

# NOTE: unlike checks 6 and 7 above (which intentionally SKIP their
# dependent sub-checks -- absent from the PASS/FAIL counters -- when a
# prerequisite id is missing, and are deliberately left unchanged here),
# check 8's four dependent sub-checks below are recorded as explicit FAILs
# rather than skipped. This is check 8's own documented contract (the
# --smokes "never a silent skip" guarantee in docker/README.md): a missing
# prerequisite must show up as a FAIL in the RESULT count, not vanish from
# it. Do not "harmonise" this back to the checks 6/7 skip shape.
if [ -n "$shared_session_id" ]; then
  # Read the row inside the container as agentconsole, straight from the
  # SQLite file the server itself writes to.
  compose exec -T --user agentconsole -e SHARED_SESSION_ID="$shared_session_id" agent-console \
    bun -e '
      import { Database } from "bun:sqlite";
      const db = new Database(process.env.AGENT_CONSOLE_HOME + "/data.db", { readonly: true });
      const sessionId = process.env.SHARED_SESSION_ID;
      const row = db.query("SELECT created_by, initiated_by FROM sessions WHERE id = ?").get(sessionId);
      console.log("ROW_CREATED_BY=" + (row && row.created_by != null ? row.created_by : ""));
      console.log("ROW_INITIATED_BY=" + (row && row.initiated_by != null ? row.initiated_by : ""));
      const shared1 = db.query("SELECT id FROM users WHERE username = ?").get("shared1");
      console.log("SHARED1_ID=" + (shared1 ? shared1.id : ""));
      const aliceRow = db.query("SELECT id FROM users WHERE username = ?").get("alice");
      console.log("ALICE_ID=" + (aliceRow ? aliceRow.id : ""));
    ' > "$S8_DB_OUT" 2>&1
  s8_db_exit=$?
  sed 's/^/  /' "$S8_DB_OUT"

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

  # bob logs in separately and lists sessions; the shared session must be
  # visible to him even though alice created it. There is no GET
  # /api/sessions collection route -- session listing is app-WS-only (the
  # sessions-sync frame on /ws/app) -- so this drives that surface via
  # verify-client.ts's --list-session mode instead of a curl GET. Do not
  # "restore" a curl here; it would 200 against the SPA catch-all and the
  # check would pass vacuously (see PR discussion, Issue #1619).
  bun "${REPO_ROOT}/docker/verify-client.ts" "$BASE_URL" bob bob-password --list-session "$shared_session_id"
  check "bob can list the shared session" $?

  if [ -n "$shared_worker_id" ]; then
    bun "${REPO_ROOT}/docker/verify-client.ts" "$BASE_URL" bob bob-password shared1 \
      --attach "$shared_session_id" "$shared_worker_id"
    check "bob can write to the shared session PTY (whoami => shared1)" $?
  else
    echo "  DIAGNOSTIC: shared_worker_id is empty (no WORKER_ID in step 2's verify-client.ts output); recording an explicit FAIL instead of skipping."
    check "bob can write to the shared session PTY (whoami => shared1)" 1
  fi
else
  echo "  DIAGNOSTIC: shared_session_id is empty (no SESSION_ID in step 2's verify-client.ts output); recording explicit FAILs for the four dependent check-8 sub-checks instead of skipping them."
  check "shared session row: created_by is shared1's users.id" 1
  check "shared session row: initiated_by is alice's users.id" 1
  check "bob can list the shared session" 1
  check "bob can write to the shared session PTY (whoami => shared1)" 1
fi

rm -f "$S8_COOKIE_JAR" "$S8_ALICE_LOGIN_RESP" "$S8_SESSION_RESP" "$S8_CLIENT_OUT" "$S8_DB_OUT"

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

if [ "$SMOKES" -eq 1 ]; then
  echo
  echo "=== 10. real-host smokes inside the container (--smokes, #1619) ==="
  SMOKE_SUMMARY=""

  run_smoke "check-multiuser-pty-env" "check-multiuser-pty-env.ts" alice
  run_smoke "check-kill-as-user" "check-kill-as-user.ts" alice
  run_smoke "check-login-shell-sentinel" "check-login-shell-sentinel.ts" --elevated alice
  run_smoke "check-orphan-sweep" "check-orphan-sweep.ts" alice
  run_smoke "check-delegated-ssh-auth-sock" "check-delegated-ssh-auth-sock.ts" alice
  run_smoke "check-embedded-agent-elevation" "check-embedded-agent-elevation.ts" alice
  run_smoke "check-embedded-agent-bash-env" "check-embedded-agent-bash-env.ts" alice

  echo
  echo "=== smoke summary (exit codes) ==="
  printf '%s' "$SMOKE_SUMMARY"
fi

echo
echo "=================================================="
echo "  RESULT: ${PASS} passed, ${FAIL} failed"
echo "=================================================="
[ "$FAIL" -eq 0 ]
