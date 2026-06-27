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
#      script; this script does NOT git pull on its own.)
#   2. bun install (all deps) @ source-repo so build tooling is present.
#   3. NODE_ENV=production bun run build @ source-repo.
#   4. rsync source-repo -> deploy target (excludes node_modules + .git).
#   5. bun install --production @ deploy target (runtime deps only).
#   6. systemctl restart <service> + status snapshot.
#   7. Health probe via curl.
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

echo "==> Config"
echo "    SERVICE_USER : ${SERVICE_USER}"
echo "    APP_SOURCE   : ${SRC}"
echo "    DEPLOY_TARGET: ${DST}"
echo "    SERVICE_NAME : ${SERVICE_NAME}"
echo "    HEALTH_URL   : ${HEALTH_URL}"
echo ""

echo "==> Pre-check: source-repo HEAD"
sudo -u "${SERVICE_USER}" bash -lc "cd '${SRC}' && git log --oneline -1"

echo ""
echo "==> 1/4 bun install (all deps, build needs dev tooling) @ source-repo"
sudo -u "${SERVICE_USER}" bash -lc "
  export PATH=\$HOME/.bun/bin:\$PATH
  cd '${SRC}' && bun install
"

echo ""
echo "==> 2/4 NODE_ENV=production bun run build @ source-repo"
sudo -u "${SERVICE_USER}" bash -lc "
  export PATH=\$HOME/.bun/bin:\$PATH
  cd '${SRC}' && NODE_ENV=production bun run build
"

echo ""
echo "==> 3/4 rsync source-repo -> deploy target (excludes node_modules, .git)"
sudo -u "${SERVICE_USER}" rsync -a --delete \
  --exclude=node_modules \
  --exclude='.git' \
  "${SRC}/" "${DST}/"

echo ""
echo "==> 4/4 bun install --production @ deploy target (runtime deps only)"
sudo -u "${SERVICE_USER}" bash -lc "
  export PATH=\$HOME/.bun/bin:\$PATH
  cd '${DST}' && bun install --production
"

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
