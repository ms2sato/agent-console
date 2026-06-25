import { describe, it, expect, beforeEach } from 'bun:test';
import type { runGh, RunGhOpts } from '../github-cli.js';
import { fetchPullRequestUrl, findOpenPullRequest } from '../github-pr-service.js';

/**
 * Build a captured-call fake `runGh` implementation. The service-level tests
 * assert that `fetchPullRequestUrl` / `findOpenPullRequest` invoke `runGh`
 * with the expected args / cwd / requestUsername / subcommand. The runner
 * contract itself (argv shape, throw-on-non-zero, throw-on-timeout, stdout
 * passthrough) is covered by `github-cli.test.ts`.
 *
 * Per `.claude/rules/elevation-helpers.md` "Test-correctness DI is orthogonal
 * to strict semantics": each service function accepts an optional
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

// =====================================================================
// fetchPullRequestUrl
// =====================================================================

describe('github-pr-service / fetchPullRequestUrl', () => {
  let captured: { calls: RunGhCall[]; impl: typeof runGh };

  beforeEach(() => {
    captured = makeFakeRunGh(() => '{"url":"https://github.com/owner/repo/pull/42"}');
  });

  it('invokes runGh with the gh pr view args / cwd / requestUsername / subcommand', async () => {
    const prUrl = await fetchPullRequestUrl(
      'feat/my-feature',
      '/repo',
      null,
      { runGhImpl: captured.impl },
    );

    expect(prUrl).toBe('https://github.com/owner/repo/pull/42');
    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0]?.args).toEqual([
      'pr', 'view', 'feat/my-feature', '--json', 'url',
    ]);
    expect(captured.calls[0]?.opts.cwd).toBe('/repo');
    expect(captured.calls[0]?.opts.requestUsername).toBeNull();
    expect(captured.calls[0]?.opts.subcommand).toBe('pr view');
  });

  it('forwards a non-null requestUsername to runGh (elevation context)', async () => {
    await fetchPullRequestUrl(
      'feat/my-feature',
      '/repo',
      'alice',
      { runGhImpl: captured.impl },
    );

    expect(captured.calls[0]?.opts.requestUsername).toBe('alice');
  });

  it('returns null when runGh throws (e.g. gh exit 1 for no PR found)', async () => {
    const { impl } = makeFakeRunGh(() => new Error('gh pr view failed'));

    const prUrl = await fetchPullRequestUrl(
      'non-existent-branch',
      '/repo',
      null,
      { runGhImpl: impl },
    );

    expect(prUrl).toBeNull();
  });

  it('returns null when runGh returns invalid JSON', async () => {
    const { impl } = makeFakeRunGh(() => 'not valid json');

    const prUrl = await fetchPullRequestUrl(
      'some-branch',
      '/repo',
      null,
      { runGhImpl: impl },
    );

    expect(prUrl).toBeNull();
  });

  it('returns null when response is missing the url field', async () => {
    const { impl } = makeFakeRunGh(() => '{}');

    const prUrl = await fetchPullRequestUrl(
      'some-branch',
      '/repo',
      null,
      { runGhImpl: impl },
    );

    expect(prUrl).toBeNull();
  });

  it('returns null when runGh throws on timeout (caller swallows runner errors)', async () => {
    const { impl } = makeFakeRunGh(() => new Error('gh pr view timed out after 5000ms'));

    const prUrl = await fetchPullRequestUrl(
      'some-branch',
      '/repo',
      null,
      { runGhImpl: impl },
    );

    expect(prUrl).toBeNull();
  });
});

// =====================================================================
// findOpenPullRequest
// =====================================================================

describe('github-pr-service / findOpenPullRequest', () => {
  let captured: { calls: RunGhCall[]; impl: typeof runGh };

  beforeEach(() => {
    captured = makeFakeRunGh(() => '[{"number":42,"title":"Add feature X"}]');
  });

  it('invokes runGh with the gh pr list args / cwd / requestUsername / subcommand', async () => {
    const result = await findOpenPullRequest(
      'feat/my-feature',
      '/repo',
      null,
      { runGhImpl: captured.impl },
    );

    expect(result).toEqual({ number: 42, title: 'Add feature X' });
    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0]?.args).toEqual([
      'pr', 'list',
      '--head', 'feat/my-feature',
      '--state', 'open',
      '--json', 'number,title',
      '--limit', '1',
    ]);
    expect(captured.calls[0]?.opts.cwd).toBe('/repo');
    expect(captured.calls[0]?.opts.requestUsername).toBeNull();
    expect(captured.calls[0]?.opts.subcommand).toBe('pr list');
  });

  it('forwards a non-null requestUsername to runGh (elevation context)', async () => {
    await findOpenPullRequest(
      'feat/my-feature',
      '/repo',
      'alice',
      { runGhImpl: captured.impl },
    );

    expect(captured.calls[0]?.opts.requestUsername).toBe('alice');
  });

  it('returns null when no open PRs exist', async () => {
    const { impl } = makeFakeRunGh(() => '[]');

    const result = await findOpenPullRequest('feat/no-pr', '/repo', null, { runGhImpl: impl });

    expect(result).toBeNull();
  });

  it('propagates runGh errors (fail-closed on gh failure)', async () => {
    const { impl } = makeFakeRunGh(() => new Error('gh: command failed'));

    await expect(
      findOpenPullRequest('some-branch', '/repo', null, { runGhImpl: impl }),
    ).rejects.toThrow('gh: command failed');
  });

  it('throws when JSON parsing fails (fail-closed)', async () => {
    const { impl } = makeFakeRunGh(() => 'not valid json');

    await expect(
      findOpenPullRequest('some-branch', '/repo', null, { runGhImpl: impl }),
    ).rejects.toThrow('Failed to parse gh pr list output');
  });

  it('throws when output has unexpected shape (fail-closed)', async () => {
    const { impl } = makeFakeRunGh(() => '[{"unexpected":"fields"}]');

    await expect(
      findOpenPullRequest('some-branch', '/repo', null, { runGhImpl: impl }),
    ).rejects.toThrow('Unexpected gh pr list output shape');
  });
});
