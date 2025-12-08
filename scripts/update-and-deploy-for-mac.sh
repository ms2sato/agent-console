#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "==> Fetching latest main..."
git fetch origin
git checkout main
git pull origin main

echo "==> Installing dependencies..."
pnpm install

echo "==> Building..."
pnpm build

echo "==> Deploying files..."
mkdir -p ~/.agent-console/server
rsync -av --delete --exclude node_modules dist/ ~/.agent-console/server/
cd ~/.agent-console/server
pnpm install --prod

echo "==> Restarting service..."
launchctl kickstart -k gui/$(id -u)/com.agent-console 2>/dev/null || \
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-console.plist

echo "==> Done!"
