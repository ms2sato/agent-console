# Sprint Lifecycle

Orchestrator sessions are managed in sprint units. Sprints run on a plan -> execute -> retrospective cycle.

## Sprint Start
1. **Sync the Orchestrator session branch with origin/main** (with owner confirmation):
   ```bash
   git fetch origin main
   git log --oneline -3        # show current HEAD
   git log --oneline -3 origin/main  # show origin/main HEAD
   # After owner confirms:
   git rebase origin/main
   ```
   **Why:** The Orchestrator session branch may be behind `origin/main` if other PRs were merged between sprints. Starting from stale code leads to incorrect decisions. Using `rebase` instead of `reset --hard` preserves any local commits that haven't been pushed, making it a safer default.
2. Decide the sprint task list in consultation with the owner (Issue-based)
3. Create `memory/orchestrator_sprint_context.md`:
   - Sprint goal
   - Task list (Issue numbers)
   - Active context (design decisions, notes, gotchas)
4. **Write initial sprint memo** via `write_memo`:
   - Sprint goal, planned task list, parallel execution plan
   - This serves as the owner's at-a-glance dashboard for the sprint
   - The previous sprint's memo will still be displayed — overwrite it with the new sprint's content (memos are replaced on each write, so no manual cleanup is needed)

## Sprint Execution
- Task progression, acceptance checks, merges
- When new gotchas are discovered, append them to `orchestrator_sprint_context.md` immediately
- Example: "WorkerType does not have 'custom' variant yet. If referenced, it's wrong"

## Post-Merge Conflict Check

After merging a PR, check all remaining open PRs for merge conflicts. This is the Orchestrator's responsibility since the Orchestrator has visibility into all parallel work.

**Process:**
1. After a PR is merged, run: `gh pr list --state open --json number,title,mergeable --jq '.[] | select(.mergeable == "CONFLICTING") | "\(.number) \(.title)"'`
2. If conflicts are found, send rebase instructions to the responsible agent via `send_session_message`:
   > The main branch has been updated and conflicts have occurred. Please rebase with `git fetch origin && git rebase origin/main`. After resolving conflicts, verify all tests pass with `bun test` and push.
3. If the agent's session is no longer active, note the conflicting PR for manual resolution or re-delegation.
4. After confirming no conflicts, update the local main branch by pulling in the main repository directory. The main directory only holds the main branch and is not used for active development.
   ```bash
   MAIN_DIR=$(git worktree list | head -1 | awk '{print $1}')
   git -C "$MAIN_DIR" pull origin main
   ```

**Why:** With multiple worktrees running in parallel, merging one PR frequently causes conflicts in others. Early detection prevents wasted CI runs and review cycles. Additionally, the main repository directory (first entry in `git worktree list`) is used as the base for worktree creation. Keeping it synchronized after each merge prevents worktrees from being based on stale code.

## Worktree Cleanup

After merging a PR (both Orchestrator-authority merges and owner-approved merges), clean up the completed session's worktree using `remove_worktree` with the session ID. This prevents worktree accumulation and frees disk space.

Only remove worktrees for sessions that have completed their task and whose PR has been merged. Do not remove worktrees with active or pending work.

## Retrospective Collection and Process Improvement

Coding agents send a retrospective report together with the merge notification after their PR is merged (defined in agent definitions).

**Orchestrator's delegation instruction must include:**
> After your PR is merged, please report back to the Orchestrator with your retrospective report and the merge confirmation.

**Orchestrator's post-merge flow:**
1. Post-Merge Conflict Check (above)
2. Wait for the agent's merge notification + retrospective report
3. Only after receiving the report, clean up the worktree via `remove_worktree`

**Orchestrator's role:**
- Receive retrospective reports from agents after PR merge
- Analyze recurring friction points across multiple retrospectives
- Propose improvements to agent definitions, skills, or CLAUDE.md when patterns emerge (backed by 2-3 observed incidents)

## Sprint End (Retrospective)
The Orchestrator proposes ending the sprint, and when the owner approves, conducts the retrospective. Order matters — memory write-out is done last so retrospective results are captured in memory.

**Step 0: Generate retrospective checklist**
- Build a dynamic checklist by combining:
  1. **Core steps** from this skill definition (Steps 1-5 below)
  2. **Dynamic items** collected from memory (e.g., cross-project knowledge sharing actions, pending follow-ups from previous sprints)
- Create the checklist via `TaskCreate` to track progress through the retrospective
- This prevents omission of project-specific actions that are not part of the static skill definition

**Step 1: Update pending triage list**
- Reflect issues discovered during the sprint in `memory/project_pending_triage_list.md`
- Add notes to resolved items
- Record Issue numbers for items that were converted to new Issues

**Step 2: Close completed worktrees**
- Delete merged PR worktrees using `remove_worktree`
- Leave pending/in-progress worktrees intact

**Step 3: Retrospective (dialogue with owner)**
- The Orchestrator reports the retrospective and aligns with the owner's perspective
- **Present improvement proposals together with the merged PR list** (at the start of the retrospective, not the end). Presenting proposals early enables agreement during the owner dialogue and allows smooth transition to parallel execution in Step 4
- Perspectives: what worked well / what needs improvement / time-consuming blockers
- **Classify "what worked well" into 3 categories** to convert into actionable improvements:
  1. **Worked by chance** — systematize by adding to skills/processes so it becomes reliable
  2. **Worked because owner drove it** — incorporate into Orchestrator skills so the Orchestrator can do it independently
  3. **Other** — analyze why it worked and consider if the conditions can be reproduced
- Reach agreement on any skill/process improvement proposals on the spot

**Step 4: Apply skill improvements**
- Apply agreed-upon improvements to skill files and merge (Orchestrator can merge since it's documentation)
- **All improvements go into a single PR:**
  - Branch: `docs/sprint-retro-YYYY-MM-DD`
  - PR title: `docs: sprint retrospective improvements (YYYY-MM-DD)`
  - When the first improvement is agreed upon, `EnterWorktree` with this branch name
  - All subsequent improvements are committed to the same worktree
  - After all improvements are complete, create one PR and merge
- Since the next Orchestrator will operate with the improved skills after context clear, **it is desirable that improvements are merged by the time the retrospective completes**. Do not defer to the next sprint

**Step 5: Final memory write-out**
- **Memory retrospective**: Review all memory files (MEMORY.md index) and delete those that fall into the following categories:
  - Already reflected in skill files or CLAUDE.md with no additional value to retain as memory
  - Completed project information already integrated into sprint context
  - Outdated information (invalidated by code or configuration changes)
- **Memory deletion criteria**: Review each memory file against the following criteria and present deletion candidates to the owner:
  1. **Is it general knowledge?**: Knowledge that AI should generally know (test principles, design patterns, etc.) is unnecessary in memory. Delete if there's no project-specific context
  2. **Does it duplicate skills/CLAUDE.md?**: If the rule is already reflected in skills or CLAUDE.md, it's a deletion candidate
  3. **However, retain memories with "Why (past failure context)"**: Even if a skill has the rule, lessons from cases where it wasn't followed have value as double reminders. The existence value of memory is in specific failure examples and "why it couldn't be followed" context
  4. Present deletion candidates to the owner with reasons and confirm before deleting
- Update `memory/orchestrator_sprint_context.md` to final version:
  - **Persistence decision**: For each active context item:
    - Permanent design decisions -> move to `docs/design/`
    - Temporary knowledge needed for the next sprint -> leave as-is
    - New tasks -> convert to Issues
    - Unnecessary -> delete
  - **Merged PR list**: This sprint's achievements
  - **Open PR cleanup**: Status, acceptance check results, blockers
  - **Active worktrees**: Remaining worktrees and reasons
  - **Next sprint recommended tasks**: Prioritized (blockers > 1st release > quality > process)
  - **Retrospective results**: What worked, what needs improvement, blockers
  - **Process improvement list**: All improvements made this sprint
  - **Cleanup of unnecessary memory**: Review MEMORY.md and delete memory that has served its purpose (completed migration records, outdated handoffs, etc.). Confirm with owner before deleting

## Sprint End Proposal Conditions

The Orchestrator can propose ending the sprint to the owner when any of the following apply:

- **All planned tasks are complete** (merged or blocked)
- **Context usage exceeds 80%** — risk of important context being lost to autocompact
- **Major direction change has occurred** — better to replan as a new sprint
- **Too much implicit knowledge has accumulated** — knowledge that should be written to memory has grown

Include the current task status and estimated retrospective time when proposing.
