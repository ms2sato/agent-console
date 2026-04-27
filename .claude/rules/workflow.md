# Workflow Rules

These rules apply to all code changes in this project. Contents span verification, branching, testing, commits, code quality, language policy, and Claude Code on the Web — collected here because each is a short declarative rule that auto-loads for all work, not just code in a particular package.

## Verification Checklist

Before completing any code changes, always verify:

1. **Run the full test suite:** Execute `bun run test` and ensure ALL tests pass — not just the tests you added or modified. The full suite must be green before every push.
   - **Test result is paste, not summary.** When reporting "tests pass" to the Orchestrator (or in any verification report), do not summarize counts (e.g., "2338 pass"). Always paste the last 100 lines of test output plus the actual test exit code. Run the tests under a bash-compatible shell using one of:
     ```bash
     # Option A: capture output and exit code separately
     output=$(bun run test 2>&1); exitcode=$?; echo "$output" | tail -100; echo "TEST_EXIT: $exitcode"

     # Option B: bash PIPESTATUS to read the test process's exit code
     bun run test 2>&1 | tail -100; echo "TEST_EXIT: ${PIPESTATUS[0]}"
     ```
     Do NOT use `bun run test 2>&1 | tail -100; echo "TEST_EXIT: $?"` — `$?` returns `tail`'s exit code (always 0), masking real test failures. Summary-only or wrong-exit-code reports have caused false-positive "verified" claims that CI later contradicted. (Lesson: Sprint 2026-04-25 — agent reported "server: 2338 pass" but CI showed 61 failures due to local fixture state.)
2. **Run type check:** Execute `bun run typecheck` and ensure no type errors. The script auto-generates `routeTree.gen.ts` (TanStack Router) via `vite build` if the file is missing, so it runs correctly on a fresh worktree.
   - **Stale `routeTree.gen.ts` caveat:** The presence-only check accepts a stale `routeTree.gen.ts` when route files have been added / renamed / removed but the generated file was not regenerated. After modifying anything under `packages/client/src/routes/`, delete `packages/client/src/routeTree.gen.ts` (or run `bun run build`) before relying on `bun run typecheck`.
3. **Run CodeRabbit CLI review:** Execute `coderabbit review --agent --base main` and fix any CRITICAL, HIGH, or MEDIUM severity issues before creating a PR. If the CodeRabbit CLI is not installed locally, skip this step and recommend installation: `curl -fsSL https://cli.coderabbit.ai/install.sh | sh`.

   **Rate limit fallback (closes Issue #653):** When the local CLI is rate-limited (typically 48-min wait window), proceed to PR creation, rely on the GitHub-side CodeRabbit bot review (separate token, runs on PR open), and add a note to the PR body:
   ```markdown
   ## Note on CodeRabbit
   Local CodeRabbit CLI rate-limited during this sprint. Relying on GitHub-side CodeRabbit bot review.
   ```
   Before merge, confirm the GitHub bot review is APPROVED. If `CHANGES_REQUESTED`, follow the resolution flow in `core-responsibilities.md` §6 (CodeRabbit "CHANGES_REQUESTED" resolution). (Sprint 2026-04-25 — verified in PRs #687 / #688 / #691 / #694.)

   **Pre-merge checks vs Review state — both required for "clean".** GitHub surfaces CodeRabbit info in two distinct layers that are easy to confuse:
   - **Pre-merge checks** (Title / Description / Docstring / Linked Issues / Out-of-Scope) — metadata validation, displayed as "5/5 passed" in the GitHub UI. **Not** code review.
   - **Review state** (`gh pr view <N> --json reviewDecision`) — actual code-review verdict. Only `APPROVED` (or empty when no review submitted yet) counts as passing.
   - **Inline comments** (`gh api repos/<owner>/<repo>/pulls/<N>/comments`) — must be addressed if actionable.

   "CodeRabbit clean" requires all three. Pre-merge checks alone are insufficient. (Sprint 2026-04-25 PR #694 — agent declared "clean" based on pre-merge 5/5 while review state was `CHANGES_REQUESTED` with 3 actionable issues.)
4. **Review test quality:** When tests are added or modified, evaluate adequacy and coverage
5. **Manual verification (UI changes only):** When modifying UI components and Chrome DevTools MCP is available, perform manual testing through the browser.

   **Skip threshold.** Browser QA may be omitted when **all** of the following conditions hold:
   - The change is a pure behavior subtraction — removing a conditional branch, a field, or a side-effect with no user-visible rendering.
   - The corresponding server-side contract is covered by existing server or integration tests.
   - The client-side behavior change is fully covered by unit tests.

   When skipping, document the three justifications in the PR body and request owner dogfood verification post-merge. The Orchestrator's acceptance check still performs Browser QA as final gate. (Lesson: Sprint 2026-04-17b PR #655 — frontend-specialist correctly skipped for a pure cache-restore subtraction; absent threshold caused unnecessary anxiety. See `frontend-standards.md` "Browser Verification for UI Changes" for the worked example.)
6. **Duplication check:** When adding or modifying logic, grep the repository for the core processing part (method chains, regex patterns, transformation expressions) with variable names removed. For example, search for `.replace(/\r?\n/g, '\r')` rather than `content.replace(...)`. If hits are found, review whether they represent the same concern and should be consolidated into a shared function.
7. **Shell script execution test:** When adding or modifying shell scripts (`scripts/*.sh`), execute them locally on macOS before committing. CI does not cover shell scripts. Watch for BSD/GNU incompatibilities (e.g., `sed -E` with non-greedy `+?` is not portable). (Lesson: Sprint 2026-04-05c — `upload-qa-screenshots.sh` had 2 bugs only caught at runtime.)

**CRITICAL: Verify BEFORE pushing.** Do NOT push code to the remote until `bun run typecheck` and `bun run test` both pass locally. Pushing unverified code wastes CI cycles and blocks other developers. If pre-existing errors exist that are unrelated to your changes, note them explicitly in your commit message or report.

**Hard rule for production code changes.** When any file outside of `docs/`, `.claude/skills/`, or `.claude/agents/` is modified, you MUST run `bun run test` (full suite) and confirm zero failures before pushing. Do not report task completion without full test verification. Running only the tests you touched is insufficient.

**Important:** The main branch is always kept GREEN (all tests and type checks pass). If any verification fails, assume it is caused by your changes on the current branch and fix it before proceeding.

## Definition of Done

A task or PR is "done" only when ALL of the following hold. Reporting "ready for merge" or "implementation complete" without all eight causes Orchestrator hand-hold cycles and erodes trust in completion reports.

1. **Production code is implemented** — the feature / fix exists in the source tree.
2. **Corresponding tests are added** — placed in the sibling `__tests__/` directory per `testing.md` "Test File Naming Convention" (production `path/to/foo.ts` → test `path/to/__tests__/foo.test.ts`). Parent-directory `__tests__/` placement does not satisfy `coverage-check`.
3. **Local verification passes** — `bun run typecheck && bun run test` exit 0, full suite paste per the Verification Checklist (Step 1 / Step 2 above).
4. **Changes are committed** with conventional commit format (`type: description`) — see Commit Standards below.
5. **Branch is pushed to origin**.
6. **PR is opened with linked Issue** — the body contains `Closes #NNN` (the title's `(closes #N)` does not auto-close the Issue; only the body's keyword does, and the script `acceptance-check.js` requires the body match).
7. **CI is fully green** — verified via the rollup, not a single per-run event. Use `gh pr view <PR> --json statusCheckRollup` to confirm. (Issue #699 fixed the per-run vs rollup gap; before that fix the per-run event could falsely report "all passed" while the rollup had failures.)
8. **CodeRabbit review state is clean across all three layers** — Pre-merge checks (5/5), `reviewDecision` (`APPROVED` or empty), inline comments (resolved or addressed). See Step 3 above for the resolution flow.

"Implementation complete" without all eight is **not** done. (Lesson: Sprint 2026-04-27 PR #703 — agent reported "Production ready" with no commit / no push / no PR, requiring three rounds of hand-holding before reaching actual mergeable state.)

## CI Failure: Self-Diagnosis Before Assumption

When CI fails, **read the failure log first** before forming hypotheses. Most CI failures originate in the diff being pushed; "infra problem" / "rate-limit" / "external service" assumptions without log evidence are almost always wrong and waste a round trip.

```bash
gh run view <run_id> --log-failed | tail -80
```

Diagnostic steps:

1. **Read the failure step** — typecheck, test, build, coverage-check, lint each have distinct failure shapes.
2. **Correlate with your changes** — does the failing file appear in your diff? Is the error message tied to a symbol you renamed / added / removed?
3. **Compare to previous CI run on the same branch** — if the previous run passed, only your last commits could have caused the failure.
4. **If the cause is genuinely opaque after the above**, ask the Orchestrator before pushing speculative fixes. Speculative pushes that only adjust adjacent code without identifying the root cause cycle CI for nothing.

Common categories that look like "infra" but are actually code:

- TypeScript error in a file the agent didn't realize they touched (e.g., a shared type rename propagated unexpectedly)
- Missing test for a newly-added production file (preflight `coverage-check` failure with explicit "expected: …" path)
- Test fixture state divergence between local and CI (look for tests that pass locally but fail CI — usually local fixture leakage from a previous run)

(Lesson: Sprint 2026-04-27 PR #703 — agent diagnosed a `TS2353 'getConditionalWakeupCleanupCallback' does not exist in type 'SessionDeletionDeps'` error as an "infra problem" and asked the Orchestrator how to investigate, when the type-definition file was in their own diff three lines away from the error site.)

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

### Continuing Work after a Squash Merge

When a PR is squash-merged into main, the local feature branch keeps its original commit hashes while main gets a new single squash commit. The local branch is effectively obsolete for further work — do not continue commits on it. For follow-up work (a fix's prevention system, a refactor's continuation, etc.), branch fresh from `origin/main`:

```bash
git fetch origin
NEED_STASH=$(git status --porcelain)         # detect uncommitted / untracked changes
[ -n "$NEED_STASH" ] && git stash --include-untracked
git checkout main
git pull origin main
git checkout -b <new-branch-name>
[ -n "$NEED_STASH" ] && git stash pop        # only pop if we actually stashed
```

The conditional stash/pop avoids `git stash pop` failing on an empty stash when the worktree was already clean.

(Sprint 2026-04-25 PR #694 — base worktree of merged PR #692 still contained 7 untracked prevention-system files. Without explicit instruction to follow this procedure, the agent would have continued committing on the obsolete `fix/660-message-input-newlines` branch.)

### Force-Push and Rebase Gating

`git push --force` and `git push --force-with-lease` require **explicit per-PR approval from the owner**. A general "merge this sequence" approval does NOT imply force-push approval for individual PRs within the sequence. Always confirm before force-pushing, even when the technical need is obvious (e.g., stacked PRs broken by squash-merge of the base PR).

The same applies to `git rebase` on a pushed branch: if the rebase will require force-push to publish, get approval first.

When the situation is a known operational pattern (stacked PR + base squash-merge), prefer to describe the patch set (commit subjects) and the intended rebase target, then request approval. Do not perform force-push "to save a round trip" — the memory `feedback_no_unauthorized_rebase.md` captures the reasoning.

This rule does not apply to the initial push of a brand-new feature branch (no force involved) or to rebasing a local branch that has never been pushed (no remote divergence).

## Testing Requirements

- **Testing with code changes:** Always update or add tests. Code without tests is incomplete.
- **TDD for bug fixes:** Write a failing test first, then implement the fix.
- **Real-device verification for bug fixes:** When fixing bugs reported from real usage (dogfooding, production), verify on the actual environment before considering complete. Verification has **two parts**:
  1. **Fix works** — the original bug symptom does not reproduce after the fix
  2. **No regression** — existing functionality (especially adjacent or upstream of the fix point) still works as before

  When the dev environment cannot reproduce the original symptom (environment-specific blocker), use **baseline comparison** as fallback: `git stash` the fix → verify the symptom + adjacent functionality on the unmodified base → `git stash pop` → re-verify after fix. If the baseline shows the same blocker, the fix is at least not the cause (transparency note required in the PR body). Lessons:
  - Sprint 2026-04-07 — two #627 fixes passed all tests but had no effect on the actual bug because the diagnosed code path was wrong.
  - Sprint 2026-04-25 — #660 fix passed unit tests but appeared to break the send pipeline. `git stash` baseline comparison proved the blocker was pre-existing, not caused by the fix.

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

## Strategy / Narrative Doc Drafting

When writing a new document under `docs/strategy/` or a `docs/narratives/` entry (especially `nature: founding`), prefer an **outline-first pattern** over drafting full content in one pass:

1. Produce a section-level outline (headings + 1-line summaries of each section's intent).
2. Ask the owner to confirm the outline — accept shape / scope / what to add / cut.
3. Draft full content for each confirmed section.
4. Ask the owner to review wording and framing, especially for strategic terminology, tone, and vendor-facing language.

Rationale: strategy and narrative docs lean on the owner's voice more than code documentation does. Drafting full content before the owner has reviewed the shape produces churn — wording revisions cascade across sections, translations arrive after the structure is set, and terminology ambiguities surface late. The Orchestrator's self-review hits its strongest calibration on content correctness and its weakest on strategic framing; outline-first trades a small amount of upfront latency for substantially less rewriting. (Lesson: Sprint 2026-04-20 — PR #674 strategic-position doc had 4 commits / 86 min TTM and PR #677 shared-orchestrator design had 3 commits / 1094 min TTM, both driven by owner-initiated reshaping of wording after full drafts were opened as PRs.)

This rule does not apply to design docs under `docs/design/` where architectural decisions are code-adjacent — the normal PR flow is sufficient there.

## Language Policy

**Public artifacts:** Write all code comments, commit messages, issues, pull requests, and documentation in English.

**User-facing artifacts:** Review annotations, memos, and other content visible only to the user should follow the user's preferred language.

**Communication:** Respond in the same language the user uses. Technical terms and code identifiers can remain in English.

## Claude Code on the Web (Remote Environment)

When running in Claude Code on the Web, `gh` CLI is automatically installed via a SessionStart hook. Due to the sandbox proxy, `gh` commands require the `-R owner/repo` flag explicitly (`-R ms2sato/agent-console`).
