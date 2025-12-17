# Development Workflow Standards

This document defines the development process rules that all implementation work must follow.

## Working Principles

**Purpose over speed.** Do not rush to finish quickly at the expense of losing sight of the original purpose. Code that fails to achieve its purpose wastes more time than code written correctly from the start.

**Do not blindly follow existing patterns.** Existing code is not automatically correct. Evaluate whether patterns in the codebase are appropriate before adopting them.

**Think before you act.** When facing a problem, first consider the correct approach rather than immediately implementing the easiest solution.

**Speak up about issues.** When you notice something inappropriate or problematic outside the current task scope, mention it as a supplementary note. Do not silently ignore issues just because they are not directly related to the task at hand.

## Branching Strategy (GitHub-Flow)

Follow GitHub-Flow:

1. Fetch the latest `origin/main` and create a feature branch from it
2. Make changes with descriptive commits
3. Open pull requests for review
4. Merge after approval

The `main` branch is always kept GREEN (all tests and type checks pass).

## Testing Requirements

**Testing with code changes.** When modifying code, always update or add corresponding tests. Code changes without test coverage are incomplete.

**TDD for bug fixes.** When fixing bugs, apply Test-Driven Development where feasible:
1. Write a failing test that reproduces the bug
2. Implement the fix
3. Verify the test passes

## Verification Checklist

Before completing any code changes, always verify:

1. **Run tests:** Execute `bun run test` and ensure all tests pass
2. **Run type check:** Execute `bun run typecheck` and ensure no type errors
3. **Review test quality:** When tests are added or modified, evaluate adequacy and coverage

If any verification fails, assume it is caused by your changes and fix it before proceeding.

## Commit Standards

Use conventional commit format: `type: description`

- `feat:` new feature
- `fix:` bug fix
- `refactor:` code change without feature/fix
- `test:` adding or updating tests
- `docs:` documentation changes

## Code Quality

**Avoid over-engineering.** Only make changes that are directly requested or clearly necessary. Keep solutions simple and focused.

- Don't add features, refactor code, or make "improvements" beyond what was asked
- A bug fix doesn't need surrounding code cleaned up
- A simple feature doesn't need extra configurability
- Don't add docstrings, comments, or type annotations to code you didn't change
- Only add comments where the logic isn't self-evident

**Avoid unnecessary complexity.**

- Don't add error handling, fallbacks, or validation for scenarios that can't happen
- Trust internal code and framework guarantees
- Only validate at system boundaries (user input, external APIs)
- Don't create helpers, utilities, or abstractions for one-time operations
- Don't design for hypothetical future requirements

**Clean up properly.**

- Avoid backwards-compatibility hacks like renaming unused `_vars`, re-exporting types, adding `// removed` comments
- If something is unused, delete it completely

## Language Policy

**Code and documentation:** Write all code comments, commit messages, and documentation in English.
