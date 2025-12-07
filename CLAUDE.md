# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working Principles

**Purpose over speed.** Do not rush to finish quickly at the expense of losing sight of the original purpose. Code that fails to achieve its purpose wastes more time than code written correctly from the start.

**Do not blindly follow existing patterns.** Existing code is not automatically correct. Evaluate whether patterns in the codebase are appropriate before adopting them.

**Think before you act.** When facing a problem, first consider the correct approach rather than immediately implementing the easiest solution.

**Speak up about issues.** When you notice something inappropriate or problematic outside the current task scope, mention it as a supplementary note. Do not silently ignore issues just because they are not directly related to the task at hand.

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
pnpm dev        # Start development servers
pnpm build      # Build all packages
pnpm test       # Run tests
pnpm typecheck  # Type check all packages
pnpm lint       # Lint all packages
```

## Project Structure

Monorepo with pnpm workspaces:
- `packages/client` - React frontend with TanStack Router
- `packages/server` - Node.js backend with Express + WebSocket
- `packages/shared` - Shared types and utilities

## TypeScript

- Avoid `any`. Use `unknown` with proper type guards only when the type is genuinely uncertain.
- Do not use `unknown` as a shortcut to bypass type checking. Casting through `unknown` (e.g., `value as unknown as TargetType`) is prohibited.
- Define shared types in `packages/shared`.

## Project Overview

A web application for managing multiple Claude Code instances running in different git worktrees. Instead of scattered terminals, users control all instances through a unified browser interface using xterm.js.

## Architecture

```
Backend (Node.js)              Frontend (Browser)
┌─────────────────────┐        ┌─────────────────────┐
│ sessions Map        │        │ xterm.js terminal   │
│ ├── WT1: {pty}     │◄──────►│ WebSocket client    │
│ ├── WT2: {pty}     │   WS   │                     │
│ └── WT3: {pty}     │        │                     │
└─────────────────────┘        └─────────────────────┘
```

- **Backend** manages PTY processes that persist across browser reconnections (tmux-like)
- **Frontend** is React with TanStack Router, using xterm.js for terminal rendering
- **WebSocket** protocol for bidirectional terminal I/O

## Key Technical Details

- Claude Code requires PTY (not regular spawn) because it's an interactive TUI
- xterm.js handles ANSI escape sequences from Claude Code
- Resize events must be propagated to PTY (`claude.resize(cols, rows)`)
- Output buffering enables reconnection without losing history

## WebSocket Message Protocol

Client → Server:
- `{ type: 'input', data: string }` - Terminal input
- `{ type: 'resize', cols: number, rows: number }` - Terminal resize

Server → Client:
- `{ type: 'output', data: string }` - PTY output
- `{ type: 'exit', exitCode: number, signal: string }` - Process exit
- `{ type: 'history', data: string }` - Buffered output on reconnect

## Dependencies

- `node-pty` - Pseudo-terminal for spawning Claude Code
- `ws` - WebSocket server
- `@xterm/xterm` - Terminal rendering in browser

## Testing

Follow the guidelines in [docs/testing-guidelines.md](docs/testing-guidelines.md).

### Verification Checklist

Before completing any code changes, always verify the following:

1. **Run tests:** Execute `pnpm test` and ensure all tests pass.
2. **Run type check:** Execute `pnpm typecheck` and ensure no type errors.
3. **Manual verification:** When Chrome DevTools MCP is available, perform manual testing through the browser to verify the changes work as expected.

**Important:** The main branch is always kept GREEN (all tests and type checks pass). If any verification fails, assume it is caused by your changes on the current branch and fix it before proceeding.
