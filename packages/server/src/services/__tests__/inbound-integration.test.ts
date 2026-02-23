import { describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { Repository, Session, SystemEvent } from '@agent-console/shared';
import { GitHubServiceParser } from '../inbound/github-service-parser.js';
import { resolveTargets } from '../inbound/resolve-targets.js';

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
          title: 'Add feature',
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
});

describe('resolveTargets', () => {
  it('matches worktree sessions by repository and branch', async () => {
    const sessions: Session[] = [
      {
        id: 'session-1',
        type: 'worktree',
        repositoryId: 'repo-1',
        repositoryName: 'repo',
        worktreeId: 'main',
        isMainWorktree: false,
        locationPath: '/worktrees/repo',
        status: 'active',
        activationState: 'running',
        createdAt: '2024-01-01T00:00:00Z',
        workers: [],
      },
    ];

    const repositories = new Map<string, Repository>([
      ['repo-1', { id: 'repo-1', name: 'repo', path: '/worktrees/repo', createdAt: '2024-01-01T00:00:00Z' }],
    ]);

    const event: SystemEvent = {
      type: 'ci:completed',
      source: 'github',
      timestamp: '2024-01-01T00:00:00Z',
      metadata: {
        repositoryName: 'owner/repo',
        branch: 'main',
      },
      payload: { ok: true },
      summary: 'CI success',
    };

    const targets = await resolveTargets(event, {
      getSessions: () => sessions,
      getRepository: (repositoryId) => repositories.get(repositoryId),
      getOrgRepoFromPath: async () => 'owner/repo',
    });

    expect(targets).toEqual([{ sessionId: 'session-1' }]);
  });

  it('returns no targets for branch mismatch', async () => {
    const sessions: Session[] = [
      {
        id: 'session-1',
        type: 'worktree',
        repositoryId: 'repo-1',
        repositoryName: 'repo',
        worktreeId: 'develop',
        isMainWorktree: false,
        locationPath: '/worktrees/repo',
        status: 'active',
        activationState: 'running',
        createdAt: '2024-01-01T00:00:00Z',
        workers: [],
      },
    ];

    const repositories = new Map<string, Repository>([
      ['repo-1', { id: 'repo-1', name: 'repo', path: '/worktrees/repo', createdAt: '2024-01-01T00:00:00Z' }],
    ]);

    const event: SystemEvent = {
      type: 'ci:completed',
      source: 'github',
      timestamp: '2024-01-01T00:00:00Z',
      metadata: {
        repositoryName: 'owner/repo',
        branch: 'main',
      },
      payload: { ok: true },
      summary: 'CI success',
    };

    const targets = await resolveTargets(event, {
      getSessions: () => sessions,
      getRepository: (repositoryId) => repositories.get(repositoryId),
      getOrgRepoFromPath: async () => 'owner/repo',
    });

    expect(targets).toEqual([]);
  });
});
