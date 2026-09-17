import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { resolveTargets, parseTriggerLabels, matchesAnyTriggerLabel, type TargetResolverDependencies } from '../resolve-targets.js';
import { GitError } from '../../../lib/git.js';
import { rootLogger } from '../../../lib/logger.js';
import type { InboundSystemEvent, Repository, WorktreeSession } from '@agent-console/shared';
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

function createIssueLabeledEvent(metadata: Partial<InboundSystemEvent['metadata']> = {}): InboundSystemEvent {
  return {
    type: 'issue:labeled',
    source: 'github',
    timestamp: new Date().toISOString(),
    metadata: {
      repositoryName: 'owner/repo',
      labels: ['orchestrator-trigger'],
      ...metadata,
    },
    payload: {},
    summary: 'Test issue:labeled event',
  };
}

// Rebuilt per test (not a shared module-level const) so no test can accidentally leak state into another via this reference.
function createDefaultRepository(): Repository {
  return buildPersistedRepository({ id: 'repo-1', path: '/path/to/repo' });
}

/**
 * `buildPersistedRepository` builds `PersistedRepository` (the legacy JSON
 * migration-only shape), which deliberately does NOT declare
 * `orchestratorSessionIds` / `issueTriggerLabels` (see
 * `persistence-service.ts`'s `PersistedRepository` and `mappers.ts`'s
 * `toRepositoryRow` comment: a migrated repository always starts with both
 * unset). Tests exercising `issue:labeled` routing need a full `Repository`
 * with those fields set, so this helper widens the persisted builder's
 * output rather than reusing it directly.
 */
function buildRepositoryWithDesignation(overrides: {
  id: string;
  path: string;
  orchestratorSessionIds?: string[];
  issueTriggerLabels?: string | null;
}): Repository {
  return {
    ...buildPersistedRepository({ id: overrides.id, path: overrides.path }),
    orchestratorSessionIds: overrides.orchestratorSessionIds ?? [],
    issueTriggerLabels: overrides.issueTriggerLabels ?? null,
  };
}

describe('resolveTargets', () => {
  let defaultRepository: Repository;

  beforeEach(() => {
    defaultRepository = createDefaultRepository();
  });

  afterEach(() => {
    mock.restore();
  });

  it('matches repository names case-insensitively', async () => {
    const session = buildWorktreeSession({ id: 'session-1', repositoryId: 'repo-1', worktreeId: 'main' });
    const deps: TargetResolverDependencies = {
      getSessions: () => [session],
      getRepository: () => defaultRepository,
      getAllRepositories: () => [defaultRepository],
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
      getAllRepositories: () => [defaultRepository],
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
      getAllRepositories: () => [defaultRepository],
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
      getAllRepositories: () => Object.values(repositories),
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

  it('includes parent session when child matches', async () => {
    const child = buildWorktreeSession({ id: 'child-1', repositoryId: 'repo-1', worktreeId: 'feature', parentSessionId: 'parent-1' });
    const deps: TargetResolverDependencies = {
      getSessions: () => [child],
      getRepository: () => defaultRepository,
      getAllRepositories: () => [defaultRepository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent({ branch: 'feature' }), deps);

    expect(targets).toEqual([
      { sessionId: 'child-1' },
      { sessionId: 'parent-1' },
    ]);
  });

  it('does not include parent when parentSessionId is absent', async () => {
    const child = buildWorktreeSession({ id: 'child-1', repositoryId: 'repo-1', worktreeId: 'feature' });
    const deps: TargetResolverDependencies = {
      getSessions: () => [child],
      getRepository: () => defaultRepository,
      getAllRepositories: () => [defaultRepository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent({ branch: 'feature' }), deps);

    expect(targets).toEqual([{ sessionId: 'child-1' }]);
  });

  it('deduplicates parent when multiple children share the same parent', async () => {
    const child1 = buildWorktreeSession({ id: 'child-1', repositoryId: 'repo-1', worktreeId: 'main', parentSessionId: 'parent-1' });
    const child2 = buildWorktreeSession({ id: 'child-2', repositoryId: 'repo-1', worktreeId: 'main', parentSessionId: 'parent-1' });
    const deps: TargetResolverDependencies = {
      getSessions: () => [child1, child2],
      getRepository: () => defaultRepository,
      getAllRepositories: () => [defaultRepository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent({ branch: 'main' }), deps);

    const parentTargets = targets.filter(t => t.sessionId === 'parent-1');
    expect(parentTargets).toHaveLength(1);
    expect(targets).toHaveLength(3); // child-1, parent-1, child-2
  });

  it('does not duplicate parent that is also a direct match', async () => {
    const parent = buildWorktreeSession({ id: 'parent-1', repositoryId: 'repo-1', worktreeId: 'main' });
    const child = buildWorktreeSession({ id: 'child-1', repositoryId: 'repo-1', worktreeId: 'main', parentSessionId: 'parent-1' });
    const deps: TargetResolverDependencies = {
      getSessions: () => [parent, child],
      getRepository: () => defaultRepository,
      getAllRepositories: () => [defaultRepository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent({ branch: 'main' }), deps);

    const parentTargets = targets.filter(t => t.sessionId === 'parent-1');
    expect(parentTargets).toHaveLength(1);
    expect(targets).toHaveLength(2); // parent-1, child-1
  });

  it('returns empty array when repositoryName is missing', async () => {
    const session = buildWorktreeSession({ id: 'session-1', repositoryId: 'repo-1' });
    const deps: TargetResolverDependencies = {
      getSessions: () => [session],
      getRepository: () => defaultRepository,
      getAllRepositories: () => [defaultRepository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent({ repositoryName: undefined }), deps);

    expect(targets).toEqual([]);
  });
});

describe('resolveTargets: designated-session fallback (#1661)', () => {
  // Shared `agent`-type worker so a designated session satisfies
  // `canDeliverToAgentWorker` by default (mirrors the sibling
  // `issue:labeled routing` describe block's `AGENT_WORKER` convention).
  const AGENT_WORKER = { id: 'worker-1', type: 'agent' as const, name: 'Claude', agentId: 'claude-code-builtin', activated: true, createdAt: '2024-01-01T00:00:00Z' };

  function buildDesignatedSession(overrides: Partial<WorktreeSession> = {}): WorktreeSession {
    return buildWorktreeSession({
      id: 'designated-1',
      repositoryId: 'repo-1',
      worktreeId: 'designated-worktree',
      workers: [AGENT_WORKER],
      ...overrides,
    });
  }

  it('positive (load-bearing): branch matches zero sessions, designated session live+deliverable -> sole fallback target', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['designated-1'],
    });
    const nonMatchingSession = buildWorktreeSession({ id: 'session-1', repositoryId: 'repo-1', worktreeId: 'feature-branch' });
    const designatedSession = buildDesignatedSession();
    const deps: TargetResolverDependencies = {
      getSessions: () => [nonMatchingSession, designatedSession],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent({ branch: 'main' }), deps);

    expect(targets).toEqual([{ sessionId: 'designated-1', fallback: true }]);
  });

  it('boundary: matched session has no parent -> designated session added alongside it', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['designated-1'],
    });
    const matchedSession = buildWorktreeSession({ id: 'session-1', repositoryId: 'repo-1', worktreeId: 'feature' });
    const designatedSession = buildDesignatedSession();
    const deps: TargetResolverDependencies = {
      getSessions: () => [matchedSession, designatedSession],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent({ branch: 'feature' }), deps);

    expect(targets).toEqual([
      { sessionId: 'session-1' },
      { sessionId: 'designated-1', fallback: true },
    ]);
  });

  it('boundary: matched session has a parentSessionId pointing at a nonexistent session -> designated session added', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['designated-1'],
    });
    const matchedSession = buildWorktreeSession({
      id: 'session-1',
      repositoryId: 'repo-1',
      worktreeId: 'feature',
      parentSessionId: 'dead-parent',
    });
    const designatedSession = buildDesignatedSession();
    const deps: TargetResolverDependencies = {
      getSessions: () => [matchedSession, designatedSession],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent({ branch: 'feature' }), deps);

    expect(targets).toEqual([
      { sessionId: 'session-1' },
      { sessionId: 'dead-parent' },
      { sessionId: 'designated-1', fallback: true },
    ]);
  });

  it('boundary: matched session has a parent that exists but is not running (hibernated) -> designated session added', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['designated-1'],
    });
    const matchedSession = buildWorktreeSession({
      id: 'session-1',
      repositoryId: 'repo-1',
      worktreeId: 'feature',
      parentSessionId: 'hibernated-parent',
    });
    const hibernatedParent = buildWorktreeSession({
      id: 'hibernated-parent',
      repositoryId: 'repo-1',
      worktreeId: 'main',
      activationState: 'hibernated',
    });
    const designatedSession = buildDesignatedSession();
    const deps: TargetResolverDependencies = {
      getSessions: () => [matchedSession, hibernatedParent, designatedSession],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent({ branch: 'feature' }), deps);

    expect(targets).toEqual([
      { sessionId: 'session-1' },
      { sessionId: 'hibernated-parent' },
      { sessionId: 'designated-1', fallback: true },
    ]);
  });

  it('boundary: matched session has a parent that reads activationState "running" but has no agent-type worker -> designated session added (vacuous-running parent cannot actually receive delivery)', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['designated-1'],
    });
    const matchedSession = buildWorktreeSession({
      id: 'session-1',
      repositoryId: 'repo-1',
      worktreeId: 'feature',
      parentSessionId: 'vacuously-running-parent',
    });
    // `computeActivationState` (session-converter-service.ts) reads
    // 'running' vacuously true when a session has zero agent/terminal-type
    // workers -- e.g. a worktree session whose only worker is a `git-diff`
    // worker. `AgentWorkerHandler.handle()` can never deliver to such a
    // parent (no agent-type worker to resolve a workerId from), so it must
    // not count as a live parent for the fallback decision.
    const vacuouslyRunningParent = buildWorktreeSession({
      id: 'vacuously-running-parent',
      repositoryId: 'repo-1',
      worktreeId: 'main',
      activationState: 'running',
      workers: [
        { id: 'worker-1', type: 'git-diff', name: 'Diff', createdAt: '2024-01-01T00:00:00Z', baseCommit: 'abc123' },
      ],
    });
    const designatedSession = buildDesignatedSession();
    const deps: TargetResolverDependencies = {
      getSessions: () => [matchedSession, vacuouslyRunningParent, designatedSession],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent({ branch: 'feature' }), deps);

    expect(targets).toEqual([
      { sessionId: 'session-1' },
      { sessionId: 'vacuously-running-parent' },
      { sessionId: 'designated-1', fallback: true },
    ]);
  });

  it('boundary: matched session has a live non-Orchestrator parent -> no fallback added, even though a designated session is configured', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['designated-1'],
    });
    const matchedSession = buildWorktreeSession({
      id: 'session-1',
      repositoryId: 'repo-1',
      worktreeId: 'feature',
      parentSessionId: 'live-non-orchestrator-parent',
    });
    const liveParent = buildWorktreeSession({
      id: 'live-non-orchestrator-parent',
      repositoryId: 'repo-1',
      worktreeId: 'main',
      activationState: 'running',
      // Must have an agent-type worker so this parent is genuinely
      // deliverable, not merely a vacuous "running" (see the sibling test
      // above for the vacuous case) -- otherwise this test would not
      // distinguish "live and deliverable" from "reads running but
      // undeliverable", the exact bug the fix above corrects for.
      workers: [AGENT_WORKER],
    });
    const designatedSession = buildDesignatedSession();
    const deps: TargetResolverDependencies = {
      getSessions: () => [matchedSession, liveParent, designatedSession],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent({ branch: 'feature' }), deps);

    expect(targets).toEqual([
      { sessionId: 'session-1' },
      { sessionId: 'live-non-orchestrator-parent' },
    ]);
  });

  it('regression: matched session has a live parent that IS the designated session -> unchanged, no duplicate/fallback entry', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['designated-1'],
    });
    const matchedSession = buildWorktreeSession({
      id: 'session-1',
      repositoryId: 'repo-1',
      worktreeId: 'feature',
      parentSessionId: 'designated-1',
    });
    const designatedSession = buildDesignatedSession();
    const deps: TargetResolverDependencies = {
      getSessions: () => [matchedSession, designatedSession],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent({ branch: 'feature' }), deps);

    expect(targets).toEqual([
      { sessionId: 'session-1' },
      { sessionId: 'designated-1' },
    ]);
  });

  it('negative control: same branch-matches-nothing event, no designated session configured -> empty (unchanged from today)', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: [],
    });
    const nonMatchingSession = buildWorktreeSession({ id: 'session-1', repositoryId: 'repo-1', worktreeId: 'feature-branch' });
    const deps: TargetResolverDependencies = {
      getSessions: () => [nonMatchingSession],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent({ branch: 'main' }), deps);

    expect(targets).toEqual([]);
  });

  it('negative control: designated session id is set but points at a dead (nonexistent) session -> empty', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['dead-designated-session'],
    });
    const nonMatchingSession = buildWorktreeSession({ id: 'session-1', repositoryId: 'repo-1', worktreeId: 'feature-branch' });
    const deps: TargetResolverDependencies = {
      getSessions: () => [nonMatchingSession],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent({ branch: 'main' }), deps);

    expect(targets).toEqual([]);
  });

  // -------------------------------------------------------------------
  // Set-model boundary cases (Issue #1716): the four cases re-pinned for
  // both this fallback and `issue:labeled` routing below.
  // -------------------------------------------------------------------

  it('set-model boundary: designated set is [] -> no fallback target (same as no designation at all)', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: [],
    });
    const nonMatchingSession = buildWorktreeSession({ id: 'session-1', repositoryId: 'repo-1', worktreeId: 'feature-branch' });
    const deps: TargetResolverDependencies = {
      getSessions: () => [nonMatchingSession],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent({ branch: 'main' }), deps);

    expect(targets).toEqual([]);
  });

  it('set-model boundary: two designated, one hibernated -> exactly the live one is a fallback target', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['designated-live', 'designated-hibernated'],
    });
    const nonMatchingSession = buildWorktreeSession({ id: 'session-1', repositoryId: 'repo-1', worktreeId: 'feature-branch' });
    const liveDesignated = buildDesignatedSession({ id: 'designated-live' });
    const hibernatedDesignated = buildDesignatedSession({ id: 'designated-hibernated', activationState: 'hibernated' });
    const deps: TargetResolverDependencies = {
      getSessions: () => [nonMatchingSession, liveDesignated, hibernatedDesignated],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent({ branch: 'main' }), deps);

    expect(targets).toEqual([{ sessionId: 'designated-live', fallback: true }]);
  });

  it('set-model boundary: three designated, all live -> three fallback targets', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['designated-1', 'designated-2', 'designated-3'],
    });
    const nonMatchingSession = buildWorktreeSession({ id: 'session-1', repositoryId: 'repo-1', worktreeId: 'feature-branch' });
    const designated1 = buildDesignatedSession({ id: 'designated-1' });
    const designated2 = buildDesignatedSession({ id: 'designated-2' });
    const designated3 = buildDesignatedSession({ id: 'designated-3' });
    const deps: TargetResolverDependencies = {
      getSessions: () => [nonMatchingSession, designated1, designated2, designated3],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent({ branch: 'main' }), deps);

    expect(new Set(targets.map((t) => t.sessionId))).toEqual(new Set(['designated-1', 'designated-2', 'designated-3']));
    expect(targets.every((t) => t.fallback)).toBe(true);
    expect(targets).toHaveLength(3);
  });

  it('set-model boundary: two same-remote rows designating the same session -> one fallback target (deduplicated)', async () => {
    const repositoryA = buildRepositoryWithDesignation({
      id: 'repo-a',
      path: '/path/to/repo-a',
      orchestratorSessionIds: ['designated-shared'],
    });
    const repositoryB = buildRepositoryWithDesignation({
      id: 'repo-b',
      path: '/path/to/repo-b',
      orchestratorSessionIds: ['designated-shared'],
    });
    const nonMatchingSession = buildWorktreeSession({ id: 'session-1', repositoryId: 'repo-a', worktreeId: 'feature-branch' });
    const sharedDesignated = buildDesignatedSession({ id: 'designated-shared' });
    const deps: TargetResolverDependencies = {
      getSessions: () => [nonMatchingSession, sharedDesignated],
      getRepository: () => repositoryA,
      getAllRepositories: () => [repositoryA, repositoryB],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createEvent({ branch: 'main' }), deps);

    expect(targets).toEqual([{ sessionId: 'designated-shared', fallback: true }]);
  });
});

describe('resolveTargets: issue:labeled routing', () => {
  // Shared across this describe block's `buildWorktreeSession` calls so a
  // session satisfies `canDeliverToAgentWorker` (Issue #1652) by default --
  // tests that specifically want to exercise the no-agent-worker drop
  // reason build their `workers` array explicitly instead.
  const AGENT_WORKER = { id: 'worker-1', type: 'agent' as const, name: 'Claude', agentId: 'claude-code-builtin', activated: true, createdAt: '2024-01-01T00:00:00Z' };

  function createOrchestratorSession(overrides: Partial<WorktreeSession> = {}): WorktreeSession {
    return buildWorktreeSession({
      id: 'orchestrator-session-1',
      repositoryId: 'repo-1',
      worktreeId: 'main',
      workers: [AGENT_WORKER],
      ...overrides,
    });
  }

  it('routes to the designated Orchestrator session when the repository matches and the label matches', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['orchestrator-session-1'],
      issueTriggerLabels: 'orchestrator-trigger',
    });
    const orchestratorSession = createOrchestratorSession();
    const deps: TargetResolverDependencies = {
      getSessions: () => [orchestratorSession],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createIssueLabeledEvent(), deps);

    expect(targets).toEqual([{ sessionId: 'orchestrator-session-1' }]);
  });

  it('does not fan out to other active sessions for the repository (unlike every other event type)', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['orchestrator-session-1'],
      issueTriggerLabels: 'orchestrator-trigger',
    });
    const orchestratorSession = createOrchestratorSession();
    const otherSession = buildWorktreeSession({ id: 'other-session', repositoryId: 'repo-1', worktreeId: 'feature', parentSessionId: 'orchestrator-session-1' });
    const deps: TargetResolverDependencies = {
      getSessions: () => [orchestratorSession, otherSession],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createIssueLabeledEvent(), deps);

    expect(targets).toEqual([{ sessionId: 'orchestrator-session-1' }]);
  });

  it('returns empty when the repository matches but the label does not match the added-label-only metadata', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['orchestrator-session-1'],
      issueTriggerLabels: 'some-other-label',
    });
    const orchestratorSession = createOrchestratorSession();
    const deps: TargetResolverDependencies = {
      getSessions: () => [orchestratorSession],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createIssueLabeledEvent({ labels: ['orchestrator-trigger'] }), deps);

    expect(targets).toEqual([]);
  });

  it('returns empty when the repository matches and the label matches but orchestratorSessionIds is empty', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      issueTriggerLabels: 'orchestrator-trigger',
    });
    const deps: TargetResolverDependencies = {
      getSessions: () => [],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createIssueLabeledEvent(), deps);

    expect(targets).toEqual([]);
  });

  it('returns empty (not thrown) when a designated session id is set but that session no longer exists', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['stale-session-id'],
      issueTriggerLabels: 'orchestrator-trigger',
    });
    const deps: TargetResolverDependencies = {
      getSessions: () => [],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createIssueLabeledEvent(), deps);

    expect(targets).toEqual([]);
  });

  it('returns empty when no registered repository matches the webhook repository name', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['orchestrator-session-1'],
      issueTriggerLabels: 'orchestrator-trigger',
    });
    const deps: TargetResolverDependencies = {
      getSessions: () => [createOrchestratorSession()],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('some-other/repo')),
    };

    const targets = await resolveTargets(createIssueLabeledEvent(), deps);

    expect(targets).toEqual([]);
  });

  it('never matches when issueTriggerLabels is empty/unset (vacuous-truth boundary), even with non-empty event labels', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['orchestrator-session-1'],
      issueTriggerLabels: null,
    });
    const deps: TargetResolverDependencies = {
      getSessions: () => [createOrchestratorSession()],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createIssueLabeledEvent({ labels: ['orchestrator-trigger'] }), deps);

    expect(targets).toEqual([]);
  });

  // -------------------------------------------------------------------
  // CodeRabbit fix-up (PR #1650): `resolveIssueLabeledTargets` used to
  // `break` on the FIRST repository whose remote matched the webhook's
  // `repository.full_name`. `RepositoryManager.registerRepository` only
  // rejects a duplicate PATH, not a duplicate remote, so two independently
  // registered repositories can legitimately share the same remote -- if
  // the ineligible one happened to iterate first, the event was dropped
  // even though an eligible sibling existed. The fix evaluates every
  // same-remote candidate instead of stopping at the first.
  // -------------------------------------------------------------------

  it('evaluates every same-remote repository for eligibility instead of stopping at the first match, regardless of iteration order', async () => {
    const ineligibleRepo = buildRepositoryWithDesignation({
      id: 'repo-ineligible',
      path: '/path/to/repo-ineligible',
      orchestratorSessionIds: ['orchestrator-session-ineligible'],
      // No configured trigger labels -- vacuous-truth boundary, never matches.
      issueTriggerLabels: null,
    });
    const eligibleRepo = buildRepositoryWithDesignation({
      id: 'repo-eligible',
      path: '/path/to/repo-eligible',
      orchestratorSessionIds: ['orchestrator-session-eligible'],
      issueTriggerLabels: 'orchestrator-trigger',
    });
    const eligibleSession = buildWorktreeSession({
      id: 'orchestrator-session-eligible',
      repositoryId: 'repo-eligible',
      worktreeId: 'main',
      workers: [AGENT_WORKER],
    });

    // Both repositories resolve to the SAME remote (`owner/repo`). Run both
    // list orders to prove the result does not depend on which repository
    // `getAllRepositories()` happens to list first.
    for (const repos of [
      [ineligibleRepo, eligibleRepo],
      [eligibleRepo, ineligibleRepo],
    ]) {
      const deps: TargetResolverDependencies = {
        getSessions: () => [eligibleSession],
        getRepository: () => undefined,
        getAllRepositories: () => repos,
        getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
      };

      const targets = await resolveTargets(createIssueLabeledEvent(), deps);

      expect(targets).toEqual([{ sessionId: 'orchestrator-session-eligible' }]);
    }
  });

  it('returns targets from every eligible same-remote repository, deduplicated by session id', async () => {
    const repoA = buildRepositoryWithDesignation({
      id: 'repo-a',
      path: '/path/to/repo-a',
      orchestratorSessionIds: ['orchestrator-session-a'],
      issueTriggerLabels: 'orchestrator-trigger',
    });
    const repoB = buildRepositoryWithDesignation({
      id: 'repo-b',
      path: '/path/to/repo-b',
      orchestratorSessionIds: ['orchestrator-session-b'],
      issueTriggerLabels: 'orchestrator-trigger',
    });
    const sessionA = buildWorktreeSession({ id: 'orchestrator-session-a', repositoryId: 'repo-a', worktreeId: 'main', workers: [AGENT_WORKER] });
    const sessionB = buildWorktreeSession({ id: 'orchestrator-session-b', repositoryId: 'repo-b', worktreeId: 'main', workers: [AGENT_WORKER] });

    const deps: TargetResolverDependencies = {
      getSessions: () => [sessionA, sessionB],
      getRepository: () => undefined,
      getAllRepositories: () => [repoA, repoB],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createIssueLabeledEvent(), deps);

    expect(targets).toHaveLength(2);
    expect(new Set(targets.map((t) => t.sessionId))).toEqual(
      new Set(['orchestrator-session-a', 'orchestrator-session-b'])
    );

    // Dedup variant: two same-remote repositories designate the SAME
    // session -- only one target must be returned, not two.
    const repoC = buildRepositoryWithDesignation({
      id: 'repo-c',
      path: '/path/to/repo-c',
      orchestratorSessionIds: ['orchestrator-session-shared'],
      issueTriggerLabels: 'orchestrator-trigger',
    });
    const repoD = buildRepositoryWithDesignation({
      id: 'repo-d',
      path: '/path/to/repo-d',
      orchestratorSessionIds: ['orchestrator-session-shared'],
      issueTriggerLabels: 'orchestrator-trigger',
    });
    const sharedSession = buildWorktreeSession({
      id: 'orchestrator-session-shared',
      repositoryId: 'repo-c',
      worktreeId: 'main',
      workers: [AGENT_WORKER],
    });

    const dedupDeps: TargetResolverDependencies = {
      getSessions: () => [sharedSession],
      getRepository: () => undefined,
      getAllRepositories: () => [repoC, repoD],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const dedupTargets = await resolveTargets(createIssueLabeledEvent(), dedupDeps);
    expect(dedupTargets).toEqual([{ sessionId: 'orchestrator-session-shared' }]);
  });

  // -------------------------------------------------------------------
  // CodeRabbit fix-up (PR #1650), Fix 3: a session id surviving in
  // `getSessions()` is not proof anything is listening -- a session with
  // all PTY workers exited stays in the list with
  // `activationState: 'hibernated'`. Routing to it would silently drop the
  // notification while still reporting delivery.
  // -------------------------------------------------------------------

  it('drops the designated session when it exists but is not running (hibernated), logging a distinct reason', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['orchestrator-session-1'],
      issueTriggerLabels: 'orchestrator-trigger',
    });
    const hibernatedSession = buildWorktreeSession({
      id: 'orchestrator-session-1',
      repositoryId: 'repo-1',
      worktreeId: 'main',
      activationState: 'hibernated',
    });
    const deps: TargetResolverDependencies = {
      getSessions: () => [hibernatedSession],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const infoSpy = spyOn(rootLogger, 'info');
    try {
      const targets = await resolveTargets(createIssueLabeledEvent(), deps);

      expect(targets).toEqual([]);

      // Zero targets alone can't distinguish this drop reason from
      // "no live orchestrator session is designated" or "label mismatch" --
      // assert the specific, textually distinct log message fired.
      const matchingCall = infoSpy.mock.calls.find(
        (call) =>
          call[1] === 'issue:labeled event matched repository but the designated orchestrator session is not running'
      );
      expect(matchingCall).toBeDefined();
      expect(matchingCall?.[0]).toMatchObject({
        repositoryId: 'repo-1',
        orchestratorSessionId: 'orchestrator-session-1',
        activationState: 'hibernated',
      });
    } finally {
      infoSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------
  // Issue #1652: `activationState === 'running'` is computed vacuously
  // true when the session has zero agent/terminal-type workers (nothing to
  // hibernate) -- e.g. a worktree session whose only worker is a
  // `git-diff` worker. Such a session passed the "not running" check above
  // and silently swallowed every issue:labeled event, because
  // AgentWorkerHandler.handle() has no `agent`-type worker to resolve a
  // workerId from.
  // -------------------------------------------------------------------

  it('drops the designated session when activationState is (vacuously) running but it has no agent worker to deliver to, logging a distinct reason', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['orchestrator-session-1'],
      issueTriggerLabels: 'orchestrator-trigger',
    });
    const noAgentWorkerSession = buildWorktreeSession({
      id: 'orchestrator-session-1',
      repositoryId: 'repo-1',
      worktreeId: 'main',
      activationState: 'running',
      workers: [
        { id: 'worker-1', type: 'git-diff', name: 'Diff', createdAt: '2024-01-01T00:00:00Z', baseCommit: 'abc123' },
      ],
    });
    const deps: TargetResolverDependencies = {
      getSessions: () => [noAgentWorkerSession],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const infoSpy = spyOn(rootLogger, 'info');
    try {
      const targets = await resolveTargets(createIssueLabeledEvent(), deps);

      expect(targets).toEqual([]);

      // Zero targets alone can't distinguish this drop reason from the
      // other three ("not running" / "label mismatch" / "no live session
      // designated") -- assert the specific, textually distinct log
      // message fired.
      const matchingCall = infoSpy.mock.calls.find(
        (call) =>
          call[1] ===
          'issue:labeled event matched repository but the designated orchestrator session has no agent worker to deliver to'
      );
      expect(matchingCall).toBeDefined();
      expect(matchingCall?.[0]).toMatchObject({
        repositoryId: 'repo-1',
        orchestratorSessionId: 'orchestrator-session-1',
      });
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('matches with multiple configured trigger labels, mixed case, and whitespace around commas', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['orchestrator-session-1'],
      issueTriggerLabels: ' Bug ,  Orchestrator-Trigger,needs-triage ',
    });
    const deps: TargetResolverDependencies = {
      getSessions: () => [createOrchestratorSession()],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createIssueLabeledEvent({ labels: ['Orchestrator-Trigger'] }), deps);

    expect(targets).toEqual([{ sessionId: 'orchestrator-session-1' }]);
  });

  // -------------------------------------------------------------------
  // Set-model boundary cases (Issue #1716), mirroring the fallback
  // describe block's own set of four. "row with [] -> nothing" is already
  // covered above ('...orchestratorSessionIds is empty'); "two same-remote
  // rows designating the same session -> one target" is already covered
  // above ('returns targets from every eligible same-remote repository,
  // deduplicated by session id').
  // -------------------------------------------------------------------

  it('set-model boundary: two designated, one hibernated -> exactly the live one is delivered', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['orchestrator-live', 'orchestrator-hibernated'],
      issueTriggerLabels: 'orchestrator-trigger',
    });
    const liveSession = createOrchestratorSession({ id: 'orchestrator-live' });
    const hibernatedSession = createOrchestratorSession({ id: 'orchestrator-hibernated', activationState: 'hibernated' });
    const deps: TargetResolverDependencies = {
      getSessions: () => [liveSession, hibernatedSession],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createIssueLabeledEvent(), deps);

    expect(targets).toEqual([{ sessionId: 'orchestrator-live' }]);
  });

  it('set-model boundary: three designated, all live -> three targets, one per designated session', async () => {
    const repository = buildRepositoryWithDesignation({
      id: 'repo-1',
      path: '/path/to/repo',
      orchestratorSessionIds: ['orchestrator-1', 'orchestrator-2', 'orchestrator-3'],
      issueTriggerLabels: 'orchestrator-trigger',
    });
    const session1 = createOrchestratorSession({ id: 'orchestrator-1' });
    const session2 = createOrchestratorSession({ id: 'orchestrator-2' });
    const session3 = createOrchestratorSession({ id: 'orchestrator-3' });
    const deps: TargetResolverDependencies = {
      getSessions: () => [session1, session2, session3],
      getRepository: () => repository,
      getAllRepositories: () => [repository],
      getOrgRepoFromPath: mock(() => Promise.resolve('owner/repo')),
    };

    const targets = await resolveTargets(createIssueLabeledEvent(), deps);

    expect(new Set(targets.map((t) => t.sessionId))).toEqual(
      new Set(['orchestrator-1', 'orchestrator-2', 'orchestrator-3'])
    );
    expect(targets).toHaveLength(3);
  });
});

describe('parseTriggerLabels', () => {
  it('returns an empty array for an empty string', () => {
    expect(parseTriggerLabels('')).toEqual([]);
  });

  it('returns an empty array for null', () => {
    expect(parseTriggerLabels(null)).toEqual([]);
  });

  it('returns an empty array for undefined', () => {
    expect(parseTriggerLabels(undefined)).toEqual([]);
  });

  it('parses a single label', () => {
    expect(parseTriggerLabels('bug')).toEqual(['bug']);
  });

  it('parses multiple comma-separated labels', () => {
    expect(parseTriggerLabels('bug,enhancement')).toEqual(['bug', 'enhancement']);
  });

  it('normalizes mixed case to lowercase', () => {
    expect(parseTriggerLabels('Bug,ENHANCEMENT')).toEqual(['bug', 'enhancement']);
  });

  it('trims extra whitespace around entries and commas', () => {
    expect(parseTriggerLabels('  bug ,  enhancement  ')).toEqual(['bug', 'enhancement']);
  });

  it('drops empty entries produced by trailing/duplicate commas', () => {
    expect(parseTriggerLabels('bug,,enhancement,')).toEqual(['bug', 'enhancement']);
  });
});

describe('matchesAnyTriggerLabel', () => {
  it('returns false when triggerLabelsRaw is empty/unset (vacuous-truth boundary)', () => {
    expect(matchesAnyTriggerLabel(['bug'], null)).toBe(false);
    expect(matchesAnyTriggerLabel(['bug'], undefined)).toBe(false);
    expect(matchesAnyTriggerLabel(['bug'], '')).toBe(false);
  });

  it('returns false when eventLabels is empty even with configured labels', () => {
    expect(matchesAnyTriggerLabel([], 'bug')).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(matchesAnyTriggerLabel(['BUG'], 'bug')).toBe(true);
  });

  it('matches when any one of multiple event labels matches', () => {
    expect(matchesAnyTriggerLabel(['unrelated', 'bug'], 'bug,enhancement')).toBe(true);
  });

  it('returns false when no event label matches any configured label', () => {
    expect(matchesAnyTriggerLabel(['unrelated'], 'bug,enhancement')).toBe(false);
  });
});
