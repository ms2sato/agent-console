import { describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { Repository, Session, SystemEvent } from '@agent-console/shared';
import { GitHubServiceParser } from '../inbound/github-service-parser.js';
import { resolveTargets } from '../inbound/resolve-targets.js';

describe('GitHubServiceParser', () => {
  it('authenticates webhook signatures', async () => {
    const secret = 'secret-token';
    const parser = new GitHubServiceParser(secret);
    const payload = JSON.stringify({ hello: 'world' });
    const signature = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    const headers = new Headers({ 'x-hub-signature-256': signature });

    const authenticated = await parser.authenticate(payload, headers);
    expect(authenticated).toBe(true);
  });

  it('rejects invalid webhook signatures', async () => {
    const parser = new GitHubServiceParser('secret-token');
    const payload = JSON.stringify({ hello: 'world' });
    const headers = new Headers({ 'x-hub-signature-256': 'sha256=bad' });

    const authenticated = await parser.authenticate(payload, headers);
    expect(authenticated).toBe(false);
  });

  it('parses workflow_run success events', async () => {
    const parser = new GitHubServiceParser('secret-token');
    const payload = JSON.stringify({
      action: 'completed',
      workflow_run: {
        conclusion: 'success',
        name: 'CI',
        html_url: 'https://example.com/run/1',
        head_branch: 'main',
      },
      repository: {
        full_name: 'owner/repo',
      },
    });
    const headers = new Headers({ 'x-github-event': 'workflow_run' });

    const event = await parser.parse(payload, headers);
    expect(event?.type).toBe('ci:completed');
    expect(event?.metadata.repositoryName).toBe('owner/repo');
  });

  it('parses issue closed events', async () => {
    const parser = new GitHubServiceParser('secret-token');
    const payload = JSON.stringify({
      action: 'closed',
      issue: {
        number: 42,
        title: 'Fix bug',
        html_url: 'https://example.com/issues/42',
      },
      repository: {
        full_name: 'owner/repo',
      },
    });
    const headers = new Headers({ 'x-github-event': 'issues' });

    const event = await parser.parse(payload, headers);
    expect(event?.type).toBe('issue:closed');
    expect(event?.summary).toContain('#42');
  });

  it('parses merged pull request events', async () => {
    const parser = new GitHubServiceParser('secret-token');
    const payload = JSON.stringify({
      action: 'closed',
      pull_request: {
        merged: true,
        number: 7,
        title: 'Ship feature',
        html_url: 'https://example.com/pull/7',
        head: {
          ref: 'feature-branch',
        },
      },
      repository: {
        full_name: 'owner/repo',
      },
    });
    const headers = new Headers({ 'x-github-event': 'pull_request' });

    const event = await parser.parse(payload, headers);
    expect(event?.type).toBe('pr:merged');
    expect(event?.metadata.branch).toBe('feature-branch');
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
