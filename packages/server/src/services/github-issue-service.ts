/**
 * GitHub Issue Service
 *
 * Provides functionality to fetch GitHub issue details via the GitHub CLI
 * (`gh api`). Invocations are routed through the `runGh` thin runner (which
 * composes `runAsUser` per `.claude/rules/elevation-helpers.md`) so multi-user
 * mode (AUTH_MODE=multi-user) runs `gh api` as the requesting OS user (with
 * that user's per-user gh auth token) instead of the server-process user.
 */
import type { GitHubIssueSummary } from '@agent-console/shared';
import { getRemoteUrl, parseOrgRepo } from '../lib/git.js';
import { runGh } from './github-cli.js';

const GH_API_TIMEOUT_MS = 15_000;

interface ParsedIssueReference {
  org: string;
  repo: string;
  number: number;
}

function sanitizeBranchSuggestion(title: string, fallbackNumber: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/(^-+|-+$)/g, '');

  return slug || `issue-${fallbackNumber}`;
}

export function parseIssueReference(reference: string, defaultOrgRepo?: string): ParsedIssueReference {
  const trimmed = reference.trim();
  if (!trimmed) {
    throw new Error('Issue reference is required');
  }

  const urlMatch = trimmed.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i);
  if (urlMatch) {
    return { org: urlMatch[1], repo: urlMatch[2], number: Number(urlMatch[3]) };
  }

  const fullMatch = trimmed.match(/^([^/]+)\/([^/]+)#(\d+)$/);
  if (fullMatch) {
    return { org: fullMatch[1], repo: fullMatch[2], number: Number(fullMatch[3]) };
  }

  const shortMatch = trimmed.match(/^#(\d+)$/);
  if (shortMatch) {
    if (!defaultOrgRepo) {
      throw new Error('Repository reference is required for #123 format');
    }
    const [org, repo] = defaultOrgRepo.split('/');
    if (!org || !repo) {
      throw new Error('Failed to parse GitHub repository from remote');
    }
    return { org, repo, number: Number(shortMatch[1]) };
  }

  throw new Error('Invalid GitHub issue reference');
}

async function resolveDefaultOrgRepo(repoPath: string): Promise<string> {
  // getRemoteUrl is a pure path-anchored parse of `git remote get-url origin`
  // and does not require elevation (server user can read git config in the
  // worktree directory); this call site intentionally stays at the default
  // (no elevation).
  const remoteUrl = await getRemoteUrl(repoPath);
  if (!remoteUrl) {
    throw new Error('Repository does not have a git remote');
  }
  if (!remoteUrl.includes('github.com')) {
    throw new Error('Repository remote is not GitHub');
  }

  const orgRepo = parseOrgRepo(remoteUrl);
  if (!orgRepo) {
    throw new Error('Failed to parse GitHub repository from remote');
  }

  return orgRepo;
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

export async function fetchGitHubIssue(
  reference: string,
  repoPath: string,
  requestUsername: string | null,
  seam: RunGhSeam = {},
): Promise<GitHubIssueSummary> {
  const runGhFn = seam.runGhImpl ?? runGh;
  const defaultOrgRepo = reference.trim().startsWith('#')
    ? await resolveDefaultOrgRepo(repoPath)
    : undefined;
  const { org, repo, number } = parseIssueReference(reference, defaultOrgRepo);

  if (!Number.isFinite(number) || number <= 0) {
    throw new Error('Issue number must be a positive integer');
  }

  const responseText = await runGhFn(
    ['api', `repos/${org}/${repo}/issues/${number}`],
    { cwd: repoPath, requestUsername, timeoutMs: GH_API_TIMEOUT_MS, subcommand: 'api' },
  );

  let responseJson: { title?: string; body?: string | null; html_url?: string } | undefined;
  try {
    responseJson = JSON.parse(responseText) as { title?: string; body?: string | null; html_url?: string };
  } catch {
    throw new Error('Failed to parse GitHub issue response');
  }

  if (!responseJson?.title || !responseJson?.html_url) {
    throw new Error('GitHub issue response missing expected fields');
  }

  return {
    org,
    repo,
    number,
    title: responseJson.title,
    body: responseJson.body ?? '',
    url: responseJson.html_url,
    suggestedBranch: sanitizeBranchSuggestion(responseJson.title, number),
  };
}
