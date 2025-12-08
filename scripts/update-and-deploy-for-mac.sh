#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "==> Installing dependencies..."
pnpm install

echo "==> Installing plist..."
NODE_PATH=$(which node)
PORT=${PORT:-6340}
sed -e "s|{{HOME}}|$HOME|g" \
    -e "s|{{NODE_PATH}}|$NODE_PATH|g" \
    -e "s|{{PORT}}|$PORT|g" \
    "$SCRIPT_DIR/com.agent-console.plist.template" \
    > ~/Library/LaunchAgents/com.agent-console.plist

echo "==> Cleaning up old logs..."
rm -rf ~/Library/Logs/agent-console
mkdir -p ~/Library/Logs/agent-console

echo "==> Building..."
NODE_ENV=production pnpm build

echo "==> Deploying files..."
mkdir -p ~/.agent-console/server
rsync -av --delete --exclude node_modules dist/ ~/.agent-console/server/
cd ~/.agent-console/server
pnpm install --prod

echo "==> Restarting service..."
launchctl bootout gui/$(id -u)/com.agent-console 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-console.plist

echo "==> Done!"
