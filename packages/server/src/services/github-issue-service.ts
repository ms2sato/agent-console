/**
 * GitHub Issue Service
 *
 * Provides functionality to fetch GitHub issue details via the GitHub CLI
 * (`gh api`). Issue #885: gh invocations are routed through the `runAsUser`
 * privilege-elevation helper so multi-user mode (AUTH_MODE=multi-user) runs
 * `gh api` as the requesting OS user (with that user's per-user gh auth
 * token) instead of the server-process user. Mirrors PR #842 / PR #859.
 */
import type { GitHubIssueSummary } from '@agent-console/shared';
import { getRemoteUrl, parseOrgRepo } from '../lib/git.js';
import { runAsUser, shellEscape } from './privilege-elevation.js';

const DEFAULT_GH_TIMEOUT_MS = 15000;

interface ParsedIssueReference {
  org: string;
  repo: string;
  number: number;
}

async function runGhApi(
  args: string[],
  cwd: string | undefined,
  requestUsername: string | null,
): Promise<string> {
  const command = ['gh', ...args].map(shellEscape).join(' ');
  const result = await runAsUser({
    username: requestUsername,
    command,
    cwd,
    timeoutMs: DEFAULT_GH_TIMEOUT_MS,
  });

  if (result.timedOut) {
    throw new Error(`gh api timed out after ${DEFAULT_GH_TIMEOUT_MS}ms`);
  }

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || 'gh api request failed');
  }

  return result.stdout;
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
  // worktree directory). When PR #881 added the `requestUser` parameter to
  // git helpers it left this call site at the default (no elevation), which
  // matches the historical behavior; preserve that here.
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

export async function fetchGitHubIssue(
  reference: string,
  repoPath: string,
  requestUsername: string | null,
): Promise<GitHubIssueSummary> {
  const defaultOrgRepo = reference.trim().startsWith('#')
    ? await resolveDefaultOrgRepo(repoPath)
    : undefined;
  const { org, repo, number } = parseIssueReference(reference, defaultOrgRepo);

  if (!Number.isFinite(number) || number <= 0) {
    throw new Error('Issue number must be a positive integer');
  }

  const responseText = await runGhApi(
    ['api', `repos/${org}/${repo}/issues/${number}`],
    repoPath,
    requestUsername,
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
