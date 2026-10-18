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

function completeWorker(worker: unknown): unknown {
  if (!isEntity(worker)) return worker;
  const base: Entity = { name: 'Worker', createdAt: FIXED_CREATED_AT, ...worker };
  switch (base.type) {
    case 'agent':
      return { agentId: 'claude-code-builtin', activated: true, ...base };
    case 'terminal':
      return { activated: true, ...base };
    case 'git-diff':
      return { baseCommit: 'abc123', ...base };
    case 'file-viewer':
      return base;
    case 'embedded-agent':
      return {
        embeddedAgentId: 'embedded-1',
        activated: true,
        autoCompaction: true,
        reasoningEffort: null,
        hasParameterOverride: false,
        ...base,
      };
    default:
      return base;
  }
}

function completeEmbeddedAgent(definition: unknown): unknown {
  if (!isEntity(definition)) return definition;
  const sdk = definition.engine === 'claude-sdk';
  return {
    name: 'Embedded agent',
    engine: 'openai-api',
    provider: sdk ? { model: 'sonnet' } : { baseUrl: 'http://localhost:11434/v1', model: 'model' },
    isBuiltIn: false,
    createdBy: 'user-1',
    createdAt: FIXED_CREATED_AT,
    updatedAt: FIXED_CREATED_AT,
    ...definition,
  };
}

function completeValidationResult(result: unknown): unknown {
  if (!isEntity(result)) return result;
  return {
    session: { type: 'quick', locationPath: '/path' },
    valid: true,
    issues: [],
    ...result,
  };
}

function completeReviewItem(item: unknown): unknown {
  if (!isEntity(item)) return item;
  return {
    workerId: 'worker-1',
    sessionId: 'session-1',
    sessionTitle: 'Session',
    sourceSessionId: 'source-1',
    sourceSessionTitle: 'Source',
    annotationCount: 0,
    summary: { totalFiles: 0, reviewFiles: 0, mechanicalFiles: 0, confidence: 'high' },
    status: 'pending',
    commentCount: 0,
    createdAt: FIXED_CREATED_AT,
    ...item,
  };
}

function completeWorkerMessage(message: unknown): unknown {
  if (!isEntity(message)) return message;
  return {
    sessionId: 's1',
    fromWorkerId: 'w1',
    fromWorkerName: 'A',
    toWorkerId: 'w2',
    toWorkerName: 'B',
    content: 'x',
    timestamp: FIXED_CREATED_AT,
    ...message,
  };
}

function completeReviewGroup(group: unknown): unknown {
  if (!isEntity(group) || !Array.isArray(group.items)) return group;
  return { ...group, items: group.items.map(completeReviewItem) };
}

/**
 * Fill the schema-required fields a partial `agents` / `repositories` / `session` / `worker` / `message` / `embeddedAgents` / `embeddedAgent` / `results`
 * (session validation) envelope, or a bare review-queue array of groups, leaves out.
 */
export function completeWireBody(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(completeReviewGroup);
  if (!isEntity(body)) return body;
  const out: Entity = { ...body };
  if (Array.isArray(out.results)) out.results = out.results.map(completeValidationResult);
  if (Array.isArray(out.agents)) out.agents = out.agents.map(completeAgent);
  if (Array.isArray(out.repositories)) out.repositories = out.repositories.map(completeRepository);
  if (isEntity(out.session)) out.session = completeSession(out.session);
  if (isEntity(out.worker)) out.worker = completeWorker(out.worker);
  if (isEntity(out.message)) out.message = completeWorkerMessage(out.message);
  if (Array.isArray(out.embeddedAgents)) out.embeddedAgents = out.embeddedAgents.map(completeEmbeddedAgent);
  if (isEntity(out.embeddedAgent)) out.embeddedAgent = completeEmbeddedAgent(out.embeddedAgent);
  return out;
}
