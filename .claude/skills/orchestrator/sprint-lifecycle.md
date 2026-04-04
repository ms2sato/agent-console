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
3. Update `memory/project_sprint_status.md` (Claude memory) with:
   - Sprint goal
   - Task list (Issue numbers)
   - Active context (design decisions, notes, gotchas)
4. **Write initial sprint memo** via `write_memo`:
   - Sprint goal, planned task list, parallel execution plan
   - This serves as the owner's at-a-glance dashboard for the sprint
   - The previous sprint's memo will still be displayed — overwrite it with the new sprint's content (memos are replaced on each write, so no manual cleanup is needed)

## Sprint Execution
- Task progression, acceptance checks, merges
- When new gotchas are discovered, append them to `memory/project_sprint_status.md` (Claude memory) immediately
- Example: "WorkerType does not have 'custom' variant yet. If referenced, it's wrong"

## Retrospective Collection and Process Improvement

Coding agents send a retrospective report together with the merge notification after their PR is merged (defined in agent definitions).

**Orchestrator's delegation instruction must include:**
> After your PR is merged, please report back to the Orchestrator with your retrospective report and the merge confirmation.

**Orchestrator's post-merge flow:**
1. Execute Post-Merge Flow (section 7 of core-responsibilities.md)
2. Wait for the agent's merge notification + retrospective report
3. Only after receiving the report, clean up the worktree via `remove_worktree`

**Orchestrator's role:**
- Receive retrospective reports from agents after PR merge
- Analyze recurring friction points across multiple retrospectives
- Propose improvements to agent definitions, skills, or CLAUDE.md when patterns emerge (backed by 2-3 observed incidents)

## Sprint End (Retrospective)
The Orchestrator proposes ending the sprint, and when the owner approves, conducts the retrospective. Order matters — memory write-out is done last so retrospective results are captured in memory.

**Step 0: Launch the retrospective script**
- **MUST** run `sprint-retro.js` via `run_process` before proceeding:
  ```
  run_process({ command: "node .claude/skills/orchestrator/sprint-retro.js" })
  ```
- The script guides you through all retrospective steps (1-6) interactively via STDIN/STDOUT
- Do NOT skip the script and attempt the steps manually — the script exists precisely because manual execution leads to step omission
- The steps below document what each step covers for reference, but the script is the authoritative guide during execution

**Step 1: Update pending triage list**
- Reflect issues discovered during the sprint in `memory/project_pending_triage_list.md`
- **Triage list maintenance rules:**
  1. **Issue化したらPendingから削除** — GitHub Issueが正のソース。triage listとの二重管理をしない
  2. **Resolved欄は直近2スプリント分のみ保持** — 古いものは削除（git historyで追える）
  3. **Pendingに残るのはIssue化前の「ネタ」のみ** — 具体化できたら即Issue化してPendingから削除
- Issue化していないPending項目があれば、この時点でIssue化するか判断する

**Step 2: Close completed worktrees**
- Delete merged PR worktrees using `remove_worktree`
- Leave pending/in-progress worktrees intact

**Step 3: Retrospective (dialogue with owner)**

**3a. Per-incident review + improvement proposals**
- The Orchestrator reports the retrospective and aligns with the owner's perspective
- **Present improvement proposals together with the merged PR list** (at the start of the retrospective, not the end). Presenting proposals early enables agreement during the owner dialogue and allows smooth transition to parallel execution in Step 4
- Perspectives: what worked well / what needs improvement / time-consuming blockers
- **Classify "what worked well" into 3 categories** to convert into actionable improvements:
  1. **Worked by chance** — systematize by adding to skills/processes so it becomes reliable
  2. **Worked because owner drove it** — incorporate into Orchestrator skills so the Orchestrator can do it independently
  3. **Other** — analyze why it worked and consider if the conditions can be reproduced
- Reach agreement on any skill/process improvement proposals on the spot

**3b. Process-wide review**
- After per-incident proposals, step back and review the overall process from a structural perspective
- Items already addressed in 3a are valid answers, but the goal is to find **issues that 3a missed** — structural problems not tied to any single incident
- Review the following 4 perspectives and present findings to the owner:
  1. **Redundant information**: Is the same information duplicated across memory / GitHub Issues / skills / rules? Eliminate double-management
  2. **Implicit knowledge**: Are there operational rules that only the owner knows? If the owner had to point something out during the sprint, it should become explicit in skills/rules
  3. **Name-reality mismatch**: Do step names, file names, and section titles accurately describe their actual content and scope?
  4. **Owner-dependent discoveries**: List improvements that only happened because the owner noticed and asked. For each, create a rule or checklist item so the Orchestrator catches it independently next time

**Step 4: Apply process improvements**
- Apply agreed-upon improvements to skill files, rules, agent definitions, and CLAUDE.md as appropriate. Merge after completion (Orchestrator can merge since it's non-production code)
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
- Update `memory/project_sprint_status.md` (Claude memory) to final version:
  - **Merged PR list**: This sprint's achievements
  - **Retrospective results**: What worked, what needs improvement, blockers
  - **Next sprint recommended tasks**: Prioritized (blockers > 1st release > quality > process)
  - **Active context**: Design decisions, gotchas carried forward to next sprint

## Sprint End Proposal Conditions

The Orchestrator can propose ending the sprint to the owner when any of the following apply:

- **All planned tasks are complete** (merged or blocked)
- **Context usage exceeds 80%** — risk of important context being lost to autocompact
- **Major direction change has occurred** — better to replan as a new sprint
- **Too much implicit knowledge has accumulated** — knowledge that should be written to memory has grown

Include the current task status and estimated retrospective time when proposing.
