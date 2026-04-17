#!/usr/bin/env node

/**
 * Sprint Metrics — objective numbers for the retrospective.
 *
 * Pure-ish module: all shell access goes through an injected `exec`.
 * Unit tests inject a stub; the interactive script uses `defaultExec`,
 * which shells out via `child_process.execSync`.
 *
 * Phase 1 scope: raw gh/git metrics per PR, simple aggregates,
 * threshold-based "potential retro topics" flags. No persistence,
 * no cross-sprint trend analysis.
 */

import { execSync } from 'node:child_process';

// --- Configuration constants ---

export const DEFAULT_REPO = 'ms2sato/agent-console';
export const DEFAULT_FLAG_MULTIPLIER = 2; // flag when PR value >= N × sprint median
export const MIN_PRS_FOR_DERIVED = 3;     // below this, aggregates are too noisy
export const CODERABBIT_LOGINS = new Set(['coderabbitai', 'coderabbitai[bot]']);
export const CI_FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required']);

// --- Default exec (real shell) ---

export function defaultExec(cmd) {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// --- Safe JSON parsing (I-6: validate at trust boundary) ---

export function parseJsonSafe(raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

// --- Cache factory ---

export function createCache() {
  return new Map();
}

function cached(cache, key, compute) {
  if (cache.has(key)) return cache.get(key);
  const value = compute();
  cache.set(key, value);
  return value;
}

// --- Shell wrappers (all go through injected exec) ---

function runGhJson(exec, args) {
  const raw = exec(`gh ${args}`);
  return parseJsonSafe(raw);
}

// --- Boundary validation (I-6) ---
// gh arguments we interpolate are expected to come from trusted callers,
// but since a stray value would become a shell token, we still refuse
// anything that is not a safe identifier. Fail closed.
function assertSafePrNumber(n) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`unsafe PR number: ${JSON.stringify(n)}`);
  }
}
function assertSafeRepo(r) {
  if (typeof r !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)) {
    throw new Error(`unsafe repo identifier: ${JSON.stringify(r)}`);
  }
}

// --- Per-PR fetchers ---

/**
 * Fetch PR summary via `gh pr view`. Returns null on error.
 */
export function fetchPrSummary({ exec, cache, prNumber, repo = DEFAULT_REPO }) {
  assertSafePrNumber(prNumber);
  assertSafeRepo(repo);
  const key = `pr-view:${repo}:${prNumber}`;
  return cached(cache, key, () => {
    try {
      const fields = 'number,title,headRefName,createdAt,mergedAt,commits,additions,deletions,reviews,author';
      const data = runGhJson(exec, `pr view ${prNumber} -R ${repo} --json ${fields}`);
      if (!data || typeof data !== 'object') return null;
      return data;
    } catch (err) {
      return { __error: err?.message ?? String(err) };
    }
  });
}

/**
 * Fetch CI runs for the PR's head branch. Returns an array of runs or null.
 * We query by branch so multiple pushes on the same PR are all counted.
 */
export function fetchCiRuns({ exec, cache, branch, repo = DEFAULT_REPO, limit = 100 }) {
  if (!branch) return null;
  assertSafeRepo(repo);
  const key = `ci-runs:${repo}:${branch}`;
  return cached(cache, key, () => {
    try {
      const data = runGhJson(
        exec,
        `run list --branch ${shellEscape(branch)} -R ${repo} --limit ${limit} --json databaseId,conclusion,status,createdAt,event`
      );
      if (!Array.isArray(data)) return null;
      return data;
    } catch (err) {
      return { __error: err?.message ?? String(err) };
    }
  });
}

/**
 * Fetch issue-level comments (includes coderabbitai summaries). Returns array or null.
 */
export function fetchIssueComments({ exec, cache, prNumber, repo = DEFAULT_REPO }) {
  assertSafePrNumber(prNumber);
  assertSafeRepo(repo);
  const key = `issue-comments:${repo}:${prNumber}`;
  return cached(cache, key, () => {
    try {
      const data = runGhJson(exec, `api repos/${repo}/issues/${prNumber}/comments --paginate`);
      if (!Array.isArray(data)) return null;
      return data;
    } catch (err) {
      return { __error: err?.message ?? String(err) };
    }
  });
}

/**
 * Fetch line-level review comments. Returns array or null.
 */
export function fetchReviewComments({ exec, cache, prNumber, repo = DEFAULT_REPO }) {
  assertSafePrNumber(prNumber);
  assertSafeRepo(repo);
  const key = `review-comments:${repo}:${prNumber}`;
  return cached(cache, key, () => {
    try {
      const data = runGhJson(exec, `api repos/${repo}/pulls/${prNumber}/comments --paginate`);
      if (!Array.isArray(data)) return null;
      return data;
    } catch (err) {
      return { __error: err?.message ?? String(err) };
    }
  });
}

// --- Derived per-PR metrics ---

export function computeCommitCount(summary) {
  if (!summary || summary.__error) return null;
  const commits = summary.commits;
  if (!Array.isArray(commits)) return null;
  return commits.length;
}

export function computeChangeDelta(summary) {
  if (!summary || summary.__error) return null;
  const { additions, deletions } = summary;
  if (typeof additions !== 'number' || typeof deletions !== 'number') return null;
  return additions + deletions;
}

export function computeTimeToMergeableMin(summary) {
  if (!summary || summary.__error) return null;
  const { createdAt, mergedAt } = summary;
  if (!createdAt || !mergedAt) return null;
  const start = Date.parse(createdAt);
  const end = Date.parse(mergedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 60000);
}

export function computeCiStats(runs) {
  if (!runs || runs.__error || !Array.isArray(runs)) return { runCount: null, failureCount: null };
  const runCount = runs.length;
  let failureCount = 0;
  for (const run of runs) {
    if (run && CI_FAILURE_CONCLUSIONS.has(run.conclusion)) failureCount++;
  }
  return { runCount, failureCount };
}

function isCodeRabbitAuthor(entity) {
  const login = entity?.user?.login ?? entity?.author?.login;
  if (!login) return false;
  return CODERABBIT_LOGINS.has(login);
}

export function computeCodeRabbitCount(summary, issueComments, reviewComments) {
  let total = 0;
  let anyDataSeen = false;

  if (summary && !summary.__error && Array.isArray(summary.reviews)) {
    anyDataSeen = true;
    total += summary.reviews.filter(isCodeRabbitAuthor).length;
  }
  if (Array.isArray(issueComments)) {
    anyDataSeen = true;
    total += issueComments.filter(isCodeRabbitAuthor).length;
  }
  if (Array.isArray(reviewComments)) {
    anyDataSeen = true;
    total += reviewComments.filter(isCodeRabbitAuthor).length;
  }
  return anyDataSeen ? total : null;
}

// --- Per-PR collector ---

/**
 * Collect all Phase 1 metrics for one PR.
 *
 * Returns a PrMetrics record even on partial failure. Each failed data
 * source is noted in `errors`; other fields are still populated.
 */
export function collectPrMetrics({ exec, cache, prNumber, repo = DEFAULT_REPO }) {
  const errors = [];
  const summary = fetchPrSummary({ exec, cache, prNumber, repo });
  if (summary?.__error) errors.push({ source: 'pr-view', message: summary.__error });

  const branch = summary?.headRefName ?? null;
  const runs = fetchCiRuns({ exec, cache, branch, repo });
  if (runs?.__error) errors.push({ source: 'ci-runs', message: runs.__error });

  const issueComments = fetchIssueComments({ exec, cache, prNumber, repo });
  if (issueComments?.__error) errors.push({ source: 'issue-comments', message: issueComments.__error });

  const reviewComments = fetchReviewComments({ exec, cache, prNumber, repo });
  if (reviewComments?.__error) errors.push({ source: 'review-comments', message: reviewComments.__error });

  const { runCount, failureCount } = computeCiStats(runs);

  return {
    number: prNumber,
    title: summary?.title ?? null,
    commitCount: computeCommitCount(summary),
    ciRunCount: runCount,
    ciFailureCount: failureCount,
    timeToMergeableMin: computeTimeToMergeableMin(summary),
    codeRabbitCount: computeCodeRabbitCount(summary, issueComments, reviewComments),
    changeDelta: computeChangeDelta(summary),
    errors,
  };
}

// --- Aggregates & flags ---

function median(values) {
  const nums = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function computeAggregates(prs) {
  const ttmValues = prs.map(p => p.timeToMergeableMin);
  const commitCounts = prs.map(p => p.commitCount);
  const codeRabbitCounts = prs.map(p => p.codeRabbitCount);

  const totalCiRuns = prs.reduce((s, p) => s + (p.ciRunCount ?? 0), 0);
  const totalCiFailures = prs.reduce((s, p) => s + (p.ciFailureCount ?? 0), 0);
  const totalCodeRabbit = codeRabbitCounts.reduce((s, v) => s + (v ?? 0), 0);
  const prsWithCodeRabbit = codeRabbitCounts.filter(v => typeof v === 'number' && v > 0).length;

  return {
    prCount: prs.length,
    medianTimeToMergeableMin: median(ttmValues),
    medianCommitCount: median(commitCounts),
    medianCodeRabbitCount: median(codeRabbitCounts),
    totalCodeRabbitFindings: totalCodeRabbit,
    prsWithCodeRabbitFindings: prsWithCodeRabbit,
    totalCiRuns,
    totalCiFailures,
    pushToFailRatio: totalCiRuns > 0 ? totalCiFailures / totalCiRuns : null,
  };
}

export function computeFlags(prs, aggregates, { multiplier = DEFAULT_FLAG_MULTIPLIER } = {}) {
  const flags = [];
  if (prs.length < MIN_PRS_FOR_DERIVED) return flags;

  const { medianTimeToMergeableMin, medianCommitCount, medianCodeRabbitCount } = aggregates;

  for (const pr of prs) {
    if (
      typeof pr.codeRabbitCount === 'number' &&
      typeof medianCodeRabbitCount === 'number' &&
      medianCodeRabbitCount > 0 &&
      pr.codeRabbitCount > multiplier * medianCodeRabbitCount
    ) {
      flags.push({
        prNumber: pr.number,
        kind: 'coderabbit-heavy',
        value: pr.codeRabbitCount,
        median: medianCodeRabbitCount,
        message:
          `PR #${pr.number} had ${pr.codeRabbitCount} CodeRabbit findings ` +
          `(>${multiplier}× sprint median ${medianCodeRabbitCount}). ` +
          `Consider: are catalog additions warranted from the finding patterns?`,
      });
    }
    if (
      typeof pr.timeToMergeableMin === 'number' &&
      typeof medianTimeToMergeableMin === 'number' &&
      medianTimeToMergeableMin > 0 &&
      pr.timeToMergeableMin > multiplier * medianTimeToMergeableMin
    ) {
      flags.push({
        prNumber: pr.number,
        kind: 'slow-ttm',
        value: pr.timeToMergeableMin,
        median: medianTimeToMergeableMin,
        message:
          `PR #${pr.number} time-to-mergeable ${pr.timeToMergeableMin}min ` +
          `(>${multiplier}× sprint median ${medianTimeToMergeableMin}min). ` +
          `Consider: Issue acceptance criteria precision, or delegation prompt clarity?`,
      });
    }
    if (
      typeof pr.commitCount === 'number' &&
      typeof medianCommitCount === 'number' &&
      medianCommitCount > 0 &&
      pr.commitCount > multiplier * medianCommitCount
    ) {
      flags.push({
        prNumber: pr.number,
        kind: 'rework-hotspot',
        value: pr.commitCount,
        median: medianCommitCount,
        message:
          `PR #${pr.number} had ${pr.commitCount} commits ` +
          `(>${multiplier}× sprint median ${medianCommitCount}). ` +
          `Consider: spec ambiguity or scope creep?`,
      });
    }
  }
  return flags;
}

// --- PR discovery ---

/**
 * Find merged PRs in a date range. Returns array of PR numbers.
 * Accepts ISO date (YYYY-MM-DD) for both bounds.
 */
export function findMergedPrNumbers({ exec, since, until, repo = DEFAULT_REPO, limit = 100 }) {
  assertSafeRepo(repo);
  const queryParts = ['is:pr', 'is:merged'];
  if (since) queryParts.push(`merged:>=${since}`);
  if (until) queryParts.push(`merged:<=${until}`);
  const search = queryParts.join(' ');
  try {
    const data = runGhJson(
      exec,
      `pr list -R ${repo} --state merged --search ${shellEscape(search)} --limit ${limit} --json number`
    );
    if (!Array.isArray(data)) return [];
    return data
      .map(d => d?.number)
      .filter(n => typeof n === 'number');
  } catch {
    return [];
  }
}

// --- Top-level collector ---

export function collectSprintMetrics({ exec = defaultExec, cache = createCache(), prNumbers, repo = DEFAULT_REPO, thresholdMultiplier } = {}) {
  if (!Array.isArray(prNumbers) || prNumbers.length === 0) {
    return {
      prs: [],
      aggregates: computeAggregates([]),
      flags: [],
      errors: [],
    };
  }
  const prs = [];
  const errors = [];
  for (const num of prNumbers) {
    const metrics = collectPrMetrics({ exec, cache, prNumber: num, repo });
    prs.push(metrics);
    for (const e of metrics.errors) errors.push({ prNumber: num, ...e });
  }
  const aggregates = computeAggregates(prs);
  const flags = computeFlags(prs, aggregates, { multiplier: thresholdMultiplier ?? DEFAULT_FLAG_MULTIPLIER });
  return { prs, aggregates, flags, errors };
}

// --- Formatting ---

function fmtNum(n, suffix = '') {
  return typeof n === 'number' && Number.isFinite(n) ? `${n}${suffix}` : 'n/a';
}

function fmtPercent(ratio) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return 'n/a';
  return `${Math.round(ratio * 100)}%`;
}

function fmtMedian(n, suffix = '') {
  return typeof n === 'number' && Number.isFinite(n) ? `${Math.round(n)}${suffix}` : 'n/a';
}

export function formatMetricsReport({ prs, aggregates, flags, errors }, { sprintLabel } = {}) {
  const lines = [];
  const header = sprintLabel ? `Sprint ${sprintLabel} Objective Metrics` : 'Sprint Objective Metrics';
  lines.push(header);
  lines.push('='.repeat(header.length));
  lines.push('');

  lines.push(`PRs merged this sprint: ${prs.length}`);
  for (const pr of prs) {
    const title = pr.title ?? '(unknown title)';
    const parts = [
      `${fmtNum(pr.commitCount)} commit${pr.commitCount === 1 ? '' : 's'}`,
      `${fmtNum(pr.ciRunCount)} CI iter${pr.ciRunCount === 1 ? '' : 's'}`,
      `${fmtNum(pr.timeToMergeableMin, 'min')} TTM`,
      `${fmtNum(pr.codeRabbitCount)} CR`,
    ];
    lines.push(`  PR #${pr.number} ${title} — ${parts.join(', ')}`);
  }
  lines.push('');

  if (prs.length >= MIN_PRS_FOR_DERIVED) {
    lines.push('Sprint aggregates:');
    lines.push(`  Median time-to-mergeable: ${fmtMedian(aggregates.medianTimeToMergeableMin, ' min')}`);
    lines.push(`  Total CodeRabbit findings: ${aggregates.totalCodeRabbitFindings} (across ${aggregates.prsWithCodeRabbitFindings} PR${aggregates.prsWithCodeRabbitFindings === 1 ? '' : 's'})`);
    lines.push(
      `  Push-to-fail ratio: ${fmtPercent(aggregates.pushToFailRatio)}` +
        (typeof aggregates.pushToFailRatio === 'number'
          ? ` (${aggregates.totalCiFailures} failed / ${aggregates.totalCiRuns} total CI runs)`
          : '')
    );
    lines.push('');
  } else if (prs.length > 0) {
    lines.push(`Sprint aggregates: (skipped — needs ${MIN_PRS_FOR_DERIVED}+ PRs, have ${prs.length})`);
    lines.push('');
  }

  if (flags.length > 0) {
    lines.push('Potential retro topics (flagged by thresholds):');
    for (const f of flags) lines.push(`  - ${f.message}`);
    lines.push('');
  }

  if (errors.length > 0) {
    lines.push('Data collection errors (metrics may be partial):');
    for (const e of errors) {
      lines.push(`  - PR #${e.prNumber} ${e.source}: ${e.message}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// --- helpers ---

function shellEscape(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
