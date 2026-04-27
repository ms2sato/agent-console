import * as v from 'valibot';
import { createLogger } from '../../lib/logger.js';

const logger = createLogger('ci-completion-checker');

const CI_CHECK_TIMEOUT_MS = 10000;

export interface CICompletionCheckResult {
  /** Whether all workflows have completed successfully */
  allCompleted: boolean;
  /** Total number of unique workflows found for this commit */
  totalWorkflows: number;
  /** Number of workflows that completed successfully */
  successCount: number;
  /** Names of all workflows (for aggregated summary text) */
  workflowNames: string[];
}

/**
 * Check whether the CI for a given commit SHA has completed successfully.
 *
 * When `branch` is provided, the checker first looks up the open PR for that
 * branch and evaluates the PR HEAD's `statusCheckRollup`. This avoids the
 * stale-event false positive where a webhook for an older commit reports
 * "all passed" while the latest commit on the PR is still failing (#699).
 *
 * Falls back to the per-commit workflow-runs query when no PR is found
 * (push to a branch with no PR, push to main, etc.) or when `branch` is
 * omitted (legacy callers).
 *
 * Returns null if the check cannot be performed (gh not installed,
 * API error, timeout, etc). Callers should treat null as "pass through"
 * (fail-open policy).
 */
export type CICompletionChecker = (
  repositoryName: string,
  headSha: string,
  branch?: string
) => Promise<CICompletionCheckResult | null>;

interface WorkflowRun {
  workflow_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  run_number: number;
}

interface WorkflowRunsResponse {
  total_count: number;
  workflow_runs: WorkflowRun[];
}

const CheckRunSchema = v.object({
  __typename: v.literal('CheckRun'),
  name: v.string(),
  status: v.string(),
  conclusion: v.nullish(v.string()),
});

const StatusContextSchema = v.object({
  __typename: v.literal('StatusContext'),
  context: v.string(),
  state: v.string(),
});

const RollupEntrySchema = v.union([CheckRunSchema, StatusContextSchema]);

const PullRequestSchema = v.object({
  number: v.number(),
  headRefOid: v.string(),
  statusCheckRollup: v.array(RollupEntrySchema),
});

const PullRequestListSchema = v.array(PullRequestSchema);

type RollupEntry = v.InferOutput<typeof RollupEntrySchema>;

/** Conclusions that GitHub treats as non-blocking on PR merge. */
const SUCCESS_CHECKRUN_CONCLUSIONS = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);

/** Per-entry status: terminal-success / terminal-failure / non-terminal. */
type EntryStatus = 'success' | 'failure' | 'pending';

function classifyRollupEntry(entry: RollupEntry): EntryStatus {
  if (entry.__typename === 'CheckRun') {
    if (entry.status !== 'COMPLETED') {
      return 'pending';
    }
    if (entry.conclusion == null) {
      return 'pending';
    }
    return SUCCESS_CHECKRUN_CONCLUSIONS.has(entry.conclusion) ? 'success' : 'failure';
  }
  // StatusContext
  switch (entry.state) {
    case 'SUCCESS':
      return 'success';
    case 'PENDING':
      return 'pending';
    default:
      // FAILURE, ERROR, anything unexpected — treat as failure
      return 'failure';
  }
}

function rollupEntryName(entry: RollupEntry): string {
  return entry.__typename === 'CheckRun' ? entry.name : entry.context;
}

function createTimeoutPromise(timeoutMs: number): { promise: Promise<never>; cleanup: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const promise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`gh api timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const cleanup = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  };

  return { promise, cleanup };
}

/**
 * Run a `gh` command and return stdout, or null on any failure (timeout,
 * non-zero exit, spawn error). Logs warnings for diagnostic purposes.
 */
async function runGhCommand(
  args: string[],
  context: Record<string, unknown>
): Promise<string | null> {
  try {
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
    const { promise: timeoutPromise, cleanup } = createTimeoutPromise(CI_CHECK_TIMEOUT_MS);

    try {
      const result = await Promise.race([
        (async () => {
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            return { ok: false as const, exitCode, stderr };
          }
          const stdout = await new Response(proc.stdout).text();
          return { ok: true as const, stdout };
        })(),
        timeoutPromise,
      ]);

      if (!result.ok) {
        logger.warn(
          { ...context, exitCode: result.exitCode, stderr: result.stderr.trim() },
          'gh command returned non-zero exit code'
        );
        return null;
      }
      return result.stdout;
    } catch (error) {
      if (error instanceof Error && error.message.includes('timed out')) {
        try {
          proc.kill();
        } catch {
          // Ignore kill errors (process may have already exited)
        }
      }
      throw error;
    } finally {
      cleanup();
    }
  } catch (error) {
    logger.warn({ ...context, err: error }, 'gh command failed');
    return null;
  }
}

function deduplicateByLatestRun(runs: WorkflowRun[]): WorkflowRun[] {
  const latestByWorkflowId = new Map<number, WorkflowRun>();

  for (const run of runs) {
    const existing = latestByWorkflowId.get(run.workflow_id);
    if (!existing || run.run_number > existing.run_number) {
      latestByWorkflowId.set(run.workflow_id, run);
    }
  }

  return Array.from(latestByWorkflowId.values());
}

function checkCompletion(latestRuns: WorkflowRun[]): CICompletionCheckResult {
  const workflowNames = latestRuns.map((run) => run.name);
  const successCount = latestRuns.filter(
    (run) => run.status === 'completed' && run.conclusion === 'success'
  ).length;

  return {
    allCompleted: successCount === latestRuns.length,
    totalWorkflows: latestRuns.length,
    successCount,
    workflowNames,
  };
}

/**
 * Per-commit workflow-runs check (legacy semantics).
 *
 * Used when no PR exists for the branch (push to main, branch without PR)
 * or when the caller does not have branch metadata. Subject to the #699
 * stale-event bug when used for branches with open PRs — callers should
 * prefer `checkByPullRequestRollup` and only fall back here.
 */
async function checkByCommitWorkflowRuns(
  repositoryName: string,
  headSha: string
): Promise<CICompletionCheckResult | null> {
  const endpoint = `repos/${repositoryName}/actions/runs?head_sha=${headSha}`;
  const responseText = await runGhCommand(
    ['gh', 'api', '--paginate', '--slurp', endpoint],
    { repositoryName, headSha }
  );
  if (responseText === null) {
    return null;
  }

  let allWorkflowRuns: WorkflowRun[];
  try {
    const pages = JSON.parse(responseText) as WorkflowRunsResponse[];
    allWorkflowRuns = pages.flatMap((page) => page.workflow_runs ?? []);
  } catch {
    logger.warn({ repositoryName, headSha }, 'Failed to parse gh api response as JSON');
    return null;
  }

  if (allWorkflowRuns.length === 0) {
    logger.warn({ repositoryName, headSha }, 'No workflow runs found for commit');
    return null;
  }

  const latestRuns = deduplicateByLatestRun(allWorkflowRuns);
  return checkCompletion(latestRuns);
}

/**
 * Look up the open PR for a branch and evaluate its statusCheckRollup.
 *
 * Returns:
 * - `{ matched: true, result }` — PR was found and evaluated. Result reflects
 *   PR HEAD's rollup. If `result === null`, PR lookup or parsing failed
 *   (fail-open).
 * - `{ matched: false }` — no open PR for the branch. Caller should fall back
 *   to the per-commit workflow-runs path.
 *
 * When the webhook commit SHA does not match the PR's headRefOid, the event
 * is suppressed (allCompleted: false) — the rollup belongs to a different
 * commit and reporting "all passed" would be a false positive (#699).
 */
async function checkByPullRequestRollup(
  repositoryName: string,
  webhookCommitSha: string,
  branch: string
): Promise<{ matched: true; result: CICompletionCheckResult | null } | { matched: false }> {
  const args = [
    'gh', 'pr', 'list',
    '--repo', repositoryName,
    '--head', branch,
    '--state', 'open',
    '--limit', '1',
    '--json', 'number,headRefOid,statusCheckRollup',
  ];
  const responseText = await runGhCommand(args, { repositoryName, branch, webhookCommitSha });
  if (responseText === null) {
    // gh failed — fail-open
    return { matched: true, result: null };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(responseText);
  } catch {
    logger.warn({ repositoryName, branch }, 'Failed to parse gh pr list response as JSON');
    return { matched: true, result: null };
  }

  const parsed = v.safeParse(PullRequestListSchema, parsedJson);
  if (!parsed.success) {
    logger.warn(
      { repositoryName, branch, issues: parsed.issues },
      'gh pr list output did not match expected schema'
    );
    return { matched: true, result: null };
  }

  const prs = parsed.output;
  if (prs.length === 0) {
    return { matched: false };
  }

  // Branch should resolve to at most one open PR, but if multiple are
  // returned (e.g., across forks), pick the first deterministically.
  const pr = prs[0];

  if (pr.headRefOid !== webhookCommitSha) {
    logger.info(
      {
        repositoryName,
        branch,
        prNumber: pr.number,
        webhookCommitSha,
        prHeadSha: pr.headRefOid,
      },
      'CI completion suppressed: webhook commit SHA does not match PR head SHA'
    );
    return {
      matched: true,
      result: {
        allCompleted: false,
        totalWorkflows: pr.statusCheckRollup.length,
        successCount: 0,
        workflowNames: [],
      },
    };
  }

  const rollup = pr.statusCheckRollup;
  if (rollup.length === 0) {
    // PR exists with matching head, but no checks have been registered yet.
    // Treat as "cannot determine" and fail-open — the empty.every() vacuous
    // truth would otherwise emit "all passed" with zero workflows, which is
    // worse than the original per-run event.
    logger.warn(
      { repositoryName, branch, prNumber: pr.number, webhookCommitSha },
      'PR statusCheckRollup is empty; falling open'
    );
    return { matched: true, result: null };
  }

  const classifications = rollup.map(classifyRollupEntry);
  const workflowNames = rollup.map(rollupEntryName);
  const successCount = classifications.filter((status) => status === 'success').length;
  const allTerminal = classifications.every((status) => status !== 'pending');
  const allSuccess = allTerminal && classifications.every((status) => status === 'success');

  return {
    matched: true,
    result: {
      allCompleted: allSuccess,
      totalWorkflows: rollup.length,
      successCount,
      workflowNames,
    },
  };
}

export function createCICompletionChecker(): CICompletionChecker {
  return async (
    repositoryName: string,
    headSha: string,
    branch?: string
  ): Promise<CICompletionCheckResult | null> => {
    try {
      if (branch) {
        const prCheck = await checkByPullRequestRollup(repositoryName, headSha, branch);
        if (prCheck.matched) {
          return prCheck.result;
        }
        // No PR found for branch — fall through to per-commit workflow-runs path
      }
      return await checkByCommitWorkflowRuns(repositoryName, headSha);
    } catch (error) {
      logger.warn({ err: error, repositoryName, headSha, branch }, 'CI completion check failed');
      return null;
    }
  };
}
