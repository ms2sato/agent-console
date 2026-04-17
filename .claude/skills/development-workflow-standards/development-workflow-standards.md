# Development Workflow Standards (Procedural Detail)

> See [rules/workflow.md](../../rules/workflow.md) for the declarative rules (verification checklist, branching strategy, testing requirements, commit standards, code quality, language policy, Claude Code on the Web essentials). This document covers procedural detail and decision frameworks that are too long for an auto-loaded rule.

## Conflict Assessment Before PR

Before opening a pull request, check for conflicts with the latest main:

```bash
# 1. Fetch latest changes
git fetch origin

# 2. Check diff with latest main
git diff origin/main...HEAD --stat

# 3. Check for potential conflicts
git merge-tree $(git merge-base origin/main HEAD) origin/main HEAD
```

### Conflict Assessment Criteria

| Conflict Level | Criteria | Action |
|----------------|----------|--------|
| **None/Minor** | No conflicts, or simple conflicts in 1-2 files (e.g., import additions) | Proceed with merge/rebase |
| **Moderate** | Conflicts in 3-5 files, but changes are isolated | Attempt rebase, resolve carefully |
| **Severe** | Conflicts in core files you modified, or structural changes to same components | **Propose re-implementation** |

### When to Propose Re-Implementation

- The main branch has significant changes to files you heavily modified
- The architectural approach in main has diverged from your implementation
- Resolving conflicts would require understanding and integrating unfamiliar changes
- The merge resolution effort approaches or exceeds the original implementation effort

### Re-Implementation Proposal Format

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

## TDD for Bug Fixes — Worked Example

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

The value of step 1 is not just "write a test" — it is *proving that the test catches the bug before you touch production code*. A green test after the fix does not guarantee coverage of the original bug; a failing test before the fix does.

## Claude Code on the Web — Full Setup

The declarative summary is in the rule. This is the full operational setup.

Required custom-environment configuration:

- **`GH_TOKEN`**: set in the custom environment variables. The `gh` CLI recognizes this automatically; no additional login step.
- **Network access**: if using custom network mode, add `release-assets.githubusercontent.com` to the allowlist so `gh` can download release artifacts.

The `gh` CLI is installed automatically by the `SessionStart` hook at `.claude/hooks/gh-setup.sh` on each web session.

Due to the sandbox proxy, `gh` commands always require the `-R owner/repo` flag explicitly. For this repository:

```bash
gh issue list -R ms2sato/agent-console
gh pr list -R ms2sato/agent-console
gh pr view 123 -R ms2sato/agent-console
gh pr diff 123 -R ms2sato/agent-console
```

Omitting `-R` yields an opaque proxy error, not the usual "not a git repository" message. If a `gh` command fails in an unexpected way in the web environment, the first thing to check is whether `-R` was supplied.
