import { describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { Repository, Session, InboundSystemEvent } from '@agent-console/shared';
import { GitHubServiceParser } from '../inbound/github-service-parser.js';
import { resolveTargets } from '../inbound/resolve-targets.js';
import { buildWorktreeSession, buildPersistedRepository } from '../../__tests__/utils/build-test-data.js';

describe('GitHubServiceParser', () => {
  const parser = new GitHubServiceParser('secret-token');

  it('authenticates webhook signatures', async () => {
    const secret = 'secret-token';
    const sigParser = new GitHubServiceParser(secret);
    const payload = JSON.stringify({ hello: 'world' });
    const signature = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    const headers = new Headers({ 'x-hub-signature-256': signature });

    const authenticated = await sigParser.authenticate(payload, headers);
    expect(authenticated).toBe(true);
  });

  it('rejects invalid webhook signatures', async () => {
    const payload = JSON.stringify({ hello: 'world' });
    const headers = new Headers({ 'x-hub-signature-256': 'sha256=bad' });

    const authenticated = await parser.authenticate(payload, headers);
    expect(authenticated).toBe(false);
  });

  it('parses workflow_run success events', async () => {
    const payload = JSON.stringify({
      action: 'completed',
      workflow_run: {
        conclusion: 'success',
        name: 'CI',
        html_url: 'https://example.com/run/1',
        head_branch: 'main',
      },
      repository: { full_name: 'owner/repo' },
    });
    const headers = new Headers({ 'x-github-event': 'workflow_run' });

    const event = await parser.parse(payload, headers);
    expect(event?.type).toBe('ci:completed');
    expect(event?.metadata.repositoryName).toBe('owner/repo');
  });

  it('extracts head_sha into metadata.commitSha for workflow_run events', async () => {
    const payload = JSON.stringify({
      action: 'completed',
      workflow_run: {
        conclusion: 'failure',
        name: 'Tests',
        html_url: 'https://example.com/run/2',
        head_branch: 'feature',
        head_sha: 'abc123def456',
        updated_at: '2024-06-01T12:00:00Z',
      },
      repository: { full_name: 'owner/repo' },
    });
    const headers = new Headers({ 'x-github-event': 'workflow_run' });

    const event = await parser.parse(payload, headers);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('ci:failed');
    expect(event!.metadata.commitSha).toBe('abc123def456');
    expect(event!.metadata.branch).toBe('feature');
  });

  it('leaves metadata.commitSha undefined when head_sha is absent', async () => {
    const payload = JSON.stringify({
      action: 'completed',
      workflow_run: {
        conclusion: 'success',
        name: 'Build',
        html_url: 'https://example.com/run/3',
        head_branch: 'main',
      },
      repository: { full_name: 'owner/repo' },
    });
    const headers = new Headers({ 'x-github-event': 'workflow_run' });

    const event = await parser.parse(payload, headers);
    expect(event).not.toBeNull();
    expect(event!.metadata.commitSha).toBeUndefined();
  });

  it('parses issue closed events', async () => {
    const payload = JSON.stringify({
      action: 'closed',
      issue: {
        number: 42,
        title: 'Fix bug',
        html_url: 'https://example.com/issues/42',
      },
      repository: { full_name: 'owner/repo' },
    });
    const headers = new Headers({ 'x-github-event': 'issues' });

    const event = await parser.parse(payload, headers);
    expect(event?.type).toBe('issue:closed');
    expect(event?.summary).toContain('#42');
  });

  it('parses merged pull request events', async () => {
    const payload = JSON.stringify({
      action: 'closed',
      pull_request: {
        merged: true,
        number: 7,
        title: 'Ship feature',
        html_url: 'https://example.com/pull/7',
        head: { ref: 'feature-branch' },
      },
      repository: { full_name: 'owner/repo' },
    });
    const headers = new Headers({ 'x-github-event': 'pull_request' });

    const event = await parser.parse(payload, headers);
    expect(event?.type).toBe('pr:merged');
    expect(event?.metadata.branch).toBe('feature-branch');
  });

  it('returns null for non-completed workflow_run actions', async () => {
    const payload = JSON.stringify({
      action: 'in_progress',
      workflow_run: { conclusion: null, name: 'CI', head_branch: 'main' },
      repository: { full_name: 'owner/repo' },
    });
    const headers = new Headers({ 'x-github-event': 'workflow_run' });
    const event = await parser.parse(payload, headers);
    expect(event).toBeNull();
  });

  it('returns null for non-closed issue events', async () => {
    const payload = JSON.stringify({
      action: 'reopened',
      issue: { number: 1, title: 'Some issue' },
      repository: { full_name: 'owner/repo' },
    });
    const headers = new Headers({ 'x-github-event': 'issues' });
    const event = await parser.parse(payload, headers);
    expect(event).toBeNull();
  });

  it('returns null for closed but non-merged pull requests', async () => {
    const payload = JSON.stringify({
      action: 'closed',
      pull_request: {
        merged: false,
        number: 10,
        title: 'Abandoned PR',
        head: { ref: 'feature' },
      },
      repository: { full_name: 'owner/repo' },
    });
    const headers = new Headers({ 'x-github-event': 'pull_request' });
    const event = await parser.parse(payload, headers);
    expect(event).toBeNull();
  });

  describe('pull_request_review_comment', () => {
    const reviewCommentHeaders = new Headers({ 'x-github-event': 'pull_request_review_comment' });

    function createReviewCommentPayload(overrides: {
      action?: string;
      comment?: Record<string, unknown>;
      pull_request?: Record<string, unknown>;
      repository?: Record<string, unknown>;
    } = {}): string {
      return JSON.stringify({
        action: overrides.action ?? 'created',
        comment: {
          body: 'Please fix this variable name',
          path: 'src/index.ts',
          line: 42,
          html_url: 'https://github.com/owner/repo/pull/7#discussion_r123',
          created_at: '2024-01-01T00:00:00Z',
          user: { login: 'reviewer' },
          ...overrides.comment,
        },
        pull_request: {
          number: 7,
          head: { ref: 'feature-branch' },
          ...overrides.pull_request,
        },
        repository: {
          full_name: 'owner/repo',
          ...overrides.repository,
        },
      });
    }

    it('parses created events', async () => {
      const payload = createReviewCommentPayload();

      const event = await parser.parse(payload, reviewCommentHeaders);
      expect(event?.type).toBe('pr:review_comment');
      expect(event?.source).toBe('github');
      expect(event?.timestamp).toBe('2024-01-01T00:00:00Z');
      expect(event?.metadata.repositoryName).toBe('owner/repo');
      expect(event?.metadata.branch).toBe('feature-branch');
      expect(event?.metadata.url).toBe('https://github.com/owner/repo/pull/7#discussion_r123');
      expect(event?.summary).toContain('#7');
      expect(event?.summary).toContain('src/index.ts:42');
      expect(event?.summary).toContain('Please fix this variable name');
      expect(event?.summary).toContain('by reviewer');
    });

    it('ignores non-created events', async () => {
      const payload = createReviewCommentPayload({ action: 'edited' });

      const event = await parser.parse(payload, reviewCommentHeaders);
      expect(event).toBeNull();
    });

    it('parses without path', async () => {
      const payload = createReviewCommentPayload({
        comment: { body: 'General comment', path: undefined, line: undefined },
      });

      const event = await parser.parse(payload, reviewCommentHeaders);
      expect(event).not.toBeNull();
      expect(event!.summary).not.toContain('(');
      expect(event!.summary).toContain('General comment');
    });

    it('falls back to original_line when line is absent', async () => {
      const payload = createReviewCommentPayload({
        comment: { path: 'src/utils.ts', line: undefined, original_line: 99, body: 'Outdated line comment' },
        pull_request: { number: 5, head: { ref: 'fix-branch' } },
      });

      const event = await parser.parse(payload, reviewCommentHeaders);
      expect(event).not.toBeNull();
      expect(event!.summary).toContain('src/utils.ts:99');
    });

    it('parses without user', async () => {
      const payload = createReviewCommentPayload({
        comment: { body: 'Anonymous comment', user: undefined, line: 10 },
        pull_request: { number: 3, head: { ref: 'main' } },
      });

      const event = await parser.parse(payload, reviewCommentHeaders);
      expect(event).not.toBeNull();
      expect(event!.summary).not.toContain('by ');
      expect(event!.summary).toContain('#3');
      expect(event!.summary).toContain('Anonymous comment');
    });

    it('parses without branch', async () => {
      const payload = createReviewCommentPayload({
        comment: { body: 'Comment on PR without head info', line: 1 },
        pull_request: { number: 2, head: undefined },
      });

      const event = await parser.parse(payload, reviewCommentHeaders);
      expect(event).not.toBeNull();
      expect(event!.metadata.branch).toBeUndefined();
      expect(event!.summary).toContain('#2');
    });

    it('returns null when required fields are missing', async () => {
      // Missing comment.body
      const noBody = createReviewCommentPayload({ comment: { body: undefined } });
      expect(await parser.parse(noBody, reviewCommentHeaders)).toBeNull();

      // Missing pull_request.number
      const noNumber = createReviewCommentPayload({ pull_request: { number: undefined } });
      expect(await parser.parse(noNumber, reviewCommentHeaders)).toBeNull();

      // Missing repository.full_name
      const noRepoName = createReviewCommentPayload({ repository: { full_name: undefined } });
      expect(await parser.parse(noRepoName, reviewCommentHeaders)).toBeNull();
    });

    it('handles very large comment body gracefully', async () => {
      const hugeBody = 'X'.repeat(100_000);
      const payload = createReviewCommentPayload({ comment: { body: hugeBody } });

      const event = await parser.parse(payload, reviewCommentHeaders);
      expect(event).not.toBeNull();
      expect(event!.summary).toContain('X'.repeat(200) + '...');
      expect(event!.summary).not.toContain('X'.repeat(201));
      expect((event!.payload as Record<string, unknown>).comment).toBeDefined();
    });

    it('truncates long path in summary', async () => {
      const longPath = 'a/'.repeat(150);
      const payload = createReviewCommentPayload({ comment: { path: longPath, line: 10 } });

      const event = await parser.parse(payload, reviewCommentHeaders);
      expect(event).not.toBeNull();
      expect(event!.summary).not.toContain(longPath);
      expect(event!.summary).toContain(longPath.slice(0, 200) + '...');
    });

    it('truncates long userLogin in summary', async () => {
      const longLogin = 'u'.repeat(150);
      const payload = createReviewCommentPayload({ comment: { user: { login: longLogin } } });

      const event = await parser.parse(payload, reviewCommentHeaders);
      expect(event).not.toBeNull();
      expect(event!.summary).not.toContain(longLogin);
      expect(event!.summary).toContain(longLogin.slice(0, 100) + '...');
    });

    it('truncates long comment bodies in summary', async () => {
      const longBody = 'A'.repeat(250);
      const payload = createReviewCommentPayload({ comment: { body: longBody } });

      const event = await parser.parse(payload, reviewCommentHeaders);
      expect(event).not.toBeNull();
      expect(event!.summary).toContain('A'.repeat(200) + '...');
      expect(event!.summary).not.toContain('A'.repeat(201));
    });
  });

  describe('pull_request_review', () => {
    const reviewHeaders = new Headers({ 'x-github-event': 'pull_request_review' });

    function createReviewPayload(overrides: {
      action?: string;
      review?: Record<string, unknown>;
      pull_request?: Record<string, unknown>;
      repository?: Record<string, unknown>;
    } = {}): string {
      return JSON.stringify({
        action: overrides.action ?? 'submitted',
        review: {
          state: 'changes_requested',
          user: { login: 'reviewer' },
          html_url: 'https://github.com/owner/repo/pull/7#pullrequestreview-100',
          ...overrides.review,
        },
        pull_request: {
          number: 7,
          head: { ref: 'feature-branch' },
          ...overrides.pull_request,
        },
        repository: {
          full_name: 'owner/repo',
          ...overrides.repository,
        },
      });
    }

    it('parses submitted changes_requested events', async () => {
      const payload = createReviewPayload();

      const event = await parser.parse(payload, reviewHeaders);
      expect(event).not.toBeNull();
      expect(event!.type).toBe('pr:changes_requested');
      expect(event!.source).toBe('github');
      expect(event!.metadata.repositoryName).toBe('owner/repo');
      expect(event!.metadata.branch).toBe('feature-branch');
      expect(event!.metadata.url).toBe('https://github.com/owner/repo/pull/7#pullrequestreview-100');
      expect(event!.summary).toContain('#7');
      expect(event!.summary).toContain('by reviewer');
    });

    it('ignores non-changes_requested review states', async () => {
      const payload = createReviewPayload({ review: { state: 'approved' } });

      const event = await parser.parse(payload, reviewHeaders);
      expect(event).toBeNull();
    });

    it('ignores non-submitted actions', async () => {
      const payload = createReviewPayload({ action: 'edited' });

      const event = await parser.parse(payload, reviewHeaders);
      expect(event).toBeNull();
    });

    it('parses without html_url', async () => {
      const payload = createReviewPayload({
        review: { state: 'changes_requested', html_url: undefined },
      });

      const event = await parser.parse(payload, reviewHeaders);
      expect(event).not.toBeNull();
      expect(event!.metadata.url).toBeUndefined();
    });

    it('parses without review.user.login', async () => {
      const payload = createReviewPayload({
        review: { state: 'changes_requested', user: undefined },
      });

      const event = await parser.parse(payload, reviewHeaders);
      expect(event).not.toBeNull();
      expect(event!.summary).toContain('by unknown');
    });

    it('parses without branch info', async () => {
      const payload = createReviewPayload({
        pull_request: { number: 5, head: undefined },
      });

      const event = await parser.parse(payload, reviewHeaders);
      expect(event).not.toBeNull();
      expect(event!.metadata.branch).toBeUndefined();
    });

    it('truncates long userLogin in summary', async () => {
      const longLogin = 'u'.repeat(150);
      const payload = createReviewPayload({
        review: { state: 'changes_requested', user: { login: longLogin } },
      });

      const event = await parser.parse(payload, reviewHeaders);
      expect(event).not.toBeNull();
      expect(event!.summary).not.toContain(longLogin);
      expect(event!.summary).toContain(longLogin.slice(0, 100) + '...');
    });
  });

  describe('issue_comment', () => {
    const issueCommentHeaders = new Headers({ 'x-github-event': 'issue_comment' });

    function createIssueCommentPayload(overrides: {
      action?: string;
      issue?: Record<string, unknown>;
      comment?: Record<string, unknown>;
      repository?: Record<string, unknown>;
    } = {}): string {
      return JSON.stringify({
        action: overrides.action ?? 'created',
        issue: {
          number: 7,
          pull_request: {},
          html_url: 'https://github.com/owner/repo/pull/7',
          ...overrides.issue,
        },
        comment: {
          body: 'Looks good, but please update the docs',
          html_url: 'https://github.com/owner/repo/pull/7#issuecomment-456',
          created_at: '2024-02-01T10:00:00Z',
          user: { login: 'commenter' },
          ...overrides.comment,
        },
        repository: {
          full_name: 'owner/repo',
          ...overrides.repository,
        },
      });
    }

    it('parses created PR comment events', async () => {
      const payload = createIssueCommentPayload();

      const event = await parser.parse(payload, issueCommentHeaders);
      expect(event).not.toBeNull();
      expect(event!.type).toBe('pr:comment');
      expect(event!.source).toBe('github');
      expect(event!.timestamp).toBe('2024-02-01T10:00:00Z');
      expect(event!.metadata.repositoryName).toBe('owner/repo');
      expect(event!.metadata.url).toBe('https://github.com/owner/repo/pull/7#issuecomment-456');
      expect(event!.summary).toContain('#7');
      expect(event!.summary).toContain('by commenter');
      expect(event!.summary).toContain('Looks good, but please update the docs');
      // issue_comment does NOT have branch metadata
      expect(event!.metadata.branch).toBeUndefined();
    });

    it('returns null for plain issue comments (no pull_request field)', async () => {
      const payload = createIssueCommentPayload({
        issue: { number: 42, pull_request: undefined },
      });

      const event = await parser.parse(payload, issueCommentHeaders);
      expect(event).toBeNull();
    });

    it('ignores non-created actions', async () => {
      const payload = createIssueCommentPayload({ action: 'edited' });

      const event = await parser.parse(payload, issueCommentHeaders);
      expect(event).toBeNull();
    });

    it('truncates long comment body to 200 chars', async () => {
      const longBody = 'B'.repeat(250);
      const payload = createIssueCommentPayload({ comment: { body: longBody } });

      const event = await parser.parse(payload, issueCommentHeaders);
      expect(event).not.toBeNull();
      expect(event!.summary).toContain('B'.repeat(200) + '...');
      expect(event!.summary).not.toContain('B'.repeat(201));
    });

    it('parses without user.login', async () => {
      const payload = createIssueCommentPayload({
        comment: { body: 'Anonymous comment', user: undefined },
      });

      const event = await parser.parse(payload, issueCommentHeaders);
      expect(event).not.toBeNull();
      expect(event!.summary).toContain('by unknown');
    });

    it('parses without html_url', async () => {
      const payload = createIssueCommentPayload({
        comment: { body: 'A comment', html_url: undefined },
      });

      const event = await parser.parse(payload, issueCommentHeaders);
      expect(event).not.toBeNull();
      expect(event!.metadata.url).toBeUndefined();
    });
  });
});

describe('resolveTargets', () => {
  const defaultRepo = buildPersistedRepository({ id: 'repo-1', name: 'repo', path: '/worktrees/repo' });
  const defaultRepositories = new Map<string, Repository>([[defaultRepo.id, defaultRepo]]);

  function createEvent(branch: string): InboundSystemEvent {
    return {
      type: 'ci:completed',
      source: 'github',
      timestamp: '2024-01-01T00:00:00Z',
      metadata: { repositoryName: 'owner/repo', branch },
      payload: { ok: true },
      summary: 'CI success',
    };
  }

  function createDeps(sessions: Session[], repositories = defaultRepositories) {
    return {
      getSessions: () => sessions,
      getRepository: (repositoryId: string) => repositories.get(repositoryId),
      getOrgRepoFromPath: async () => 'owner/repo',
    };
  }

  it('matches worktree sessions by repository and branch', async () => {
    const sessions = [buildWorktreeSession({ id: 'session-1', repositoryId: 'repo-1', worktreeId: 'main' })];
    const targets = await resolveTargets(createEvent('main'), createDeps(sessions));
    expect(targets).toEqual([{ sessionId: 'session-1' }]);
  });

  it('returns no targets for branch mismatch', async () => {
    const sessions = [buildWorktreeSession({ id: 'session-1', repositoryId: 'repo-1', worktreeId: 'develop' })];
    const targets = await resolveTargets(createEvent('main'), createDeps(sessions));
    expect(targets).toEqual([]);
  });

  it('includes parent session when child matches', async () => {
    const sessions = [
      buildWorktreeSession({ id: 'child-1', repositoryId: 'repo-1', worktreeId: 'feature', parentSessionId: 'parent-1' }),
    ];
    const targets = await resolveTargets(createEvent('feature'), createDeps(sessions));
    expect(targets).toEqual([
      { sessionId: 'child-1' },
      { sessionId: 'parent-1' },
    ]);
  });

  it('does not include parent when parentSessionId is absent', async () => {
    const sessions = [
      buildWorktreeSession({ id: 'child-1', repositoryId: 'repo-1', worktreeId: 'feature' }),
    ];
    const targets = await resolveTargets(createEvent('feature'), createDeps(sessions));
    expect(targets).toEqual([{ sessionId: 'child-1' }]);
  });

  it('deduplicates parent when multiple children match', async () => {
    const sessions = [
      buildWorktreeSession({ id: 'child-1', repositoryId: 'repo-1', worktreeId: 'main', parentSessionId: 'parent-1' }),
      buildWorktreeSession({ id: 'child-2', repositoryId: 'repo-1', worktreeId: 'main', parentSessionId: 'parent-1' }),
    ];
    const targets = await resolveTargets(createEvent('main'), createDeps(sessions));
    // parent-1 is added after child-1, then child-2 is added, then parent-1 again (deduped)
    expect(targets).toEqual([
      { sessionId: 'child-1' },
      { sessionId: 'parent-1' },
      { sessionId: 'child-2' },
    ]);
  });

  it('does not duplicate parent that is also a direct match', async () => {
    const sessions = [
      buildWorktreeSession({ id: 'parent-1', repositoryId: 'repo-1', worktreeId: 'main' }),
      buildWorktreeSession({ id: 'child-1', repositoryId: 'repo-1', worktreeId: 'main', parentSessionId: 'parent-1' }),
    ];
    const targets = await resolveTargets(createEvent('main'), createDeps(sessions));
    // parent-1 matches directly AND is referenced as parent — should appear only once
    expect(targets).toEqual([
      { sessionId: 'parent-1' },
      { sessionId: 'child-1' },
    ]);
  });
});
