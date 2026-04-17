import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Readable } from 'node:stream';
import {
  createStdinReader,
  getSteps,
  printStepHeader,
  printSummary,
  runRetro,
  runMetricsBlock,
  isAffirmative,
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
  it('returns 7 steps', () => {
    const steps = getSteps();
    expect(steps).toHaveLength(7);
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
    ]);
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

  it('runs through all 7 steps and prints summary', async () => {
    const answers = [
      'Removed old item from triage',
      'Cleaned wt-001',
      'PR #100 went well',
      'No redundancies found',
      'Updated CLAUDE.md rule',
      'Deleted stale memory',
      'No other sessions',
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
    const answers = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
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
    const answers = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
    const stdin = createMockStdin(answers);
    await runRetro({ stdin, metricsRunner: async () => ({ proceed: true }) });
    const output = logs.join('\n');

    // Summary should contain all responses
    expect(output).toContain('r1');
    expect(output).toContain('r7');
  });

  it('handles empty responses gracefully', async () => {
    const answers = ['', '', '', '', '', '', ''];
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
    const answers = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
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

  it('skips with a friendly message when no PRs are found', async () => {
    const readResponse = async () => '';
    const result = await runMetricsBlock({
      readResponse,
      discover: () => [],
      env: {},
    });
    expect(result.proceed).toBe(true);
    expect(logs.join('\n')).toContain('no merged PRs found');
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
});
