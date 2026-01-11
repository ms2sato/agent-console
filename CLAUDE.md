# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working Principles

**Purpose over speed.** Do not rush to finish quickly at the expense of losing sight of the original purpose. Code that fails to achieve its purpose wastes more time than code written correctly from the start.

**Do not blindly follow existing patterns.** Existing code is not automatically correct. Evaluate whether patterns in the codebase are appropriate before adopting them.

**Think before you act.** When facing a problem, first consider the correct approach rather than immediately implementing the easiest solution.

**Speak up about issues.** When you notice something inappropriate or problematic outside the current task scope, mention it as a supplementary note. Do not silently ignore issues just because they are not directly related to the task at hand.

**Ask when uncertain.** When uncertain about a design decision, do not decide arbitrarily. Ask the user for confirmation.

**Validate task assumptions before implementing.** Before implementing any task, understand WHY the task is needed. If a task assumes existing behavior that seems questionable, verify whether that assumption is correct. Do not implement a "fix" for behavior that may not actually need fixing. When in doubt, ask the user to confirm the underlying assumption.

## Design Review Mindset

The following are perspectives to revisit repeatedly during design. This is not a one-way checklist.

- Is the existing pattern truly appropriate?
  - Are you following it just because other code does so?
  - When uncertain, ask the user

- Have you considered abstraction? Have you judged whether it is truly necessary after attempting it?
  - Do not avoid abstraction; judge its necessity after considering it

- Is the placement appropriate?
  - Module-specific or shared?
  - Does it align with the scope of responsibility?

- Is the interface actually usable?
  - Is the design such that callers cannot pass the information they need?

- Does the naming cause misunderstanding in context?
  - Can you predict the value from the name?
  - Is it consistent with existing naming conventions in the codebase?

- Do default values contradict state?
  - Does the default value make sense when other fields are unset?

- Is there anything unnecessary? Can it be deleted?
  - Prioritize deletion over addition

## Subagent and Skill Usage Policy

**Primary agent as coordinator.** The primary agent (first launched) MUST NOT write code directly. Instead:
1. Understand user requirements
2. Plan the approach
3. Delegate implementation to specialist subagents
4. Evaluate results and coordinate next steps

**MUST delegate code changes to specialists:**

| File Location | Subagent to Use |
|---------------|-----------------|
| `packages/client/**` | `frontend-specialist` |
| `packages/server/**` | `backend-specialist` |
| `packages/shared/**` | Choose based on primary consumer |
| Multiple packages | Launch both specialists in parallel |

**Other subagents:**

Built-in:
- `Explore` - Codebase navigation and understanding
- `Plan` - Designing complex changes

Project-defined (`.claude/agents/`):
- `frontend-specialist` - Implementing frontend features and fixes in packages/client
- `backend-specialist` - Implementing backend features and fixes in packages/server
- `test-runner` - Running tests and analyzing failures
- `test-reviewer` - Evaluating test adequacy (use after tests are modified)
- `code-quality-reviewer` - Evaluating design and maintainability
- `ux-architecture-reviewer` - Verifying state consistency in client-server interactions
- `claude-config-specialist` - Analyzing and improving Claude Code configuration (.claude/, CLAUDE.md)

Project-defined skills (in `.claude/skills/`):
- **Development workflow standards:** `.claude/skills/development-workflow-standards/` - Development process rules (testing, branching, commits)
- **Code quality standards:** `.claude/skills/code-quality-standards/` - Evaluation criteria for code reviews
- **Frontend standards:** `.claude/skills/frontend-standards/` - React patterns and frontend best practices
- **Backend standards:** `.claude/skills/backend-standards/` - Hono/Bun patterns and backend best practices
- **Test standards:** `.claude/skills/test-standards/` - Testing best practices and anti-patterns

**Parallel execution.** When changes span multiple packages, launch specialists in parallel:
- Frontend and backend changes → `frontend-specialist` + `backend-specialist` simultaneously
- After implementation → `test-runner` for verification

**Propose missing subagents or skills.** When you identify a recurring task pattern that would benefit from a specialized subagent or skill but none exists, propose it to the user. Use `/agents` command to create interactively.

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
- Always use `async/await`. Avoid fire-and-forget patterns (calling async functions without awaiting). See frontend-standards and backend-standards for detailed rules.

## Schema Validation (Valibot)

**Always add `minLength(1)` before regex validation.** When an empty string reaches a regex, it fails with a confusing error message (e.g., "Invalid branch name" instead of "Branch name is required"). Users cannot understand what to fix.

```typescript
// ❌ Bug: empty string shows "Invalid branch name"
v.pipe(
  v.string(),
  v.regex(branchNamePattern, branchNameErrorMessage)
)

// ✅ Correct: empty string shows "Branch name is required"
v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, 'Branch name is required'),
  v.regex(branchNamePattern, branchNameErrorMessage)
)
```

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
  - `/ws/app` - Broadcasts session/worker lifecycle events (app-wide state sync)
  - `/ws/session/:sessionId/worker/:workerId` - Individual worker I/O

### Client-Server Responsibility

**Server is the source of truth.** The client should always follow the server's state, not make independent decisions about application state.

- **Session/Worker lifecycle:** Server creates, manages, and destroys sessions and workers. Client only displays what server provides.
- **State synchronization:** Client receives state updates via WebSocket and renders accordingly. No client-side state that contradicts server.
- **User actions:** Client sends user intent to server (e.g., "create session"), server executes and broadcasts result.
- **Terminal caching:** Client caches terminal state in IndexedDB for UX optimization (instant tab switching), but always syncs with server to get updates since the cached offset. Cache is a performance optimization, not a source of truth.

## Key Technical Details

- AI agents require PTY (not regular spawn) because they are interactive TUIs
- xterm.js handles ANSI escape sequences from agents
- Resize events must be propagated to PTY
- Output buffering enables reconnection without losing history
- Activity detection: Parses agent output to determine state (active/idle/asking)
- Terminal state caching: IndexedDB stores terminal state for instant restore on tab switch (see [terminal-state-sync.md](docs/design/terminal-state-sync.md))

## WebSocket Message Protocol

See [docs/design/websocket-protocol.md](docs/design/websocket-protocol.md) for detailed protocol specification.

- `/ws/app` - App-wide state synchronization (sessions, worker activity)
- `/ws/session/:sessionId/worker/:workerId` - Individual worker I/O

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
3. **Manual verification (UI changes only):** When modifying UI components and Chrome DevTools MCP is available, perform manual testing through the browser to verify the changes work as expected.

**Important:** The main branch is always kept GREEN (all tests and type checks pass). If any verification fails, assume it is caused by your changes on the current branch and fix it before proceeding.

### Reviewer Usage

Use reviewers to evaluate code before finalizing changes. Run applicable reviewers in parallel for efficiency.

| Reviewer | When to Use |
|----------|-------------|
| `test-reviewer` | **Always** when tests are added or modified (code changes require test changes) |
| `code-quality-reviewer` | New features, refactoring, or architectural decisions |
| `ux-architecture-reviewer` | State synchronization, WebSocket, persistence, or session/worker lifecycle changes |

Each reviewer focuses on a specific aspect:
- **test-reviewer**: Test validity, coverage, methodology, anti-patterns
- **code-quality-reviewer**: Design, maintainability, patterns (React and Backend)
- **ux-architecture-reviewer**: UI accurately represents system state, edge case handling
