/**
 * GitHub Pull Request Service
 *
 * Provides functionality to fetch PR information for branches using the GitHub CLI (gh).
 *
 * Issue #885: gh invocations are routed through the `runGh` thin runner
 * (`services/github-cli.ts`) which composes `runAsUser` per
 * `.claude/rules/elevation-helpers.md` so multi-user mode
 * (AUTH_MODE=multi-user) runs `gh pr view` / `gh pr list` as the requesting
 * OS user (with that user's per-user gh auth token) instead of the
 * server-process user (agentconsole). In single-user mode (or when
 * `requestUsername` equals the server-process user), the underlying
 * `runAsUser` bypasses sudo and spawns directly, preserving prior behavior.
 * Mirrors the pattern established by PR #842 (description gen) and PR #859
 * (session-metadata suggester).
 */
import { runGh } from './github-cli.js';

interface PullRequestInfo {
  url: string;
}

export interface OpenPrInfo {
  number: number;
  title: string;
}

/**
 * Test-seam DI per `.claude/rules/elevation-helpers.md` "Test-correctness DI
 * is orthogonal to strict semantics". Production callers ignore this opt;
 * tests inject a captured-call fake `runGh` to assert helper-level call shape
 * (args / cwd / requestUsername / subcommand) without spawning real `sh -c`.
 */
interface RunGhSeam {
  runGhImpl?: typeof runGh;
}

function isOpenPrInfo(value: unknown): value is OpenPrInfo {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.number === 'number' && typeof record.title === 'string';
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
 *
 * Note: this function's null-on-error semantics are a CALLER concern, not a
 * runner concern. `runGh` itself is strict (throws on non-zero / timeout per
 * `.claude/rules/elevation-helpers.md`); the try/catch below maps every
 * failure path — spawn failure, timeout, non-zero exit (gh returns 1 when no
 * PR exists for the branch), JSON parse failure, missing url field — to null.
 */
export async function fetchPullRequestUrl(
  branch: string,
  cwd: string,
  requestUsername: string | null,
  seam: RunGhSeam = {},
): Promise<string | null> {
  const runGhFn = seam.runGhImpl ?? runGh;
  try {
    const stdout = await runGhFn(
      ['pr', 'view', branch, '--json', 'url'],
      { cwd, requestUsername, subcommand: 'pr view' },
    );
    const parsed = JSON.parse(stdout.trim()) as PullRequestInfo;
    return parsed?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if a branch has any open pull requests.
 * Uses `gh pr list --head <branch>` to query GitHub.
 *
 * Fail-closed design: throws an error if the check fails (gh not installed,
 * network issues, timeout, invalid output, etc.) so that callers block the
 * operation rather than proceeding without a PR check. The throw originates
 * from `runGh` for spawn / non-zero / timeout paths; JSON validation throws
 * here.
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
  seam: RunGhSeam = {},
): Promise<OpenPrInfo | null> {
  const runGhFn = seam.runGhImpl ?? runGh;
  const stdout = await runGhFn(
    ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,title', '--limit', '1'],
    { cwd, requestUsername, subcommand: 'pr list' },
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`Failed to parse gh pr list output: ${stdout.trim()}`);
  }

  if (!Array.isArray(parsed) || !parsed.every(isOpenPrInfo)) {
    throw new Error(`Unexpected gh pr list output shape: ${stdout.trim()}`);
  }

  return parsed.length > 0 ? parsed[0] : null;
}
