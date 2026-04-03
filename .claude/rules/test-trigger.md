---
globs:
  - "packages/server/src/routes/**/*.ts"
  - "packages/server/src/services/**/*.ts"
  - "packages/client/src/hooks/**/*.ts"
  - "packages/client/src/components/**/*.tsx"
  - "packages/shared/src/**/*.ts"
  - "!**/*.test.ts"
  - "!**/*.test.tsx"
  - "!**/__tests__/**"
---

# Test Coverage Requirement

When modifying production files matching these patterns, corresponding test files **must** be added or updated.

## Expected Test File Locations

| File Pattern | Expected Test Location |
|-------------|------------------------|
| `packages/server/src/routes/*.ts` | `packages/server/src/routes/__tests__/*.test.ts` |
| `packages/server/src/services/*.ts` | `packages/server/src/services/__tests__/*.test.ts` |
| `packages/client/src/hooks/*.ts` | `packages/client/src/hooks/__tests__/*.test.ts` |
| `packages/client/src/components/**/*.tsx` | `packages/client/src/components/**/__tests__/*.test.tsx` |
| `packages/shared/src/**/*.ts` | `packages/shared/src/**/__tests__/*.test.ts` |

## Before Creating a PR

Run the coverage check to verify all production files have corresponding tests:

```bash
node .claude/skills/orchestrator/acceptance-check.js <PR-number> --check-only
```

If any gaps are detected (non-zero exit code), add the missing tests before proceeding.
