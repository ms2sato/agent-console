/**
 * GitHub Pull Request Service
 *
 * Provides functionality to fetch PR information for branches using the GitHub CLI (gh).
 *
 * Issue #885: gh invocations are routed through the `runAsUser`
 * privilege-elevation helper so multi-user mode (AUTH_MODE=multi-user) runs
 * `gh pr view` / `gh pr list` as the requesting OS user (with that user's
 * per-user gh auth token) instead of the server-process user (agentconsole).
 * In single-user mode (or when `requestUsername` equals the server-process
 * user), `runAsUser` bypasses sudo and spawns directly, preserving prior
 * behavior. Mirrors the pattern established by PR #842 (description gen) and
 * PR #859 (session-metadata suggester).
 */
import { runAsUser, shellEscape } from './privilege-elevation.js';

const DEFAULT_GH_TIMEOUT_MS = 5000;

interface PullRequestInfo {
  url: string;
}

export interface OpenPrInfo {
  number: number;
  title: string;
}

function isOpenPrInfo(value: unknown): value is OpenPrInfo {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.number === 'number' && typeof record.title === 'string';
}

/**
 * Build a shell command string for `gh` with the given args. Each argument is
 * shell-escaped (the literal `gh` and flags are escape-safe characters, but
 * escaping them is harmless; branch names and other free-form args MUST be
 * escaped to prevent shell injection).
 */
function buildGhCommand(args: string[]): string {
  return ['gh', ...args].map(shellEscape).join(' ');
}

/**
 * Fetch the pull request URL for a given branch.
 *
 * @param branch - The branch name to look up
 * @param cwd - The working directory (repository path)
 * @param requestUsername - The OS username that requested the lookup. In
 *   multi-user mode this is threaded down so `gh` runs with the requesting
 *   user's per-user gh auth token via the `runAsUser` privilege-elevation
 *   helper. Pass `null` when no elevation is needed (single-user mode or
 *   internal callers).
 * @returns The PR URL if a PR exists for the branch, null otherwise
 */
export async function fetchPullRequestUrl(
  branch: string,
  cwd: string,
  requestUsername: string | null,
): Promise<string | null> {
  let result;
  try {
    result = await runAsUser({
      username: requestUsername,
      command: buildGhCommand(['pr', 'view', branch, '--json', 'url']),
      cwd,
      timeoutMs: DEFAULT_GH_TIMEOUT_MS,
    });
  } catch {
    // Spawn failure (e.g., sudo missing). Match the original error semantics
    // -- any error path returns null for fetchPullRequestUrl.
    return null;
  }

  if (result.timedOut) {
    // Original behavior: timeout falls through to the null return.
    return null;
  }

  if (result.exitCode !== 0) {
    // Non-zero exit code typically means PR doesn't exist
    // gh pr view returns exit code 1 when no PR is found for the branch
    return null;
  }

  let responseJson: PullRequestInfo | undefined;
  try {
    responseJson = JSON.parse(result.stdout.trim()) as PullRequestInfo;
  } catch {
    // Failed to parse JSON response
    return null;
  }

  if (!responseJson?.url) {
    return null;
  }

  return responseJson.url;
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
 * @param requestUsername - See {@link fetchPullRequestUrl}.
 * @returns The first open PR info if found, null when no open PRs exist
 * @throws Error if the gh CLI fails, times out, or returns invalid output
 */
export async function findOpenPullRequest(
  branch: string,
  cwd: string,
  requestUsername: string | null,
): Promise<OpenPrInfo | null> {
  const result = await runAsUser({
    username: requestUsername,
    command: buildGhCommand([
      'pr', 'list',
      '--head', branch,
      '--state', 'open',
      '--json', 'number,title',
      '--limit', '1',
    ]),
    cwd,
    timeoutMs: DEFAULT_GH_TIMEOUT_MS,
  });

  if (result.timedOut) {
    throw new Error(`gh pr list timed out after ${DEFAULT_GH_TIMEOUT_MS}ms`);
  }

  if (result.exitCode !== 0) {
    throw new Error(
      `gh pr list failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`Failed to parse gh pr list output: ${result.stdout.trim()}`);
  }

  if (!Array.isArray(parsed) || !parsed.every(isOpenPrInfo)) {
    throw new Error(`Unexpected gh pr list output shape: ${result.stdout.trim()}`);
  }

  return parsed.length > 0 ? parsed[0] : null;
}
