import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Readable } from 'node:stream';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createStdinReader,
  getSteps,
  printStepHeader,
  printSummary,
  runRetro,
  runMetricsBlock,
  isAffirmative,
  MissingSprintPrNumbersError,
} from '../sprint-retro.js';
import {
  collectSprintMetrics,
  collectPrMetrics,
  computeAggregates,
  computeFlags,
  computeTimeToMergeableMin,
  computeCiStats,
  computeCodeRabbitCount,
  formatMetricsReport,
  findMergedPrNumbers,
  computeGapCandidates,
  parseJsonSafe,
  createCache,
  DEFAULT_FLAG_MULTIPLIER,
  MIN_PRS_FOR_DERIVED,
} from '../sprint-metrics.js';

// --- Helper: create a readable stream that emits null-byte terminated data ---

function createMockStdin(answers) {
  const chunks = answers.map(a => a + '\0');
  let index = 0;
  return new Readable({
    read() {
      if (index < chunks.length) {
        this.push(Buffer.from(chunks[index]));
        index++;
      } else {
        this.push(null);
      }
    },
  });
}

// --- Tests ---

describe('getSteps', () => {
  it('returns 9 steps', () => {
    const steps = getSteps();
    expect(steps).toHaveLength(9);
  });

  it('returns steps with expected keys in order', () => {
    const steps = getSteps();
    const keys = steps.map(s => s.key);
    expect(keys).toEqual([
      'triage',
      'worktree_cleanup',
      'incident_review',
      'process_review',
      'apply_improvements',
      'memory_writeout',
      'cross_project',
      'final_memory_sync',
      'memory_gap_scan',
    ]);
  });

  it('final_memory_sync step instructs post-merge update of 3 memory files', () => {
    const steps = getSteps();
    const finalSync = steps.find(s => s.key === 'final_memory_sync');
    const text = finalSync.instructions.join('\n');
    expect(text).toContain('project_sprint_status.md');
    expect(text).toContain('MEMORY.md');
    expect(text).toContain('project_pending_triage_list.md');
    expect(text).toContain('After the retrospective PR is merged');
  });

  it('memory_gap_scan step describes mechanical gh + comm diff procedure', () => {
    const steps = getSteps();
    const gapScan = steps.find(s => s.key === 'memory_gap_scan');
    const text = gapScan.instructions.join('\n');
    expect(text).toContain('gh pr list --state merged');
    expect(text).toContain('comm -13');
    expect(text).toContain('grep -l');
    expect(text).toContain('project_sprint_status.md');
    expect(text).toContain('project_pending_triage_list.md');
  });

  it('memory_gap_scan step does not tell the reader to combine --search with --json', () => {
    const steps = getSteps();
    const gapScan = steps.find(s => s.key === 'memory_gap_scan');
    const text = gapScan.instructions.join('\n');
    // `gh pr list` silently drops the search query's date qualifiers when
    // --json is also passed, so the sprint window is never applied and the
    // scan reports nearly every merged PR as a gap candidate. Measured
    // 2026-08-28: a 2026-08-25..2026-08-29 window returned PRs merged as far
    // back as 2026-08-03. The instruction must steer to a client-side filter.
    // Anchored on the command form, not the bare flag: the prose above it
    // names `--search` precisely to warn the reader off it.
    expect(text).not.toContain('gh pr list --search');
    expect(text).toContain('--jq');
    expect(text).toContain('.mergedAt');
  });

  it('memory_gap_scan step builds the known set from SPRINT_PR_NUMBERS plus the retro PR', () => {
    const steps = getSteps();
    const gapScan = steps.find(s => s.key === 'memory_gap_scan');
    const text = gapScan.instructions.join('\n');
    expect(text).toContain('$SPRINT_PR_NUMBERS');
    expect(text).toContain('retro-pr-number');
    expect(text).toContain('KNOWN set');
  });

  it('memory_gap_scan step frames diff survivors as candidates needing disposition, not confirmed gaps', () => {
    const steps = getSteps();
    const gapScan = steps.find(s => s.key === 'memory_gap_scan');
    const text = gapScan.instructions.join('\n');
    // Measured 2026-08-30: the old per-PR memory-file criterion flagged 50 of
    // 52 merged PRs when nothing was missing. The instruction must say the
    // diff's survivors are candidates, not automatic gaps -- pinned against
    // the exact verdict wording the old criterion used ("is a gap candidate").
    expect(text).toContain('CANDIDATE');
    expect(text).toContain('hypothesis');
    expect(text).toContain('not an automatic gap verdict');
    expect(text).not.toContain('is a gap candidate');
  });

  it('memory_gap_scan step names the previous sprint\'s retro PR as an inclusive-lower-bound artifact', () => {
    const steps = getSteps();
    const gapScan = steps.find(s => s.key === 'memory_gap_scan');
    const text = gapScan.instructions.join('\n');
    expect(text).toContain('PREVIOUS sprint');
    expect(text).toContain('retro');
    expect(text).toContain('inclusive lower bound artifact');
  });

  it('memory_gap_scan step scopes the memory-file grep to remaining candidates only', () => {
    const steps = getSteps();
    const gapScan = steps.find(s => s.key === 'memory_gap_scan');
    const text = gapScan.instructions.join('\n');
    expect(text).toContain('REMAINING candidate');
    expect(text).toContain('narrow');
    // The old criterion grepped every merged PR against all three memory
    // files including MEMORY.md; the new one narrows to two files and only
    // the candidates left after the inclusive-lower-bound disposition.
    expect(text).not.toContain('memory/MEMORY.md');
  });

  it('each step has title and instructions', () => {
    const steps = getSteps();
    for (const step of steps) {
      expect(step.title).toBeTruthy();
      expect(step.instructions).toBeInstanceOf(Array);
      expect(step.instructions.length).toBeGreaterThan(0);
    }
  });

  it('process_review step lists 4 review perspectives', () => {
    const steps = getSteps();
    const processReview = steps.find(s => s.key === 'process_review');
    const text = processReview.instructions.join('\n');
    expect(text).toContain('Redundant information');
    expect(text).toContain('Implicit knowledge');
    expect(text).toContain('Name-reality mismatches');
    expect(text).toContain('Owner-dependent discoveries');
  });
});

// The known-set-building command below is extracted from the PRODUCTION
// instruction text and actually executed in bash. This is not a duplicate
// of the logic -- it IS the logic: the literal string a human copies out of
// Step 8 and runs. Executing it here is what "test production code" means
// when the artifact under test is a shell one-liner embedded in prose,
// rather than a JS function.
//
// An earlier version of this line used an unquoted
// `printf '%s\n' $SPRINT_PR_NUMBERS <retro-pr-number>` alone, which never
// splits on commas -- SPRINT_PR_NUMBERS is documented as whitespace- OR
// comma-separated, and the script's own parser splits on `/[\s,]+/`. A
// comma-separated SPRINT_PR_NUMBERS silently reintroduced the defect this
// step exists to fix: nearly every sprint PR reads as a gap candidate again.
function extractKnownSetCommand() {
  const steps = getSteps();
  const gapScan = steps.find(s => s.key === 'memory_gap_scan');
  const line = gapScan.instructions.find(l => l.includes('/tmp/known.txt') && l.includes('printf'));
  if (!line) throw new Error('known-set command line not found in Step 8 instructions');
  return line.trim();
}

function runKnownSetCommand(sprintPrNumbersRaw, retroPrNumber = '1514') {
  const rawCmd = extractKnownSetCommand().replace('<retro-pr-number>', String(retroPrNumber));
  const dir = mkdtempSync(join(tmpdir(), 'sprint-retro-known-set-'));
  const knownPath = join(dir, 'known.txt');
  const cmd = rawCmd.replace('/tmp/known.txt', knownPath);
  try {
    execSync(cmd, {
      shell: '/bin/bash',
      env: { ...process.env, SPRINT_PR_NUMBERS: sprintPrNumbersRaw },
    });
    return readFileSync(knownPath, 'utf-8').trim().split('\n').filter(Boolean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('memory_gap_scan Step 8 instructions: known-set command (executed, not duplicated)', () => {
  it('normalizes comma-separated SPRINT_PR_NUMBERS, matching the script\'s own .split(/[\\s,]+/) contract', () => {
    // Reach: reverting the fix (dropping `| tr \', \' \'\\n\' | sed \'/^$/d\'`)
    // makes this fail -- the output would be ["1392,1393", "1514"] instead
    // of ["1392", "1393", "1514"]. Confirmed by hand: reverted to the
    // pre-fix line, this test failed with exactly that output; restored,
    // it passes. (No other test in this suite would have caught it --
    // the prose-content tests only check for substrings, not behavior.)
    const known = runKnownSetCommand('1392,1393');
    expect(known).toEqual(['1392', '1393', '1514']);
  });

  it('still handles whitespace-separated SPRINT_PR_NUMBERS (regression control)', () => {
    const known = runKnownSetCommand('1392 1393');
    expect(known).toEqual(['1392', '1393', '1514']);
  });

  it('handles a mixed comma-and-space separated value', () => {
    const known = runKnownSetCommand('1392, 1393, 1395');
    expect(known).toEqual(['1392', '1393', '1395', '1514']);
  });
});

describe('printStepHeader', () => {
  let logSpy;
  let logs;

  beforeEach(() => {
    logs = [];
    logSpy = spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints step title and instructions', () => {
    const step = {
      key: 'test',
      title: 'Step X: Test Step',
      instructions: ['Do something', 'Do another thing'],
    };
    printStepHeader(step);
    const output = logs.join('\n');
    expect(output).toContain('--- Step X: Test Step ---');
    expect(output).toContain('Do something');
    expect(output).toContain('Do another thing');
  });
});

describe('printSummary', () => {
  let logSpy;
  let logs;

  beforeEach(() => {
    logs = [];
    logSpy = spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints all step responses', () => {
    const steps = [
      { key: 's1', title: 'Step 1' },
      { key: 's2', title: 'Step 2' },
    ];
    const responses = { s1: 'Response one', s2: 'Response two' };
    printSummary(responses, steps);
    const output = logs.join('\n');
    expect(output).toContain('Sprint Retrospective Summary');
    expect(output).toContain('[Step 1]');
    expect(output).toContain('Response one');
    expect(output).toContain('[Step 2]');
    expect(output).toContain('Response two');
  });

  it('truncates long responses to 200 chars', () => {
    const steps = [{ key: 's1', title: 'Step 1' }];
    const longResponse = 'x'.repeat(250);
    const responses = { s1: longResponse };
    printSummary(responses, steps);
    const output = logs.join('\n');
    expect(output).toContain('x'.repeat(200) + '...');
  });

  it('skips steps without responses', () => {
    const steps = [
      { key: 's1', title: 'Step 1' },
      { key: 's2', title: 'Step 2' },
    ];
    const responses = { s1: 'Only this one' };
    printSummary(responses, steps);
    const output = logs.join('\n');
    expect(output).toContain('[Step 1]');
    expect(output).not.toContain('[Step 2]');
  });
});

describe('createStdinReader', () => {
  it('reads multiple null-byte delimited responses', async () => {
    const stdin = createMockStdin(['first', 'second', 'third']);
    const readResponse = createStdinReader(stdin);
    expect(await readResponse()).toBe('first');
    expect(await readResponse()).toBe('second');
    expect(await readResponse()).toBe('third');
  });

  it('trims whitespace from responses', async () => {
    const stdin = createMockStdin(['  trimmed  ']);
    const readResponse = createStdinReader(stdin);
    expect(await readResponse()).toBe('trimmed');
  });
});

describe('runRetro', () => {
  let logSpy;
  let logs;

  beforeEach(() => {
    logs = [];
    logSpy = spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('runs through all 9 steps and prints summary', async () => {
    const answers = [
      'Removed old item from triage',
      'Cleaned wt-001',
      'PR #100 went well',
      'No redundancies found',
      'Updated CLAUDE.md rule',
      'Deleted stale memory',
      'No other sessions',
      'Task created, will sync after merge of PR #NNN',
      'No gaps found',
    ];
    const stdin = createMockStdin(answers);
    await runRetro({ stdin, metricsRunner: async () => ({ proceed: true }) });
    const output = logs.join('\n');

    // Verify header and TaskCreate instruction
    expect(output).toContain('=== Sprint Retrospective ===');
    expect(output).toContain('TaskCreate');

    // Verify all step titles appear
    const steps = getSteps();
    for (const step of steps) {
      expect(output).toContain(step.title);
    }

    // Verify all confirmation messages
    for (const step of steps) {
      expect(output).toContain(`✓ ${step.title} — recorded`);
    }

    // Verify summary includes responses
    expect(output).toContain('Sprint Retrospective Summary');
    for (const answer of answers) {
      expect(output).toContain(answer);
    }
  });

  it('presents steps in correct order', async () => {
    const answers = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'];
    const stdin = createMockStdin(answers);
    await runRetro({ stdin, metricsRunner: async () => ({ proceed: true }) });
    const output = logs.join('\n');

    const steps = getSteps();
    let lastIndex = -1;
    for (const step of steps) {
      const idx = output.indexOf(`--- ${step.title} ---`);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  it('collects responses and maps them to step keys', async () => {
    const answers = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'];
    const stdin = createMockStdin(answers);
    await runRetro({ stdin, metricsRunner: async () => ({ proceed: true }) });
    const output = logs.join('\n');

    // Summary should contain all responses
    expect(output).toContain('r1');
    expect(output).toContain('r9');
  });

  it('handles empty responses gracefully', async () => {
    const answers = ['', '', '', '', '', '', '', '', ''];
    const stdin = createMockStdin(answers);
    await runRetro({ stdin, metricsRunner: async () => ({ proceed: true }) });
    const output = logs.join('\n');

    // Should still complete without errors
    expect(output).toContain('Sprint Retrospective Summary');
    const steps = getSteps();
    for (const step of steps) {
      expect(output).toContain(`✓ ${step.title} — recorded`);
    }
  });

  it('aborts without running steps if metrics block returns proceed:false', async () => {
    const answers = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'];
    const stdin = createMockStdin(answers);
    await runRetro({ stdin, metricsRunner: async () => ({ proceed: false }) });
    const output = logs.join('\n');
    expect(output).toContain('Retrospective interrupted by user');
    expect(output).not.toContain('Sprint Retrospective Summary');
  });
});

describe('isAffirmative', () => {
  it('treats empty string as Y (default)', () => {
    expect(isAffirmative('')).toBe(true);
  });
  it('treats y / yes (any case) as Y', () => {
    expect(isAffirmative('y')).toBe(true);
    expect(isAffirmative('Y')).toBe(true);
    expect(isAffirmative('yes')).toBe(true);
    expect(isAffirmative('YES')).toBe(true);
  });
  it('treats n / no / anything else as not-affirmative', () => {
    expect(isAffirmative('n')).toBe(false);
    expect(isAffirmative('no')).toBe(false);
    expect(isAffirmative('stop')).toBe(false);
  });
});

// --- Metrics fixtures ---

const FIXTURE_PRS = {
  633: {
    number: 633,
    title: 'docs: session-data-path design',
    headRefName: 'docs/pr633',
    createdAt: '2026-04-17T10:00:00Z',
    mergedAt: '2026-04-17T10:05:00Z',
    commits: [{ oid: 'a' }],
    additions: 100,
    deletions: 5,
    reviews: [],
    author: { login: 'ms2sato' },
  },
  635: {
    number: 635,
    title: 'docs: architectural-invariants',
    headRefName: 'docs/pr635',
    createdAt: '2026-04-17T11:00:00Z',
    mergedAt: '2026-04-17T11:03:00Z',
    commits: [{ oid: 'b' }],
    additions: 200,
    deletions: 10,
    reviews: [],
    author: { login: 'ms2sato' },
  },
  638: {
    number: 638,
    title: 'feat: session-data-path scope-based impl',
    headRefName: 'feat/pr638',
    createdAt: '2026-04-17T12:00:00Z',
    mergedAt: '2026-04-17T14:20:00Z', // 140 min
    commits: [{ oid: 'c1' }, { oid: 'c2' }, { oid: 'c3' }, { oid: 'c4' }, { oid: 'c5' }],
    additions: 500,
    deletions: 120,
    reviews: [],
    author: { login: 'ms2sato' },
  },
  639: {
    number: 639,
    title: 'feat: structural metrics tooling',
    headRefName: 'feat/pr639',
    createdAt: '2026-04-17T15:00:00Z',
    mergedAt: '2026-04-17T16:20:00Z', // 80 min
    commits: [{ oid: 'd1' }, { oid: 'd2' }, { oid: 'd3' }, { oid: 'd4' }],
    additions: 300,
    deletions: 80,
    reviews: [],
    author: { login: 'ms2sato' },
  },
};

const FIXTURE_RUNS = {
  'docs/pr633': [],
  'docs/pr635': [{ conclusion: 'success' }],
  'feat/pr638': [
    { conclusion: 'success' },
    { conclusion: 'failure' },
    { conclusion: 'success' },
  ],
  'feat/pr639': [
    { conclusion: 'failure' },
    { conclusion: 'success' },
  ],
};

// coderabbit issue comments per PR
const FIXTURE_ISSUE_COMMENTS = {
  633: [],
  635: [],
  638: [
    { user: { login: 'coderabbitai' } },
    { user: { login: 'coderabbitai[bot]' } },
    { user: { login: 'coderabbitai' } },
    { user: { login: 'coderabbitai[bot]' } },
    { user: { login: 'coderabbitai' } },
    { user: { login: 'coderabbitai' } },
    { user: { login: 'ms2sato' } }, // ignored
  ],
  639: [
    { user: { login: 'coderabbitai' } },
    { user: { login: 'coderabbitai' } },
    { user: { login: 'coderabbitai' } },
  ],
};

const FIXTURE_REVIEW_COMMENTS = {
  633: [],
  635: [],
  638: [],
  639: [],
};

function buildFixtureExec(prNumbers, { callLog, fail } = {}) {
  return (cmd) => {
    if (callLog) callLog.push(cmd);
    if (fail && fail.has(cmd)) throw new Error(`simulated failure: ${cmd}`);

    const viewMatch = cmd.match(/^gh pr view (\d+) /);
    if (viewMatch) {
      const num = Number(viewMatch[1]);
      if (!prNumbers.includes(num)) return '';
      return JSON.stringify(FIXTURE_PRS[num]);
    }
    const runMatch = cmd.match(/^gh run list --branch '([^']+)'/);
    if (runMatch) {
      const branch = runMatch[1];
      return JSON.stringify(FIXTURE_RUNS[branch] ?? []);
    }
    const issueMatch = cmd.match(/^gh api repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments/);
    if (issueMatch) {
      const num = Number(issueMatch[1]);
      return JSON.stringify(FIXTURE_ISSUE_COMMENTS[num] ?? []);
    }
    const reviewMatch = cmd.match(/^gh api repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/comments/);
    if (reviewMatch) {
      const num = Number(reviewMatch[1]);
      return JSON.stringify(FIXTURE_REVIEW_COMMENTS[num] ?? []);
    }
    if (cmd.startsWith('gh pr list')) {
      return JSON.stringify(prNumbers.map(n => ({ number: n })));
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
}

describe('boundary validation', () => {
  it('rejects non-integer PR numbers (shell injection guard)', () => {
    const exec = () => '[]';
    const cache = createCache();
    // Non-integer slips past `collectPrMetrics` → assertSafePrNumber throws
    expect(() => collectPrMetrics({ exec, cache, prNumber: 'abc; rm -rf /' }))
      .toThrow(/unsafe PR number/);
  });
  it('rejects repo identifiers with suspicious characters', () => {
    const exec = () => '[]';
    const cache = createCache();
    expect(() => collectPrMetrics({ exec, cache, prNumber: 1, repo: 'ms2sato/agent-console; rm -rf /' }))
      .toThrow(/unsafe repo identifier/);
  });
});

describe('parseJsonSafe', () => {
  it('returns null for empty / null / undefined', () => {
    expect(parseJsonSafe('')).toBe(null);
    expect(parseJsonSafe(null)).toBe(null);
    expect(parseJsonSafe(undefined)).toBe(null);
  });
  it('returns null for malformed JSON', () => {
    expect(parseJsonSafe('not-json')).toBe(null);
    expect(parseJsonSafe('{')).toBe(null);
  });
  it('parses valid JSON', () => {
    expect(parseJsonSafe('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonSafe('[1,2]')).toEqual([1, 2]);
  });
});

describe('computeTimeToMergeableMin', () => {
  it('computes minutes between createdAt and mergedAt', () => {
    const result = computeTimeToMergeableMin({
      createdAt: '2026-04-17T10:00:00Z',
      mergedAt: '2026-04-17T10:45:00Z',
    });
    expect(result).toBe(45);
  });
  it('returns null if fields missing', () => {
    expect(computeTimeToMergeableMin({})).toBe(null);
    expect(computeTimeToMergeableMin({ createdAt: '2026-04-17T10:00:00Z' })).toBe(null);
  });
  it('returns null if mergedAt < createdAt (corrupt data)', () => {
    const result = computeTimeToMergeableMin({
      createdAt: '2026-04-17T10:00:00Z',
      mergedAt: '2026-04-17T09:00:00Z',
    });
    expect(result).toBe(null);
  });
  it('returns null if input is null / __error', () => {
    expect(computeTimeToMergeableMin(null)).toBe(null);
    expect(computeTimeToMergeableMin({ __error: 'x' })).toBe(null);
  });
});

describe('computeCiStats', () => {
  it('counts runs and failures', () => {
    expect(computeCiStats([
      { conclusion: 'success' },
      { conclusion: 'failure' },
      { conclusion: 'cancelled' },
      { conclusion: 'success' },
    ])).toEqual({ runCount: 4, failureCount: 2 });
  });
  it('returns null counts if input is not an array', () => {
    expect(computeCiStats(null)).toEqual({ runCount: null, failureCount: null });
    expect(computeCiStats({ __error: 'x' })).toEqual({ runCount: null, failureCount: null });
  });
  it('returns zeros on empty array', () => {
    expect(computeCiStats([])).toEqual({ runCount: 0, failureCount: 0 });
  });
});

describe('computeCodeRabbitCount', () => {
  it('counts from all three sources', () => {
    const summary = { reviews: [{ author: { login: 'coderabbitai' } }] };
    const issueComments = [{ user: { login: 'coderabbitai[bot]' } }, { user: { login: 'ms2sato' } }];
    const reviewComments = [{ user: { login: 'coderabbitai' } }];
    expect(computeCodeRabbitCount(summary, issueComments, reviewComments)).toBe(3);
  });
  it('returns null if all sources are missing / errored', () => {
    expect(computeCodeRabbitCount({ __error: 'x' }, null, null)).toBe(null);
    expect(computeCodeRabbitCount(null, null, null)).toBe(null);
  });
  it('returns 0 when at least one source is an empty array', () => {
    expect(computeCodeRabbitCount(null, [], null)).toBe(0);
  });
});

describe('collectPrMetrics + collectSprintMetrics (4-PR fixture)', () => {
  it('produces the expected numbers from the fixture', () => {
    const cache = createCache();
    const exec = buildFixtureExec([633, 635, 638, 639]);
    const result = collectSprintMetrics({ exec, cache, prNumbers: [633, 635, 638, 639] });

    expect(result.prs).toHaveLength(4);

    const by = {};
    for (const p of result.prs) by[p.number] = p;

    expect(by[633].commitCount).toBe(1);
    expect(by[633].ciRunCount).toBe(0);
    expect(by[633].ciFailureCount).toBe(0);
    expect(by[633].timeToMergeableMin).toBe(5);
    expect(by[633].codeRabbitCount).toBe(0);
    expect(by[633].changeDelta).toBe(105);

    expect(by[635].commitCount).toBe(1);
    expect(by[635].ciRunCount).toBe(1);
    expect(by[635].timeToMergeableMin).toBe(3);
    expect(by[635].codeRabbitCount).toBe(0);

    expect(by[638].commitCount).toBe(5);
    expect(by[638].ciRunCount).toBe(3);
    expect(by[638].ciFailureCount).toBe(1);
    expect(by[638].timeToMergeableMin).toBe(140);
    expect(by[638].codeRabbitCount).toBe(6);

    expect(by[639].commitCount).toBe(4);
    expect(by[639].ciRunCount).toBe(2);
    expect(by[639].ciFailureCount).toBe(1);
    expect(by[639].timeToMergeableMin).toBe(80);
    expect(by[639].codeRabbitCount).toBe(3);
  });

  it('computes aggregates: totals, medians, push-to-fail', () => {
    const cache = createCache();
    const exec = buildFixtureExec([633, 635, 638, 639]);
    const { aggregates } = collectSprintMetrics({ exec, cache, prNumbers: [633, 635, 638, 639] });

    expect(aggregates.prCount).toBe(4);
    // ttm values [5, 3, 140, 80] sorted → [3, 5, 80, 140], median = (5+80)/2 = 42.5
    expect(aggregates.medianTimeToMergeableMin).toBe(42.5);
    expect(aggregates.totalCodeRabbitFindings).toBe(9);
    expect(aggregates.prsWithCodeRabbitFindings).toBe(2);
    expect(aggregates.totalCiRuns).toBe(6);
    expect(aggregates.totalCiFailures).toBe(2);
    expect(aggregates.pushToFailRatio).toBeCloseTo(2 / 6, 5);
  });

  it('flags PR #638 for coderabbit-heavy and slow-ttm (>2× median)', () => {
    const cache = createCache();
    const exec = buildFixtureExec([633, 635, 638, 639]);
    const { flags } = collectSprintMetrics({ exec, cache, prNumbers: [633, 635, 638, 639] });

    const pr638Flags = flags.filter(f => f.prNumber === 638);
    const kinds = pr638Flags.map(f => f.kind).sort();
    expect(kinds).toEqual(['coderabbit-heavy', 'slow-ttm']);

    // PR #639 should NOT flag: 80 < 2*42.5 = 85; 3 < 2*1.5 = 3 (strict >, equal does not fire)
    const pr639Flags = flags.filter(f => f.prNumber === 639);
    expect(pr639Flags).toHaveLength(0);
  });
});

describe('computeFlags threshold behavior', () => {
  it('skips flags entirely when PR count < MIN_PRS_FOR_DERIVED', () => {
    const prs = [
      { number: 1, commitCount: 10, timeToMergeableMin: 1000, codeRabbitCount: 10 },
      { number: 2, commitCount: 1, timeToMergeableMin: 1, codeRabbitCount: 0 },
    ];
    const agg = computeAggregates(prs);
    const flags = computeFlags(prs, agg);
    expect(flags).toEqual([]);
    expect(MIN_PRS_FOR_DERIVED).toBe(3);
  });

  it('respects custom multiplier', () => {
    const prs = [
      { number: 1, commitCount: 4, timeToMergeableMin: 40, codeRabbitCount: 2 },
      { number: 2, commitCount: 2, timeToMergeableMin: 20, codeRabbitCount: 1 },
      { number: 3, commitCount: 2, timeToMergeableMin: 20, codeRabbitCount: 1 },
    ];
    const agg = computeAggregates(prs);
    // median(ttm) = 20. PR#1 ttm=40 > 1.5*20=30 → flagged
    const flagsLoose = computeFlags(prs, agg, { multiplier: 1.5 });
    expect(flagsLoose.some(f => f.prNumber === 1 && f.kind === 'slow-ttm')).toBe(true);
    // With default multiplier=2, 40 > 2*20=40 is false
    const flagsStrict = computeFlags(prs, agg, { multiplier: DEFAULT_FLAG_MULTIPLIER });
    expect(flagsStrict.some(f => f.prNumber === 1 && f.kind === 'slow-ttm')).toBe(false);
  });
});

describe('caching', () => {
  it('calls each gh endpoint only once per PR within one run', () => {
    const calls = [];
    const cache = createCache();
    const exec = buildFixtureExec([638], { callLog: calls });
    collectSprintMetrics({ exec, cache, prNumbers: [638] });

    // Re-run: cache should short-circuit all fetches
    const callsBefore = calls.length;
    collectSprintMetrics({ exec, cache, prNumbers: [638] });
    expect(calls.length).toBe(callsBefore);
  });

  it('calls each endpoint once per PR on initial run', () => {
    const calls = [];
    const cache = createCache();
    const exec = buildFixtureExec([638], { callLog: calls });
    collectSprintMetrics({ exec, cache, prNumbers: [638] });
    // Expected: pr view, run list, issue comments, review comments = 4 calls
    expect(calls.length).toBe(4);
  });
});

describe('graceful degradation', () => {
  it('records per-PR error but continues for other PRs', () => {
    const failCmd = new Set(['gh pr view 635 -R ms2sato/agent-console --json number,title,headRefName,createdAt,mergedAt,commits,additions,deletions,reviews,author']);
    const exec = buildFixtureExec([633, 635, 638, 639], { fail: failCmd });
    const cache = createCache();
    const result = collectSprintMetrics({ exec, cache, prNumbers: [633, 635, 638, 639] });

    expect(result.prs).toHaveLength(4);
    const pr635 = result.prs.find(p => p.number === 635);
    expect(pr635.commitCount).toBe(null); // summary failed
    expect(pr635.errors.length).toBeGreaterThan(0);
    expect(pr635.errors.some(e => e.source === 'pr-view')).toBe(true);

    // Other PRs still populated
    const pr633 = result.prs.find(p => p.number === 633);
    expect(pr633.commitCount).toBe(1);

    // Aggregate captures errors too
    expect(result.errors.some(e => e.prNumber === 635 && e.source === 'pr-view')).toBe(true);
  });

  it('never throws even if gh output is malformed JSON', () => {
    const exec = () => 'this is not json';
    const cache = createCache();
    const result = collectSprintMetrics({ exec, cache, prNumbers: [999] });
    expect(result.prs[0].commitCount).toBe(null);
    expect(result.prs[0].ciRunCount).toBe(null);
  });
});

describe('findMergedPrNumbers', () => {
  it('returns numbers from gh pr list', () => {
    const exec = buildFixtureExec([100, 101, 102]);
    const nums = findMergedPrNumbers({ exec, since: '2026-04-01' });
    expect(nums).toEqual([100, 101, 102]);
  });
  it('returns [] on failure', () => {
    const exec = () => { throw new Error('boom'); };
    expect(findMergedPrNumbers({ exec })).toEqual([]);
  });
});

describe('computeGapCandidates', () => {
  // Real Sprint 2026-08-30 data (verified against `gh pr list` on this repo,
  // 2026-08-31). The window is every PR merged from the previous retro PR
  // (#1388, inclusive lower bound) through this sprint's own retro PR
  // (#1514). SPRINT_PR_NUMBERS for that sprint covered exactly #1392-#1512
  // (50 PRs) -- set before #1514 existed, so neither #1388 nor #1514 is in
  // it. This is the exact shape the Issue measured: 52 in the window, 50
  // known, 2 explainable candidates, zero false positives.
  const KNOWN_50 = [
    1392, 1393, 1395, 1396, 1397, 1398, 1402, 1403, 1405, 1413, 1415, 1417,
    1422, 1427, 1429, 1431, 1432, 1436, 1437, 1438, 1439, 1441, 1443, 1448,
    1451, 1453, 1456, 1462, 1466, 1467, 1469, 1472, 1473, 1474, 1477, 1478,
    1480, 1481, 1482, 1484, 1485, 1489, 1490, 1493, 1500, 1503, 1505, 1507,
    1510, 1512,
  ];
  const WINDOW_52 = [1388, ...KNOWN_50, 1514];

  it('the 2026-08-30 shape: 50 known + 52 in window -> exactly the 2 explainable candidates', () => {
    const result = computeGapCandidates({ windowPrNumbers: WINDOW_52, knownPrNumbers: KNOWN_50 });
    expect(result).toEqual([1388, 1514]);
  });

  it('zero false positives: none of the 50 known PRs are reported as candidates', () => {
    const result = computeGapCandidates({ windowPrNumbers: WINDOW_52, knownPrNumbers: KNOWN_50 });
    for (const knownPr of KNOWN_50) {
      expect(result).not.toContain(knownPr);
    }
    expect(result).toHaveLength(2);
  });

  it('polarity: a PR genuinely absent from the known set IS flagged, alongside the explainable candidates', () => {
    // Today's per-PR memory-file criterion cannot distinguish "clean sprint"
    // from "one PR genuinely missing" -- both read as ~50 gap candidates.
    // The new criterion must: unlike the old one, a real gap changes the
    // candidate count from 2 to 3, not from 50-ish to 51-ish.
    const windowWithGenuineGap = [...WINDOW_52, 1499];
    const result = computeGapCandidates({ windowPrNumbers: windowWithGenuineGap, knownPrNumbers: KNOWN_50 });
    expect(result).toEqual([1388, 1499, 1514]);
  });

  it('dedupes repeated PR numbers in the window', () => {
    // Reach: removing the `new Set(windowPrNumbers)` dedup step (using the
    // raw array instead) makes this fail -- 1388 would appear twice.
    const result = computeGapCandidates({
      windowPrNumbers: [1388, 1388, 1392, 1514],
      knownPrNumbers: [1392],
    });
    expect(result).toEqual([1388, 1514]);
  });

  it('sorts candidates ascending regardless of input order', () => {
    // Reach: removing the `.sort((a, b) => a - b)` call makes this fail --
    // Set iteration order is insertion order, so it would come back
    // [1514, 1388] here.
    const result = computeGapCandidates({
      windowPrNumbers: [1514, 1392, 1388],
      knownPrNumbers: [1392],
    });
    expect(result).toEqual([1388, 1514]);
  });

  it('returns [] when the window is empty', () => {
    expect(computeGapCandidates({ windowPrNumbers: [], knownPrNumbers: [1392, 1393] })).toEqual([]);
  });

  it('returns [] when the window is a subset of the known set', () => {
    // Reach: flipping the filter predicate (`known.has(n)` instead of
    // `!known.has(n)`) makes this fail -- it would return the whole window.
    expect(computeGapCandidates({ windowPrNumbers: [1392, 1393], knownPrNumbers: [1392, 1393, 1400] })).toEqual([]);
  });
});

describe('formatMetricsReport', () => {
  it('produces the expected report structure for the 4-PR fixture', () => {
    const cache = createCache();
    const exec = buildFixtureExec([633, 635, 638, 639]);
    const result = collectSprintMetrics({ exec, cache, prNumbers: [633, 635, 638, 639] });
    const report = formatMetricsReport(result, { sprintLabel: '2026-04-17' });

    expect(report).toContain('Sprint 2026-04-17 Objective Metrics');
    expect(report).toContain('PRs merged this sprint: 4');
    expect(report).toContain('PR #638');
    expect(report).toContain('140min TTM');
    expect(report).toContain('6 CR');
    expect(report).toContain('Potential retro topics');
    expect(report).toContain('PR #638 had 6 CodeRabbit findings');
    expect(report).toContain('Push-to-fail ratio: 33%');
  });

  it('skips aggregates block when fewer than MIN_PRS_FOR_DERIVED PRs', () => {
    const cache = createCache();
    const exec = buildFixtureExec([633, 635]);
    const result = collectSprintMetrics({ exec, cache, prNumbers: [633, 635] });
    const report = formatMetricsReport(result);
    expect(report).toContain('(skipped — needs 3+ PRs, have 2)');
    expect(report).not.toContain('Push-to-fail ratio:');
  });

  it('includes error lines when partial failures occurred', () => {
    const failCmd = new Set(['gh pr view 635 -R ms2sato/agent-console --json number,title,headRefName,createdAt,mergedAt,commits,additions,deletions,reviews,author']);
    const exec = buildFixtureExec([633, 635, 638, 639], { fail: failCmd });
    const cache = createCache();
    const result = collectSprintMetrics({ exec, cache, prNumbers: [633, 635, 638, 639] });
    const report = formatMetricsReport(result);
    expect(report).toContain('Data collection errors');
    expect(report).toContain('PR #635 pr-view:');
  });
});

describe('runMetricsBlock', () => {
  let logSpy;
  let logs;

  beforeEach(() => {
    logs = [];
    logSpy = spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('throws MissingSprintPrNumbersError when SPRINT_PR_NUMBERS is unset', async () => {
    const readResponse = async () => '';
    await expect(runMetricsBlock({ readResponse, env: {} }))
      .rejects.toBeInstanceOf(MissingSprintPrNumbersError);
  });

  it('throws MissingSprintPrNumbersError when SPRINT_PR_NUMBERS is empty / non-numeric', async () => {
    const readResponse = async () => '';
    await expect(runMetricsBlock({ readResponse, env: { SPRINT_PR_NUMBERS: '' } }))
      .rejects.toBeInstanceOf(MissingSprintPrNumbersError);
    await expect(runMetricsBlock({ readResponse, env: { SPRINT_PR_NUMBERS: '   ,  ' } }))
      .rejects.toBeInstanceOf(MissingSprintPrNumbersError);
  });

  it('error message points the user to the canonical invocation form', async () => {
    const readResponse = async () => '';
    try {
      await runMetricsBlock({ readResponse, env: {} });
      throw new Error('expected MissingSprintPrNumbersError');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingSprintPrNumbersError);
      expect(err.message).toContain('SPRINT_PR_NUMBERS is required');
      expect(err.message).toContain('node .claude/skills/orchestrator/sprint-retro.js');
    }
  });

  it('uses SPRINT_PR_NUMBERS env override and prints the report', async () => {
    const readResponse = async () => 'y';
    const exec = buildFixtureExec([633, 635, 638, 639]);
    const result = await runMetricsBlock({
      readResponse,
      exec,
      env: { SPRINT_PR_NUMBERS: '633 635 638 639', SPRINT_LABEL: '2026-04-17' },
    });
    expect(result.proceed).toBe(true);
    expect(result.prNumbers).toEqual([633, 635, 638, 639]);
    expect(logs.join('\n')).toContain('Sprint 2026-04-17 Objective Metrics');
    expect(logs.join('\n')).toContain('Continue to retro questions? [Y/n]');
  });

  it('returns proceed:false when user answers n', async () => {
    const readResponse = async () => 'n';
    const exec = buildFixtureExec([633, 635, 638, 639]);
    const result = await runMetricsBlock({
      readResponse,
      exec,
      env: { SPRINT_PR_NUMBERS: '633,635,638,639' },
    });
    expect(result.proceed).toBe(false);
  });

  it('defaults to proceed:true when user answers empty (Y default)', async () => {
    const readResponse = async () => '';
    const exec = buildFixtureExec([633, 635, 638, 639]);
    const result = await runMetricsBlock({
      readResponse,
      exec,
      env: { SPRINT_PR_NUMBERS: '633,635,638,639' },
    });
    expect(result.proceed).toBe(true);
  });

  it('forwards onProgress to collectSprintMetrics', async () => {
    const readResponse = async () => 'y';
    const progressEvents = [];
    const onProgress = evt => progressEvents.push(evt);
    const exec = buildFixtureExec([633, 635, 638, 639]);
    const result = await runMetricsBlock({
      readResponse,
      exec,
      env: { SPRINT_PR_NUMBERS: '633 635 638 639' },
      onProgress,
    });
    expect(result.prNumbers).toEqual([633, 635, 638, 639]);
    expect(progressEvents).toHaveLength(4);
    expect(progressEvents[0]).toEqual({ index: 1, total: 4, prNumber: 633 });
    expect(progressEvents[3]).toEqual({ index: 4, total: 4, prNumber: 639 });
  });
});
