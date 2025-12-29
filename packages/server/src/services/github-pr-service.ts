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
