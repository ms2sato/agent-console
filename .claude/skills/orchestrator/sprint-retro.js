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
        '  1. List all agreed improvements',
        '  2. For each improvement, identify the target file(s) to modify',
        '     (e.g., CLAUDE.md, skills, rules, agents, memory)',
        '  3. Apply the changes or create Issues for larger changes',
        '',
        'Report what was changed and what was deferred to Issues.',
      ],
    },
    {
      key: 'memory_writeout',
      title: 'Step 5: Memory Write-Out',
      instructions: [
        'Review memory files against these criteria:',
        '  - Is the content general knowledge derivable from code? → DELETE',
        '  - Does it duplicate what is already in skills/rules? → DELETE',
        '  - Does it have a "why" context that is not obvious? → RETAIN',
        '  - Is the project status still current? → UPDATE',
        '',
        'Actions:',
        '  1. List deletion candidates with reasoning',
        '  2. Update sprint status in project_sprint_status.md',
        '  3. Update any stale memory entries',
        '',
        'Report deletions, updates, and rationale.',
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

// --- Main flow ---

async function runRetro({ stdin = process.stdin } = {}) {
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
};

// --- Main ---

const isMainModule = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('sprint-retro.js');
if (!isMainModule) {
  // Module is being imported for testing — do not execute main logic
} else {
  await runRetro();
  process.exit(0);
}
