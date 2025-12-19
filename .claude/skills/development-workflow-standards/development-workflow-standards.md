# Development Workflow Standards

This document defines the development process rules that all implementation work must follow.

## Working Principles

See [CLAUDE.md](/CLAUDE.md#working-principles) for the canonical definition. Summary:

- **Purpose over speed** - Don't rush; code that fails its purpose wastes more time
- **Don't blindly follow patterns** - Evaluate existing code before adopting
- **Think before acting** - Consider the correct approach first
- **Speak up about issues** - Mention problems even outside task scope

## Branching Strategy (GitHub-Flow)

Follow GitHub-Flow. The `main` branch is always kept GREEN (all tests and type checks pass).

### Starting Work (Branch Creation)

Before creating a feature branch, **always fetch and sync with the latest main**:

```bash
# 1. Fetch the latest changes from remote
git fetch origin

# 2. Create a new branch from the latest origin/main
git checkout -b feature/your-feature origin/main
```

**Important:** Never branch from a stale local main. Always use `origin/main` after fetching.

### During Development

1. Make changes with descriptive commits
2. Run verification checklist before considering work complete

### Before Completing Work (Conflict Assessment)

Before opening a pull request, **always check for conflicts with the latest main**:

```bash
# 1. Fetch latest changes
git fetch origin

# 2. Check diff with latest main
git diff origin/main...HEAD --stat

# 3. Check for potential conflicts
git merge-tree $(git merge-base origin/main HEAD) origin/main HEAD
```

**Conflict Assessment Criteria:**

| Conflict Level | Criteria | Action |
|----------------|----------|--------|
| **None/Minor** | No conflicts, or simple conflicts in 1-2 files (e.g., import additions) | Proceed with merge/rebase |
| **Moderate** | Conflicts in 3-5 files, but changes are isolated | Attempt rebase, resolve carefully |
| **Severe** | Conflicts in core files you modified, or structural changes to same components | **Propose re-implementation** |

**When to propose re-implementation:**

- The main branch has significant changes to files you heavily modified
- The architectural approach in main has diverged from your implementation
- Resolving conflicts would require understanding and integrating unfamiliar changes
- The merge resolution effort approaches or exceeds the original implementation effort

**Re-implementation proposal format:**

> ⚠️ **Conflict Assessment Result**
>
> Significant changes have been made to `main` that conflict with this implementation:
> - [List conflicting files and nature of changes]
> - [Explain why re-implementation is recommended over merge resolution]
>
> **Recommendation:** Re-implement on a fresh branch from latest `main` to ensure:
> - Clean integration with current codebase state
> - No risk of regression from incorrect merge resolution
> - Opportunity to leverage any new patterns introduced in main

### Pull Request

1. Open pull requests for review
2. **Merging is the user's responsibility** - Never merge PRs automatically. Always leave the merge decision to the user.

## Testing Requirements

**Testing with code changes.** When modifying code, always update or add corresponding tests. Code changes without test coverage are incomplete.

**TDD for bug fixes.** When fixing bugs, apply Test-Driven Development where feasible:
1. Write a failing test that reproduces the bug
2. Implement the fix
3. Verify the test passes

Example:
```typescript
// 1. Write failing test that reproduces the bug
it('should handle session with no workers without crashing', () => {
  const session = createSession({ workers: [] });
  // Bug: getActiveWorker() throws when workers array is empty
  expect(() => session.getActiveWorker()).not.toThrow();
  expect(session.getActiveWorker()).toBeNull();
});

// 2. Run test - it fails (confirms bug exists)
// 3. Implement fix in production code
// 4. Run test - it passes (confirms bug is fixed)
```

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
