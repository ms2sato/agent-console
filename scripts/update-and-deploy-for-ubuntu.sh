#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "==> Installing dependencies..."
bun install

echo "==> Installing systemd user service..."
COMMAND_PATH=$(which bun)
DEFAULT_PORT=$((6000 + $(id -u) % 1000))
PORT=${PORT:-$DEFAULT_PORT}
APP_URL=${APP_URL:-"http://localhost:$PORT"}

echo ""
echo "  Port: $PORT"
echo "  URL:  $APP_URL"
echo ""

# Create systemd user directory if not exists
mkdir -p ~/.config/systemd/user

sed -e "s|{{HOME}}|$HOME|g" \
    -e "s|{{COMMAND_PATH}}|$COMMAND_PATH|g" \
    -e "s|{{PORT}}|$PORT|g" \
    -e "s|{{APP_URL}}|$APP_URL|g" \
    -e "s|{{PATH}}|$PATH|g" \
    "$SCRIPT_DIR/agent-console.service.template" \
    > ~/.config/systemd/user/agent-console.service

echo "==> Cleaning up old logs..."
rm -rf ~/.local/share/agent-console/logs
mkdir -p ~/.local/share/agent-console/logs

echo "==> Building..."
NODE_ENV=production bun run build

echo "==> Deploying files..."
mkdir -p ~/.agent-console/server
rsync -av --delete --exclude node_modules dist/ ~/.agent-console/server/
cd ~/.agent-console/server
bun install --production

echo "==> Reloading systemd and restarting service..."
systemctl --user daemon-reload
systemctl --user restart agent-console.service
systemctl --user enable agent-console.service

echo "==> Waiting for service to start..."
sleep 2

echo "==> Service status:"
systemctl --user status agent-console.service --no-pager || true

echo ""
echo "==> Done!"
echo ""
echo "Useful commands:"
echo "  systemctl --user status agent-console   # Check status"
echo "  systemctl --user stop agent-console     # Stop service"
echo "  systemctl --user start agent-console    # Start service"
echo "  journalctl --user -u agent-console -f   # View logs (journald)"
echo "  tail -f ~/.local/share/agent-console/logs/agent-console.log  # View logs (file)"
