/**
 * GitHub Pull Request Service
 *
 * Provides functionality to fetch PR information for branches using the GitHub CLI (gh).
 * Follows the same pattern as github-issue-service.ts for timeout handling and error management.
 */

const DEFAULT_GH_TIMEOUT_MS = 5000;

interface PullRequestInfo {
  url: string;
}

export interface OpenPrInfo {
  number: number;
  title: string;
}

function createTimeoutPromise(timeoutMs: number): { promise: Promise<never>; cleanup: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const promise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`gh pr view timed out after ${timeoutMs}ms`));
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
 * Fetch the pull request URL for a given branch.
 *
 * @param branch - The branch name to look up
 * @param cwd - The working directory (repository path)
 * @returns The PR URL if a PR exists for the branch, null otherwise
 */
export async function fetchPullRequestUrl(branch: string, cwd: string): Promise<string | null> {
  const proc = Bun.spawn(['gh', 'pr', 'view', branch, '--json', 'url'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const { promise: timeoutPromise, cleanup } = createTimeoutPromise(DEFAULT_GH_TIMEOUT_MS);

  try {
    const exitCode = await Promise.race([proc.exited, timeoutPromise]);

    if (exitCode !== 0) {
      // Non-zero exit code typically means PR doesn't exist
      // gh pr view returns exit code 1 when no PR is found for the branch
      return null;
    }

    const stdout = await new Response(proc.stdout).text();

    let responseJson: PullRequestInfo | undefined;
    try {
      responseJson = JSON.parse(stdout.trim()) as PullRequestInfo;
    } catch {
      // Failed to parse JSON response
      return null;
    }

    if (!responseJson?.url) {
      return null;
    }

    return responseJson.url;
  } catch (error) {
    if (error instanceof Error && error.message.includes('timed out')) {
      try {
        proc.kill();
      } catch {
        // Ignore kill errors (process may have already exited)
      }
    }
    // For any error (timeout, network issues, etc.), return null
    return null;
  } finally {
    cleanup();
  }
}

/**
 * Check if a branch has any open pull requests.
 * Uses `gh pr list --head <branch>` to query GitHub.
 *
 * Fail-closed design: throws an error if the check fails (gh not installed,
 * network issues, timeout, invalid output, etc.) so that callers block the
 * operation rather than proceeding without a PR check.
 *
 * @param branch - The branch name to check
 * @param cwd - The working directory (must be inside a git repository)
 * @returns The first open PR info if found, null when no open PRs exist
 * @throws Error if the gh CLI fails, times out, or returns invalid output
 */
export async function findOpenPullRequest(
  branch: string,
  cwd: string,
): Promise<OpenPrInfo | null> {
  const proc = Bun.spawn(
    ['gh', 'pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,title', '--limit', '1'],
    { cwd, stdout: 'pipe', stderr: 'pipe' },
  );

  const { promise: timeoutPromise, cleanup } = createTimeoutPromise(DEFAULT_GH_TIMEOUT_MS);

  try {
    const exitCode = await Promise.race([proc.exited, timeoutPromise]);

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`gh pr list failed with exit code ${exitCode}: ${stderr.trim()}`);
    }

    const stdout = await new Response(proc.stdout).text();

    let prs: OpenPrInfo[];
    try {
      prs = JSON.parse(stdout.trim()) as OpenPrInfo[];
    } catch {
      throw new Error(`Failed to parse gh pr list output: ${stdout.trim()}`);
    }

    return prs.length > 0 ? prs[0] : null;
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
}
