#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "==> Installing dependencies..."
bun install

echo "==> Installing plist..."
COMMAND_PATH=$(which bun)
# UID-based port assignment is only useful when multiple users share the host
# (AUTH_MODE=multi-user). For the single-user default (AUTH_MODE unset or 'none')
# fall back to the historical fixed default so existing bookmarks keep working.
if [ "${AUTH_MODE:-none}" = "multi-user" ]; then
    DEFAULT_PORT=$((6000 + $(id -u) % 1000))
else
    DEFAULT_PORT=6340
fi
PORT=${PORT:-$DEFAULT_PORT}
APP_URL=${APP_URL:-"http://localhost:$PORT"}

echo ""
echo "  Port: $PORT"
echo "  URL:  $APP_URL"
echo ""

# Opt-in: emit a PTY_PROVIDER env entry only when the operator explicitly sets it.
# Unset -> the placeholder line is replaced by an empty string (no entry), so the
# server falls back to its compiled default. Used for dogfooding bun-terminal
# before stage-2 default flip (issues #824 / #827).
if [ -n "${PTY_PROVIDER:-}" ]; then
    # Single-line XML: literal newlines in the sed substitution pattern are
    # rejected by BSD sed (macOS). The plist parser is whitespace-insensitive,
    # so the collapsed form is semantically identical.
    PTY_PROVIDER_BLOCK="<key>PTY_PROVIDER</key><string>$PTY_PROVIDER</string>"
    echo "  PTY_PROVIDER: $PTY_PROVIDER"
    echo ""
else
    PTY_PROVIDER_BLOCK=""
fi

sed -e "s|{{HOME}}|$HOME|g" \
    -e "s|{{COMMAND_PATH}}|$COMMAND_PATH|g" \
    -e "s|{{PORT}}|$PORT|g" \
    -e "s|{{APP_URL}}|$APP_URL|g" \
    -e "s|{{PATH}}|$PATH|g" \
    -e "s|<!-- PTY_PROVIDER_BLOCK_PLACEHOLDER -->|${PTY_PROVIDER_BLOCK}|" \
    "$SCRIPT_DIR/com.agent-console.plist.template" \
    > ~/Library/LaunchAgents/com.agent-console.plist

echo "==> Generating start script..."
sed -e "s|{{COMMAND_PATH}}|$COMMAND_PATH|g" \
    "$SCRIPT_DIR/start.sh.template" \
    > /tmp/agent-console-start.sh

echo "==> Cleaning up old logs..."
rm -rf ~/Library/Logs/agent-console
mkdir -p ~/Library/Logs/agent-console

echo "==> Building..."
NODE_ENV=production bun run build

echo "==> Deploying files..."
mkdir -p ~/.agent-console/server
rsync -av --delete --exclude node_modules dist/ ~/.agent-console/server/
cp /tmp/agent-console-start.sh ~/.agent-console/server/start.sh
chmod +x ~/.agent-console/server/start.sh
rm /tmp/agent-console-start.sh
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
