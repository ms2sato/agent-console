# CLAUDE.md

## Project Overview

A web application for managing multiple AI coding agent instances (Claude Code, etc.) running in different git worktrees. Instead of scattered terminals, users control all instances through a unified browser interface using xterm.js.

## Project Structure

Monorepo with Bun workspaces:
- `packages/client` - React frontend with Vite, TanStack Router, TanStack Query, and Tailwind CSS
- `packages/server` - Bun backend with Hono framework and native WebSocket
- `packages/shared` - Shared types and utilities

## Core Concepts

- **Session**: A working context tied to a worktree or arbitrary directory. Each session can have multiple workers.
- **Worker**: A PTY process running within a session. Two types:
  - **Agent Worker**: Runs an AI agent (e.g., Claude Code)
  - **Terminal Worker**: A plain terminal shell
- **Agent**: Definition of an AI tool (command, activity patterns, etc.). Claude Code is built-in; custom agents can be registered.

## Subagent Policy

**Primary agent MUST NOT write production code directly.** Delegate to specialist subagents defined in `.claude/agents/`. Each package's rule file (auto-loaded by path) specifies which specialist to use.

## Architecture

See [docs/design/session-worker-design.md](docs/design/session-worker-design.md) for detailed architecture and data models.

**Server is the source of truth.** The client should always follow the server's state, not make independent decisions about application state.

- Backend manages PTY processes that persist across browser reconnections (tmux-like)
- Frontend renders terminal state using xterm.js
- WebSocket provides real-time communication (see [docs/design/websocket-protocol.md](docs/design/websocket-protocol.md))
  - `/ws/app` - App-wide state synchronization
  - `/ws/session/:sessionId/worker/:workerId` - Individual worker I/O
