# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working Principles

**Purpose over speed.** Do not rush to finish quickly at the expense of losing sight of the original purpose. Code that fails to achieve its purpose wastes more time than code written correctly from the start.

**Do not blindly follow existing patterns.** Existing code is not automatically correct. Evaluate whether patterns in the codebase are appropriate before adopting them.

**Think before you act.** When facing a problem, first consider the correct approach rather than immediately implementing the easiest solution.

**Speak up about issues.** When you notice something inappropriate or problematic outside the current task scope, mention it as a supplementary note. Do not silently ignore issues just because they are not directly related to the task at hand.

## Subagent and Skill Usage Policy

**Primary agent as coordinator.** The primary agent (first launched) should focus on understanding user requirements, planning the overall approach, and coordinating work. Delegate actual implementation tasks to specialized subagents and skills.

**Delegate actual work to subagents.** Use subagents proactively for:

Built-in subagents:
- **Code exploration and search:** Use `Explore` subagent for codebase navigation and understanding
- **Implementation planning:** Use `Plan` subagent for designing complex changes
- **Code modifications:** Use `general-purpose` subagent for implementing features and fixes

User-defined subagents (in `~/.claude/agents/`):
- **Web research:** Use `web-research-specialist` subagent for technical documentation lookup

Project-defined subagents (in `.claude/agents/`):
- **Test execution:** Use `test-runner` subagent for running tests and analyzing failures
- **Test quality review:** Use `test-reviewer` subagent for evaluating test adequacy and coverage

**Propose missing subagents or skills.** When you identify a recurring task pattern that would benefit from a specialized subagent or skill but none exists, propose it to the user with a ready-to-use definition file.

Subagent definition format (user chooses where to save):
- `.claude/agents/<name>.md` - Project-specific (this repository only)
- `~/.claude/agents/<name>.md` - User-wide (available in all projects)
```markdown
---
name: test-runner
description: Execute tests for specific packages and analyze failures. Use when running tests or investigating test failures.
tools: Read, Grep, Glob, Bash
model: haiku
---

Run tests for the specified package. Analyze any failures and suggest fixes.
Report test coverage changes if applicable.
Focus on identifying root causes rather than just reporting errors.
```

Alternatively, use the `/agents` command to create subagents interactively.

Skills can be defined for complex workflows requiring multiple files, templates, or resources (user chooses where to save):
- `.claude/skills/` - Project-specific
- `~/.claude/skills/` - User-wide

**Parallel execution.** When multiple independent tasks exist, launch subagents in parallel to maximize efficiency.

## Language Policy

**Code and documentation:** Write all code comments, commit messages, issues, pull requests, and documentation (including files under `docs/`) in English.

**Communication with Claude:** Adapt to the user's preferred language. Respond in the same language the user uses.

## Development Workflow

**Branching:** Follow GitHub-Flow. Create feature branches from main, open pull requests for review, and merge after approval.

**Testing with code changes:** When modifying code, always update or add corresponding tests. Code changes without test coverage are incomplete.

**TDD for bug fixes:** When fixing bugs, apply Test-Driven Development where feasible. Write a failing test that reproduces the bug first, then implement the fix.

**Commit messages:** Use conventional commit format: `type: description`
- `feat:` new feature
- `fix:` bug fix
- `refactor:` code change without feature/fix
- `test:` adding or updating tests
- `docs:` documentation changes

## Commands

```bash
bun run dev        # Start development servers (uses AGENT_CONSOLE_HOME=$HOME/.agent-console-dev)
bun run build      # Build all packages
bun run test       # Run typecheck then tests
bun run test:only  # Run tests only (skip typecheck)
bun run typecheck  # Type check all packages
bun run lint       # Lint all packages
```

## Project Structure

Monorepo with Bun workspaces:
- `packages/client` - React frontend with Vite, TanStack Router, TanStack Query, and Tailwind CSS
- `packages/server` - Bun backend with Hono framework and native WebSocket
- `packages/shared` - Shared types and utilities

## TypeScript

- Avoid `any`. Use `unknown` with proper type guards only when the type is genuinely uncertain.
- Do not use `unknown` as a shortcut to bypass type checking. Casting through `unknown` (e.g., `value as unknown as TargetType`) is prohibited.
- Define shared types in `packages/shared`.

## Project Overview

A web application for managing multiple AI coding agent instances (Claude Code, etc.) running in different git worktrees. Instead of scattered terminals, users control all instances through a unified browser interface using xterm.js.

## Core Concepts

- **Session**: A working context tied to a worktree or arbitrary directory. Each session can have multiple workers.
- **Worker**: A PTY process running within a session. Two types:
  - **Agent Worker**: Runs an AI agent (e.g., Claude Code)
  - **Terminal Worker**: A plain terminal shell
- **Agent**: Definition of an AI tool (command, activity patterns, etc.). Claude Code is built-in; custom agents can be registered.

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

- **Backend** manages PTY processes that persist across browser reconnections (tmux-like)
- **Frontend** is React with TanStack Router, using xterm.js for terminal rendering
- **WebSocket** endpoints:
  - `/ws/dashboard` - Broadcasts session/worker lifecycle events
  - `/ws/sessions/:sessionId/workers/:workerId` - Individual worker I/O

## Key Technical Details

- AI agents require PTY (not regular spawn) because they are interactive TUIs
- xterm.js handles ANSI escape sequences from agents
- Resize events must be propagated to PTY
- Output buffering enables reconnection without losing history
- Activity detection: Parses agent output to determine state (active/idle/asking)

## WebSocket Message Protocol

### Worker Connection (`/ws/sessions/:sessionId/workers/:workerId`)

Client → Server:
- `{ type: 'input', data: string }` - Terminal input
- `{ type: 'resize', cols: number, rows: number }` - Terminal resize
- `{ type: 'image', data: string, mimeType: string }` - Image data (base64)

Server → Client:
- `{ type: 'output', data: string }` - PTY output
- `{ type: 'exit', exitCode: number, signal: string | null }` - Process exit
- `{ type: 'history', data: string }` - Buffered output on reconnect
- `{ type: 'activity', state: AgentActivityState }` - Agent activity state change (agent workers only)

### Dashboard Connection (`/ws/dashboard`)

Server → Client:
- `{ type: 'sessions-sync', sessions: [...] }` - Full session list sync
- `{ type: 'session-created', session: Session }` - New session created
- `{ type: 'session-updated', session: Session }` - Session updated
- `{ type: 'session-deleted', sessionId: string }` - Session deleted
- `{ type: 'worker-activity', sessionId, workerId, activityState }` - Worker activity state change

## Key Dependencies

- `bun-pty` - Pseudo-terminal for spawning agents (Bun native)
- `hono` - Web framework for Bun
- `@xterm/xterm` - Terminal rendering in browser
- `@tanstack/react-query` - Server state management
- `@tanstack/react-router` - File-based routing

## Testing

Follow the guidelines in [docs/testing-guidelines.md](docs/testing-guidelines.md).

### Verification Checklist

Before completing any code changes, always verify the following:

1. **Run tests:** Execute `bun run test` and ensure all tests pass.
2. **Run type check:** Execute `bun run typecheck` and ensure no type errors.
3. **Review test quality:** When tests are added or modified, use `test-reviewer` to evaluate adequacy and coverage.
4. **Manual verification (UI changes only):** When modifying UI components and Chrome DevTools MCP is available, perform manual testing through the browser to verify the changes work as expected.

**Important:** The main branch is always kept GREEN (all tests and type checks pass). If any verification fails, assume it is caused by your changes on the current branch and fix it before proceeding.
