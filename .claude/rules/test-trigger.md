---
globs:
  - "packages/server/src/routes/**/*.ts"
  - "packages/server/src/services/**/*.ts"
  - "packages/server/src/mcp/**/*.ts"
  - "packages/server/src/lib/**/*.ts"
  - "packages/server/src/repositories/**/*.ts"
  - "packages/client/src/hooks/**/*.ts"
  - "packages/client/src/components/**/*.{ts,tsx}"
  - "packages/client/src/lib/**/*.ts"
  - "packages/shared/src/**/*.ts"
  - "packages/embedded-agent/src/**/*.ts"
  - ".claude/hooks/**/*.sh"
  - "scripts/lib/**/*.ts"
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
| `packages/server/src/mcp/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `packages/server/src/lib/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `packages/server/src/repositories/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `packages/client/src/hooks/**/*.ts` | `.../__tests__/*.test.ts(x)` or sibling `*.test.ts(x)` |
| `packages/client/src/components/**/*.{ts,tsx}` | `.../__tests__/*.test.ts(x)` or sibling `*.test.ts(x)` (a JSX-free pure-logic test may instead use `*.test.ts`, e.g. `SessionPage.test.ts` alongside `SessionPage.tsx`; this row now also covers nested `.ts` hooks under `components/**/hooks/` and plain pure-logic `.ts` files under `components/**`, previously outside this table entirely — Issue #1902) |
| `packages/client/src/lib/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` (Issue #1902 — previously had no coverage pattern at all) |
| `packages/shared/src/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `packages/embedded-agent/src/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `.claude/hooks/**/*.sh` | `.claude/hooks/__tests__/*.test.mjs` or sibling `*.test.mjs` |
| `scripts/lib/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` (the bun entries the shell lib shells out to, e.g. `embedded-agent-bun-identity.ts`; the `.sh` lib itself is covered by `scripts/__tests__/setup-multiuser-checks.test.mjs` via its subcommand dispatcher) |

A topic-split test — `<name>-<topic>.test.<ext>` or `<name>.<topic>.test.<ext>` in the same `__tests__/` directory (or sibling placement) — also counts as coverage for `<name>`, attributed to the longest matching production basename actually present in that directory (Issue #1553).

## Protocol-dispatch fixture trigger (Issue #975 Tier 2)

This is a different obligation from the table above, and it is **blocking**, not advisory. A change to any one of the three protocol dispatch-union input files — `packages/shared/src/types/session.ts`, `packages/shared/src/types/git-diff.ts`, `packages/shared/src/schemas/app-server-message.ts` — must land in the same PR as a change to at least one of the three wire-consumption fixture tests Tier 1 (#975) introduced: `packages/client/src/components/terminal/__tests__/terminal-store-wire-consumption.test.ts`, `packages/client/src/components/workers/__tests__/embedded-agent-store-wire-consumption.test.ts`, `packages/client/src/hooks/__tests__/useAppWs-wire-consumption.test.ts`. A sibling unit test next to the trigger file does not satisfy this — the fixture tests are what prove a dispatch-union member is actually consumed by the dispatcher, not merely accepted by a type.

This is enforced by `preflight-check.js`'s "Protocol-dispatch fixtures" section (backed by `detectProtocolDispatchGaps` / `PROTOCOL_DISPATCH_TRIGGERS` in `check-utils.js`), and it fails the run on a gap, unlike the integration-test-gap warning above. A comment-only diff of a trigger file is exempt, same as the coverage table's comment-only exemption. This list is deliberately NOT part of `COVERAGE_PATTERNS` and is therefore outside `check-mirror-drift.js`'s comparison — see the Mirror Maintenance section below, which covers only `COVERAGE_PATTERNS`.

## Exceptions

- **`packages/integration/src/`** uses a flat sibling layout (no `__tests__/` directory) for its boundary tests. This is deliberate: the package contains no production code — its entire `src/` is test infrastructure (`setup.ts`, `test-utils.ts`) and boundary tests (`*-boundary.test.ts(x)`). Do not move these files into a `__tests__/` subdirectory. The one exception is `src/e2e-native/`, which holds the two shipping-path e2e test files that require a separate `bun test` invocation without the happy-dom preload (see `src/e2e-native/setup-native.ts` for why, and `package.json`'s `test` / `test:coverage` / `test:watch` scripts for the two-invocation chain).
- **`packages/server`'s nine real-fs test files** (`lib/__tests__/memory-dir.test.ts`, `lib/__tests__/trusted-dir.test.ts`, `routes/__tests__/workers-upload-dir-real-fs.test.ts`, `__tests__/utils/__tests__/scratch-git.test.ts`, `services/__tests__/git-diff-base-reresolve.test.ts`, `services/__tests__/worker-manager-kill-signal-real-fs.test.ts`, `database/__tests__/connection-real-fs.test.ts`, `lib/__tests__/repository-path-status.test.ts`, `lib/__tests__/git-bare-repository.test.ts`) stay in their ordinary sibling `__tests__/` location — no subdirectory, no filename suffix. They assert something outside the JS-level fs simulation (mode bits, gid inheritance, symlink semantics, a real on-disk SQLite file, or a real subprocess such as `git` or a PTY shell that needs a directory memfs cannot make visible), and memfs is process-global for the life of whichever `bun:test` PROCESS first loads `mock-fs-helper.ts` (`packages/server/src/__tests__/utils/memfs-detection.ts`'s header). They therefore run in a SECOND `bun test` PROCESS, selected by an explicit path list in `packages/server/package.json`'s `test` / `test:coverage` / `test:watch` + `test:watch:real-fs` scripts (moving them to a subdir would break `check-utils.js`'s sibling-test mapping for `lib/memory-dir.ts` / `lib/trusted-dir.ts` / `routes/workers.ts`). Each real-fs case calls `assertRealFs(label)` (in `memfs-detection.ts`) instead of silently skipping under memfs, and `packages/server/src/__tests__/real-fs-invocation.test.ts` keeps the list honest in both directions (Issue [#1699](https://github.com/ms2sato/agent-console/issues/1699); the Memory Layer section of `smoke-verification-embedded.md` relies on this second invocation for the multi-user `2775` contract; rationale: comment of 2026-10-12 on #1699).
- **`*.gen.ts` / `*.gen.tsx`** files are build-time generated (e.g. `packages/shared/src/schema-version.gen.ts` emitted by a codegen step). Their contents derive from an authoritative source at build time, so a hand-written sibling test would be tautological — test the generator, not its emitted output. The exclusion is anchored on the `.gen.<ext>$` suffix; files like `generator.ts` (substring "gen", no `.gen.` suffix) still require coverage.
- **Bare `types.ts` / `types.tsx` as a full path segment** are module-level type-definitions files colocated with their consumers (a natural React / Node.js convention — e.g. `packages/embedded-agent/src/tools/types.ts`). Same rationale as the `-types.ts` convention above: the type system enforces shape at consume sites. Exclusion is anchored on the segment boundary, so files like `mytypes.ts` (mid-segment match) or `type.ts` (singular, may contain runtime enums / factories) still require coverage.
- **`<x>-repository.ts` under `packages/server/src/repositories/`** whose basename does NOT start with `sqlite-` / `json-` / `inbound-` are interface-only contract files (`export interface` / `export type` only, no runtime logic). Same rationale as the `-types.ts` convention above — the type system already enforces their shape at consume sites, so a runtime test would be tautological. Implementations whose basename starts with those prefixes (`sqlite-*-repository.ts`, `json-*-repository.ts`, `inbound-*-repository.ts`) and `repository-factory.ts` (runtime code, not a contract file) remain in scope. `index.ts` in that directory is covered by the existing re-export-only content exemption above, not by a path regex.
- **Comment-only diffs** are exempted content-based, not path-based (Issue #1189), and the exemption applies to **both** checks that gate on a file's diff content: `check-utils.js`'s `findTestFiles()` (sibling-test coverage) and `detectIntegrationTestNeeds()` (integration-test-gap detection, extended to this exemption by Issue [#1816](https://github.com/ms2sato/agent-console/issues/1816) — before that, a comment-only diff to a `packages/shared/src/**` / route / component path still tripped the "raise it with the requester" flag). Both call the same underlying `isCommentOnlyFileDiff()` (which wraps `isCommentOnlyDiff()`) to inspect a file's actual diff hunks against the base branch (`git diff --unified=0`); if every added/removed line is a comment (`//`, `/* */` block, or `#` for `.sh`) or blank, the corresponding requirement — sibling test, or integration-test-gap trigger — is skipped for that file. A mixed diff (any real code line alongside comment changes) still requires a sibling test and still trips the integration-test-gap flag. A second class is exempted by the same function: a diff whose every changed line falls inside a **whole-declaration type-only** `import type ...` / `export type { ... } from` statement on its own side (head line numbers for added lines, base line numbers for removed lines), because TypeScript erases those at emit and no test can observe the rewiring. The boundary is whole-declaration only: inline `type` specifiers (`import { type A }`), type alias and interface bodies, and value imports still require coverage, and any parse failure or unresolvable `typescript` degrades to requiring coverage. This exception cannot be expressed as a glob and is intentionally excluded from `check-mirror-drift.js`'s comparison, same as the `isTestFile()` negation entries above.

  Both `preflight-check.js` and `acceptance-check.js` call the same `findTestFiles()` and `detectIntegrationTestNeeds()` (single writer). The diff they read defaults to the checked-out worktree's `HEAD`, which is wrong when checking an arbitrary PR number from a *different* worktree (`acceptance-check.js`'s usage pattern), so `resolvePrDiffRef(prNumber)` resolves that PR's real base/head SHAs via the GitHub API and fetches them; it fails loudly (no silent fallback to `HEAD`) if they can't be resolved or fetched. Background: Issue [#1463](https://github.com/ms2sato/agent-console/issues/1463) (comment of 2026-10-12).

## Registering a smoke script (applies to every section in the three domain files)

**A new `scripts/smoke/*` script gets exactly one way to be registered and one way to be invoked.** Registration is an Additional Verification section in the domain's `smoke-verification-*.md` rule (embedded / sdk-probes / server), in the same PR that adds the script — the sections in `smoke-verification-embedded.md`, `smoke-verification-sdk-probes.md` and `smoke-verification-server.md` are instances of that rule, not a closed list; a sixth smoke needs a sixth section, and names its verification tier in one clause (Discipline 4 of `os-environment-coupling.md`). Invocation is `bun scripts/smoke/<file>` — there is no `package.json` `check:` alias for any smoke; two spellings for the same script was the defect Issue [#1637](https://github.com/ms2sato/agent-console/issues/1637) closed.

Do not read "this is a manual gate, never a CI job" as a reason to skip registration. **Every smoke registered in those three files is a manual gate** -- except a free, deterministic smoke that a `scripts/smoke/__tests__/*.run.test.ts` wrapper runs under `test:scripts`, which is then a CI job as well; the manual-gate wording exists for billable or elevated smokes, where the rationale is cost, and does not apply to a smoke whose only cost is two seconds. Registration is about *reachability* — a script nobody can find is a script nobody re-runs after the change that would have broken it — while automation is about CI, and the two decisions are independent. When a script is billable or needs an authenticated CLI, say so in its section, so a future reader knows the cost before running it rather than after.

(Issue [#671](https://github.com/ms2sato/agent-console/issues/671): two smokes were added in parallel and neither was registered; narrative in `docs/narratives/2026-10-12-smoke-registration-rule-two-parallel-smokes.md`. `scripts/smoke/__tests__/registry-reachability.test.ts` — every `scripts/smoke/*` basename must appear in the registry rules — is what stops it mechanically.)

**A smoke promoted to CI must bound its waits generously (tens of seconds); the per-cycle counts, not the bounds, are its measurement.** A fixed-size `while`/polling loop that breaks on success costs nothing extra on the happy path when its ceiling is widened, so size these ceilings for a loaded CI runner, not for the fast path. **Tear a PTY shell down with `SIGHUP`, not `SIGTERM` — an interactive shell ignores `SIGTERM`.** A kill-then-wait-for-exit race built on `SIGTERM` loses on nearly every cycle, so widening THAT specific timeout (as opposed to a genuine polling ceiling) multiplies total runtime instead of fixing anything. Fix the signal, not the bound. (Measurement, Issue #1872: `docs/narratives/2026-10-12-smoke-pty-teardown-sigterm-vs-sighup.md`.)

**A new smoke script is born import-safe and born-covered.** Write it with a named `main()` whose only top-level invocation is guarded by `if (import.meta.main) { main(); }` — importing an exported function from it (the pattern the domain files' sections use for a free, non-billed proxy verification) must never execute the script. `scripts/smoke/__tests__/import-safety.test.ts` discovers every `scripts/smoke/*.{ts,mjs}` via a glob and subprocess-imports each one, so a new script is enforced mechanically with no separate registration step for this specific check (Issue #1479).

**A new smoke script is also born knip-reachable, for the same reason.** `knip.json`'s root workspace `entry` list includes `scripts/smoke/**/*.{ts,mjs}` as a glob, not a per-file list — this is the third mechanical reachability net alongside the domain files' sections (human-readable registration) and `import-safety.test.ts` (import safety): without it, `bun run lint:unused` (`knip`, CI's `check-structure` job) has no static entry point for a smoke, and a smoke reached only through a removed `package.json` `check:` alias becomes an "unused file" the moment that alias is removed (Issue #1637; `docs/narratives/2026-10-12-knip-reachability-after-check-alias-removal.md`). A new smoke needs no edit to `knip.json` for this to hold.

**A new smoke script is also born type-checked, for the same reason.** `scripts/tsconfig.json` includes all of `scripts/**/*.ts`, and `bun run typecheck`'s `typecheck:scripts` step (`tsc -p scripts`) runs it in CI — a fourth mechanical reachability net alongside registration, import-safety, and knip-reachability: no per-script registration is needed for a type error in a new smoke to fail CI before anyone bills a run to find it (Issue #1611).

**A new smoke script's first import is `./_env.js`, unless it is NODE_ENV-sensitive.** `NODE_ENV` unset on a production-shaped tree (`bun install --production`, no `pino-pretty` devDependency) crashes any smoke that transitively imports `packages/server/src/lib/logger.ts`, because `resolveLoggerConfig` treats unset as development and constructs the `pino-pretty` transport (Issue #1289). `scripts/smoke/_env.ts` defaults `process.env.NODE_ENV ??= 'production'` for logging purposes only; import it (`import './_env.js';`) as the literal first import of a new smoke's entry point so the default lands before any later import's own transitive imports reach `logger.ts`. If the new smoke's verified path reads `NODE_ENV` for actual behaviour — not just log formatting (e.g. a `Secure` cookie attribute, web-UI enablement, any env-gated branch a production deploy relies on) — do NOT import `./_env`; instead add the explicit, fail-fast check (`if (!process.env.NODE_ENV) { ...; process.exit(2); }`) before any server import, and list the smoke's basename with a one-line reason in `NODE_ENV_SENSITIVE_SMOKES` (`scripts/smoke/__tests__/node-env-discipline.test.ts`). `node-env-discipline.test.ts` is the fifth mechanical reachability net alongside registration, import-safety, knip-reachability, and type-checking: it enforces that every entry point does exactly one of the two, with no per-script registration step beyond the `NODE_ENV_SENSITIVE_SMOKES` listing itself.

**An in-process smoke creates its session with `embeddedAgentId` so no default PTY worker is spawned.** `createSession` gives every session an initial worker, and without `embeddedAgentId` that is a claude-code PTY agent worker; `shutdownAppContext` does not end PTY workers, so a smoke that creates the session plain and then adds its embedded worker leaks an unused login shell. Read the embedded worker from the returned session's `workers`.

## Exceptions to the reachability rule

**A `scripts/smoke/*` file with no top-level `import.meta.main` guard is a shared library, not an entry point, and needs no section of its own.** The guard (`if (import.meta.main) { main(); }`, required of every entry point per "A new smoke script is born import-safe and born-covered" above) is what makes a file directly runnable; its absence is exactly what makes a file a library instead -- nobody invokes it with `bun scripts/smoke/<file>`, so the reachability rule's rationale ("a script nobody can find is a script nobody re-runs") does not apply to it. One file this currently exempts is `probe-sdk-session-harness.ts`, whose own header says so explicitly ("Not an entry point -- it has no `main()` and running it directly does nothing"): it is a shared live-session harness imported by `probe-sdk-compaction.ts` and `probe-sdk-resume.ts` (both documented in `smoke-verification-sdk-probes.md`, both crediting it as their shared methodology), reachable through those two consumers instead. A second is `disposable-multi-user-home.ts` (Issue #1713), a shared helper for building a disposable `AGENT_CONSOLE_HOME` that satisfies the production data-root's `2775` setgid contract -- reachable through its two consumers, `check-embedded-agent-bash-env.ts` and `check-embedded-agent-elevation.ts` (both documented in `smoke-verification-server.md`). A third is `_env.ts` (Issue #1289), the `NODE_ENV` default for logging purposes described above -- reachable through every NODE_ENV-neutral smoke's own `import './_env.js';` first import, not through a single named consumer, so it has no "A new smoke script" bullet of its own; `scripts/smoke/__tests__/node-env-discipline.test.ts` is its reachability net. `scripts/smoke/__tests__/registry-reachability.test.ts` derives this exemption from the same content-based rule (guard absence), not from a hand-maintained name list, so a future library file is exempted automatically and a future genuinely-unregistered script (which necessarily has the guard) cannot slip into this bucket.

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
