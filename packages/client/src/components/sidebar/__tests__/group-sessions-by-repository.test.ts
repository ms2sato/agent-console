import { describe, it, expect } from 'bun:test';
import {
  groupSessionsByRepository,
  getGroupAggregateActivityState,
  QUICK_SESSIONS_GROUP_KEY,
  QUICK_SESSIONS_GROUP_LABEL,
} from '../group-sessions-by-repository';
import type { SessionWithActivity } from '../../../hooks/useActiveSessionsWithActivity';
import type { AgentActivityState, WorktreeSession, QuickSession } from '@agent-console/shared';

function worktreeSession(overrides: Partial<Omit<WorktreeSession, 'type'>> = {}): WorktreeSession {
  return {
    id: `session-${Math.random().toString(36).slice(2)}`,
    type: 'worktree',
    repositoryId: 'repo-1',
    repositoryName: 'my-repo',
    worktreeId: 'wt-1',
    isMainWorktree: false,
    locationPath: '/path/to/worktree',
    title: 'test-branch',
    status: 'active',
    activationState: 'running',
    createdAt: new Date().toISOString(),
    workers: [],
    isShared: false,
    recoveryState: 'healthy',
    ...overrides,
  };
}

function quickSession(overrides: Partial<Omit<QuickSession, 'type'>> = {}): QuickSession {
  return {
    id: `session-${Math.random().toString(36).slice(2)}`,
    type: 'quick',
    locationPath: '/some/path',
    status: 'active',
    activationState: 'running',
    createdAt: new Date().toISOString(),
    workers: [],
    isShared: false,
    recoveryState: 'healthy',
    ...overrides,
  };
}

function withActivity(
  session: SessionWithActivity['session'],
  activityState: AgentActivityState = 'idle'
): SessionWithActivity {
  return { session, activityState };
}

describe('groupSessionsByRepository', () => {
  it('returns an empty array for empty input', () => {
    expect(groupSessionsByRepository([])).toEqual([]);
  });

  it('returns a single group for a single session', () => {
    const session = worktreeSession({ id: 's1', repositoryId: 'repo-a', repositoryName: 'repo-a-name' });
    const groups = groupSessionsByRepository([withActivity(session)]);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('repo-a');
    expect(groups[0].label).toBe('repo-a-name');
    expect(groups[0].sessions).toHaveLength(1);
  });

  it('puts multiple sessions from one repository into a single group, preserving order', () => {
    const s1 = worktreeSession({ id: 's1', repositoryId: 'repo-a', repositoryName: 'repo-a-name' });
    const s2 = worktreeSession({ id: 's2', repositoryId: 'repo-a', repositoryName: 'repo-a-name' });
    const s3 = worktreeSession({ id: 's3', repositoryId: 'repo-a', repositoryName: 'repo-a-name' });

    const groups = groupSessionsByRepository([withActivity(s2), withActivity(s3), withActivity(s1)]);

    expect(groups).toHaveLength(1);
    expect(groups[0].sessions.map((s) => s.session.id)).toEqual(['s2', 's3', 's1']);
  });

  it('creates a separate group per repository, sorted by label localeCompare', () => {
    const zulu = worktreeSession({ id: 'z', repositoryId: 'repo-z', repositoryName: 'zulu' });
    const alpha = worktreeSession({ id: 'a', repositoryId: 'repo-alpha', repositoryName: 'alpha' });
    const mike = worktreeSession({ id: 'm', repositoryId: 'repo-mike', repositoryName: 'mike' });

    const groups = groupSessionsByRepository([
      withActivity(zulu),
      withActivity(alpha),
      withActivity(mike),
    ]);

    expect(groups.map((g) => g.label)).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('groups quick sessions under the QUICK_SESSIONS sentinel key/label', () => {
    const q1 = quickSession({ id: 'q1' });
    const groups = groupSessionsByRepository([withActivity(q1)]);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe(QUICK_SESSIONS_GROUP_KEY);
    expect(groups[0].label).toBe(QUICK_SESSIONS_GROUP_LABEL);
  });

  it('places the quick group last, after all repository groups regardless of label sort order', () => {
    const q1 = quickSession({ id: 'q1' });
    const alpha = worktreeSession({ id: 'a', repositoryId: 'repo-alpha', repositoryName: 'alpha' });
    const zulu = worktreeSession({ id: 'z', repositoryId: 'repo-z', repositoryName: 'zulu' });

    // Quick session listed first in the input to prove ordering is not
    // input-position-dependent.
    const groups = groupSessionsByRepository([
      withActivity(q1),
      withActivity(zulu),
      withActivity(alpha),
    ]);

    expect(groups.map((g) => g.key)).toEqual(['repo-alpha', 'repo-z', QUICK_SESSIONS_GROUP_KEY]);
  });

  it('does not split a group when sessions sharing a repositoryId disagree on repositoryName; first occurrence wins (M1)', () => {
    const first = worktreeSession({ id: 's1', repositoryId: 'repo-a', repositoryName: 'old-name' });
    const stale = worktreeSession({ id: 's2', repositoryId: 'repo-a', repositoryName: 'renamed-name' });

    const groups = groupSessionsByRepository([withActivity(first), withActivity(stale)]);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('old-name');
    expect(groups[0].sessions).toHaveLength(2);
  });

  it('mixes quick and worktree sessions into their respective groups', () => {
    const wt = worktreeSession({ id: 'wt1', repositoryId: 'repo-a', repositoryName: 'repo-a' });
    const q = quickSession({ id: 'q1' });

    const groups = groupSessionsByRepository([withActivity(wt), withActivity(q)]);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.key)).toEqual(['repo-a', QUICK_SESSIONS_GROUP_KEY]);
  });

  it('R7: never produces a group for a repository absent from the (already-filtered) input', () => {
    // Simulates the mine/shared filter (applied upstream, before this
    // function ever sees the list) having removed every session belonging
    // to repo-b. The pure function only ever sees repo-a's sessions, so it
    // must not fabricate an empty repo-b header.
    const onlyRepoA = [
      withActivity(worktreeSession({ id: 's1', repositoryId: 'repo-a', repositoryName: 'repo-a' })),
    ];

    const groups = groupSessionsByRepository(onlyRepoA);

    expect(groups).toHaveLength(1);
    expect(groups.map((g) => g.key)).toEqual(['repo-a']);
    expect(groups.find((g) => g.key === 'repo-b')).toBeUndefined();
  });
});

describe('getGroupAggregateActivityState', () => {
  const s = (activityState: AgentActivityState) => withActivity(worktreeSession(), activityState);

  it('returns null for an empty group', () => {
    expect(getGroupAggregateActivityState([])).toBeNull();
  });

  it('returns null when every session is idle', () => {
    expect(getGroupAggregateActivityState([s('idle'), s('idle')])).toBeNull();
  });

  it('returns "active" when the only non-idle session is active', () => {
    expect(getGroupAggregateActivityState([s('idle'), s('active')])).toBe('active');
  });

  it('returns "asking" when the only non-idle session is asking', () => {
    expect(getGroupAggregateActivityState([s('idle'), s('asking')])).toBe('asking');
  });

  it('prefers "asking" over "active" when both are present (asking is higher attention priority)', () => {
    expect(getGroupAggregateActivityState([s('active'), s('idle'), s('asking')])).toBe('asking');
  });
});
