#!/usr/bin/env node

/**
 * Sprint Retrospective Interactive Process Script
 *
 * Guides the Orchestrator through sprint retrospective steps via STDIN/STDOUT.
 * Each step displays instructions and waits for a null-byte delimited response.
 *
 * Usage:
 *   Run as interactive process via run_process MCP tool.
 */

import {
  collectSprintMetrics,
  findMergedPrNumbers,
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
        'Clean up worktrees for merged PRs:',
        '  1. Run list_sessions to see all active sessions/worktrees',
        '  2. Identify worktrees whose PRs have been merged',
        '  3. Run remove_worktree for each merged PR worktree',
        '',
        'Report which worktrees were removed (or "none to clean up").',
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

async function runMetricsBlock({
  readResponse,
  exec = defaultExec,
  cache = createCache(),
  env = process.env,
  collect = collectSprintMetrics,
  discover = findMergedPrNumbers,
  format = formatMetricsReport,
} = {}) {
  const sprintLabel = env.SPRINT_LABEL || new Date().toISOString().slice(0, 10);
  const since = env.SPRINT_SINCE || null;
  const until = env.SPRINT_UNTIL || null;

  let prNumbers;
  if (env.SPRINT_PR_NUMBERS) {
    prNumbers = env.SPRINT_PR_NUMBERS
      .split(/[\s,]+/)
      .map(s => Number.parseInt(s, 10))
      .filter(n => Number.isFinite(n));
  } else {
    try {
      prNumbers = discover({ exec, since, until });
    } catch {
      prNumbers = [];
    }
  }

  if (!Array.isArray(prNumbers) || prNumbers.length === 0) {
    console.log('\n--- Sprint Objective Metrics ---');
    console.log('(no merged PRs found for this sprint window — skipping metrics)');
    console.log();
    return { prNumbers: [], proceed: true };
  }

  console.log();
  const result = collect({ exec, cache, prNumbers });
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

  const { proceed } = await metricsRunner({ readResponse });
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
  await runRetro();
  process.exit(0);
}
