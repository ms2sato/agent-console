# Sprint Lifecycle

Orchestrator sessions are managed in sprint units. Sprints run on a plan -> execute -> retrospective cycle.

## Sprint label convention

Each sprint is labeled by the calendar date its retrospective runs (e.g., `2026-04-17`). When two or more sprints complete on the same calendar day, suffix the second and onward with `-b`, `-c`, etc. (e.g., `2026-04-17b`). Use the same label consistently in retrospective memos, `project_sprint_status.md`, and commit / PR references for that sprint's artifacts.

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
5. **Re-evaluate open PRs carried over from previous sprints.** Run `gh pr list --state open` and for each PR not created or merged in this session, evaluate:
   - **Staleness of feedback**: Does it have unaddressed review feedback (e.g., CodeRabbit CHANGES_REQUESTED) older than a sprint? Age it.
   - **Mergeability**: Does `mergeStateStatus: CLEAN` still hold? Is there semantic conflict (test in a temp worktree: `git worktree add /tmp/test <branch> && git merge origin/main && bun run typecheck && bun run test`)?
   - **Obsoletion**: Has the feature been superseded by later work (e.g., a root-cause fix that makes the original symptom fix redundant)?
   - **Propose a disposition** to the owner: resume (rebase + address feedback), close (obsoleted), or defer (keep open, revisit next sprint with a concrete trigger).

   **Why:** PRs silently rotting is a real failure mode. Sprint 2026-04-17 discovered PR #626 had sat 10 days with unaddressed CodeRabbit feedback; it turned out to still be valid and was merged after review. Without this step, it would have continued to rot. This step converts "discovered by accident" into "verified every sprint."
6. **Pick founding-narrative frontmatter.** Scan `docs/narratives/` for entries with `nature: founding` and `importance: high`. **Read only the frontmatter** (date, nature, tags, `summary`, `read_when`) — not the body. The summary primes judgment with the lesson; the body is loaded on demand later when a `read_when` trigger matches the current task. (This is the ctx-saving design: founding narratives total ~600 lines / ~10K tokens; frontmatter-only pick saves ~95% of that at Sprint Start, with the full body still one Read away when needed.) See [Narrative Memory System](#narrative-memory-system) below.

## Sprint Execution
- Task progression, acceptance checks, merges
- When new gotchas are discovered, append them to `memory/project_sprint_status.md` (Claude memory) immediately
- Example: "WorkerType does not have 'custom' variant yet. If referenced, it's wrong"
- **Idle time utilization**: When waiting for agent completion or owner approval and **active worktrees are ≤1**, consider running `review-loop` on the full codebase or specific packages. This catches systemic issues and makes productive use of wait time. Do NOT run review-loop when many worktrees are active — it competes for compute resources.

## Mid-sprint Handoff

When the orchestrator session approaches context-window saturation **before the sprint completes**, perform a deliberate handoff so the next session can pick up without losing in-flight context. This is a normal mid-sprint operation, not a Sprint End.

**Trigger conditions** (any one is sufficient):
- Owner observes ctx pressure (e.g., "write a handoff document, we'll continue in a fresh session")
- ctx remaining drops below ~30-40% with several pending acceptance checks ahead — auto-compaction during multi-step verification is high-cost
- Sprint mid-flight pivot or discovery has accumulated unwritten state that compaction would lose

**Procedure (current orchestrator):**

1. **Write a comprehensive handoff document via `write_memo`.** Include: completed work table (PR / Issue / merge commit), in-flight tasks, owner-pending judgments, retro topic candidates, carried-over open PRs, active gotchas. The memo replaces the previous one but is durable on disk for the next session.
2. **Mirror the same content into `memory/project_sprint_status.md`.** The memo and the memory file overlap deliberately — memo is at-a-glance during the session, memory persists across sessions.
3. **Update the front-matter `description`** in the memory file to capture the *next-action signal* (e.g., "Wave 1 done. Remaining = brewing #X + retro. Owner pending = 1-A/B"). That description is what the next session's MEMORY.md index loads into ambient context — if it stays at the previous sprint's "complete" state, the next orchestrator misclassifies the situation as Sprint Start.
4. **Owner closes the current session.** The next orchestrator session reads MEMORY.md → memory file → memo, then resumes.

**Procedure (next orchestrator on pick-up):**

1. After `/orchestrator` invocation, read the memo + memory file to understand current state. **Do not re-enter Sprint Start procedure** — the sprint is in progress; jump directly to the named next-action signal.
2. Confirm to the owner: "Handoff received. Of the remaining tasks A/B/C, which should I start with?" (translate to the project's working language as appropriate). Wait for owner direction before touching state.
3. Read the existing TaskList; do not recreate completed tasks. Continue from in_progress / pending entries.

(Lesson: Sprint 2026-05-03 — orchestrator session reached ~33% ctx during Wave 1 acceptance checks; owner directed handoff. The new-session pick-up initially entered Sprint Start procedure because MEMORY.md's Sprint status description still pointed at the previous sprint's "complete" state. Owner correction redirected to the handoff document. This rule's existence + the next-action signal in the description prevents the misclassification.)

## Memory as temporary bridge to rules/skills

When a retrospective surfaces a learning worth codifying, the usual flow is: create a feedback memory for immediate retention AND file an Issue to land the learning in a rule or skill. The memory is a **temporary bridge** — once the Issue merges the learning into a rule/skill, remove the memory (or narrow it to a pointer like "covered in rules/X.md since commit ABC"). Otherwise the memory and rule drift, reintroducing the exact pattern `rule-skill-duplication-check.js` was built to prevent.

On the memory side, record the landing Issue in the `description` front-matter field so the cleanup is visible at `MEMORY.md`-scan time.

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

### Objective metrics block (Phase 1)

Before the first interactive step, the script prints an objective-metrics report for the sprint's merged PRs: commits per PR, CI iterations, time-to-mergeable, CodeRabbit findings, push-to-fail ratio. Flags fire for PRs whose values exceed 2× the sprint median (minimum 3 PRs needed for aggregates). Use the flags as discussion starters for the incident review step — do not treat them as verdicts.

Data sources are live `gh api` / `gh run list` / `gh pr list` calls; no persistent storage yet. If gh fails for a specific PR, that PR's affected fields show `n/a` and the error is listed at the end of the block; the rest of the report still renders.

**Environment variables**:

| Variable | Required | Effect |
|---|---|---|
| `SPRINT_PR_NUMBERS` | **required** | Space- or comma-separated merged PR numbers for this sprint. The script aborts with a helpful error if unset. (Date-window discovery was removed — its 14-day default over-scoped post-Pilot sprints.) |
| `SPRINT_LABEL` | optional | Header label for the report (defaults to today's date in ISO) |

Canonical invocation form:

```bash
SPRINT_PR_NUMBERS="751 755 756 757" SPRINT_LABEL="Sprint 2026-05-02" \
  node .claude/skills/orchestrator/sprint-retro.js
```

Answer `Y` (default) at the `Continue to retro questions?` prompt to proceed to the interactive steps. Answer `n` only if the metrics reveal something that warrants re-planning the retrospective itself.

**Process improvement PR convention** (referenced by the script's Step 4):
- All improvements go into a single PR: branch `docs/sprint-retro-YYYY-MM-DD`, title `docs: sprint retrospective improvements (YYYY-MM-DD)`
- Use `EnterWorktree` when the first improvement is agreed upon; commit all subsequent improvements to the same worktree
- Merge before the retrospective completes — the next Orchestrator needs the updated skills

**Sprint closure spans the retro PR merge** (Steps 7 & 8 of `sprint-retro.js`):
- Steps 1–6 finish before the retrospective PR exists, so the retro PR's own merge state cannot be captured during script execution.
- After the retro PR is merged, the Orchestrator MUST update `project_sprint_status.md`, `MEMORY.md`, and `project_pending_triage_list.md` to reflect the final merged state. Without this final pass, the sprint pointer drifts (status memo stays "merge-pending", MEMORY.md lags one sprint, triage misses the retro PR).
- **Step 7 (write)** instructs the Orchestrator to create a TaskCreate task pinned to the retro PR number so the deferred sync is not lost between conversation compactions.
- **Step 8 (verify, mechanical)** runs a `gh pr list --search "merged:>=<sprint-start>"` scan and grep against the three memory files to flag any PR that was not captured by Step 7. This catches post-retro follow-up improvement PRs, brewing-log batch PRs, and hot-fix PRs that landed after Step 5 — none of which are in Step 7's narrow retro-PR scope. Step 8 converts "did I remember everything?" (LLM-weak) into "scan + grep diff" (mechanical).

## Sprint End Proposal Conditions

The Orchestrator can propose ending the sprint to the owner when any of the following apply:

- **All planned tasks are complete** (merged or blocked)
- **Context usage exceeds 80%** — risk of important context being lost to autocompact
- **Major direction change has occurred** — better to replan as a new sprint
- **Too much implicit knowledge has accumulated** — knowledge that should be written to memory has grown

Include the current task status and estimated retrospective time when proposing.

## Narrative Memory System

The `docs/narratives/` directory preserves **qualitative accounts** of incidents, insights, and foundational decisions — the lived texture that rules lose during distillation. Rules say "don't do X"; narratives say "here is what happened when we did X, and here is what it felt like." This system exists because AI instances (this one included) do not retain embodied experience across sessions; rules alone produce compliance without conviction.

### Three-tier knowledge hierarchy

- **Rules / Skills** (`.claude/rules/` / `.claude/skills/`) — prescriptive principles, concise, always applicable
- **Memory feedback** (`memory/feedback_*.md`) — summarized lessons, short "why", point to narratives
- **Narratives** (`docs/narratives/`) — full qualitative background, first-person, emotion-labeled, timeline-detailed

When a rule feels arbitrary, walk the hierarchy: rule → feedback's "why" → narrative. Readers may stop at any level.

### When to read narratives

- **Sprint Start Step 6** — scan `nature: founding`, `importance: high` entries; pick **frontmatter only** (`summary` + `read_when`), not the body. Body is loaded later when a `read_when` trigger matches.
- **When a rule feels arbitrary** — follow the `Read this if the rule feels arbitrary:` link from the rule
- **After a near-miss or incident** — read the matching tag to see if the pattern recurred
- **On demand** when exploring a topic — `grep tags:` in front matter, then load the matching narrative's body if its `read_when` triggers apply

### When to write a narrative

During retrospective (Step 5 / Step 3a), consider writing a narrative if:

- Something surprised the orchestrator in a way a rule would not convey
- A near-miss was resolved by luck rather than process — document so future versions do not rely on the same luck
- A rule was born from experience and the story deserves retention
- The owner's correction or question reframed the problem (record in owner's own words where possible)

Do not force it. Some sprints are mechanical.

### Volume and retention

Narratives are on-disk files, not loaded into context automatically. Volume can grow without affecting conversation context. No strict retention limit at this stage — err on the side of writing. Future retrospectives may introduce archival policy when the directory becomes unwieldy (hundreds of entries).

### Format

Each file: Markdown with front-matter (`date`, `importance`, `nature`, `tags`, `related_rules`, `related_issues`). Body in first-person present tense where possible, with an explicit "emotion labels" section. Full template and tag taxonomy in [docs/narratives/README.md](../../../docs/narratives/README.md).

### Distillation vs preservation

Some observations, repeated across sprints, deserve promotion into `memory/feedback_*.md` (rule-level, concise). Others are best kept only as narratives — one-off events whose full texture matters more than any extractable rule. **Preserve narratives even after distillation**; the rule and the story serve different purposes. Do not delete a narrative just because its lesson became a rule.

### Honest limitation

AI tends to skim prose when task-focused. A narrative is easy to skip. This system reduces but does not eliminate skipping — through prominent rule-side links, retrospective-level forced reading cadence, and tag-based retrieval. Accept the residual skip rate. Write narratives anyway; they will be read when they count.
