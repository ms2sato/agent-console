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
3. **Run CodeRabbit CLI review:** Execute `coderabbit review --agent --base main` and address any CRITICAL / HIGH / MEDIUM severity issues before creating a PR. If the CodeRabbit CLI is not installed locally, skip this step and recommend installation: `curl -fsSL https://cli.coderabbit.ai/install.sh | sh`.

   For the LOW / NITPICK findings policy, the **3-layer clean verdict** (Pre-merge checks / `reviewDecision` / inline comments), and operational case-by-case dispositions (rate-limit fallback, GitHub-side bot unresponsive, both layers simultaneously rate-limited, `CHANGES_REQUESTED` resolution), invoke the [`coderabbit-ops`](../skills/coderabbit-ops/SKILL.md) skill.
4. **Review test quality:** When tests are added or modified, evaluate adequacy and coverage
5. **Manual verification (UI changes only):** When modifying UI components and Chrome DevTools MCP is available, perform manual testing through the browser.

   **Skip threshold.** Browser QA may be omitted when **all** of the following conditions hold:
   - The change is a pure behavior subtraction — removing a conditional branch, a field, or a side-effect with no user-visible rendering.
   - The corresponding server-side contract is covered by existing server or integration tests.
   - The client-side behavior change is fully covered by unit tests.

   When skipping, document the three justifications in the PR body and request owner dogfood verification post-merge. The Orchestrator's acceptance check still performs Browser QA as final gate. (Lesson: Sprint 2026-04-17b PR #655 — frontend-specialist correctly skipped for a pure cache-restore subtraction; absent threshold caused unnecessary anxiety. See `frontend-standards.md` "Browser Verification for UI Changes" for the worked example.)

   **Gated / conditional UI true-path requirement.** When the change adds or modifies UI that is feature-flagged or conditionally rendered (visible only under a config / auth / role state), Browser QA MUST include screenshots of the **feature-visible (true-path)** state, not only the hidden / default state, and they must let a non-technical reader understand what the feature does. When the true-path state cannot be reached in the default dev environment, drive it with a temporary uncommitted dev stub, capture, then revert (document the technique transparently in the PR body). (Lesson: Sprint 2026-05-12 PR #786 — shared-session UI shipped with false-path-only screenshots; the owner could not understand the feature and required true-path screenshots plus a plain-language Feature Overview after the fact.)
6. **Duplication check:** When adding or modifying logic, grep the repository for the core processing part (method chains, regex patterns, transformation expressions) with variable names removed. For example, search for `.replace(/\r?\n/g, '\r')` rather than `content.replace(...)`. If hits are found, review whether they represent the same concern and should be consolidated into a shared function.
7. **Shell script execution test:** When adding or modifying shell scripts (`scripts/*.sh`), execute them locally on macOS before committing. CI does not cover shell scripts. Watch for BSD/GNU incompatibilities (e.g., `sed -E` with non-greedy `+?` is not portable). (Lesson: Sprint 2026-04-05c — `upload-qa-screenshots.sh` had 2 bugs only caught at runtime.)
8. **Public-artifact language check:** When adding or modifying any file under `docs/`, `.claude/`, or `CLAUDE.md`, run `bun run check:lang` and ensure exit 0. The check rejects any non-Latin/Greek/Cyrillic Letter character — see Language Policy below. The same check also runs as part of `node .claude/skills/orchestrator/preflight-check.js` and the `language-lint` CI workflow.

**CRITICAL: Verify BEFORE pushing.** Do NOT push code to the remote until `bun run typecheck` and `bun run test` both pass locally. Pushing unverified code wastes CI cycles and blocks other developers. If pre-existing errors exist that are unrelated to your changes, note them explicitly in your commit message or report.

**Hard rule for production code changes.** When any file outside of `docs/`, `.claude/skills/`, or `.claude/agents/` is modified, you MUST run `bun run test` (full suite) and confirm zero failures before pushing. Do not report task completion without full test verification. Running only the tests you touched is insufficient.

**Important:** The main branch is always kept GREEN (all tests and type checks pass). If any verification fails, assume it is caused by your changes on the current branch and fix it before proceeding.

## Definition of Done

A task or PR is "done" only when ALL of the following hold. Reporting "ready for merge" or "implementation complete" without all eight causes Orchestrator hand-hold cycles and erodes trust in completion reports.

1. **Production code is implemented** — the feature / fix exists in the source tree.
2. **Corresponding tests are added** — placed in the sibling `__tests__/` directory per `testing.md` "Test File Naming Convention" (production `path/to/foo.ts` → test `path/to/__tests__/foo.test.ts`). Parent-directory `__tests__/` placement does not satisfy `preflight`.
3. **Local verification passes** — `bun run typecheck && bun run test` exit 0, full suite paste per the Verification Checklist (Step 1 / Step 2 above).
4. **Changes are committed** with conventional commit format (`type: description`) — see Commit Standards below.
5. **Branch is pushed to origin**.
6. **PR is opened with linked Issue** — the body contains `Closes #NNN` (the title's `(closes #N)` does not auto-close the Issue; only the body's keyword does, and the script `acceptance-check.js` requires the body match).
7. **CI is fully green** — verified via the rollup, not a single per-run event. Use `gh pr view <PR> --json statusCheckRollup` to confirm. (Issue #699 fixed the per-run vs rollup gap; before that fix the per-run event could falsely report "all passed" while the rollup had failures.)
8. **CodeRabbit review state is clean** — see [`coderabbit-ops`](../skills/coderabbit-ops/SKILL.md) skill for the 3-layer verdict (Pre-merge checks / `reviewDecision` / inline comments) and any fallback exceptions.

"Implementation complete" without all eight is **not** done. (Lesson: Sprint 2026-04-27 PR #703 — agent reported "Production ready" with no commit / no push / no PR, requiring three rounds of hand-holding before reaching actual mergeable state.)

## Inference vs Verification

When you form a conclusion from a *secondary signal* — a derived, lagging, or proxy indicator — instead of *primary information* — the authoritative source — you are inferring, not verifying. The same failure mode recurs across CI, code review, cross-repo coordination, and runtime observation: a secondary signal is treated as ground truth, the real cause diverges from the inference, and at least one round trip is wasted. Before acting on (or reporting) a conclusion drawn from a secondary signal, read the primary source.

| Domain | Secondary signal (do NOT conclude from this alone) | Primary information (verify here) |
|---|---|---|
| CI failure | "infra problem" / "rate-limit" / "external service" intuition; the red X without the log | `gh run view <run_id> --log-failed` |
| CodeRabbit review | absence of new comments; pre-merge checks passing; a stale `CHANGES_REQUESTED`; a rate-limit message | the PR's 3-layer state (Pre-merge checks / `reviewDecision` / inline comments) re-read at decision time |
| Cross-repo issue | "this symptom looks like the other repo's known bug / shared pattern" | reproduce in *this* repo's own code path before filing, blaming, or claiming applicability |
| Runtime observation | a dev-server log line / websocket frame / UI render / channel assumption taken as proof a path ran or a notification arrived | the authoritative store / server-side state / a deterministic probe / per-channel confirmation |

The four sub-patterns below are specializations of this single rule. Each names the inference trap, the verify procedure, and its Lesson source.

### Sub-pattern 1: CI failure self-diagnosis

When CI fails, **read the failure log first** before forming hypotheses. Most CI failures originate in the diff being pushed; "infra problem" / "rate-limit" / "external service" assumptions without log evidence are almost always wrong and waste a round trip.

```bash
gh run view <run_id> --log-failed | tail -80
```

Diagnostic steps:

1. **Read the failure step** — typecheck, test, build, preflight, lint each have distinct failure shapes.
2. **Correlate with your changes** — does the failing file appear in your diff? Is the error message tied to a symbol you renamed / added / removed?
3. **Compare to previous CI run on the same branch** — if the previous run passed, only your last commits could have caused the failure.
4. **If the cause is genuinely opaque after the above**, ask the Orchestrator before pushing speculative fixes. Speculative pushes that only adjust adjacent code without identifying the root cause cycle CI for nothing.

Common categories that look like "infra" but are actually code:

- TypeScript error in a file the agent didn't realize they touched (e.g., a shared type rename propagated unexpectedly)
- Missing test for a newly-added production file (`preflight` failure with explicit "expected: …" path)
- Test fixture state divergence between local and CI (look for tests that pass locally but fail CI — usually local fixture leakage from a previous run)

(Lesson: Sprint 2026-04-27 PR #703 — agent diagnosed a `TS2353 'getConditionalWakeupCleanupCallback' does not exist in type 'SessionDeletionDeps'` error as an "infra problem" and asked the Orchestrator how to investigate, when the type-definition file was in their own diff three lines away from the error site.)

**Reverse case — common categories that look like a code bug but are actually environment differences:**

The reverse failure mode is also real: CI output that locally would mean "broken helper logic" can in CI mean "the runtime that your script spawns is not on PATH". Suspect environment differences before logic when:

- A script that worked locally produces nonsensical output in CI (e.g., contradictions in the output template — "Found 0 violations" alongside a non-zero exit code).
- The output is empty or template-only, with no meaningful content where data should be.
- Failure is on the first CI run for a freshly-added cross-runtime invocation (e.g., a `node` workflow now spawning `bun`, or vice versa).
- The same script invoked from a different workflow on the same branch passes — only the new caller fails.

**Diagnostic procedure for environment-difference suspects:**

1. **Identify the spawn target** — what binary does the script try to invoke? (`spawn('bun', ...)` / `spawn('node', ...)` / `spawn('npx', ...)`)
2. **Check the workflow yml** for the failing job — does it install or set up the target runtime? Look for `setup-bun`, `setup-node`, `actions/cache`, etc.
3. **Trace transitive callers** — the script may be invoked indirectly. A workflow you did not touch may now depend on a runtime you added a spawn for. Cross-runtime spawn is a transitive dependency and `paths-ignore` filters do not help.
4. **Compare with a known-passing workflow** — if a sibling workflow (`language-lint`, `test`, etc.) passes for the same script invocation, the difference is in the failing workflow's setup, not the script.

(Lesson: Sprint 2026-04-28 PR #716 — `coverage-check` failed with "Found 0 violation(s) ... exit 1". The Orchestrator hypothesized a logic bug in the language-check helper. Real cause: `test-coverage-check.yml` had no `setup-bun` step, so `spawnSync('bun', ...)` returned `result.status === null`, and `null ?? 1` produced exit code 1 with empty stdout. The agent — not the Orchestrator — found the true cause by tracing the spawn ENOENT chain.)

### Sub-pattern 2: CodeRabbit feedback

**Inference trap.** Concluding "CodeRabbit is clean" from a secondary signal: pre-merge checks passing (5/5), the absence of *new* inline comments, or a rate-limit message read as "nothing to address". None of these are the review verdict. A stale `CHANGES_REQUESTED` from an earlier push, or a bot that never actually ran because it was rate-limited, both look identical to "clean" if you only glance at one layer.

**Verify procedure.** Re-read the PR's 3-layer state at decision time, not from memory of an earlier read:

1. **Pre-merge checks** — necessary but not sufficient on their own.
2. **`reviewDecision`** — `gh pr view <N> --json reviewDecision`. Empty means the bot has not reviewed yet (not "clean"); `CHANGES_REQUESTED` must be resolved, not aged out. The only exception is the documented rate-limit fallback.
3. **Inline comments** — read the current actionable set, not "no new ones since last time".

When the local CLI or GitHub-side bot is rate-limited or unresponsive, follow the explicit dispositions in the [`coderabbit-ops`](../skills/coderabbit-ops/SKILL.md) skill rather than inferring the verdict from silence.

(Lesson: Sprint 2026-04-25 PR #694 — agent declared "clean" based on pre-merge 5/5 while `reviewDecision` was `CHANGES_REQUESTED` with 3 actionable issues. The passing pre-merge check was a secondary signal; the review state was the primary information.)

### Sub-pattern 3: Cross-repo issue separation

**Inference trap.** A cross-project knowledge share, or a symptom that resembles a sibling repo's known bug, is treated as proof that *this* repo exhibits the same defect. Filing an Issue, blaming a shared dependency, or claiming a pattern applies — all on resemblance alone — propagates a misdiagnosis across repos and wastes triage in both.

**Verify procedure.** Before filing, blaming, or claiming applicability:

1. **Reproduce in this repo's own code path** — locate the analogous code here and confirm the defect actually manifests, rather than asserting parity from the other repo's description.
2. **Separate send-side from receive-side** — when relaying a learning to another orchestrator, state what *this* repo verified versus what is inherited from the source. Do not present the source repo's inference as this repo's verified fact.
3. **Cite the code, not the other repo's doc** — the sibling's design doc describes its intent; this repo's code describes this repo's reality.

(Lesson: Sprint 2026-05-04 CTO room cross-share — conteditor Sprint 26 PR #1387 webhook fix misidentified its root cause four times in one day because each diagnosis inferred from a secondary signal instead of reading primary information. The shared learning is adopted here as a rule precisely so the same inference trap is not re-walked per repo.)

### Sub-pattern 4: Runtime observation

**Inference trap.** A dev-server log line, a websocket frame, a UI render, or an assumption about which notification channel is active is taken as proof that a code path executed or a notification will arrive. Channel behavior in particular is easy to over-generalize from a single observation — concluding "this channel does not work here" from one missed event without testing each channel independently.

**Verify procedure.**

1. **Confirm execution at the authoritative source** — the server-side store / state, or a deterministic single-file probe, not a log line or rendered UI that may lag or come from cache.
2. **Confirm each channel independently** — webhook routing and `conditional_wakeup` / `create_timer` are separate mechanisms with different reach: webhooks do not route to lightweight `EnterWorktree` worktrees, but `conditional_wakeup` and `create_timer` route to the orchestrator's own session and work regardless of how the worktree was created (see [`core-responsibilities.md`](../skills/orchestrator/core-responsibilities.md) Post-Merge Flow §7f for the same webhook gap). Do not collapse "one channel missed an event" into "all channels fail here".
3. **State the observation's confidence** — if a conclusion rests on a secondary runtime signal that could not be primary-verified, say so rather than reporting it as established fact.

(Lesson: Sprint 2026-05-02 retro PR #758 / brew PR #759 — the lightweight-worktree notification limitation was first recorded as "webhook AND `conditional_wakeup` both fail", inferred from a single missed-event observation. The owner clarified `conditional_wakeup` works fine; only webhooks fail. One observation was generalized across channels without per-channel verification.)

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

When the situation is a known operational pattern (stacked PR + base squash-merge), prefer to describe the patch set (commit subjects) and the intended rebase target, then request approval. Do not perform force-push "to save a round trip" — the per-PR approval gate exists because unintended branch overwrites are expensive to recover and the round-trip cost is small by comparison.

This rule does not apply to the initial push of a brand-new feature branch (no force involved) or to rebasing a local branch that has never been pushed (no remote divergence).

**Orchestrator-side phrasing discipline.** When the Orchestrator (or any instruction-writer) authorizes work that touches a force-push-relevant operation, the instruction must explicitly say what is approved and what is not. Vague phrases like "after rebase, continue" / "proceed" risk being read as blanket force-push approval. Required phrasing pattern: separate (a) "rebase and local verification are approved" from (b) "force-push remains gated — stop and report before pushing". (Lesson: Sprint 2026-06-26 PR #897 — the Orchestrator authorized "continue after rebase" intending only local rebase plus tests; the agent interpreted it as force-push approval as well. Both sides contributed to the gap, and explicit instruction phrasing is the orchestrator-side prevention.)

## Testing Requirements

- **Testing with code changes:** Always update or add tests. Code without tests is incomplete.
- **TDD for bug fixes:** Write a failing test first, then implement the fix. Verify the test's polarity by stashing **only the candidate fix** while keeping the new test present — either commit the failing test first and `git stash` the fix, or use `git stash --patch` to deselect the test hunks. Run the new test against unmodified production code (must fail), then restore the fix and confirm it passes. Tests that pass in both directions (with and without the fix) are not actually testing the bug; they will continue to pass after a future regression. (Lesson: Sprint 2026-04-29 — recurring agent pattern of writing tests that exercise adjacent code instead of the changed line.)

  **No partial polarity.** When N of M newly-added tests polarity-flip (fail without the fix, pass with it) but the remaining M−N tests pass identically in both directions, the M−N tests are NOT exercising the fix — they exercise adjacent code that happens to be involved. Do NOT accept "N of M is enough" as the gate. **Redesign the M−N tests to target the specific code path the fix changes, or remove them as non-regression-guarding.** Partial-polarity tests silently pass after a future regression and provide false confidence. (Lesson: Sprint 2026-06-26 PR #897 — agent wrote 4 #895 tests; stashing the fix failed only 3 of 4. The 4th passed identically in both directions because its assertion shape happened to match both branches. The agent reported "3/4 polarity confirmed" and proceeded; the 4th test does not regression-guard the orphan-recovery path.)
- **E2E / real-device verification is the default.** When a change has user-observable runtime behavior and that behavior is reachable in the available environment, verify it end-to-end through the actual shipping code path (the same entry point the user / caller uses) before reporting it complete — not only via unit / integration tests. This generalizes "Real-device verification for bug fixes" (below) from bug fixes to all observable runtime changes.
  - **Mechanism probe is not goal verification.** Exercising an internal sub-component in isolation (e.g., writing bytes directly to a PTY, calling a service without its caller) is a hypothesis check, not an E2E. Never substitute a probe for a shipping-path E2E and report "verified".
  - **Skipping E2E is not a unilateral agent decision.** If you believe E2E should be skipped — not executable in the environment, genuinely meaningless, or blocked by flakiness — STOP and consult the requester (the Orchestrator, or the owner) at that point; the skip is decided jointly by both parties. Never silently skip and open the PR. "Executable but flaky / tedious / multi-step" is not by itself a skip reason: flakiness calls for stabilization, retry, or a joint decision, not silent substitution. When a skip is jointly agreed, document the justification and who agreed in the PR body.
  - **A joint decision does not unlock a strong preflight recommend.** When the agent proposes to skip an integration test (or any other check that `preflight-check.js` flags as `strongly recommended`) and the Orchestrator approves, the approval is not a constraint override — it is a second judgment about the same gap, and both judgments can fail together. The Orchestrator's `Y` does not convert a `strongly recommended` warning into an `optional` one. Treat the warning as binding for the category it flags (wire-level cross-package changes, derived shared-type fields, etc.); the joint decision can move *which* test to add (e.g., integration vs. E2E) but not whether to add one. The preflight warning stays advisory by design (mechanical blocking would reject too many legitimate PRs), so the discipline lives in this rule rather than in the script. (Lesson: Sprint 2026-06-30 PR #926 — the agent proposed to skip the integration test on the grounds "derived field, simple shape, unit tests suffice"; the Orchestrator approved on the same reasoning. Both unit-test layers passed; the wire-level schema gap landed in main and surfaced during the owner's Browser QA. The structural backstop is tracked separately in `pre-pr-completeness.md` Q10 and Issue #927.)
  - (Lesson: Sprint 2026-05-20 #792 / PR #793 — the agent verified via PTY byte probes (mechanism) and reported "verified" without the shipping-path E2E (MessagePanel -> server -> injectMessage); an unconditional bracketed-paste fix that did not actually fix the bug nearly merged. Owner-prompted real E2E disproved both the fix and the original root-cause diagnosis. Cost: a closed PR + Issue re-diagnosis, avoidable by E2E-by-default.)
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

### Privilege-elevation commit message convention

Commit messages for PRs that introduce or modify privilege-elevation paths (the `runAsUser` / `spawnAsUser` / `rmRecursiveAsUser` family in `packages/server/src/services/privilege-elevation.ts`, or any caller chain that ends in a `sudo -i`-shaped invocation) MUST avoid writing `sudo` as a literal token in the message body. Phrase the same intent with "elevated login shell" / "via privileged spawn" / "via the elevation helper" instead.

**Why.** The orchestrator's sandbox guard scans tool inputs for `sudo` as a destructive-action precaution and blocks the entire invocation when it matches — including `gh issue create --body-file` / `git commit -m`-style usages where the literal is only narrative. Two attempts on PR #915 hit this trap before the agent paraphrased the body and the commit landed. Code comments are not scanned and can keep using `sudo` directly; only commit messages, PR bodies, and Issue bodies need the paraphrase.

**Scope extension: the same trap fires on any tool input body, not only commit messages for elevation code.** PR bodies, Issue bodies, `gh api ... -X PATCH` heredoc contents, and any other narrative body containing the `sudo` substring — even inside a quoted test name (e.g. `describe('sudo-skip (direct) path')`) or narration referencing an existing identifier — will be blocked identically. The trap is content-based, not context-aware. When a public artifact needs to reference such an identifier, paraphrase the reference (`describe('elevation-skip (direct) path')` in the body reference, or `elevation-skip test in multi-user-mode.test.ts`), leaving the source file's actual name unchanged. This applies regardless of whether the PR itself touches elevation code — it triggers whenever the narrative substring appears.

(Lessons: Sprint 2026-06-29 PR #915 — agent's first commit message body contained `sudo -i` in the elevation explanation; both attempts returned `sudo is denied` until the body was sanitized. Sprint 2026-07-16 — two independent delegates (PR #1143 delegate referencing `multi-user-mode.test.ts` describe titles, and PR #1148 delegate referencing an existing failing test name) hit the same trap in PR body / heredoc content unrelated to elevation-code PRs; both resolved with paraphrase.)

### Allowlist-baseline lint introduction template

When introducing a new lint that flags repo content already pervasive at main (CodeRabbit-pattern lint, comment-blame-shift lint, etc.), bake an initial allowlist of current violations into the same PR that introduces the detector, AND document the **migration policy** in the PR body. The allowlist absorbs the baseline so CI does not fail on existing content; the migration policy is what stops the allowlist from becoming a permanent silencer.

Required PR body sections (in this order, for reviewer 1-second comprehension):

1. **Why** — one-paragraph motivation for the lint.
2. **Strategy: allowlist baseline + new-violation gate** — explicitly state that the allowlist captures the current main snapshot; new violations introduced after this PR will trip CI.
3. **Baseline breakdown** — count by package / pattern / file with concentration ranking (which files / areas are most violation-heavy, for cleanup prioritization).
4. **Migration policy** — name the cleanup track / Issue that will shrink the allowlist over time. Without this, the lint becomes a permanent silencer.
5. **Summary / Test plan / Closes #N** — standard tail.

(Lesson: Sprint 2026-06-29 PR #909 — source-comment blame-shift lint detector landed with 174 allowlisted entries; PR body documented the cleanup track ([#898](https://github.com/ms2sato/agent-console/issues/898)) and a concentration-ranked priority list, so reviewers immediately understood the trade-off and downstream agents had a concrete starting point. Without the migration policy section, the allowlist would silently become permanent technical debt.)

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

**Public artifacts:** Write all code comments, commit messages, issues, pull requests, and documentation in English. Quoted owner remarks are also translated to English in public artifacts (the original wording can be paraphrased; the surrounding lesson does not need to preserve the exact phrase).

**User-facing artifacts:** Review annotations, memos, and other content visible only to the user should follow the user's preferred language.

**Communication:** Respond in the same language the user uses. Technical terms and code identifiers can remain in English.

### Mechanical enforcement

`scripts/check-public-artifacts-language.mjs` is the canonical check. It scans `CLAUDE.md`, `docs/**/*.md`, `.claude/rules/**/*.md`, `.claude/skills/**/*.md`, and `.claude/agents/**/*.md` for any Letter character (`\p{L}`) that is not in the Latin / Greek / Cyrillic scripts. The detection is language-agnostic: it does not hard-code Japanese or any other writing system, so adding a new public artifact in any other script (Han, Hangul, Arabic, Hebrew, Devanagari, Thai, ...) fails the same way.

The check runs at five points:

1. **Local (any time):** `bun run check:lang` — quick ad-hoc verification.
2. **Commit-msg git hook (recommended setup):** `bun run hooks:install` installs `scripts/git-hooks/commit-msg` into the repository's hooks directory (idempotent, symlink with copy fallback). The hook pipes the prepared commit message through the language check in stdin mode and rejects the commit on any violation. This is opt-in but strongly recommended — it surfaces commit-message violations at commit time, before push, while the CI / preflight gates only scan files. The hook resolves the script path via `git rev-parse --show-toplevel`, so it works correctly across linked worktrees once installed once at the common hooks dir.
3. **Pre-PR preflight:** `node .claude/skills/orchestrator/preflight-check.js` — runs the language check alongside the test-coverage and rule-skill-duplication invariants. Non-zero exit blocks PR readiness.

   **Preflight diff-scope caveat — run AFTER commit, BEFORE push, not pre-commit.** The script derives the affected file set from `git diff origin/main...HEAD` (committed changes vs the merge base), so it sees zero files when the working tree changes have not yet been committed. Pre-commit runs therefore return a misleadingly-green "no files affected" report, leaving real coverage gaps to surface only at CI push time. The robust local invocation order is: stage everything → `git commit` → `node .claude/skills/orchestrator/preflight-check.js` → fix any reported gaps with a fixup commit → `git push`. (Lesson: Sprint 2026-06-29 PR #906 — local preflight passed clean before commit because two newly-modified production files had no committed diff yet to be evaluated; CI's post-push preflight then flagged both as missing sibling tests, requiring a follow-up commit round. The script behaves identically locally and in CI; only the timing of the invocation differs.)
4. **CI:** `.github/workflows/language-lint.yml` — fires on changes under `docs/`, `.claude/`, and any `*.md`. Failure blocks merge.
5. **Acceptance Q11:** `.claude/skills/orchestrator/acceptance-check.js` — auto-detects the verdict and asks the Orchestrator to confirm before merge.

Output format is consistent across all entry points: `file:LINE:COL CHAR U+CODEPOINT`, one line per violation. The commit-msg hook reports violations under the virtual filename `<stdin>`.

## Claude Code on the Web (Remote Environment)

When running in Claude Code on the Web, `gh` CLI is automatically installed via a SessionStart hook. Due to the sandbox proxy, `gh` commands require the `-R owner/repo` flag explicitly (`-R ms2sato/agent-console`).
