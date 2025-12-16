# Copilot Instructions

This file provides guidance to GitHub Copilot when working with code in this repository.

## Project Overview

A web application for managing multiple AI coding agent instances (Claude Code, etc.) running in different git worktrees. Users control all instances through a unified browser interface using xterm.js instead of scattered terminals.

## Technology Stack

**Runtime:** Bun (JavaScript runtime)

**Backend:**
- Hono - Web framework for Bun
- bun-pty - Pseudo-terminal for spawning agents
- Native WebSocket

**Frontend:**
- React 18
- Vite - Build tool
- TanStack Router - File-based routing
- TanStack Query - Server state management
- Tailwind CSS - Styling
- xterm.js - Terminal rendering

**Testing:** Bun test runner with Vitest-compatible API

## Project Structure

Monorepo with Bun workspaces:

```
packages/
  client/   - React frontend with Vite
  server/   - Bun backend with Hono framework
  shared/   - Shared types and utilities
```

## Core Concepts

- **Session**: A working context tied to a worktree or directory. Each session can have multiple workers.
- **Worker**: A PTY process running within a session (AgentWorker or TerminalWorker).
- **Agent**: Definition of an AI tool (command, activity patterns). Claude Code is built-in; custom agents can be registered.

## Commands

```bash
bun run dev        # Start development servers
bun run build      # Build all packages
bun run test       # Run typecheck then tests
bun run test:only  # Run tests only (skip typecheck)
bun run typecheck  # Type check all packages
bun run lint       # Lint all packages
```

## Coding Guidelines

**TypeScript:**
- Avoid `any`. Use `unknown` with proper type guards only when the type is genuinely uncertain.
- Do not cast through `unknown` (e.g., `value as unknown as TargetType`).
- Define shared types in `packages/shared`.

**Testing:**
- All code changes require corresponding tests.
- When fixing bugs, write a failing test first (TDD).
- Follow the guidelines in `docs/testing-guidelines.md`.

**Commits:**
- Use conventional commit format: `type: description`
- Types: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`

**Language:**
- Write all code comments and documentation in English.

## Architecture

```
Backend (Bun + Hono)                Frontend (React + Vite)
┌──────────────────────────┐        ┌──────────────────────────┐
│ SessionManager           │        │ Dashboard                │
│ ├── Session1             │        │ ├── SessionList          │
│ │   ├── AgentWorker     │◄──────►│ │   └── WorkerTabs       │
│ │   └── TerminalWorker   │  WS   │ └── Terminal (xterm.js)  │
│ └── Session2             │        │                          │
│     └── AgentWorker      │        │                          │
└──────────────────────────┘        └──────────────────────────┘
```

**WebSocket endpoints:**
- `/ws/app` - Broadcasts session/worker lifecycle events (app-wide state sync)
- `/ws/session/:sessionId/worker/:workerId` - Individual worker I/O

## Key Technical Details

- AI agents require PTY (not regular spawn) because they are interactive TUIs.
- xterm.js handles ANSI escape sequences from agents.
- Resize events must be propagated to PTY.
- Output buffering enables reconnection without losing history.
- Activity detection parses agent output to determine state (active/idle/asking).

## Boundaries

**Always:**
- Write tests for new features and bug fixes.
- Follow TypeScript strict mode.
- Use conventional commit format.

**Never:**
- Use `any` type without explicit justification.
- Commit secrets or credentials.
- Skip type checking.
