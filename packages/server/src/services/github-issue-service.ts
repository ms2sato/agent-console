import type { GitHubIssueSummary } from '@agent-console/shared';
import { getRemoteUrl, parseOrgRepo } from '../lib/git.js';

const DEFAULT_GH_TIMEOUT_MS = 15000;

interface ParsedIssueReference {
  org: string;
  repo: string;
  number: number;
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

async function runGhApi(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(['gh', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const { promise: timeoutPromise, cleanup } = createTimeoutPromise(DEFAULT_GH_TIMEOUT_MS);

  try {
    const exitCode = await Promise.race([proc.exited, timeoutPromise]);
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(stderr.trim() || 'gh api request failed');
    }

    return new Response(proc.stdout).text();
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

export async function fetchGitHubIssue(reference: string, repoPath: string): Promise<GitHubIssueSummary> {
  const defaultOrgRepo = reference.trim().startsWith('#')
    ? await resolveDefaultOrgRepo(repoPath)
    : undefined;
  const { org, repo, number } = parseIssueReference(reference, defaultOrgRepo);

  if (!Number.isFinite(number) || number <= 0) {
    throw new Error('Issue number must be a positive integer');
  }

  const responseText = await runGhApi(['api', `repos/${org}/${repo}/issues/${number}`], repoPath);

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
