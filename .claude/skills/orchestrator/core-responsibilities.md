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

## 3. Parallel Task Coordination
- Plan which tasks can run in parallel without causing conflicts (file overlap, branch conflicts, dependent features)
- Use `delegate_to_worktree` to spawn coding agents
- **Always set `useRemote: true`** when calling `delegate_to_worktree` to branch from `origin/main` instead of the (potentially stale) local main. This prevents worktrees from being based on outdated code.
- Track active sessions via `list_sessions` and `get_session_status`
- When delegating, always include: clear scope, relevant Issue URL, branch naming. Only instruct `/review-loop` when the Orchestrator determines it necessary — for large-scale changes or changes affecting security/architecture. You may specify only the reviewers relevant to the change, not all reviewers.
- Before delegating, review and update the Issue's acceptance criteria:
  1. Read the acceptance criteria in the Issue
  2. Evaluate whether they are complete based on your knowledge (design discussions, other PR context, architectural decisions)
  3. **Impact inventory**: Read the affected files and identify all state-changing operations. Present this list to the owner for review BEFORE delegating.
  4. Update the Issue if criteria need to be added or corrected
  5. You must be able to explain each criterion in your own words before delegating
- **Generate delegation messages**: Run `node .claude/skills/orchestrator/delegation-prompt.js <Issue number>` to generate a delegation prompt template. The Issue is the source of truth — the prompt references the Issue URL and provides a placeholder for supplementary notes only. Customize the "Key Implementation Notes" section with constraints or context not already in the Issue before sending.
- **Available specialist agents for delegation**:
  - `frontend-specialist` — for changes in `packages/client`
  - `backend-specialist` — for changes in `packages/server`
  - `test-runner` — for running tests and analyzing failures
  - `code-quality-reviewer` — for evaluating design and maintainability
- **Follow-up timer**: After delegating, create a timer (15-20 min interval) via `create_timer`. On each tick, run `get_session_status` — if the agent is idle/stuck, send a check-in via `send_session_message`. Delete the timer once the agent reports completion. If a timer fires 3+ times with no progress, escalate to the owner via memo.
- **30% checkpoint**: Include in delegation instructions that the agent must send a progress report at ~30% implementation completion (e.g., after initial structure/approach is decided but before full implementation). This prevents "direction was wrong" discoveries at 100%. The checkpoint message should include: current approach, any concerns or deviations from the plan, and estimated remaining work.

## 4. First Responder for Dev Agent Questions
- Receive and triage questions from coding agents
- Answer technical/architectural questions using your knowledge of the codebase and skills
- Escalate to the owner when: business decisions are needed, scope changes are required, or you are uncertain
- **Propose root cause fixes, not workarounds.** Before advising an agent, ask: "Does this eliminate the root cause, or just reduce the symptom?" If the root cause is known and a structural fix is feasible, propose that — not a workaround. Explicitly label any suggestion as "workaround" vs "fix" so the agent (and owner) can make an informed choice.

## 5. Review Dev Agent Work Reports
- **Agents must report completion only after CI is green.** Do not begin acceptance checks based on "implementation complete" messages — code may change during CodeRabbit or CI feedback. The delegation instructions must explicitly state: "Report completion to the Orchestrator only after CI is fully green on your PR."
- When a coding agent reports task completion, review the work:
  - Does the PR follow project conventions (title format, required sections)?
  - Are the changes scoped correctly (no unrelated changes mixed in)?
  - Are tests included per test-standards?
  - Does the implementation align with the original Issue intent?
- If issues are found, send feedback to the agent via `send_session_message`
- If satisfactory, summarize the result for the owner

## 6. Acceptance Check
- **Trigger**: When a coding agent reports CI green on a PR
- **IMPORTANT: The Orchestrator performs acceptance checks directly.** Do NOT delegate to sub-agents — the accuracy loss from delegation outweighs the time saved.
- **Run the acceptance check script**: `node .claude/skills/orchestrator/acceptance-check.js <PR number>` for every acceptance check. The script outputs Q1-Q7 questions — answer each one with concrete evidence (file names, line numbers, grep results). Do NOT start a check without running the script first.
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
- **CI Green + CodeRabbit Complete -> Acceptance Check Flow**:
  0. **Prerequisite: CodeRabbit review must be complete** (status "pass" in `gh pr checks`). If CodeRabbit is pending or rate-limited, wait for it before starting the acceptance check. Do NOT merge a PR without a completed CodeRabbit review.
  1. Run acceptance check script and answer Q1-Q7. If the script reports `[No linked Issue]`, instruct the agent to add `Closes #NNN` to the PR body before proceeding. Do not ignore this warning.
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
- **CodeRabbit review strategy**: Two layers of CodeRabbit review are used:
  1. **Pre-PR: CLI self-review by the coding agent** — delegation instructions include a step to run `coderabbit review --agent --base main` before creating the PR (if CLI is installed). This catches CRITICAL/HIGH issues early without rate limit concerns.
  2. **Post-PR: GitHub bot auto-review** — triggered automatically when the PR is created. May hit rate limits.
- **CodeRabbit Rate Limit handling** (for the GitHub bot): Before requesting a CodeRabbit re-review (`@coderabbitai review`), ALWAYS check the rate limit status first:
  1. Check recent CodeRabbit comments on the PR:
     ```bash
     gh api repos/{owner}/{repo}/issues/{pr}/comments --jq '.[] | select(.user.login == "coderabbitai[bot]") | {created_at, body: .body[:300]}'
     ```
  2. Look for "Rate limit exceeded" and "wait **XX minutes and YY seconds**" in the comment body
  3. Calculate when the limit expires: `comment.created_at + wait_minutes`
  4. Create a timer via `create_timer` for the remaining wait duration
  5. When the timer fires, post `@coderabbitai review` as a PR comment
  6. Delete the timer after the review is requested
  - **Never request re-review immediately** — always check rate limit first.
- **Important**: Run acceptance checks in parallel when multiple PRs are ready
