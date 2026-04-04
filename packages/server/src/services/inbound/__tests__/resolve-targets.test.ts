import { describe, it, expect, mock } from 'bun:test';
import { resolveTargets, type TargetResolverDependencies } from '../resolve-targets.js';
import { GitError } from '../../../lib/git.js';
import type { InboundSystemEvent, Repository } from '@agent-console/shared';
import {
  buildWorktreeSession,
  buildQuickSession,
  buildPersistedRepository,
} from '../../../__tests__/utils/build-test-data.js';

function createEvent(metadata: Partial<InboundSystemEvent['metadata']> = {}): InboundSystemEvent {
  return {
    type: 'ci:completed',
    source: 'github',
    timestamp: new Date().toISOString(),
    metadata: {
      repositoryName: 'owner/repo',
      ...metadata,
    },
    payload: {},
    summary: 'Test event',
  } as InboundSystemEvent;
}

const defaultRepository = buildPersistedRepository({ id: 'repo-1', path: '/path/to/repo' });

describe('resolveTargets', () => {
  it('matches repository names case-insensitively', async () => {
    const session = buildWorktreeSession({ id: 'session-1', repositoryId: 'repo-1', worktreeId: 'main' });
    const deps: TargetResolverDependencies = {
      getSessions: () => [session],
      getRepository: () => defaultRepository,
      getOrgRepoFromPath: mock(() => Promise.resolve('Owner/Repo')),
    };

    const targets = await resolveTargets(createEvent({ repositoryName: 'owner/repo' }), deps);

    expect(targets).toEqual([{ sessionId: 'session-1' }]);
  });

  it('filters by branch when event specifies a branch', async () => {
    const mainSession = buildWorktreeSession({ id: 'session-main', worktreeId: 'main' });
    const featureSession = buildWorktreeSession({ id: 'session-feature', worktreeId: 'feature-branch' });
    const deps: TargetResolverDependencies = {
      getSessions: () => [mainSession, featureSession],
      getRepository: () => defaultRepository,
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent({ branch: 'feature-branch' }), deps);

    expect(targets).toEqual([{ sessionId: 'session-feature' }]);
  });

  it('skips non-worktree sessions', async () => {
    const session = buildQuickSession();
    const deps: TargetResolverDependencies = {
      getSessions: () => [session],
      getRepository: () => defaultRepository,
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent(), deps);

    expect(targets).toEqual([]);
  });

  it('swallows GitError and continues processing remaining sessions', async () => {
    const session1 = buildWorktreeSession({ id: 'session-1', repositoryId: 'repo-1' });
    const session2 = buildWorktreeSession({ id: 'session-2', repositoryId: 'repo-2' });
    const repositories: Record<string, Repository> = {
      'repo-1': buildPersistedRepository({ id: 'repo-1', path: '/path/to/repo1' }),
      'repo-2': buildPersistedRepository({ id: 'repo-2', path: '/path/to/repo2' }),
    };
    let callCount = 0;
    const deps: TargetResolverDependencies = {
      getSessions: () => [session1, session2],
      getRepository: (id) => repositories[id],
      getOrgRepoFromPath: mock(() => {
        callCount++;
        if (callCount === 1) {
          throw new GitError('not a git repository', 128, 'fatal: not a git repository');
        }
        return Promise.resolve('owner/repo');
      }),
    };

    const targets = await resolveTargets(createEvent(), deps);

    expect(targets).toEqual([{ sessionId: 'session-2' }]);
  });

  it('returns empty array when repositoryName is missing', async () => {
    const session = buildWorktreeSession({ id: 'session-1', repositoryId: 'repo-1' });
    const deps: TargetResolverDependencies = {
      getSessions: () => [session],
      getRepository: () => defaultRepository,
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent({ repositoryName: undefined }), deps);

    expect(targets).toEqual([]);
  });
});
