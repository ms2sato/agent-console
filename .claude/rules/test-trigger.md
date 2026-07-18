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
| `packages/client/src/components/**/*.tsx` | `.../__tests__/*.test.tsx` or sibling `*.test.tsx` (a JSX-free pure-logic test may instead use `*.test.ts`, e.g. `SessionPage.test.ts` alongside `SessionPage.tsx`) |
| `packages/shared/src/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `packages/embedded-agent/src/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `.claude/hooks/**/*.sh` | `.claude/hooks/__tests__/*.test.mjs` or sibling `*.test.mjs` |

## Exceptions

- **`packages/integration/src/`** uses a flat sibling layout (no `__tests__/` directory). This is deliberate: the package contains no production code — its entire `src/` is test infrastructure (`setup.ts`, `test-utils.ts`) and boundary tests (`*-boundary.test.ts(x)`). Do not move these files into a `__tests__/` subdirectory.
- **`*.gen.ts` / `*.gen.tsx`** files are build-time generated (e.g. `packages/shared/src/schema-version.gen.ts` emitted by a codegen step). Their contents derive from an authoritative source at build time, so a hand-written sibling test would be tautological — test the generator, not its emitted output. The exclusion is anchored on the `.gen.<ext>$` suffix; files like `generator.ts` (substring "gen", no `.gen.` suffix) still require coverage.
- **Bare `types.ts` / `types.tsx` as a full path segment** are module-level type-definitions files colocated with their consumers (a natural React / Node.js convention — e.g. `packages/embedded-agent/src/tools/types.ts`). Same rationale as the `-types.ts` convention above: the type system enforces shape at consume sites. Exclusion is anchored on the segment boundary, so files like `mytypes.ts` (mid-segment match) or `type.ts` (singular, may contain runtime enums / factories) still require coverage.
- **Comment-only diffs** are exempted content-based, not path-based (Issue #1189). For each production file matching a coverage pattern, `preflight-check.js` inspects the file's actual diff hunks against the base branch (`git diff --unified=0`); if every added/removed line is a comment (`//`, `/* */` block, or `#` for `.sh`) or blank, the sibling-test requirement is skipped for that file. A mixed diff (any real code line alongside comment changes) still requires a sibling test. This exception cannot be expressed as a glob and is intentionally excluded from `check-mirror-drift.js`'s comparison, same as the `isTestFile()` negation entries above.

## Additional Verification: Preview Sandbox Real-Browser Check

PRs touching `packages/client/src/lib/preview-sandbox.ts`, `packages/client/src/lib/__fixtures__/preview-sandbox-corpus.ts`, or `packages/client/src/components/workers/PreviewPanel.tsx` must run `bun run check:preview-sandbox-browser` locally before pushing. This runs `scripts/run-preview-sandbox-browser-check.mjs`, which re-verifies the mXSS regression corpus against a real Chromium browser — `bun:test`'s happy-dom environment does not reproduce Chromium's HTML5 parsing edge cases (see `.claude/rules/os-environment-coupling.md`). This check is a real-browser regression gate, not a sibling-test requirement, so it is not part of the `preflight-check.js` coverage patterns above.

## Additional Verification: PTY Master FD Leak Check

PRs touching `packages/server/src/lib/pty-provider.ts` or `packages/server/src/services/worker-manager.ts`'s `detachPty` must run `bun run check:pty-fd-leak` locally before pushing. This runs `scripts/smoke/check-pty-fd-leak.ts`, which drives 100 real spawn/kill cycles through the production `bunTerminalProvider` and asserts that the process's ptmx-fd count (`/proc/self/fd`) and the kernel-wide allocated-pty counter (`/proc/sys/kernel/pty/nr`) stay flat — confirming `BunTerminalPtyAdapter.dispose()` actually releases the `Bun.Terminal` master-fd handle deterministically, rather than relying on the object becoming unreachable and incidentally GC-finalized (unsound in production, where `InternalPtyWorker.pty` stays reachable via session/worker maps for the life of the worker) (see Issue #1196). This check is a real-fd regression gate, not a sibling-test requirement, so it is not part of the `preflight-check.js` coverage patterns above.

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
