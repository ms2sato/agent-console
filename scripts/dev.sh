#!/bin/bash

# Load .env file if exists (for direct script execution)
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Regenerate the wire-schema version constant before starting the dev servers
# so the server advertises a value that matches the current schema files.
bun "$(dirname "$0")/generate-schema-version.mjs" > /dev/null

export AGENT_CONSOLE_HOME=${AGENT_CONSOLE_HOME:-$HOME/.agent-console-dev}
export CLIENT_PORT=${CLIENT_PORT:-5173}
export PORT=${PORT:-3457}
export APP_URL=${APP_URL:-http://localhost:$CLIENT_PORT}

echo ""
echo "========================================"
echo "  Development Server Starting"
echo "----------------------------------------"
echo "  Frontend: http://localhost:$CLIENT_PORT"
echo "  Backend:  http://localhost:$PORT"
echo "  Data:     $AGENT_CONSOLE_HOME"
echo "========================================"
echo ""

exec concurrently -n client,server -c cyan,yellow \
  "cd packages/client && bun run dev --port $CLIENT_PORT" \
  "cd packages/server && bun run dev"
