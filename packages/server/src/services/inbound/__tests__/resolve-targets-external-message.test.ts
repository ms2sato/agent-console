import { describe, it, expect, mock, spyOn, afterEach } from 'bun:test';
import type { InboundSystemEvent, Repository, Session, WorktreeSession } from '@agent-console/shared';
import {
  resolveTargets,
  resolveOrchestratorSessionTargets,
  type TargetResolverDependencies,
} from '../resolve-targets.js';
import { rootLogger } from '../../../lib/logger.js';
import { buildWorktreeSession, buildPersistedRepository } from '../../../__tests__/utils/build-test-data.js';

const AGENT_WORKER = {
  id: 'worker-1',
  type: 'agent' as const,
  name: 'Claude',
  agentId: 'claude-code-builtin',
  activated: true,
  createdAt: '2024-01-01T00:00:00Z',
};
const DIFF_WORKER = {
  id: 'worker-diff',
  type: 'git-diff' as const,
  name: 'Diff',
  createdAt: '2024-01-01T00:00:00Z',
  baseCommit: 'abc123',
};

function createExternalMessageEvent(metadata: Partial<InboundSystemEvent['metadata']> = {}): InboundSystemEvent {
  return {
    type: 'external:message',
    source: 'webhook',
    timestamp: '2024-01-01T00:00:00Z',
    metadata: {
      repositoryName: 'owner/repo',
      targetRepositoryId: 'repo-1',
      deliveryId: 'inbound-webhook:ep1:wh1',
      ...metadata,
    },
    payload: {},
    summary: 'A message',
  };
}

function buildRepository(orchestratorSessionIds: string[]): Repository {
  return {
    ...buildPersistedRepository({ id: 'repo-1', path: '/path/to/repo' }),
    orchestratorSessionIds,
    issueTriggerLabels: null,
  };
}

function designated(id: string, overrides: Partial<WorktreeSession> = {}): Session {
  return buildWorktreeSession({ id, repositoryId: 'repo-1', workers: [AGENT_WORKER], ...overrides });
}

function depsFor(
  repository: Repository | undefined,
  live: Session[],
  paused: Session[] = [],
): { deps: TargetResolverDependencies; getPausedSessions: ReturnType<typeof mock> } {
  const getPausedSessions = mock(async () => paused);
  return {
    getPausedSessions,
    deps: {
      getSessions: () => live,
      getPausedSessions,
      getRepository: (id) => (repository && id === repository.id ? repository : undefined),
      getAllRepositories: () => (repository ? [repository] : []),
      // Would match nothing: external:message must never consult the remote name.
      getOrgRepoFromPath: mock(() => Promise.resolve(null)),
    },
  };
}

function infoMessages(calls: unknown[][]): Array<{ obj: Record<string, unknown>; msg: string }> {
  return calls.map((call) => {
    const [obj, msg] = call;
    return { obj: typeof obj === 'object' && obj !== null ? { ...obj } : {}, msg: String(msg) };
  });
}

describe('resolveTargets: external:message', () => {
  afterEach(() => {
    mock.restore();
  });

  it('missing targetRepositoryId -> []', async () => {
    const { deps } = depsFor(buildRepository(['orch-1']), [designated('orch-1')]);
    const event = createExternalMessageEvent({ targetRepositoryId: undefined });
    expect(await resolveTargets(event, deps)).toEqual([]);
  });

  it('unknown repository -> []', async () => {
    const { deps } = depsFor(buildRepository(['orch-1']), [designated('orch-1')]);
    expect(await resolveTargets(createExternalMessageEvent({ targetRepositoryId: 'nope' }), deps)).toEqual([]);
  });

  it('zero designated sessions -> []', async () => {
    const { deps } = depsFor(buildRepository([]), [designated('orch-1')]);
    expect(await resolveTargets(createExternalMessageEvent(), deps)).toEqual([]);
  });

  it('routes with no repositoryName in the metadata (the branch precedes the repositoryName guard)', async () => {
    const { deps } = depsFor(buildRepository(['orch-1']), [designated('orch-1')]);
    const event = createExternalMessageEvent({ repositoryName: undefined });
    expect(await resolveTargets(event, deps)).toEqual([{ sessionId: 'orch-1', provenance: 'match' }]);
  });

  it('does not use the remote name: a repository whose remote resolves to nothing still routes', async () => {
    const { deps } = depsFor(buildRepository(['orch-1']), [designated('orch-1')]);
    expect(await resolveTargets(createExternalMessageEvent(), deps)).toEqual([{ sessionId: 'orch-1', provenance: 'match' }]);
  });

  it('keeps one live, one paused (deferred) target and excludes hibernated and no-agent-worker sessions, in designation order, each exclusion logged at info', async () => {
    const live = designated('orch-live');
    const hibernated = designated('orch-hibernated', { activationState: 'hibernated' });
    const noAgent = designated('orch-noagent', { workers: [DIFF_WORKER] });
    const paused = designated('orch-paused', { activationState: 'hibernated' });
    const repository = buildRepository(['orch-hibernated', 'orch-paused', 'orch-missing', 'orch-noagent', 'orch-live']);
    const { deps } = depsFor(repository, [live, hibernated, noAgent], [paused]);

    const infoSpy = spyOn(rootLogger, 'info');
    let targets;
    try {
      targets = await resolveTargets(createExternalMessageEvent(), deps);
      const logged = infoMessages(infoSpy.mock.calls);

      expect(targets).toEqual([
        { sessionId: 'orch-paused', provenance: 'match' },
        { sessionId: 'orch-live', provenance: 'match' },
      ]);

      const find = (needle: string) => logged.find((l) => l.msg.includes(needle));
      expect(find('is not running')?.obj).toMatchObject({
        repositoryId: 'repo-1',
        orchestratorSessionId: 'orch-hibernated',
        activationState: 'hibernated',
      });
      expect(find('is not a live session')?.obj).toMatchObject({ repositoryId: 'repo-1', orchestratorSessionId: 'orch-missing' });
      expect(find('has no agent worker')?.obj).toMatchObject({ repositoryId: 'repo-1', orchestratorSessionId: 'orch-noagent' });
      expect(find('paused designated orchestrator session')?.obj).toMatchObject({
        repositoryId: 'repo-1',
        orchestratorSessionId: 'orch-paused',
      });
      for (const needle of ['is not running', 'is not a live session', 'has no agent worker', 'paused designated']) {
        expect(find(needle)?.msg).toContain('external:message');
      }
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('reads the paused provider exactly once per event', async () => {
    const { deps, getPausedSessions } = depsFor(buildRepository(['orch-1', 'orch-2']), [designated('orch-1'), designated('orch-2')]);
    await resolveTargets(createExternalMessageEvent(), deps);
    expect(getPausedSessions).toHaveBeenCalledTimes(1);
  });
});

describe('resolveOrchestratorSessionTargets', () => {
  it('lists a session designated twice once', () => {
    const repository = buildRepository(['orch-1', 'orch-2', 'orch-1']);
    const sessions = [designated('orch-1'), designated('orch-2')];
    expect(resolveOrchestratorSessionTargets(repository, { sessions, pausedIds: new Set() })).toEqual([
      { sessionId: 'orch-1', provenance: 'match' },
      { sessionId: 'orch-2', provenance: 'match' },
    ]);
  });

  it('returns [] when nothing is designated', () => {
    expect(resolveOrchestratorSessionTargets(buildRepository([]), { sessions: [], pausedIds: new Set() })).toEqual([]);
  });
});
