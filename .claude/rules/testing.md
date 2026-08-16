---
paths:
  - "**/*.test.*"
  - "**/__tests__/**"
---

# Testing Rules

## Core Principles

1. **Tests Must Test Production Code** - Import and test production code directly. Never duplicate production logic in test files. Test-only classes that mirror production classes, or functions in test files that replicate production behavior, are signs of logic duplication.
2. **Test Through Public Interface** - If you feel the need to test a private method, reconsider the design. Test observable behavior via public API. If a private method is complex enough to warrant direct testing, consider extracting it to a separate module.
3. **Mock at the Lowest Level** - Mock at the communication layer (`fetch`, `WebSocket`, file system) rather than mocking intermediate modules. `mock.module()` is process-global in bun:test and pollutes all test files in the same process. Prefer dependency injection over module mocking for cross-cutting concerns.
4. **Do Not Change Production Code for Testing Without Discussion** - Changes that improve testability often also improve design, but this should be a deliberate decision, not an afterthought. Consult with the team first.

## Anti-Patterns

### 1. Logic Duplication
Test file re-implements production logic instead of importing it. Signs: test-only classes mirroring production classes, functions in test files doing the same thing as production code, tests that wouldn't break when production code changes.

### 2. Module-Level Mocking
Using `mock.module()` or `vi.mock()` instead of fetch-level mocks. Problems: bypasses actual API function logic, `mock.module()` is permanent in bun:test, tests pass even when integration is broken. Has caused production incidents (mocking `config.js` broke 26+ unrelated tests). **Preferred: dependency injection over module mocking.**

**Never `mock.module()` a target that any other test file imports for real.** `bun:test`'s `mock.module()` is process-global and irreversible for the life of the test process, so it poisons every test file loaded afterward in the same process — and bun runs test files in directory readdir order (not CLI-arg order), which differs across operating systems. A suite that is green on one OS and red on another (or green locally and red in CI) is the signature of this failure mode (Issue #970, PR #976, Issue #977).

- **Prohibited example:** `mock.module('../../routes/__root', () => ({ useWorktreeCreationTasksContext: () => ({ ... }) }))`. `routes/__root` is the route root, so multiple other test files (route tests, sibling component tests) import it for real; a mock factory that only re-declares a subset of its exports silently breaks any file that loads afterward and needs an export the factory omitted.
- **Permitted example:** a module consumed exclusively by the one test file mocking it (e.g. a component's own tightly-scoped internal helper with no other importer) may still use `mock.module()`, but confirm the exclusivity first — grep the repo for other real importers before relying on this exception.
- **Before adding a new `mock.module()` call**, grep the repository for other files that import the target module without mocking it. If any exist, do not use `mock.module()` — use one of, in order of preference: (1) a DI seam (prop / injected factory) on the component or hook under test, (2) `spyOn()` on the module's named export (restorable per-test via `.mockRestore()` in `afterEach`), (3) fetch-level request stubbing, (4) a real store/context with an injected fake value. See `test-standards` skill for worked conversion patterns.
- **This prohibition is mechanically enforced.** `scripts/check-mock-module-poisoners.mjs` (CI: `mock-module-lint`) AST-parses every `packages/*/src/**/*.{ts,tsx}` file and fails on any new `mock.module()` call outside the central mock registry (`packages/server/src/__tests__/test-utils.ts` and `packages/server/src/__tests__/utils/**`). Run it locally via `bun run check:mock-module`. The permitted file-exclusive exception above is exercised by adding a justified `file + specifier` entry to the script's `KNOWN_VIOLATIONS` (reviewed), or preferably by moving the mock into the central registry.

### 3. Private Method Testing
Attempting to test internal/private methods directly. Test through public interface instead, or extract to a separate module if complexity warrants it.

### 4. Boundary Testing Gaps
Missing client-server boundary tests for forms. Must catch: `null` vs `undefined` mismatches, JSON serialization issues, schema validation mismatches. Unit tests on client or server alone cannot catch these.

### 5. Form Testing Gaps
Schema unit tests alone are insufficient. Required: actual form interaction tests, conditional field tests (hidden fields don't block submission), empty default value handling, validation error message verification, explicit "cannot submit" cases.

## Test Strategy: Unit vs Integration

- **Unit tests**: Exhaustively cover all patterns defined in the spec (all event types, all handler cases)
- **Integration tests**: Verify pipeline connectivity with 1-2 representative events -- exhaustive coverage is the unit test's job
- These responsibilities must not be confused

## Test File Naming Convention

- Test files MUST be named after the production file they test: `foo-bar.ts` -> `__tests__/foo-bar.test.ts`
- Place test files in the `__tests__/` directory at the same level as the production file

## Test Categories and What "Polarity" Means for Each

`workflow.md` requires a failing-first test for bug fixes. Applied mechanically to every test in a PR, that requirement produces a wrong verdict, because tests come in kinds with different correct behaviors against unmodified code.

| Category | Purpose | Against unmodified code |
|---|---|---|
| **Bug-polarity** | Prove the reported defect existed and is now fixed | **Must fail** — no exceptions |
| **New-mechanism contract** | Pin the behavior a newly added mechanism promises | **Must fail** (the mechanism does not exist yet) |
| **Invariant-preservation** | Prove existing behavior did *not* change when new code was introduced alongside it | **Passes in both worlds — this is correct** |

The third category is the one that gets misjudged. A test that passes before and after looks like the "passes in both directions" case `workflow.md` warns about, but the two are distinguished by a different question:

> **Would this test fail against a plausible wrong implementation of the new code?**

If yes, it is a real guard and its both-worlds pass is the point. If no — if no realistic mistake in this PR could break it — it is vacuous and should be redesigned or removed.

Worked example: PR [#1283](https://github.com/ms2sato/agent-console/pull/1283) added a `{{var:+prefix}}` template form, and two of its nine new tests asserted that reserved names (`{{prompt:+X}}`, `{{cwd:+X}}`) are *not* expanded through it. Those two passed against the unmodified engine — the reserved-name guard already existed one pass down. They are not vacuous: dropping the guard from the new pass makes `{{prompt:+X}}` expand to the empty string and the placeholder silently disappear, which is exactly the mistake an implementer might make. Seven tests flipped, two did not, and all nine were correct.

**When reporting polarity, state the category per test.** "7 of 9 flipped" invites a partial-polarity finding; "7 bug/contract tests flipped, 2 invariant-preservation tests hold in both worlds and fail against a guard-less implementation" is the same fact, correctly classified.

### Demonstrating polarity without breaking the build

To show a test fails against pre-change code, **comment out only the added block, leaving new exports and signatures intact**, then restore.

Do not use `git stash --patch` to separate an added block from the exports it needs. Splitting hunks interactively is error-prone (a mis-answered prompt leaves a broken intermediate state), and stashing a new export makes the whole test file fail to load — a load error, not a behavioral failure, which proves nothing about the assertion under test and cannot be distinguished from a real polarity result. (Lesson: Sprint 2026-08-05 — PR [#1275](https://github.com/ms2sato/agent-console/pull/1275)'s delegate hit exactly this: a heredoc-driven `stash --patch` stashed a helper's export while leaving its call sites, and the resulting failure was an import error. PR [#1276](https://github.com/ms2sato/agent-console/pull/1276)'s delegate used the comment-out form and got a clean `But it was not called` on precisely the assertions that mattered.)

After restoring, confirm the round trip left nothing behind — `git diff --stat` should match what it was before, and `git status` should be clean of stray edits.

**When the polarity subject is a running process rather than an in-process test, revert whole directories instead.** Commenting out a block works when the thing under test is loaded by the test runner in the same process. It does not scale to a dev-instance E2E, where the fix spans several files, the code is already loaded into a live server, and what must be shown is that the *original symptom reproduces* against unmodified code. There, check out the parent commit for the affected trees, run the real end-to-end flow against a throwaway instance, then restore:

```bash
git checkout HEAD~1 -- packages/server packages/shared   # revert the fix, keep everything else
# start a throwaway instance, run the full E2E, observe the symptom reproduce
git checkout HEAD -- packages/server packages/shared     # restore
```

**The gotcha: `git checkout <ref> -- <dir>` does not delete files that do not exist in `<ref>`.** Files added by the fix are silently left in place. That is usually harmless — nothing imports them once the wiring files are reverted — but it means the reverted tree is "pre-fix plus some orphans", not a clean parent checkout. Know that going in rather than discovering it when an unexpected module loads. If a leftover file *would* change behavior, delete it explicitly for the duration of the run.

Prefer this over `git stash` for anything touching a worktree: **`refs/stash` is shared across all worktrees of the same repository**, so a concurrent agent can pop your stash or you can pop theirs.

(Lesson: Sprint 2026-08-16 PR [#1304](https://github.com/ms2sato/agent-console/pull/1304) — the AC required demonstrating that a repository-unregister leak reproduced end-to-end on unmodified code. Neither documented option fit: the fix spanned two packages and the subject was a live HTTP server, not a test module. The directory-revert round trip reproduced both defects live, then showed both absent after restoring.)

## Evaluation Criteria

### Test Validity
- Tests verify **requirements**, not implementation details
- Assertions are meaningful and specific
- Test names clearly describe what is being tested
- Tests would fail if production code behavior changes (see the category table above for what this means for invariant-preservation tests)

### Coverage
- Happy path is covered
- Edge cases are considered (empty, null, boundary values)
- Error scenarios are tested
- Integration points are verified

### Methodology
- Mocks are used appropriately (not over-mocked)
- Test isolation is maintained
- Setup/teardown is clean

### Maintainability
- Tests are readable without excessive comments
- Duplication is minimized
- Test data is clear and purposeful

## Pre-Implementation Checklist

Before writing tests, verify:
- [ ] Importing production code directly (not duplicating logic)
- [ ] Testing through public interface (not private methods)
- [ ] Mocking at lowest level (fetch, WebSocket, not modules)
- [ ] Not following existing bad patterns blindly
- [ ] Not changing production code just for testing without discussion
- [ ] **Target code is mockable via DI** — check if the code under test imports module-level singletons. If it does, DI refactoring is required before the test can be written safely. Do NOT use `mock.module()` to work around missing DI. See Anti-Pattern #2.
- [ ] **If a new `mock.module()` call is unavoidable**, grep the repo for other real importers of the target module first. See Anti-Pattern #2's cross-file-imported-target prohibition.
