---
globs:
  - "packages/server/src/routes/**/*.ts"
  - "packages/server/src/services/**/*.ts"
  - "packages/client/src/hooks/**/*.ts"
  - "packages/client/src/components/**/*.tsx"
  - "packages/shared/src/**/*.ts"
  - "packages/embedded-agent/src/**/*.ts"
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
| `packages/embedded-agent/src/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `.claude/hooks/**/*.sh` | `.claude/hooks/__tests__/*.test.mjs` or sibling `*.test.mjs` |

## Exceptions

- **`packages/integration/src/`** uses a flat sibling layout (no `__tests__/` directory). This is deliberate: the package contains no production code — its entire `src/` is test infrastructure (`setup.ts`, `test-utils.ts`) and boundary tests (`*-boundary.test.ts(x)`). Do not move these files into a `__tests__/` subdirectory.
- **`*.gen.ts` / `*.gen.tsx`** files are build-time generated (e.g. `packages/shared/src/schema-version.gen.ts` emitted by a codegen step). Their contents derive from an authoritative source at build time, so a hand-written sibling test would be tautological — test the generator, not its emitted output. The exclusion is anchored on the `.gen.<ext>$` suffix; files like `generator.ts` (substring "gen", no `.gen.` suffix) still require coverage.
- **Bare `types.ts` / `types.tsx` as a full path segment** are module-level type-definitions files colocated with their consumers (a natural React / Node.js convention — e.g. `packages/embedded-agent/src/tools/types.ts`). Same rationale as the `-types.ts` convention above: the type system enforces shape at consume sites. Exclusion is anchored on the segment boundary, so files like `mytypes.ts` (mid-segment match) or `type.ts` (singular, may contain runtime enums / factories) still require coverage.

## Before Creating a PR

Run the coverage check to verify all production files have corresponding tests:

```bash
# With a PR number (uses gh pr diff):
node .claude/skills/orchestrator/preflight-check.js <PR-number>

# Without a PR number (uses local git diff against origin/main):
node .claude/skills/orchestrator/preflight-check.js
```

If any gaps are detected (non-zero exit code), add the missing tests before proceeding.

## Mirror Maintenance

The patterns above are a **markdown mirror** of the executable single-writer `COVERAGE_PATTERNS` in `.claude/skills/orchestrator/check-utils.js` (the source of truth used by `preflight-check.js`). When updating one, update the other in the same PR.

Drift between the two is detected mechanically by `.claude/skills/orchestrator/check-mirror-drift.js` (CI workflow: `.github/workflows/check-mirror-drift.yml`). To verify locally:

```bash
node .claude/skills/orchestrator/check-mirror-drift.js
```

The check normalizes the regex `^DIR\/.+\.EXT$` shape to its glob `DIR/**/*.EXT` equivalent and compares against both the markdown table above and the YAML `globs:` frontmatter. Negation entries in the YAML (`!**/*.test.ts`, `!**/__tests__/**`) mirror the `isTestFile()` helper rather than `COVERAGE_PATTERNS`, and are excluded from the comparison. (Issue #752)
