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

**MUST** run `sprint-retro.js` via `run_process` before proceeding:
```
run_process({ command: "node .claude/skills/orchestrator/sprint-retro.js" })
```
The script guides you through all retrospective steps interactively via STDIN/STDOUT and instructs you to create a TaskCreate checklist for progress tracking. Do NOT skip the script and attempt the steps manually — the script exists precisely because manual execution leads to step omission.

**Process improvement PR convention** (referenced by the script's Step 4):
- All improvements go into a single PR: branch `docs/sprint-retro-YYYY-MM-DD`, title `docs: sprint retrospective improvements (YYYY-MM-DD)`
- Use `EnterWorktree` when the first improvement is agreed upon; commit all subsequent improvements to the same worktree
- Merge before the retrospective completes — the next Orchestrator needs the updated skills

## Sprint End Proposal Conditions

The Orchestrator can propose ending the sprint to the owner when any of the following apply:

- **All planned tasks are complete** (merged or blocked)
- **Context usage exceeds 80%** — risk of important context being lost to autocompact
- **Major direction change has occurred** — better to replan as a new sprint
- **Too much implicit knowledge has accumulated** — knowledge that should be written to memory has grown

Include the current task status and estimated retrospective time when proposing.
