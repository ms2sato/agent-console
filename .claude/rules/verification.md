# Verification and Workflow Rules

These rules apply to all code changes in this project.

## Verification Checklist

Before completing any code changes, always verify:

1. **Run tests:** Execute `bun run test` and ensure all tests pass
2. **Run type check:** Execute `bun run typecheck` and ensure no type errors
3. **Review test quality:** When tests are added or modified, evaluate adequacy and coverage
4. **Manual verification (UI changes only):** When modifying UI components and Chrome DevTools MCP is available, perform manual testing through the browser
5. **Duplication check:** When adding or modifying logic, grep the repository for the core processing part (method chains, regex patterns, transformation expressions) with variable names removed. For example, search for `.replace(/\r?\n/g, '\r')` rather than `content.replace(...)`. If hits are found, review whether they represent the same concern and should be consolidated into a shared function.

6. **Shell script execution test:** When adding or modifying shell scripts (`scripts/*.sh`), execute them locally on macOS before committing. CI does not cover shell scripts. Watch for BSD/GNU incompatibilities (e.g., `sed -E` with non-greedy `+?` is not portable). (Lesson: Sprint 2026-04-05c — `upload-qa-screenshots.sh` had 2 bugs only caught at runtime.)

**CRITICAL: Verify BEFORE pushing.** Do NOT push code to the remote until `bun run typecheck` and `bun run test` both pass locally. Pushing unverified code wastes CI cycles and blocks other developers. If pre-existing errors exist that are unrelated to your changes, note them explicitly in your commit message or report.

**Important:** The main branch is always kept GREEN (all tests and type checks pass). If any verification fails, assume it is caused by your changes on the current branch and fix it before proceeding.

## Commands

```bash
bun run dev        # Start development servers (uses AGENT_CONSOLE_HOME=$HOME/.agent-console-dev)
bun run build      # Build all packages
bun run test       # Run typecheck then tests
bun run test:only  # Run tests only (skip typecheck)
bun run typecheck  # Type check all packages
bun run lint       # Lint all packages
```

### Environment Configuration

**Before starting `bun run dev`:** Check `.env` for port configuration. Each worktree may use different ports to avoid conflicts.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3457 | Backend server port |
| `CLIENT_PORT` | 5173 | Frontend dev server port |
| `AGENT_CONSOLE_HOME` | ~/.agent-console-dev | Data directory |

## Branching Strategy (GitHub-Flow)

Follow GitHub-Flow. The `main` branch is always kept GREEN.

- **Always fetch and branch from `origin/main`:** Never branch from a stale local main. Always `git fetch origin` then `git checkout -b feature/your-feature origin/main`.
- **Conflict assessment before PR:** Always check conflicts with latest main before opening a PR.
- **Never merge PRs:** Merging is always the user's decision.

## Testing Requirements

- **Testing with code changes:** Always update or add tests. Code without tests is incomplete.
- **TDD for bug fixes:** Write a failing test first, then implement the fix.

## Commit Standards

Use conventional commit format: `type: description`

- `feat:` new feature
- `fix:` bug fix
- `refactor:` code change without feature/fix
- `test:` adding or updating tests
- `docs:` documentation changes

### CI Must Mirror Local Commands

CI must run the same build and test commands as local development (`bun run build`, `bun run test`). Never add CI-only workaround steps that mask broken local workflows. If CI needs an extra step to pass, it means the local scripts are broken — fix the scripts, not CI.

### Skipping CI with `[skip ci]`

Use `[skip ci]` only for commits that **only** change non-production files (`docs/**`, `.claude/skills/**`, `.claude/agents/**`, `CLAUDE.md`). Do not use if the commit includes production code or test changes.

## Code Quality

**Avoid over-engineering.** Only make changes that are directly requested or clearly necessary.

- Don't add features, refactor code, or make "improvements" beyond what was asked
- Don't add docstrings, comments, or type annotations to code you didn't change
- Only add comments where the logic isn't self-evident

**Avoid unnecessary complexity.**

- Don't add error handling, fallbacks, or validation for scenarios that can't happen
- Trust internal code and framework guarantees
- Only validate at system boundaries (user input, external APIs)
- Don't create helpers, utilities, or abstractions for one-time operations

**Clean up properly.**

- If something is unused, delete it completely
- Avoid backwards-compatibility hacks

## Design Documents as Specification

Design documents (`docs/design/`) are specifications. Code is their implementation. Update the design document FIRST as the spec, then implement code to match. The spec and implementation must never silently diverge.

## Language Policy

**Public artifacts:** Write all code comments, commit messages, issues, pull requests, and documentation in English.

**User-facing artifacts:** Review annotations, memos, and other content visible only to the user should follow the user's preferred language.

**Communication:** Respond in the same language the user uses. Technical terms and code identifiers can remain in English.

## Claude Code on the Web (Remote Environment)

When running in Claude Code on the Web, `gh` CLI is automatically installed via a SessionStart hook. Due to the sandbox proxy, `gh` commands require the `-R owner/repo` flag explicitly (`-R ms2sato/agent-console`).
