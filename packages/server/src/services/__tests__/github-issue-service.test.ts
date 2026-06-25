import { describe, it, expect, beforeEach } from 'bun:test';
import { mockGit } from '../../__tests__/utils/mock-git-helper.js';
import type { runGh, RunGhOpts } from '../github-cli.js';
import { fetchGitHubIssue, parseIssueReference } from '../github-issue-service.js';

/**
 * Build a captured-call fake `runGh` implementation. The service-level test
 * asserts that `fetchGitHubIssue` invokes `runGh` with the expected args /
 * cwd / requestUsername / subcommand / timeoutMs. The runner contract itself
 * (argv shape, throw-on-non-zero, throw-on-timeout, stdout passthrough) is
 * covered by `github-cli.test.ts`.
 *
 * Per `.claude/rules/elevation-helpers.md` "Test-correctness DI is orthogonal
 * to strict semantics": `fetchGitHubIssue` accepts an optional
 * `runGhImpl?: typeof runGh` seam (pay-as-you-go DI), which the tests inject.
 */
type RunGhCall = { args: string[]; opts: RunGhOpts };

function makeFakeRunGh(
  responder: (call: RunGhCall) => string | Error,
): { calls: RunGhCall[]; impl: typeof runGh } {
  const calls: RunGhCall[] = [];
  const impl: typeof runGh = async (args, opts) => {
    const call: RunGhCall = { args, opts };
    calls.push(call);
    const response = responder(call);
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, impl };
}

describe('github-issue-service', () => {
  beforeEach(() => {
    mockGit.getRemoteUrl.mockReset();
    mockGit.parseOrgRepo.mockReset();
    mockGit.getRemoteUrl.mockImplementation(() => Promise.resolve('git@github.com:owner/repo.git'));
    mockGit.parseOrgRepo.mockImplementation(() => 'owner/repo');
  });

  it('parses URL references', () => {
    const result = parseIssueReference('https://github.com/owner/repo/issues/123');
    expect(result).toEqual({ org: 'owner', repo: 'repo', number: 123 });
  });

  it('parses owner/repo references', () => {
    const result = parseIssueReference('owner/repo#456');
    expect(result).toEqual({ org: 'owner', repo: 'repo', number: 456 });
  });

  it('invokes runGh with the gh api args / cwd / timeoutMs / subcommand for #123 references', async () => {
    const captured = makeFakeRunGh(
      () => '{"title":"Add docs","body":"Details","html_url":"https://github.com/owner/repo/issues/123"}',
    );

    const issue = await fetchGitHubIssue('#123', '/repo', null, { runGhImpl: captured.impl });

    expect(issue.title).toBe('Add docs');
    expect(issue.body).toBe('Details');
    expect(issue.url).toBe('https://github.com/owner/repo/issues/123');
    expect(issue.suggestedBranch).toBe('add-docs');

    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0]?.args).toEqual(['api', 'repos/owner/repo/issues/123']);
    expect(captured.calls[0]?.opts.cwd).toBe('/repo');
    expect(captured.calls[0]?.opts.requestUsername).toBeNull();
    expect(captured.calls[0]?.opts.subcommand).toBe('api');
    expect(captured.calls[0]?.opts.timeoutMs).toBe(15_000);
  });

  it('forwards a non-null requestUsername to runGh (elevation context)', async () => {
    const captured = makeFakeRunGh(
      () => '{"title":"Add docs","body":"Details","html_url":"https://github.com/owner/repo/issues/456"}',
    );

    const issue = await fetchGitHubIssue('owner/repo#456', '/repo', 'alice', {
      runGhImpl: captured.impl,
    });

    expect(issue.title).toBe('Add docs');
    expect(captured.calls[0]?.opts.requestUsername).toBe('alice');
    // owner/repo#456 hits the explicit-orgrepo branch, so the args reflect 456.
    expect(captured.calls[0]?.args).toEqual(['api', 'repos/owner/repo/issues/456']);
  });

  it('propagates runGh errors when gh fails (no swallow at this layer)', async () => {
    const { impl } = makeFakeRunGh(() => new Error('gh api failed'));

    await expect(
      fetchGitHubIssue('#123', '/repo', null, { runGhImpl: impl }),
    ).rejects.toThrow('gh api failed');
  });

  it('throws when runGh returns invalid JSON', async () => {
    const { impl } = makeFakeRunGh(() => 'not valid json');

    await expect(
      fetchGitHubIssue('#123', '/repo', null, { runGhImpl: impl }),
    ).rejects.toThrow('Failed to parse GitHub issue response');
  });

  it('throws when the response is missing expected fields', async () => {
    const { impl } = makeFakeRunGh(() => '{"body":"no title"}');

    await expect(
      fetchGitHubIssue('#123', '/repo', null, { runGhImpl: impl }),
    ).rejects.toThrow('GitHub issue response missing expected fields');
  });
});
