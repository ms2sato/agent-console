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
SERVICE_TARGET="gui/$(id -u)/com.agent-console"
SERVICE_DOMAIN="gui/$(id -u)"

# Bootout the existing service (ignore errors if not loaded)
launchctl bootout "$SERVICE_TARGET" 2>/dev/null || true

# Wait for the service to be fully unloaded before bootstrapping
# This prevents "Bootstrap failed: 5: Input/output error" race condition
MAX_WAIT=30
WAITED=0
while launchctl list "com.agent-console" >/dev/null 2>&1; do
    if [ $WAITED -ge $MAX_WAIT ]; then
        echo "Warning: Service did not unload within ${MAX_WAIT}s, proceeding anyway..."
        break
    fi
    sleep 0.5
    WAITED=$((WAITED + 1))
done

# Bootstrap the service with the updated plist
launchctl bootstrap "$SERVICE_DOMAIN" ~/Library/LaunchAgents/com.agent-console.plist

echo "==> Done!"
