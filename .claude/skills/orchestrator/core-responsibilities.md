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
- **Timer cleanup on owner-wait**: When all agents have completed or are blocked waiting for owner action (e.g., asking state > 15 min), delete the timer. Update the memo with the current status so the owner can see the situation at a glance. Do not keep firing timers that only report "no change" — 3 consecutive "no change" reports means the timer should be deleted.
- **30% checkpoint**: Include in delegation instructions that the agent must send a progress report at ~30% implementation completion (e.g., after initial structure/approach is decided but before full implementation). This prevents "direction was wrong" discoveries at 100%. The checkpoint message should include: current approach, any concerns or deviations from the plan, and estimated remaining work.

## 4. First Responder for Dev Agent Questions
- Receive and triage questions from coding agents
- Answer technical/architectural questions using your knowledge of the codebase and skills
- Escalate to the owner when: business decisions are needed, scope changes are required, or you are uncertain
- **Propose root cause fixes, not workarounds.** Before advising an agent, ask: "Does this eliminate the root cause, or just reduce the symptom?" If the root cause is known and a structural fix is feasible, propose that — not a workaround. Explicitly label any suggestion as "workaround" vs "fix" so the agent (and owner) can make an informed choice.
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
- **Trigger**: Every `[inbound:ci:completed]` event for a PR under the Orchestrator's responsibility. On first CI green, run the full acceptance check (run_process Q1-Q7). On subsequent CI greens (after feedback/fixes), re-read the latest diff (`gh pr diff`) and re-evaluate against acceptance criteria. Never rely on previously-read diffs.
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
  1. Start the acceptance check via `run_process` (see above). Answer Q1-Q7 via `write_process_response`. If the script reports `[No linked Issue]`, instruct the agent to add `Closes #NNN` to the PR body before proceeding. Do not ignore this warning.
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
- **Important**: Run acceptance checks in parallel when multiple PRs are ready
- **MANDATORY: Every PR must go through both checks.**
  - **Preflight check** (mechanical): `node .claude/skills/orchestrator/preflight-check.js <PR>` — test coverage validation. CI runs this automatically.
  - **Acceptance check** (human judgment): `node .claude/skills/orchestrator/acceptance-check.js <PR>` via `run_process` — full Q1-Q7 interactive review. **Always required for production code changes.** Never skip this — even when the diff looks trivial. (Lesson: Sprint 2026-04-05c — skipping the full acceptance check caused a UI requirement to be missed on #599.)

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
