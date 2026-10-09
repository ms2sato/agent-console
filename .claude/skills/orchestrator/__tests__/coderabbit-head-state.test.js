import { describe, it, expect } from 'bun:test';
import { getCodeRabbitHeadState } from '../coderabbit-head-state.js';

/**
 * Builds a stubbed `execImpl` that dispatches on which of the three `gh`
 * commands `getCodeRabbitHeadState` issued, mirroring the
 * `resolvePrDiffRef` test pattern in check-utils.test.js (per-command
 * switch rather than a single fixed return value).
 *
 * @param {{ pr?: string | null, reviews?: string | null, status?: string | null }} responses
 */
function makeExecImpl({ pr = '{}', reviews = '[[]]', status = '{"statuses":[]}' } = {}) {
  return (cmd) => {
    if (cmd.includes('gh pr view')) return pr;
    if (cmd.includes('/reviews')) return reviews;
    if (cmd.includes('/status')) return status;
    throw new Error(`Unexpected command in test stub: ${cmd}`);
  };
}

const HEAD = 'abc123def456';

describe('getCodeRabbitHeadState', () => {
  // (a) review with matching commit_id -> reviewed.
  it('reviewed: a review whose commit_id matches the current head', () => {
    const execImpl = makeExecImpl({
      pr: JSON.stringify({ headRefOid: HEAD, body: '' }),
      reviews: JSON.stringify([
        [{ user: { login: 'coderabbitai[bot]' }, commit_id: HEAD, submitted_at: '2026-10-01T00:00:00Z' }],
      ]),
      status: JSON.stringify({ statuses: [] }),
    });
    const result = getCodeRabbitHeadState('1', { execImpl });
    expect(result.state).toBe('reviewed');
    expect(result.headSha).toBe(HEAD);
    expect(result.matchingReviewAt).toBe('2026-10-01T00:00:00Z');
    expect(result.statusDescription).toBeNull();
    expect(result.dispositionRecorded).toBe(false);
  });

  // CodeRabbit finding (PR #1917): the reviews call must paginate. GitHub's
  // default page size is 30 reviews, so on a PR with many review rounds the
  // review matching the head can be on a later page. The stub here returns
  // two pages (matching `gh api --paginate --slurp`'s array-of-arrays
  // shape) with the matching review on page 2.
  it('reviewed: the matching review is on the second page of a paginated reviews response', () => {
    const execImpl = makeExecImpl({
      pr: JSON.stringify({ headRefOid: HEAD, body: '' }),
      reviews: JSON.stringify([
        [{ user: { login: 'coderabbitai[bot]' }, commit_id: 'old-stale-sha', submitted_at: '2026-09-01T00:00:00Z' }],
        [{ user: { login: 'coderabbitai[bot]' }, commit_id: HEAD, submitted_at: '2026-10-09T00:00:00Z' }],
      ]),
      status: JSON.stringify({ statuses: [] }),
    });
    const result = getCodeRabbitHeadState('1', { execImpl });
    expect(result.state).toBe('reviewed');
    expect(result.matchingReviewAt).toBe('2026-10-09T00:00:00Z');
  });

  // (b) no matching review but description "Review completed" -> reviewed.
  it('reviewed: no matching review, but the commit-status description reads "Review completed"', () => {
    const execImpl = makeExecImpl({
      pr: JSON.stringify({ headRefOid: HEAD, body: '' }),
      reviews: JSON.stringify([]),
      status: JSON.stringify({ statuses: [{ context: 'CodeRabbit', description: 'Review completed' }] }),
    });
    const result = getCodeRabbitHeadState('1', { execImpl });
    expect(result.state).toBe('reviewed');
    expect(result.matchingReviewAt).toBeNull();
    expect(result.statusDescription).toBe('Review completed');
  });

  // (c) stale review (commit_id != head) + description "Review skipped: ..." -> unreviewed.
  it('unreviewed: a stale review (commit_id differs from head) and a "Review skipped" status', () => {
    const execImpl = makeExecImpl({
      pr: JSON.stringify({ headRefOid: HEAD, body: '' }),
      reviews: JSON.stringify([
        { user: { login: 'coderabbitai[bot]' }, commit_id: 'old-stale-sha', submitted_at: '2026-09-01T00:00:00Z' },
      ]),
      status: JSON.stringify({ statuses: [{ context: 'CodeRabbit', description: 'Review skipped: draft pull request' }] }),
    });
    const result = getCodeRabbitHeadState('1', { execImpl });
    expect(result.state).toBe('unreviewed');
    expect(result.matchingReviewAt).toBeNull();
    expect(result.statusDescription).toBe('Review skipped: draft pull request');
  });

  // (d) the bot's login is matched by the EXACT string "coderabbitai[bot]"
  // -- not by bare equality against "coderabbitai" (the documented
  // false-empty: that login never appears verbatim, since the real bot
  // account always carries the "[bot]" suffix), and not by a prefix match
  // either (CodeRabbit review on PR #1917: `startsWith('coderabbitai')`
  // also admits a lookalike human account such as `coderabbitai-helper`,
  // letting anyone who can comment on a public PR suppress Q13). Exact
  // match against the full string satisfies both constraints at once.
  it('reviewed: the bot login "coderabbitai[bot]" is matched by exact string, not bare "coderabbitai"', () => {
    const execImpl = makeExecImpl({
      pr: JSON.stringify({ headRefOid: HEAD, body: '' }),
      reviews: JSON.stringify([
        { user: { login: 'coderabbitai[bot]' }, commit_id: HEAD, submitted_at: '2026-10-05T00:00:00Z' },
      ]),
      status: JSON.stringify({ statuses: [] }),
    });
    const result = getCodeRabbitHeadState('1', { execImpl });
    // An equality compare against bare "coderabbitai" would filter this
    // review out entirely (no "[bot]" suffix), leaving no matching review
    // and no "Review completed" status -- i.e. 'unreviewed'. The exact
    // "coderabbitai[bot]" string must be matched.
    expect(result.state).toBe('reviewed');
    expect(result.matchingReviewAt).toBe('2026-10-05T00:00:00Z');
  });

  // Negative case for the same finding: a lookalike login that merely
  // SHARES A PREFIX with the real bot login must NOT be treated as a
  // CodeRabbit review. A prefix-based match (`startsWith('coderabbitai')`)
  // would wrongly admit this and let a regular GitHub user's own PR
  // comment suppress Q13 on a genuinely unreviewed head.
  it('unreviewed: a lookalike login "coderabbitai-helper" (shares a prefix, not the exact bot login) is not treated as a CodeRabbit review', () => {
    const execImpl = makeExecImpl({
      pr: JSON.stringify({ headRefOid: HEAD, body: '' }),
      reviews: JSON.stringify([
        { user: { login: 'coderabbitai-helper' }, commit_id: HEAD, submitted_at: '2026-10-05T00:00:00Z' },
      ]),
      status: JSON.stringify({ statuses: [] }),
    });
    const result = getCodeRabbitHeadState('1', { execImpl });
    expect(result.state).toBe('unreviewed');
    expect(result.matchingReviewAt).toBeNull();
  });

  // Negative case: bare "coderabbitai" (no "[bot]" suffix) must also not
  // match -- the real bot account never has this exact login, so admitting
  // it would be just as wrong as admitting a lookalike.
  it('unreviewed: the bare login "coderabbitai" (no "[bot]" suffix) is not treated as a CodeRabbit review', () => {
    const execImpl = makeExecImpl({
      pr: JSON.stringify({ headRefOid: HEAD, body: '' }),
      reviews: JSON.stringify([
        { user: { login: 'coderabbitai' }, commit_id: HEAD, submitted_at: '2026-10-05T00:00:00Z' },
      ]),
      status: JSON.stringify({ statuses: [] }),
    });
    const result = getCodeRabbitHeadState('1', { execImpl });
    expect(result.state).toBe('unreviewed');
    expect(result.matchingReviewAt).toBeNull();
  });

  // (e) empty reviews array + empty status -> unreviewed, dispositionRecorded false.
  it('unreviewed: empty reviews array and no CodeRabbit status entry', () => {
    const execImpl = makeExecImpl({
      pr: JSON.stringify({ headRefOid: HEAD, body: 'Just an ordinary PR description.' }),
      reviews: JSON.stringify([]),
      status: JSON.stringify({ statuses: [] }),
    });
    const result = getCodeRabbitHeadState('1', { execImpl });
    expect(result.state).toBe('unreviewed');
    expect(result.statusDescription).toBeNull();
    expect(result.matchingReviewAt).toBeNull();
    expect(result.dispositionRecorded).toBe(false);
  });

  // (f) any call returning an empty string -> retrieval-failed, never
  // silently 'reviewed' or 'unreviewed'. Covers all three call positions.
  it('retrieval-failed: the gh pr view call returns an empty string', () => {
    const execImpl = makeExecImpl({ pr: '' });
    const result = getCodeRabbitHeadState('1', { execImpl });
    expect(result.state).toBe('retrieval-failed');
    expect(result.headSha).toBeNull();
  });

  it('retrieval-failed: the reviews call returns an empty string', () => {
    const execImpl = makeExecImpl({
      pr: JSON.stringify({ headRefOid: HEAD, body: '' }),
      reviews: '',
    });
    const result = getCodeRabbitHeadState('1', { execImpl });
    expect(result.state).toBe('retrieval-failed');
    expect(result.headSha).toBe(HEAD);
  });

  it('retrieval-failed: the commit-status call returns an empty string', () => {
    const execImpl = makeExecImpl({
      pr: JSON.stringify({ headRefOid: HEAD, body: '' }),
      reviews: JSON.stringify([]),
      status: '',
    });
    const result = getCodeRabbitHeadState('1', { execImpl });
    expect(result.state).toBe('retrieval-failed');
    expect(result.headSha).toBe(HEAD);
  });

  it('retrieval-failed: a call returns non-JSON garbage rather than empty', () => {
    const execImpl = makeExecImpl({
      pr: JSON.stringify({ headRefOid: HEAD, body: '' }),
      reviews: 'not json at all',
    });
    const result = getCodeRabbitHeadState('1', { execImpl });
    expect(result.state).toBe('retrieval-failed');
  });

  // (g) body containing "## CodeRabbit disposition" -> dispositionRecorded true.
  it('dispositionRecorded is true when the PR body carries the "CodeRabbit disposition" heading', () => {
    const execImpl = makeExecImpl({
      pr: JSON.stringify({
        headRefOid: HEAD,
        body: 'Some PR description.\n\n## CodeRabbit disposition\n\nRecorded here: https://example.com/comment/1\n',
      }),
      reviews: JSON.stringify([]),
      status: JSON.stringify({ statuses: [] }),
    });
    const result = getCodeRabbitHeadState('1', { execImpl });
    expect(result.dispositionRecorded).toBe(true);
    // Disposition detection is independent of review state -- this PR is
    // still 'unreviewed' even though a disposition was recorded.
    expect(result.state).toBe('unreviewed');
  });

  it('dispositionRecorded is false when the PR body has no disposition marker', () => {
    const execImpl = makeExecImpl({
      pr: JSON.stringify({ headRefOid: HEAD, body: 'Nothing relevant here.' }),
    });
    const result = getCodeRabbitHeadState('1', { execImpl });
    expect(result.dispositionRecorded).toBe(false);
  });

  // CodeRabbit finding (PR #1917): a prose-only mention of the same words,
  // with no actual heading, must NOT count as a recorded disposition --
  // otherwise a sentence like "No CodeRabbit disposition has been
  // recorded" would itself satisfy the check it is describing the absence
  // of.
  it('dispositionRecorded is false for a prose-only mention with no heading', () => {
    const execImpl = makeExecImpl({
      pr: JSON.stringify({
        headRefOid: HEAD,
        body: 'No CodeRabbit disposition has been recorded for this PR yet.',
      }),
    });
    const result = getCodeRabbitHeadState('1', { execImpl });
    expect(result.dispositionRecorded).toBe(false);
  });

  it('dispositionRecorded is still reported true even when the gh pr view call itself succeeds but a later call fails', () => {
    const execImpl = makeExecImpl({
      pr: JSON.stringify({ headRefOid: HEAD, body: '## CodeRabbit disposition\n\nfoo' }),
      reviews: '',
    });
    const result = getCodeRabbitHeadState('1', { execImpl });
    expect(result.state).toBe('retrieval-failed');
    expect(result.dispositionRecorded).toBe(true);
  });

  it('retrieval-failed when the PR has no headRefOid at all', () => {
    const execImpl = makeExecImpl({ pr: JSON.stringify({ body: '' }) });
    const result = getCodeRabbitHeadState('1', { execImpl });
    expect(result.state).toBe('retrieval-failed');
    expect(result.headSha).toBeNull();
  });
});
