#!/bin/bash
export AGENT_CONSOLE_HOME=$HOME/.agent-console-dev
exec concurrently -n client,server -c cyan,yellow \
  "cd packages/client && bun run dev" \
  "cd packages/server && bun run dev"
