#!/bin/bash
export AGENT_CONSOLE_HOME=$HOME/.agent-console-dev
export CLIENT_PORT=${CLIENT_PORT:-5173}
export PORT=${PORT:-3457}
export APP_URL=${APP_URL:-http://localhost:$CLIENT_PORT}
exec concurrently -n client,server -c cyan,yellow \
  "cd packages/client && bun run dev --port $CLIENT_PORT" \
  "cd packages/server && bun run dev"
