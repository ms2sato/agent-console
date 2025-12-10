#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "==> Installing dependencies..."
bun install

echo "==> Installing plist..."
COMMAND_PATH=$(which bun)
PORT=${PORT:-6340}
sed -e "s|{{HOME}}|$HOME|g" \
    -e "s|{{COMMAND_PATH}}|$COMMAND_PATH|g" \
    -e "s|{{PORT}}|$PORT|g" \
    -e "s|{{PATH}}|$PATH|g" \
    "$SCRIPT_DIR/com.agent-console.plist.template" \
    > ~/Library/LaunchAgents/com.agent-console.plist

echo "==> Cleaning up old logs..."
rm -rf ~/Library/Logs/agent-console
mkdir -p ~/Library/Logs/agent-console

echo "==> Building..."
NODE_ENV=production bun run build

echo "==> Deploying files..."
mkdir -p ~/.agent-console/server
rsync -av --delete --exclude node_modules dist/ ~/.agent-console/server/
cd ~/.agent-console/server
bun install --production

echo "==> Restarting service..."
# Use bootout + bootstrap to ensure plist changes (including environment variables) are reloaded
launchctl bootout "gui/$(id -u)/com.agent-console" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.agent-console.plist

echo "==> Done!"
