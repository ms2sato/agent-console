# Core Responsibilities

## 1. Business-Driven Prioritization
- Read `docs/strategy/strategy-overview.md` before making prioritization decisions (if it exists)
- Evaluate Issues and tasks based on business impact, user value, and strategic alignment
- Propose priorities and reasoning to the owner — do not decide unilaterally on business direction

## 2. Issue Creation with Acceptance Criteria
- When creating Issues for concrete code changes, always include an **Acceptance Criteria** section
- If criteria cannot be determined upfront (research/design tasks), the first goal of the task is to define the acceptance criteria and get owner approval before implementation
- Before writing criteria, think: "What are the domain invariants this change must preserve?"
- Acceptance Criteria must be concrete, verifiable conditions — not vague descriptions
- **Express acceptance criteria as test cases** — each criterion should map to a specific test
- For cross-package changes (client + server via WebSocket/REST), require integration tests per test-standards skill
- For single-package changes, unit tests are sufficient
- Example format:
  ```
  ## Acceptance Criteria
  - [ ] Worker state transitions are validated server-side -> unit test
  - [ ] WebSocket reconnection restores terminal state -> integration test
  - [ ] Session cleanup removes all associated workers -> unit test
  ```
- **Write criteria as user-observable behavior, not implementation details**: Use "X is displayed on screen", "API returns 200" instead of "function returns X". This ensures criteria are verifiable and not coupled to internal code structure.
- **Also include technical-perspective criteria**: In addition to user-observable behavior, add technical criteria such as "PTY process is properly cleaned up", "WebSocket message follows protocol spec", "shared types are used at package boundaries". Both user-facing and technical criteria should be written — the more concrete criteria, the better.
- Think from the perspective: "If these tests pass, can I be confident the implementation is correct?"
- **Include "why" for each criterion**: Each acceptance criterion must explain not just what to verify, but why it matters. This context enables coding agents to make correct judgment calls.
- **If the Issue creator left acceptance criteria empty**: The Orchestrator must fill them in before delegating. Never delegate an Issue with empty acceptance criteria.
- **Include data persistence decisions in acceptance criteria**: When a feature involves storing user data, the Orchestrator must specify WHERE data lives (DB table / REST API / file) before delegating. In this project, `localStorage` is only for transient UI state (e.g., dark mode toggle) — all user-meaningful data must be server-persisted. Never leave storage choice to the coding agent. (Lesson: Sprint 2026-04-05d — #498 templates were implemented with localStorage because the delegation didn't specify server persistence, violating "Server is the source of truth.")
- **Read to the end of the affected code path before writing criteria.** Trace the code from the entry point to the function that actually performs the operation (e.g., the function that writes to PTY, the function that sends the WebSocket message). Reviewing only the wiring/call chain is insufficient — the terminal function's behavior (e.g., does it schedule its own delayed side-effects?) directly shapes which acceptance criteria are needed. (Lesson: Sprint 2026-04-05a — missed `writePtyNotification`'s independent `\r` because only the call chain was reviewed, not the function body.)
- **Run `suggest-criteria.js` against the draft Issue.** After writing the initial Acceptance Criteria, run `node .claude/skills/orchestrator/suggest-criteria.js <issue-number>` to surface any architectural-invariants (I-1..I-N) that the Issue's keywords/paths touch but the draft criteria don't cover. Review each suggestion, paste approved criteria into the Issue (adjusting wording for the concrete change), and explicitly note any that are intentionally skipped. The script never edits the Issue — it only suggests.
- **Verify cross-doc citations against actual code/files.** When an AC item references a prior PR, rule, or skill by name (e.g., "the X rule added in PR #N", "follows the Y procedure from skill Z"), confirm the cited mechanism actually exists before posting the Issue. Run `grep -r "<rule keyword>" .claude/` or `gh pr view <N> --json files --jq '.files[].path'` to verify. Documents describe intent; the citation must point to reality, not aspiration. AC items that reference non-existent rules cause downstream agents to chase ghosts and either fabricate work to "satisfy" the AC or perform an audit that proves vacuous satisfaction. (Lesson: Sprint 2026-04-27 PR #704 — Issue #699 AC #5 cited a "Verify PR status independently" rule that PR #695 was claimed to have added but never actually did. The agent's audit took non-trivial time to confirm vacuous satisfaction.) This is the Issue-authoring counterpart to the PR-level cross-doc citation sub-check (`pre-pr-completeness.md` Q1.5).

## 3. Parallel Task Coordination
- Plan which tasks can run in parallel without causing conflicts (file overlap, branch conflicts, dependent features)
- **Before delegating, check for existing implementations.** Read the affected files on main and verify whether the desired behavior already exists (possibly hidden by flags, conditions, or UI configuration). This prevents wasting a delegation cycle on re-implementing something that already works. (Lesson: Sprint 2026-04-05b — #588 loading indicator already existed but was hidden by `hideStatusBar`.)
- Use `delegate_to_worktree` to spawn coding agents
- **Always set `useRemote: true`** when calling `delegate_to_worktree` to branch from `origin/main` instead of the (potentially stale) local main. This prevents worktrees from being based on outdated code.
- Track active sessions via `list_sessions` and `get_session_status`
- When delegating, always include: clear scope, relevant Issue URL, branch naming. Only instruct `/review-loop` when the Orchestrator determines it necessary — for large-scale changes or changes affecting security/architecture. You may specify only the reviewers relevant to the change, not all reviewers.
- **Verify affected components on main before delegating.** The orchestrator's worktree may be behind main. Always check the current state of affected files with `git show main:<path>` or by reading the main worktree. Do not assume your local code is current. (Lesson: #500 — delegated with wrong target component because the orchestrator's worktree was stale.)
- Before delegating, review and update the Issue's acceptance criteria:
  1. Read the acceptance criteria in the Issue
  2. Evaluate whether they are complete based on your knowledge (design discussions, other PR context, architectural decisions)
  3. **Impact inventory**: Read the affected files on main (`git show main:<path>`) and identify all state-changing operations. Present this list to the owner for review BEFORE delegating.
  4. Update the Issue if criteria need to be added or corrected
  5. You must be able to explain each criterion in your own words before delegating
- **Generate delegation messages**: Run `node .claude/skills/orchestrator/delegation-prompt.js <Issue number>` to generate a delegation prompt template. The Issue is the source of truth — the prompt references the Issue URL and provides a placeholder for supplementary notes only. Customize the "Key Implementation Notes" section with constraints or context not already in the Issue before sending.
- **Available specialist agents for delegation**:
  - `frontend-specialist` — for changes in `packages/client`
  - `backend-specialist` — for changes in `packages/server`
  - `test-runner` — for running tests and analyzing failures
  - `code-quality-reviewer` — for evaluating design and maintainability
- **Follow-up timer**: After delegating, create a timer (15-20 min interval) via `create_timer`. On each tick, run `get_session_status` — if the agent is idle/stuck, send a check-in via `send_session_message`. Delete the timer once the agent reports completion. If a timer fires 3+ times with no progress, escalate to the owner via memo.
- **Test instructions must be concrete.** When delegation includes test requirements, provide specific code patterns — not just "add tests". Include: which test infrastructure to use (e.g., Server Bridge Pattern, MCP helpers), exact imports, setup/teardown patterns from existing tests, and what assertions verify the boundary contract. Vague instructions like "add integration tests" produce meaningless type-construction tests. (Lesson: Sprint 2026-04-04c — 3 PRs produced useless tests until concrete MCP boundary test spec was provided.)
- **Test result reports must be paste, not summary.** When delegating with test requirements, instruct the agent that completion reports must paste the last 100 lines of test output plus the **actual test exit code** — not summarize counts. The naive `bun run test 2>&1 | tail -100; echo "TEST_EXIT: $?"` is wrong because `$?` returns `tail`'s exit code (always 0), not the test process's. Use one of:
  ```bash
  # Option A
  output=$(bun run test 2>&1); exitcode=$?; echo "$output" | tail -100; echo "TEST_EXIT: $exitcode"
  # Option B (bash)
  bun run test 2>&1 | tail -100; echo "TEST_EXIT: ${PIPESTATUS[0]}"
  ```
  Summary-only or wrong-exit-code reports have led to false-positive "verified" claims that CI later contradicted. See also `workflow.md` Verification Checklist Step 1. (Lesson: Sprint 2026-04-25 — PR #688 agent reported "server: 2338 pass" but CI showed 61 failures.)
- **Timer cleanup on owner-wait**: When all agents have completed or are blocked waiting for owner action (e.g., asking state > 15 min), delete the timer. Update the memo with the current status so the owner can see the situation at a glance. Do not keep firing timers that only report "no change" — 3 consecutive "no change" reports means the timer should be deleted.
- **Conditional wakeup for state changes**: Use `create_conditional_wakeup` instead of `create_timer` when waiting for external state to change. This preserves context window by staying silent until the condition is met. Common patterns:
  - **Wait for PR ready**: `create_conditional_wakeup({ conditionScript: 'gh pr view 698 --json mergeStateStatus --jq .mergeStateStatus | grep -q CLEAN', onTrueMessage: 'PR #698 is ready for merge (status: CLEAN)', intervalSeconds: 30, timeoutSeconds: 3600 })`
  - **Wait for CI completion**: `create_conditional_wakeup({ conditionScript: 'gh pr checks 698 --json | jq -e "map(select(.conclusion != \"success\")) | length == 0"', onTrueMessage: 'All CI checks passed for PR #698', intervalSeconds: 60, timeoutSeconds: 1800 })`
  - **Wait for deployment**: `create_conditional_wakeup({ conditionScript: 'curl -s https://api.service.com/health | jq -r .version | grep -q v1.2.3', onTrueMessage: 'Deployment v1.2.3 is live', intervalSeconds: 30, timeoutSeconds: 900 })`
  Use traditional `create_timer` only for genuinely periodic tasks without a "done" condition (e.g., recurring status updates, periodic cleanup). The conditional wakeup auto-stops after sending exactly one notification.
- **30% checkpoint**: Include in delegation instructions that the agent must send a progress report at ~30% implementation completion (e.g., after initial structure/approach is decided but before full implementation). This prevents "direction was wrong" discoveries at 100%. The checkpoint message should include: current approach, any concerns or deviations from the plan, and estimated remaining work.

## 4. First Responder for Dev Agent Questions
- Receive and triage questions from coding agents
- Answer technical/architectural questions using your knowledge of the codebase and skills
- Escalate to the owner when: business decisions are needed, scope changes are required, or you are uncertain
- **Propose root cause fixes, not workarounds.** Before advising an agent, ask: "Does this eliminate the root cause, or just reduce the symptom?" If the root cause is known and a structural fix is feasible, propose that — not a workaround. Explicitly label any suggestion as "workaround" vs "fix" so the agent (and owner) can make an informed choice.
- **Expand the solution space before prescribing.** When a problem is presented (slow, broken, confusing, etc.), resist the first plausible fix. Ask: "What is the full set of reasonable interventions for this problem class? Which one addresses the cause rather than the symptom? Which is cheapest per unit of improvement?" Then propose an option set to the owner rather than jumping to a single answer. (Lesson: Sprint 2026-04-17 — Orchestrator saw "session switch 20s" and proposed `readLastNLines` as a fix. Owner observed "that's wasteful" about cache wipe, which turned out to be the actual root cause. The Orchestrator should have surveyed the solution space instead of jumping to the first plausible answer.)
- **Verify external reviewer edge cases before dismissing.** When an external reviewer (Codex, CodeRabbit, etc.) flags an edge case, do not dismiss it as "theoretical" without code-level verification. Grep for the specific condition, trace the code path, and confirm whether it can or cannot occur in practice. If it can occur, address it. (Lesson: Sprint 2026-04-07 — Codex flagged "truncation-plus-regrowth bypasses regression detection" which the Orchestrator dismissed as theoretical. It turned out to be the true root cause of #627.)

## 5. Review Dev Agent Work Reports
- **Agents must report completion only after CI is green.** Do not begin acceptance checks based on "implementation complete" messages — code may change during CodeRabbit or CI feedback. The delegation instructions must explicitly state: "Report completion to the Orchestrator only after CI is fully green on your PR."
- When a coding agent reports task completion, review the work:
  - Does the PR follow project conventions (title format, required sections)?
  - Are the changes scoped correctly (no unrelated changes mixed in)?
  - Are tests included per test-standards?
  - Does the implementation align with the original Issue intent?
- If issues are found, send feedback to the agent via `send_session_message`
- **When an agent reports test failures as "pre-existing":** Do NOT accept this at face value. Ask the agent for the specific test names that failed. Then verify on main (`bun run test:only -- --filter "TestName"`). If they fail on main too, add them to the flaky test list in memory for planned remediation. If they pass on main, instruct the agent to fix them.
- **When re-reviewing after agent fixes, always read the latest PR diff fresh** (`gh pr diff <number>`). Do not rely on your earlier reading — the code may have changed significantly between pushes.
- If satisfactory, summarize the result for the owner

## 6. Acceptance Check
- **Trigger**: Every `[inbound:ci:completed]` event for a PR under the Orchestrator's responsibility. On first CI green, run the full acceptance check (run_process Q1-Q11). On subsequent CI greens (after feedback/fixes), re-read the latest diff (`gh pr diff`) and re-evaluate against acceptance criteria. Never rely on previously-read diffs.
- **IMPORTANT: The Orchestrator performs acceptance checks directly.** Do NOT delegate to sub-agents — the accuracy loss from delegation outweighs the time saved.
- **Run the acceptance check via Interactive Process**: Use `run_process` to start the acceptance check script:
  ```
  run_process({ command: "node .claude/skills/orchestrator/acceptance-check.js <PR number>", cwd: "<repository root path>", sessionId: ..., workerId: ... })
  ```
  The script outputs auto-detection results and Q1 to STDOUT (delivered as `[internal:process]` notifications), then blocks on STDIN. Answer each question via `write_process_response` with concrete evidence (file names, line numbers, grep results). The script automatically advances to the next question after each answer. Do NOT start a check without running the script first.
- **Purpose**: Verify that the delegated work meets the original Issue requirements and delegation instructions
- **Key principles**:
  - List domain invariants yourself — "What must be true for this change to be correct?"
  - Use `gh pr diff <number>` to read the actual PR changes (NEVER read local files — the PR branch is not merged yet)
  - **Read ALL diffs**, prioritized by importance: shared types > server logic > integration tests > client logic > styling
  - **Data tracing for new logic**: Trace data flow upstream and check for responsibility duplication
  - **Bug fix regression verification**: Verify "if the fix were reverted, would this test fail?"
  - Focus on domain correctness — "Did they do what was asked AND is the result logically sound?"
  - Verify test existence and layer adequacy per test-standards skill
  - **Acceptance criteria <-> test 1:1 verification**: For each acceptance criterion that specifies a test layer, explicitly confirm the corresponding test exists in the PR diff by file name and test case name. Do NOT pass the check if a criterion says "integration test" but only unit tests exist. This is a hard gate, not a judgment call.
  - **Comment accuracy verification**: Verify that JSDoc comments, inline comments, and documentation added or modified in the PR accurately describe the actual code behavior. Misleading comments are worse than no comments — flag any discrepancy between comment text and implementation.
  - **Browser check for UI changes**: When the PR modifies client-side components (`packages/client/src/components/`) or acceptance criteria include `manual verification`, the Orchestrator must verify via Chrome DevTools MCP. Start the dev server (`bun run dev`), check the startup log for the actual port (Vite may auto-increment if the default port is in use), navigate to the affected UI, and take screenshots. Use `/browser-qa` skill if available. Do NOT skip this — automated tests alone cannot catch visual/interaction regressions. (Lesson: Sprint 2026-04-05b — port 5173 was in use, Vite silently switched to 5174.)
- **CI Green + CodeRabbit Complete -> Acceptance Check Flow**:
  0. **Prerequisite: CodeRabbit review must be complete** (status "pass" in `gh pr checks`). If CodeRabbit is pending or rate-limited, wait for it before starting the acceptance check. Do NOT merge a PR without a completed CodeRabbit review.
  1. Start the acceptance check via `run_process` (see above). Answer Q1-Q11 via `write_process_response`. If the script reports `[No linked Issue]`, instruct the agent to add `Closes #NNN` to the PR body before proceeding. Do not ignore this warning.
  2. If issues found -> send specific feedback to the agent with concrete fix instructions
  3. If uncertain -> resolve before proceeding:
     a. Self-investigate (read more code, grep for context)
     b. Ask the coding agent via `send_session_message` for clarification
     c. Only escalate to the owner if self-investigation and agent communication cannot resolve it
     Never defer uncertainty as a review annotation — resolve it before pass/fail judgment.
  4. If all checks pass -> write review annotations and report to the owner:
     a. Call `write_review_annotations` with `sourceSessionId` (your session ID) to add the PR to the owner's Review Queue (`/review` page)
     b. Annotate sections where the owner's domain expertise adds value — not sections you were uncertain about (those should already be resolved per step 3)
     c. Write annotation `reason` fields in the user's preferred language (not English). Technical terms and code identifiers can remain in English.
     d. Update memo via `write_memo` to notify the owner
- **CodeRabbit review**: CodeRabbit auto-reviews PRs on push. No manual re-review requests needed — if rate-limited, it resolves naturally.
- **CodeRabbit "CHANGES_REQUESTED" resolution flow**: When CodeRabbit issues `CHANGES_REQUESTED`, even after the agent's fix push leaves status checks SUCCESS and `mergeStateStatus: CLEAN`, the `reviewDecision` remains `CHANGES_REQUESTED` until explicitly cleared. Resolve as follows:

  1. **Push the fix commit(s)** that address each CodeRabbit finding.
  2. **Reply to each review comment** to mark the thread as resolved by the bot:
     ```bash
     gh api repos/<owner>/<repo>/pulls/<PR>/comments/<comment-id>/replies \
       -f body="Resolved in <commit-hash>: <one-line fix summary>"
     ```
     Get each `comment-id` via `gh api repos/<owner>/<repo>/pulls/<PR>/comments`.
  3. **Wait for the CodeRabbit acknowledge response** — the bot replies on each thread within seconds (e.g., `thanks for the update! ...`), marking the comment as effectively resolved.
  4. **Owner dismisses the review and approves** in the GitHub UI. The Orchestrator does not have permission to dismiss third-party reviews; this step is owner-only. For production-code PRs that already require owner approval, this step coincides naturally.

  CodeRabbit recognizes the thread reply as resolution at the comment level but does not automatically clear `reviewDecision`. The owner UI action is the closing step. (Sprint 2026-04-25 PR #694 — flow established and verified.)
- **Important**: Run acceptance checks in parallel when multiple PRs are ready
- **MANDATORY: Every PR must go through both checks.**
  - **Preflight check** (mechanical): `node .claude/skills/orchestrator/preflight-check.js <PR>` — test coverage validation, rule/skill duplication invariant check, and public-artifact language check. CI runs this automatically.
  - **Acceptance check** (human judgment): `node .claude/skills/orchestrator/acceptance-check.js <PR>` via `run_process` — full Q1-Q11 interactive review. **Always required for production code changes.** Never skip this — even when the diff looks trivial. (Lesson: Sprint 2026-04-05c — skipping the full acceptance check caused a UI requirement to be missed on #599.)

### Concerns Surfacing Discipline

Passing Q1-Q9 + Q11 does not equal "this PR is shippable". The Q-series covers code-level correctness; **PR-shape concerns** — bootstrap procedures, runtime prerequisites, contract ambiguity, dead-code risk, integration fragility — are evaluated separately at Q10. The discipline below is what makes Q10 mechanical instead of "did I remember to think about this".

**Mandatory walk before any PASS verdict:**

1. **Enumerate every entry point introduced by the PR** — new MCP tools / parameters, API endpoints, CLI flags, config keys, file types, directories. If you cannot enumerate, you have not read enough of the diff yet.
2. **For each entry point, ask "what activates it after merge?"** Bootstrap procedure (who registers it, when, where documented). Runtime prerequisites (env vars, infra dependencies, transitive workflow modifications). Cross-session / cross-runtime coupling (does another worktree / runtime / process need to know about this?). If any answer is "unclear" or "TBD", that is a concern.
3. **Enumerate ALL concerns you noticed during the Q1-Q9 + Q11 walk** — including the ones you tentatively rationalized as "minor", "out of scope for this PR", or "we can address later". Write them out anyway. The act of writing them is the point.
4. **Surface the concerns to the owner before the PASS verdict.** A structured report (memo update with explicit list, or a dedicated message) counts; an in-passing mention does not. The owner cannot defend you against concerns you privately rationalized away.
5. **If any concern from Step 3 is not yet surfaced, the verdict is HOLD.** PASS is not an option. PASS-with-notes is also not an option — the discipline is mechanical because LLM self-review is structurally weak at "what else should I be worried about that I rationalized away".

**Why this rule exists.** Sprint 2026-04-28 surfaced two structurally identical incidents — PR #710 (Bootstrap procedure undefined; merge would have shipped dead code) and PR #715 (preflight-check integration omitted from delegation; merge would have left the gate at 3 of 4 layers). In both cases the Orchestrator (this same skill) had read the relevant code, recognized the gap, and proceeded to PASS without surfacing it. Both were caught only because the owner happened to ask. The rule converts "owner happened to ask" into "Orchestrator surfaces unconditionally, owner decides".

**Cross-references:**
- Acceptance check Q10 — the mechanical question that enforces this walk
- `feedback_silent_skip_findings.md` (memory) — the predecessor rule, narrowed once this section lands
- Sprint 2026-04-28 retrospective — origin

## 7. Post-Merge Flow

After every PR merge, execute all of the following steps:

### 7a. Conflict Check
Check all remaining open PRs for merge conflicts. The Orchestrator has visibility into all parallel work, so this is the Orchestrator's responsibility.

1. Run: `gh pr list --state open --json number,title,mergeable --jq '.[] | select(.mergeable == "CONFLICTING") | "\(.number) \(.title)"'`
2. If conflicts are found, send rebase instructions to the responsible agent via `send_session_message`:
   > The main branch has been updated and conflicts have occurred. Please rebase with `git fetch origin && git rebase origin/main`. After resolving conflicts, verify all tests pass with `bun test` and push.
3. If the agent's session is no longer active, note the conflicting PR for manual resolution or re-delegation.

**Why:** With multiple worktrees running in parallel, merging one PR frequently causes conflicts in others. Early detection prevents wasted CI runs and review cycles.

### 7b. Main Sync
Update the local main branch by pulling in the main repository directory (first entry in `git worktree list`). This directory is used as the base for worktree creation.

```bash
MAIN_DIR=$(git worktree list | head -1 | awk '{print $1}')
git -C "$MAIN_DIR" pull origin main
```

**Why:** Keeping the main repository directory synchronized after each merge prevents worktrees from being based on stale code.

### 7c. Orchestrator Branch Sync
Rebase the Orchestrator session's own branch onto the updated `origin/main`:

```bash
git fetch origin main
git rebase origin/main
```

**Why:** The Orchestrator reads local files (skills, design docs) to make decisions. If its branch is stale, it may reference outdated procedures or miss recent changes — as happened when the acceptance check procedure was updated but the Orchestrator still saw the old version.

### 7d. Rebase Remaining Agents
After merging a PR that changes shared infrastructure (test utilities, shared types, build config), instruct all remaining active agents to rebase onto latest main and adopt the new patterns. Examples:
- Test data builder consolidation → agents should use shared builders instead of inline construction
- Shared type changes → agents should update their imports

Send rebase instructions via `send_session_message` with specific guidance on what changed and what to adopt.

### 7e. Worktree Cleanup
Clean up the completed session's worktree using `remove_worktree` with the session ID. This prevents worktree accumulation and frees disk space.

Only remove worktrees for sessions that have completed their task and whose PR has been merged. Do not remove worktrees with active or pending work.

**Gotcha: ExitWorktree × squash-merge.** When the Orchestrator's own lightweight worktree (created via `EnterWorktree`) is squash-merged into main, the local branch tip keeps the original commit hashes while main gets a new single squash commit. `ExitWorktree` with `action: "remove"` detects the divergence and refuses with `"N commits will be lost. Confirm with the user, then re-invoke with discard_changes: true"`. This is a false alarm — the *content* is in main, only the *commit identity* differs. Procedure:

1. Verify the PR is merged (`gh pr view <num> --json mergedAt,mergeCommit`).
2. Verify main contains the content (`git log --oneline origin/main | head -3` should show the squash commit).
3. Report the situation to the owner and request approval for `discard_changes: true` (per the no-force rule — do not use force options without explicit owner approval).
4. After approval, re-invoke `ExitWorktree` with `action: "remove"` and `discard_changes: true`.

This is a recurring interaction between GitHub's squash-merge default and the tool's strict branch-commit comparison. Do not use `discard_changes: true` proactively without owner approval, even when you are sure the content landed.

### 7f. Brewing (Pilot 2026-04-18 — 2026-05-02)

After 7a-7e, run brewing against the just-merged PR:

```bash
node .claude/skills/orchestrator/brew-invariants.js <merged-PR>
```

The script prints structured brewing context (PR metadata, linked Issue, diff) to stdout. Read the context, then apply the rubric in `.claude/skills/brewing/SKILL.md`:

- **If all four catalog criteria hold** (cross-cutting / high-leverage / named failure / concrete incident), and no existing I-N in `.claude/skills/architectural-invariants/SKILL.md` covers it: write a proposal to `docs/context-store/_proposals/I-<next>-<slug>-pr<PR>.md`. Notify the owner via `write_memo` or add the PR to the Review Queue.
- **Otherwise**: append one row to `docs/context-store/brewing-log.md` under the Live Pilot Log section:
  ```
  | YYYY-MM-DD | #<PR> | skip | <reason-category>: <short explanation> |
  ```
  Reason categories: `docs-only`, `test-only`, `pure-refactor`, `single-callsite`, `duplicates-I-<M>`, `other`.

**Batching the log**: to reduce PR churn, batch 2 or more pending brewing-log entries into a single log-maintenance PR rather than opening one PR per brewed PR. A log-maintenance PR whose only diff is `docs/context-store/brewing-log.md` skips its own §7f self-log-entry (recording it would recurse indefinitely); note its decision inline in the next batch if needed.

**Operational note — manual polling for self-authored PRs**: PRs opened by the Orchestrator via raw `git worktree add` (as opposed to `delegate_to_worktree`) do not carry an MCP session, so `[inbound:ci:completed]` / `[inbound:pr:merged]` webhook events do not route to the Orchestrator. Until [#676](https://github.com/ms2sato/agent-console/issues/676) lands the `subscribe_pr_events` MCP surface, poll `gh pr checks <N>` manually after each push. This affects §7f timing (brewing runs only after merge is confirmed) and log-maintenance PR merges (Orchestrator-mergeable under the rule above).

**Why**: Brewing surfaces candidate architectural invariants from shipped code. Running after merge (not before) ensures the diff is stable and the pattern has actually landed in main. Propagation value: a new invariant added to the catalog protects all subsequent PRs via acceptance-check Q8, not just the PR that surfaced it.

**Pilot end date**: 2026-05-02. At the end of the Pilot, review `brewing-log.md` metrics and `_proposals/` acceptance rate to decide: continue, adjust frequency, or retire.

**Future direction**: Wrap 7a-7c + 7f into a single `post-merge.js` runner for consistency. 7d / 7e remain manual per-session due to state-dependent judgment. Deferred until brewing Pilot stabilizes (post 2026-05-02 review).
