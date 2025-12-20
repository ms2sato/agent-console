# Repository Guidelines

## Project Structure & Module Organization
- Root uses Bun workspaces; run commands from the repo root unless noted.
- `packages/client/`: React + Vite UI (routes in `src/routes`, components/tests in `src/components` and `src/components/__tests__`).
- `packages/server/`: Bun + Hono API/websocket server, services under `src/services`, tests in `src/services/__tests__` and `src/lib/__tests__`.
- `packages/shared/`: TypeScript types/Valibot schemas consumed by client and server.
- `docs/`: Design/testing notes; `scripts/`: deployment helpers; `dist/`: built server bundle and static assets (generated).

## Build, Test, and Development Commands
- Install: `bun install` (workspace-aware).
- Dev (full stack): `bun dev` (runs filtered workspace dev scripts; frontend at 5173, backend at 3457).
- Build: `bun run build` (shared → client → server; outputs to `dist/`).
- Prod run after build: `bun start` or `NODE_ENV=production bun dist/index.js`.
- Type checks: `bun run typecheck` (all workspaces).
- Tests: `bun run test` for full suite; `bun run test:only` skips typecheck; workspace-specific `bun run --filter '@agent-console/server' test`, etc.

## Coding Style & Naming Conventions
- TypeScript everywhere; `tsconfig.base.json` enforces strict mode and no unuseds.
- Indent with 2 spaces; prefer named exports from module entry points.
- React components/hooks use PascalCase filenames (`SessionSettings.tsx`, `useAppWebSocket.ts`); tests mirror sources with `.test.ts`/`.test.tsx` in `__tests__` or alongside modules.
- Shared schemas/types live in `packages/shared/src`; keep API contracts there to avoid duplication.

## Testing Guidelines
- Default to `bun test`; client tests preload `src/test/setup.ts` (happy-dom + RTL); server/shared tests live under `__tests__`.
- Favor integration-style tests and communication-layer mocks (fetch/WebSocket/FS); avoid module-level mocks unless unavoidable—see `docs/testing-guidelines.md`.
- Forms need component-level tests to cover React Hook Form + Valibot wiring; add cases for hidden/conditional fields.

## Commit & Pull Request Guidelines
- Follow the existing conventional style seen in history (`feat:`, `fix:`, `refactor:`, etc.); write imperative, scoped messages.
- Include PR descriptions with context, linked issues, and risk notes; add screenshots/GIFs for UI changes and API notes for server changes.
- Run `bun run typecheck` and relevant `bun run test` before raising a PR; paste failures and rationale if something must be skipped.

## Communication
- Communicate in the user's natural language (match the user's input or inferred language).
- Write all public/shared text in English (issues/PRs, code comments, docs).
- Use GitHub for issues.
- You may use `gh` for GitHub issue/PR creation.

## Working Principles
- Purpose over speed. Do not rush to finish quickly at the expense of losing sight of the original purpose.
- Do not blindly follow existing patterns. Evaluate whether existing code is appropriate before adopting it.
- Think before you act. Consider the correct approach rather than immediately implementing the easiest solution.
- Speak up about issues. Mention noteworthy problems even if they are outside the immediate task scope.

## Development Workflow
- Follow GitHub-Flow; create feature branches from main and open PRs for review.
- When modifying code, update or add corresponding tests.
- For bug fixes, apply TDD when feasible: write a failing test first, then fix.
- Commit messages use conventional format: `type: description` (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).

## Commands
```bash
bun run dev        # Start development servers (uses AGENT_CONSOLE_HOME=$HOME/.agent-console-dev)
bun run build      # Build all packages
bun run test       # Run typecheck then tests
bun run test:only  # Run tests only (skip typecheck)
bun run typecheck  # Type check all packages
bun run lint       # Lint all packages
```

## TypeScript
- Avoid `any`. Use `unknown` with proper type guards only when the type is genuinely uncertain.
- Do not use `unknown` as a shortcut to bypass type checking.
- Define shared types in `packages/shared`.

## Schema Validation (Valibot)
Always add `minLength(1)` before regex validation to avoid confusing errors.

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
A web application for managing multiple AI coding agent instances running in different git worktrees.

## Core Concepts
- Session: Working context tied to a worktree or arbitrary directory. Each session can have multiple workers.
- Worker: PTY process within a session (Agent Worker or Terminal Worker).
- Agent: Definition of an AI tool (command, activity patterns). Claude Code is built-in; custom agents can be registered.

## Architecture
Backend (Bun + Hono) manages PTY processes and state; frontend (React + Vite) renders sessions and terminals using xterm.js.

## Client-Server Responsibility
- Server is the source of truth. Client follows server state and renders updates.
- Client sends user intent; server executes and broadcasts results.

## Key Technical Details
- AI agents require PTY (not regular spawn) because they are interactive TUIs.
- Resize events must be propagated to PTY.
- Output buffering enables reconnection without losing history.
- Activity detection parses agent output to determine state.

## WebSocket Message Protocol
See `docs/design/websocket-protocol.md`.

## Key Dependencies
- `bun-pty`, `hono`, `@xterm/xterm`, `@tanstack/react-query`, `@tanstack/react-router`

## Verification Checklist
- Run `bun run test` and ensure all tests pass.
- Run `bun run typecheck` and ensure no type errors.
- For UI changes, perform manual verification when possible.

## Reviewer Usage
Use reviewers to evaluate code before finalizing changes.
- `test-reviewer` when tests are added or modified.
- `code-quality-reviewer` for new features, refactors, or architectural decisions.
- `ux-architecture-reviewer` for state sync, WebSocket, persistence, or lifecycle changes.
