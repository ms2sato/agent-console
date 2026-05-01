---
globs:
  - "packages/server/src/routes/**/*.ts"
  - "packages/server/src/services/**/*.ts"
  - "packages/client/src/hooks/**/*.ts"
  - "packages/client/src/components/**/*.tsx"
  - "packages/shared/src/**/*.ts"
  - ".claude/hooks/**/*.sh"
  - "!**/*.test.ts"
  - "!**/*.test.tsx"
  - "!**/*.test.mjs"
  - "!**/__tests__/**"
---

# Test Coverage Requirement

When modifying production files matching these patterns, corresponding test files **must** be added or updated.

## Expected Test File Locations

| File Pattern | Expected Test Location |
|-------------|------------------------|
| `packages/server/src/routes/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `packages/server/src/services/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `packages/client/src/hooks/**/*.ts` | `.../__tests__/*.test.ts(x)` or sibling `*.test.ts(x)` |
| `packages/client/src/components/**/*.tsx` | `.../__tests__/*.test.tsx` or sibling `*.test.tsx` |
| `packages/shared/src/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `.claude/hooks/**/*.sh` | `.claude/hooks/__tests__/*.test.mjs` or sibling `*.test.mjs` |

## Exceptions

- **`packages/integration/src/`** uses a flat sibling layout (no `__tests__/` directory). This is deliberate: the package contains no production code — its entire `src/` is test infrastructure (`setup.ts`, `test-utils.ts`) and boundary tests (`*-boundary.test.ts(x)`). Do not move these files into a `__tests__/` subdirectory.

## Before Creating a PR

Run the coverage check to verify all production files have corresponding tests:

```bash
# With a PR number (uses gh pr diff):
node .claude/skills/orchestrator/preflight-check.js <PR-number>

# Without a PR number (uses local git diff against origin/main):
node .claude/skills/orchestrator/preflight-check.js
```

If any gaps are detected (non-zero exit code), add the missing tests before proceeding.
