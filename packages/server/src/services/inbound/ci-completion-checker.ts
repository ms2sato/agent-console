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
 * Check whether all GitHub Actions workflows for a given commit SHA
 * have completed successfully.
 *
 * Returns null if the check cannot be performed (gh not installed,
 * API error, timeout, etc). Callers should treat null as "pass through"
 * (fail-open policy).
 */
export type CICompletionChecker = (
  repositoryName: string,
  headSha: string
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

export function createCICompletionChecker(): CICompletionChecker {
  return async (repositoryName: string, headSha: string): Promise<CICompletionCheckResult | null> => {
    try {
      const endpoint = `repos/${repositoryName}/actions/runs?head_sha=${headSha}`;
      const proc = Bun.spawn(['gh', 'api', '--paginate', '--slurp', endpoint], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const { promise: timeoutPromise, cleanup } = createTimeoutPromise(CI_CHECK_TIMEOUT_MS);

      let responseText: string;
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
            { exitCode: result.exitCode, stderr: result.stderr.trim(), repositoryName, headSha },
            'gh api returned non-zero exit code'
          );
          return null;
        }
        responseText = result.stdout;
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
    } catch (error) {
      logger.warn({ err: error, repositoryName, headSha }, 'CI completion check failed');
      return null;
    }
  };
}
