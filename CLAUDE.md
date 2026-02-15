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

- Is the module cohesive?
  - Does each file/class/module have a single, clear responsibility?
  - If you removed any part, would the rest still make sense as a unit?
  - Would you name this module the same way after reading all its contents?

- Is coupling minimized?
  - Can this module change without forcing changes elsewhere?
  - Does this module depend on implementation details of another?
  - Would a new team member understand this module without reading its dependencies?

- Is the interface well-encapsulated?
  - Does the public API reveal only what callers need?
  - Are implementation details hidden behind stable interfaces?
  - Can the internal implementation change without affecting callers?

- Is the dependency direction correct?
  - Do high-level modules depend on low-level details? (They shouldn't)
  - Are dependencies explicit (imports) rather than implicit (global state, conventions)?

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
- `coderabbit-reviewer` - External AI review via CodeRabbit CLI (optional, skips if CLI not installed)

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

## Project Structure

Monorepo with Bun workspaces:
- `packages/client` - React frontend with Vite, TanStack Router, TanStack Query, and Tailwind CSS
- `packages/server` - Bun backend with Hono framework and native WebSocket
- `packages/shared` - Shared types and utilities

## Project Overview

A web application for managing multiple AI coding agent instances (Claude Code, etc.) running in different git worktrees. Instead of scattered terminals, users control all instances through a unified browser interface using xterm.js.

## Core Concepts

- **Session**: A working context tied to a worktree or arbitrary directory. Each session can have multiple workers.
- **Worker**: A PTY process running within a session. Two types:
  - **Agent Worker**: Runs an AI agent (e.g., Claude Code)
  - **Terminal Worker**: A plain terminal shell
- **Agent**: Definition of an AI tool (command, activity patterns, etc.). Claude Code is built-in; custom agents can be registered.

## Architecture

See [docs/design/session-worker-design.md](docs/design/session-worker-design.md) for detailed architecture and data models.

**Server is the source of truth.** The client should always follow the server's state, not make independent decisions about application state.

- Backend manages PTY processes that persist across browser reconnections (tmux-like)
- Frontend renders terminal state using xterm.js
- WebSocket provides real-time communication (see [docs/design/websocket-protocol.md](docs/design/websocket-protocol.md))
  - `/ws/app` - App-wide state synchronization
  - `/ws/session/:sessionId/worker/:workerId` - Individual worker I/O

## Reference

Details for each domain are defined in their respective skills and docs. CLAUDE.md intentionally does NOT duplicate skill content — each skill is the single source of truth for its domain.

| Topic | Source |
|-------|--------|
| Development workflow (branching, testing, commits, commands) | `development-workflow-standards` skill |
| Code quality (design principles, TypeScript, module evaluation) | `code-quality-standards` skill |
| Frontend (React, TanStack, Tailwind, Valibot) | `frontend-standards` skill |
| Backend (Hono, Bun, PTY, WebSocket, logging) | `backend-standards` skill |
| Testing (methodology, anti-patterns, boundary testing) | `test-standards` skill |
| WebSocket protocol specification | [docs/design/websocket-protocol.md](docs/design/websocket-protocol.md) |
| Terminal state sync design | [docs/design/terminal-state-sync.md](docs/design/terminal-state-sync.md) |
| Session/Worker data model | [docs/design/session-worker-design.md](docs/design/session-worker-design.md) |
| Testing guidelines (human reference) | [docs/testing-guidelines.md](docs/testing-guidelines.md) |
