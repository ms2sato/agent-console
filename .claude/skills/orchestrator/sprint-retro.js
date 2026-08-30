#!/usr/bin/env node

/**
 * Sprint Retrospective Interactive Process Script
 *
 * Guides the Orchestrator through sprint retrospective steps via STDIN/STDOUT.
 * Each step displays instructions and waits for a null-byte delimited response.
 *
 * Usage:
 *   Run as interactive process via run_process MCP tool.
 *
 * Environment variables:
 *   SPRINT_PR_NUMBERS  REQUIRED. Explicit whitespace/comma-separated list of PR
 *                      numbers (e.g., "665,666,667"). The script aborts with a
 *                      helpful error if not set — date-window discovery was
 *                      removed because its default returned the entire post-
 *                      Pilot history, not the current sprint's PRs.
 *   SPRINT_LABEL       Label used in the metrics report header (default: today in
 *                      ISO). Does not affect which PRs are selected.
 */

import {
  collectSprintMetrics,
  formatMetricsReport,
  defaultExec,
  createCache,
} from './sprint-metrics.js';

// --- STDIN reading (null-byte delimited) ---

/**
 * Creates a reader that reads null-byte delimited responses from a stream.
 * Same pattern as acceptance-check.js.
 */
function createStdinReader(stdin = process.stdin) {
  let buffer = '';
  const iterator = stdin[Symbol.asyncIterator]();

  return async function readResponse() {
    while (true) {
      const nullIdx = buffer.indexOf('\0');
      if (nullIdx !== -1) {
        const answer = buffer.slice(0, nullIdx);
        buffer = buffer.slice(nullIdx + 1);
        return answer.trim();
      }
      const { value, done } = await iterator.next();
      if (done) break;
      buffer += Buffer.from(value).toString();
    }
    const answer = buffer;
    buffer = '';
    return answer.trim();
  };
}

// --- Step definitions ---

function getSteps() {
  return [
    {
      key: 'triage',
      title: 'Step 1: Triage List Update',
      instructions: [
        'Review and update the Pending triage list following these rules:',
        '  - Issue化したら Pending から削除',
        '  - Resolved した項目は直近2スプリント分のみ保持、それ以前は削除',
        '  - 新たに発見した課題があれば Pending に追加',
        '  - memory の project_pending_triage_list.md を更新',
        '',
        'Report what you updated (additions, removals, or "no changes").',
      ],
    },
    {
      key: 'worktree_cleanup',
      title: 'Step 2: Worktree Cleanup',
      instructions: [
        'Clean up worktrees for merged PRs.',
        '',
        '**Enumerate from `git worktree list`, not from any one creator.** Known',
        'populations are listed below, but the list is open — Sprint 2026-08-30',
        'found a third kind that no named population covers. `git worktree list`',
        'is the only view that shows every kind at once, because it is keyed on',
        'the git registration rather than on who created it.',
        '',
        '  A. Delegate worktrees (have a session):',
        '     1. Run list_sessions to see all active sessions/worktrees',
        '     2. Identify worktrees whose PRs have been merged',
        '     3. Run remove_worktree for each (NOT close_session — that leaves',
        '        the worktree entity orphaned and no longer removable)',
        '',
        '  B. EnterWorktree worktrees the Orchestrator made for itself:',
        '     These have NO session, so list_sessions never shows them, and',
        '     ExitWorktree with action "keep" leaves them on disk indefinitely.',
        '     1. ls .claude/worktrees/ in the source repo',
        '     2. For each, find its PR: gh pr list --state all --head <branch>',
        '     3. Remove the merged ones: git worktree remove <path>',
        '',
        '  C. and whatever else `git worktree list` shows. Sprint 2026-08-30 had',
        '     worktrees belonging to disposable QA instances the Orchestrator had',
        '     booted with their own AGENT_CONSOLE_HOME, plus worktrees created',
        '     INSIDE those instances by test sessions. Their sessions live in a',
        '     different instance\'s database, so the running list_sessions cannot',
        '     see them; they are not EnterWorktree-made, so .claude/worktrees/',
        '     does not hold them. Only git worktree list does.',
        '     1. `git worktree list --porcelain` — record each entry\'s path and',
        '        whether it is on a branch or detached.',
        '     2. Settle merged-ness on the PR, per the traps below. A DETACHED',
        '        entry has no branch to look up: identify it by the worktree\'s',
        '        purpose (its directory name, the instance that booted it) and',
        '        treat "no PR" as "not merged" — keep it unless you can say what',
        '        it was for and that it is finished.',
        '     3. Before removing: `git status --porcelain` in that worktree must',
        '        be empty, and no live process may hold it. Check BOTH — a cwd',
        '        scan alone misses a process that only names the path in its',
        '        argv (Sprint 2026-08-30: an instance was using two worktrees',
        '        that a cwd-only check reported as idle).',
        '     4. Remove with remove_worktree when its owning session is reachable',
        '        from the running instance; otherwise `git worktree remove <path>`',
        '        from the owning repository. Do not pass --force to get past a',
        '        refusal — the refusal is step 3 working.',
        '',
        'Three traps when deciding whether a branch is merged. Each one alone',
        'produces a wrong answer, and all three have actually fired here:',
        '',
        '  - `git branch --merged origin/main` reports NOTHING as merged here. The',
        '    repo squash-merges, so a branch\'s commits never become ancestors of',
        '    main. Use the PR state, not ancestry. (Sprint 2026-08-28)',
        '  - `git cherry` (patch-id) can also miss: a squash-merge that was edited',
        '    before landing produces a different patch-id, so real, merged work looks',
        '    absent. When patch-id disagrees with the PR state, grep main for the',
        '    text the commit actually added. Removing a worktree can destroy unmerged',
        '    work, so settle it on content before deleting. (Sprint 2026-08-28)',
        '  - `git branch -d` compares against the CURRENT HEAD, not origin/main. From',
        '    an old orchestrator branch it refuses ("not fully merged") for branches',
        '    fully contained in origin/main. Do not reach for -D to get past it —',
        '    that discards the check rather than fixing it. Ask the question you',
        '    actually mean: `git merge-base --is-ancestor <sha> origin/main`, or for',
        '    a squash-merged PR, resolve its mergeCommit via the API and test THAT',
        '    for ancestry. (Sprint 2026-08-30)',
        '',
        'Report which worktrees were removed from each population (or "none to clean up").',
      ],
    },
    {
      key: 'incident_review',
      title: 'Step 3a: Per-Incident Review',
      instructions: [
        'Review each merged PR from this sprint:',
        '  1. Present the list of merged PRs',
        '  2. For each PR, evaluate:',
        '     - What worked well? (classify: by chance / owner-driven / structural)',
        '     - What needs improvement?',
        '     - Improvement proposals (if any)',
        '',
        'Report your findings per PR.',
      ],
    },
    {
      key: 'process_review',
      title: 'Step 3b: Process-Wide Review',
      instructions: [
        'Review the overall development process from these 4 perspectives:',
        '',
        '  1. Redundant information: Is there overlap across memory / Issues / skills / rules?',
        '     (e.g., same guidance in CLAUDE.md and a skill file)',
        '',
        '  2. Implicit knowledge: Is there knowledge only the owner knows that should be',
        '     documented? (e.g., unwritten conventions, tribal knowledge)',
        '',
        '  3. Name-reality mismatches: Do any step names, file names, or section titles',
        '     no longer match what they actually do? (e.g., a file named "cleanup" that',
        '     also handles initialization)',
        '',
        '  4. Owner-dependent discoveries: Were there things this sprint that only the',
        '     owner noticed or could fix? (e.g., bugs caught by manual review that',
        '     automation should have caught)',
        '',
        'Report findings for each perspective (or "none" if clean).',
      ],
    },
    {
      key: 'apply_improvements',
      title: 'Step 4: Apply Process Improvements',
      instructions: [
        'Based on findings from Steps 3a and 3b:',
        '  1. List all proposed improvements',
        '  2. For each improvement, identify the target file(s) to modify',
        '     (e.g., CLAUDE.md, skills, rules, agents, memory)',
        '  3. ⚠ IMPORTANT: Propose changes to the user and get approval before applying.',
        '     Skills and rules are shared project assets — do not modify without user consent.',
        '  4. After approval, apply the changes or create Issues for larger changes',
        '',
        'Report what was proposed, what the user approved, and what was applied or deferred.',
      ],
    },
    {
      key: 'memory_writeout',
      title: 'Step 5: Memory Write-Out',
      instructions: [
        'Review memory files against these criteria:',
        '  - Is the content general knowledge derivable from code? → DELETE candidate',
        '  - Does it duplicate what is already in skills/rules? → DELETE candidate',
        '  - Does it have a "why" context that is not obvious? → RETAIN',
        '  - Is the project status still current? → UPDATE',
        '',
        'Actions:',
        '  1. List deletion candidates with reasoning',
        '  2. ⚠ IMPORTANT: Present deletion/edit proposals to the user and get approval',
        '     before modifying or deleting any memory files. Memory is the user\'s persistent',
        '     context — do not alter without explicit consent.',
        '  3. After approval, update sprint status in project_sprint_status.md',
        '  4. Apply approved deletions and updates',
        '',
        'Report proposals, user decisions, and applied changes.',
      ],
    },
    {
      key: 'cross_project',
      title: 'Step 6: Cross-Project Knowledge Sharing',
      instructions: [
        'Check for other active orchestrator sessions to share learnings with:',
        '  1. Run list_sessions to find other orchestrator sessions',
        '  2. If found, use send_session_message to share relevant sprint learnings',
        '     (e.g., new patterns, process improvements, tooling changes)',
        '  3. If no other sessions, skip this step',
        '',
        'Report what was shared (or "no other sessions" / "skipped").',
      ],
    },
    {
      key: 'final_memory_sync',
      title: 'Step 7: Final Memory Sync (post-merge)',
      instructions: [
        'This step closes the sprint memory state AFTER the retrospective PR is merged.',
        'Step 5 (Memory Write-Out) ran before the retro PR existed, so the retro PR\'s',
        'own merge cannot be captured at that point. Without this final pass, the sprint',
        'pointer drifts: status memo says "owner-merge-pending" forever, MEMORY.md index',
        'lags one sprint behind, the triage list misses the retro PR.',
        '',
        'After the retrospective PR is merged, update all three files:',
        '  1. memory/project_sprint_status.md — flip retro PR row from "open" to merged,',
        '     update front-matter description to reflect final state',
        '  2. memory/MEMORY.md — update the Sprint status pointer line to the final',
        '     sentence (e.g., "Sprint YYYY-MM-DD 完了 (PRs #A/#B/#R all merged: ...)")',
        '  3. memory/project_pending_triage_list.md — two edits, not one:',
        '     (a) add the retro PR to the sprint\'s Merged section (it was opened during',
        '         retro, so it was not yet there in Step 1), and',
        '     (b) DELETE every Pending item this retro PR just landed. Step 1 ran before',
        '         the PR existed, so it could not remove them; if this step does not, they',
        '         survive as "next retro で成文化" long after they were written. Walk the',
        '         retro PR\'s own diff and remove the Pending entry each change came from.',
        '         (Sprint 2026-08-28 found 8 such items still Pending three weeks after',
        '         PR #1284 landed them — none of the existing checks look for this, because',
        '         Step 8 asks "is every merged PR recorded?", never "is every recorded item',
        '         still unresolved?")',
        '',
        'Reliable execution pattern: create a TaskCreate task "final memory sync (post-merge)"',
        'tagged with the retro PR number. Mark in_progress when the merge is observed,',
        'completed after the 3 files are updated. Do not rely on memory of "I should sync",',
        'rely on the task list.',
        '',
        'Report acknowledgement of the deferred action (e.g., "task created, will sync',
        'after merge of PR #NNN").',
      ],
    },
    {
      key: 'memory_gap_scan',
      title: 'Step 8: Memory Sync Gap-Scan (verify)',
      instructions: [
        'Step 7 writes what the Orchestrator REMEMBERS to memory. This step VERIFIES',
        'mechanically. Step 7\'s scope is the retrospective PR; if any other PR landed',
        'in this sprint window after Step 5 (e.g., post-retro follow-up improvements,',
        'brewing-log batch PRs, hot-fix PRs that merged after retro started), Step 7',
        'will silently miss them. The scan below catches the gap regardless of recall.',
        '',
        'Mechanical scan procedure (run AFTER Step 7):',
        '  1. Determine sprint window: start = sprint kickoff date (per',
        '     project_sprint_status.md front-matter / Sprint Start memo),',
        '     end = current timestamp.',
        '  2. List all PRs merged in the window. Filter CLIENT-SIDE, not with',
        '     --search: `gh pr list` SILENTLY IGNORES the search query\'s date',
        '     qualifiers when --json is also passed, so the window is not applied',
        '     at all and the result is just "the last N merged PRs".',
        '       gh pr list --state merged --limit 100 \\',
        '         --json number,title,mergedAt \\',
        '         --jq \'.[] | select(.mergedAt >= "<start>" and .mergedAt <= "<end>")\'',
        '     Dates are ISO-8601 and compare lexicographically, so a plain',
        '     "2026-08-25" bound works against a full "2026-08-25T12:41:08Z" value.',
        '     Raise --limit if the window could hold more than 100 merged PRs.',
        '  3. For each returned PR number, grep all three memory files:',
        '       grep -l "#<NUM>" \\',
        '         memory/project_sprint_status.md \\',
        '         memory/MEMORY.md \\',
        '         memory/project_pending_triage_list.md',
        '  4. A PR NOT appearing in BOTH project_sprint_status.md AND',
        '     project_pending_triage_list.md is a gap candidate.',
        '     (MEMORY.md only carries the sprint-pointer summary line, so individual',
        '     PR mentions there are not required.)',
        '  5. For each gap candidate, decide:',
        '     - sprint-related (planned task, retro PR, follow-up improvement,',
        '       brewing-log batch) → add the missing entries',
        '     - unrelated (someone else\'s PR that happened to merge in window,',
        '       or off-sprint maintenance) → note and skip',
        '  6. Apply additions if any.',
        '',
        'This converts "did I remember everything?" (LLM-weak) into "scan + grep diff"',
        '(mechanical). Run the scan even if Step 7 already ran — the cost is one gh',
        'call plus a handful of greps. The scan is also valuable as a Sprint Start',
        'opening check for the previous sprint\'s closure.',
        '',
        'Report gap candidates and applied additions (or "no gaps").',
      ],
    },
  ];
}

// --- Display functions ---

function printStepHeader(step) {
  console.log(`\n--- ${step.title} ---`);
  for (const line of step.instructions) {
    console.log(line);
  }
  console.log();
}

function printSummary(responses, steps) {
  console.log('\n=== Sprint Retrospective Summary ===\n');
  for (const step of steps) {
    const response = responses[step.key];
    if (response !== undefined) {
      const display = response.length > 200 ? response.substring(0, 200) + '...' : response;
      console.log(`[${step.title}]`);
      console.log(`  ${display}`);
      console.log();
    }
  }
}

// --- Metrics block ---

function isAffirmative(answer) {
  if (!answer) return true; // default [Y/n] → Y on empty
  const trimmed = answer.trim().toLowerCase();
  return trimmed === '' || trimmed === 'y' || trimmed === 'yes';
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

export class MissingSprintPrNumbersError extends Error {
  constructor() {
    super(
      [
        'SPRINT_PR_NUMBERS is required.',
        '',
        'Set the env var to a whitespace/comma-separated list of merged PR numbers for this sprint, e.g.:',
        '  SPRINT_PR_NUMBERS="751 755 756 757" SPRINT_LABEL="Sprint 2026-05-02" \\',
        '    node .claude/skills/orchestrator/sprint-retro.js',
        '',
        'Date-window discovery was removed: the previous default scanned everything since the brewing Pilot start, which over-scoped post-Pilot sprints. Pass the sprint PRs explicitly.',
      ].join('\n')
    );
    this.name = 'MissingSprintPrNumbersError';
  }
}

function defaultProgressReporter(write = process.stderr.write.bind(process.stderr)) {
  return ({ index, total, prNumber }) => {
    write(`[${index}/${total}] fetching PR #${prNumber}...\n`);
  };
}

async function runMetricsBlock({
  readResponse,
  exec = defaultExec,
  cache = createCache(),
  env = process.env,
  collect = collectSprintMetrics,
  format = formatMetricsReport,
  now = new Date(),
  onProgress = () => {},
} = {}) {
  if (!env.SPRINT_PR_NUMBERS) {
    throw new MissingSprintPrNumbersError();
  }

  const sprintLabel = env.SPRINT_LABEL || isoDate(now);

  const prNumbers = env.SPRINT_PR_NUMBERS
    .split(/[\s,]+/)
    .map(s => Number.parseInt(s, 10))
    .filter(n => Number.isFinite(n));

  if (prNumbers.length === 0) {
    throw new MissingSprintPrNumbersError();
  }

  console.log();
  const result = collect({ exec, cache, prNumbers, onProgress });
  console.log(format(result, { sprintLabel }));
  console.log('Continue to retro questions? [Y/n]');
  const answer = await readResponse();
  return { prNumbers, proceed: isAffirmative(answer) };
}

// --- Main flow ---

async function runRetro({ stdin = process.stdin, metricsRunner = runMetricsBlock } = {}) {
  console.log('=== Sprint Retrospective ===');
  console.log();
  console.log('Before starting, create a TaskCreate checklist for tracking progress:');

  const steps = getSteps();

  for (const step of steps) {
    console.log(`  - ${step.title}`);
  }
  console.log();
  console.log('Use TaskCreate for each step, then mark them in_progress/completed as you go.');
  console.log();

  const responses = {};
  const readResponse = createStdinReader(stdin);

  const { proceed } = await metricsRunner({ readResponse, onProgress: defaultProgressReporter() });
  if (!proceed) {
    console.log('Retrospective interrupted by user after metrics block.');
    return;
  }

  for (const step of steps) {
    printStepHeader(step);
    const answer = await readResponse();
    responses[step.key] = answer;
    console.log(`✓ ${step.title} — recorded`);
  }

  printSummary(responses, steps);
}

// --- Exports for testing ---
export {
  createStdinReader,
  getSteps,
  printStepHeader,
  printSummary,
  runRetro,
  runMetricsBlock,
  isAffirmative,
};

// --- Main ---

const isMainModule = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('sprint-retro.js');
if (!isMainModule) {
  // Module is being imported for testing — do not execute main logic
} else {
  try {
    await runRetro();
    process.exit(0);
  } catch (err) {
    if (err instanceof MissingSprintPrNumbersError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}
