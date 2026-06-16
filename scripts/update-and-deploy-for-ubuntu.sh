#!/bin/bash
#
# Deploy Agent Console as a per-user systemd service on Ubuntu/Linux.
#
# Notes:
#   - Requires `rsync` (checked below). Install with: sudo apt-get install -y rsync
#   - The service port defaults to 6000 + (uid % 1000). Known caveat: users whose
#     UIDs differ by a multiple of 1000 (e.g. 1000 and 2000) collide on the same
#     port. Set PORT explicitly to override.
#   - Enables systemd "lingering" for the current user so the service keeps running
#     after logout and starts on boot (no login session required).
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Fail early with a clear message if rsync is missing (used during deploy below).
if ! command -v rsync >/dev/null 2>&1; then
    echo "Error: rsync is required but was not found." >&2
    echo "Install it with: sudo apt-get install -y rsync" >&2
    exit 1
fi

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

echo "==> Enabling lingering (keeps the service running after logout / across reboots)..."
# Without lingering, a --user service stops at logout and does not start on boot.
# enable-linger for one's own user may or may not require privileges depending on
# the system's polkit policy, so do not abort the whole deploy if it fails.
LINGER_USER="${USER:-$(id -un)}"
if loginctl enable-linger "$LINGER_USER" 2>/dev/null; then
    echo "  Lingering enabled for $LINGER_USER"
else
    echo "  Warning: could not enable lingering for $LINGER_USER."
    echo "  The service will stop at logout and not start on boot until you run:"
    echo "    sudo loginctl enable-linger $LINGER_USER"
fi

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
