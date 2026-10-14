/**
 * Completes the partial entity fixtures that client tests hand to a mocked
 * `fetch`, so the body passes the strict wire schema the API client now parses
 * it with.
 *
 * The REST read fetchers `v.parse` their response; a fixture that lists only
 * the fields a test cares about (an agent without `createdAt`, a repository
 * without `orchestratorSessionIds`) is rejected there. Pass the response body
 * through `completeWireBody` where the test builds its `Response`: missing
 * required fields get inert defaults, fields the fixture sets are never
 * touched, and a body without a recognised envelope key is returned as-is. A
 * new required schema field is then a one-place change here.
 */

type Entity = Record<string, unknown>;

const FIXED_CREATED_AT = '2026-01-01T00:00:00.000Z';

function isEntity(value: unknown): value is Entity {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function completeAgent(agent: unknown): unknown {
  if (!isEntity(agent)) return agent;
  return {
    name: 'Agent',
    commandTemplate: 'agent {{prompt}}',
    isBuiltIn: false,
    createdAt: FIXED_CREATED_AT,
    capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
    ...agent,
  };
}

function completeRepository(repository: unknown): unknown {
  if (!isEntity(repository)) return repository;
  return {
    name: 'repo',
    path: '/repo',
    createdAt: FIXED_CREATED_AT,
    orchestratorSessionIds: [],
    clonedSourceRepoPath: null,
    ...repository,
  };
}

function completeSession(session: unknown): unknown {
  if (!isEntity(session)) return session;
  const base: Entity = {
    locationPath: '/path',
    status: 'active',
    activationState: 'running',
    createdAt: FIXED_CREATED_AT,
    workers: [],
    isShared: false,
    recoveryState: 'healthy',
    ...session,
  };
  if (base.type !== 'worktree') return base;
  return {
    repositoryId: 'repo-1',
    repositoryName: 'repo',
    worktreeId: 'main',
    isMainWorktree: true,
    ...base,
  };
}

/** Fill the schema-required fields a partial `agents` / `repositories` / `session` envelope leaves out. */
export function completeWireBody(body: unknown): unknown {
  if (!isEntity(body)) return body;
  const out: Entity = { ...body };
  if (Array.isArray(out.agents)) out.agents = out.agents.map(completeAgent);
  if (Array.isArray(out.repositories)) out.repositories = out.repositories.map(completeRepository);
  if (isEntity(out.session)) out.session = completeSession(out.session);
  return out;
}
