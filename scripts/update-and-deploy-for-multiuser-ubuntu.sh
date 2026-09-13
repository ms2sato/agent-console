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
#   9. systemctl restart <service> + status snapshot.
#  10. Health probe via curl.
#
# Run as your login user (sudo required for the inner elevation to the
# service user, and for the system-level systemctl restart).
#
# Usage:
#   sudo scripts/update-and-deploy-for-multiuser-ubuntu.sh
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
#   AGENT_CONSOLE_PORT               Port used by the health probe URL.
#                                    Default: 8080
#
# Example with overrides:
#   sudo AGENT_CONSOLE_PORT=9000 AGENT_CONSOLE_SERVICE_USER=ac-svc \
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
HEALTH_URL="http://localhost:${PORT}/api/auth/me"

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

echo "==> Config"
echo "    SERVICE_USER : ${SERVICE_USER}"
echo "    APP_SOURCE   : ${SRC}"
echo "    DEPLOY_TARGET: ${DST}"
echo "    SERVICE_NAME : ${SERVICE_NAME}"
echo "    HEALTH_URL   : ${HEALTH_URL}"
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
# destination; `install -D` creates missing parent directories (mode 0755,
# world-traversable) and `-m0644` makes the files themselves world-readable
# -- both properties are what makes the destination reachable by every
# elevation-target OS user, which is the entire point of this step.
sudo install -Dm0644 "${DST}/dist/embedded-agent.js" "${UNIFIED_ENTRY_PATH}"
sudo install -Dm0644 "${DST}/dist/embedded-agent.js.map" "${UNIFIED_ENTRY_MAP_PATH}"

echo ""
echo "==> 6/6 bun install --production @ deploy target (runtime deps only)"
sudo -u "${SERVICE_USER}" bash -lc '
  export PATH=$HOME/.bun/bin:$PATH
  cd -- "$1" && bun install --production
' _ "${DST}"

echo ""
echo "==> fail-closed check: unified entry path is readable before restart"
# Mirrors assert_unified_bun_executable's fail-closed discipline (Issue
# #1222) for the entry path (Issue #1668): refuses to restart into a unit
# whose EMBEDDED_AGENT_ENTRY_PATH would point at a file step 5/6 did not
# actually provision. Always runs after an unconditional copy step (unlike
# the bun-binary check, this script has no --dry-run preview mode to skip
# for), so on a normal successful deploy this can never legitimately fail --
# it exists to catch a partial/interrupted copy rather than a first-run
# bootstrap ordering gap.
assert_readable_file "${UNIFIED_ENTRY_PATH}" \
  "step 5/6 (copy dist/embedded-agent.js to the unified entry path) did not complete -- re-run this script" || exit 1

echo ""
echo "==> systemctl restart ${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"
sleep 2
sudo systemctl status "${SERVICE_NAME}" --no-pager | head -10

echo ""
echo "==> Post-deploy: quick health probe"
if curl -sf -m 5 "${HEALTH_URL}" >/dev/null; then
  echo "    ${HEALTH_URL} OK"
else
  echo "    ${HEALTH_URL} FAILED"
fi

echo ""
echo "==> Done."
