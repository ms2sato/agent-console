/**
 * `initializeInboundIntegration` registers BOTH job handlers on the queue it is given, and the
 * `inbound-webhook:process` handler it registers is wired to the endpoint repository and the
 * action (real RepositoryManager and SessionManager, capture-only queue).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import type { InboundWebhookProcessPayload } from '@agent-console/shared';
import { setupMemfs, cleanupMemfs } from '../../../__tests__/utils/mock-fs-helper.js';
import { createMockPtyFactory } from '../../../__tests__/utils/mock-pty.js';
import { mockProcess, resetProcessMock } from '../../../__tests__/utils/mock-process-helper.js';
import { resetGitMocks } from '../../../__tests__/utils/mock-git-helper.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../../database/connection.js';
import { JOB_TYPES, type JobQueue, type JobHandler } from '../../../jobs/index.js';
import { SessionManager } from '../../session-manager.js';
import { RepositoryManager } from '../../repository-manager.js';
import { AgentManager } from '../../agent-manager.js';
import { EmbeddedAgentManager } from '../../embedded-agent-manager.js';
import { SqliteAgentRepository } from '../../../repositories/sqlite-agent-repository.js';
import { SqliteEmbeddedAgentRepository } from '../../../repositories/sqlite-embedded-agent-repository.js';
import { SqliteRepositoryRepository } from '../../../repositories/sqlite-repository-repository.js';
import { SqliteSessionRepository } from '../../../repositories/sqlite-session-repository.js';
import { SqliteUserRepository } from '../../../repositories/sqlite-user-repository.js';
import { SqliteInboundWebhookEndpointRepository } from '../../../repositories/sqlite-inbound-webhook-endpoint-repository.js';
import { SingleUserMode } from '../../user-mode.js';
import { McpTokenRegistry } from '../../../mcp/mcp-auth.js';
import { AnnotationService } from '../../annotation-service.js';
import { initializeInboundIntegration } from '../index.js';
import { repositoryLookupFromSlug } from '../../../__tests__/utils/repository-lookup-mock.js';

/** `JobQueue` has private fields; `Partial<JobQueue>` keeps the brand, so one cast type-checks. */
function asJobQueue(stub: Partial<JobQueue>): JobQueue {
  return stub as JobQueue;
}

const TEST_CONFIG_DIR = '/test/config-inbound-index-webhook';
const TEST_REPO_PATH = '/test/repo-inbound-index-webhook';
const REPO_ID = 'repo-inbound-index-webhook';

describe('initializeInboundIntegration: job handler registration', () => {
  const ptyFactory = createMockPtyFactory();
  let sessionManager: SessionManager;
  let repositoryManager: RepositoryManager;
  const registered = new Map<string, JobHandler<never>>();

  beforeEach(async () => {
    await closeDatabase();
    registered.clear();
    setupMemfs({ [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main', [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    await initializeDatabase(':memory:');
    resetProcessMock();
    mockProcess.markAlive(process.pid);
    ptyFactory.reset();
    resetGitMocks();

    const db = getDatabase();
    const agentManager = await AgentManager.create(new SqliteAgentRepository(db));
    const embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(db));
    const repositoryRepo = new SqliteRepositoryRepository(db);
    await repositoryRepo.save({
      id: REPO_ID,
      name: 'test-repo',
      path: TEST_REPO_PATH,
      createdAt: new Date().toISOString(),
      orchestratorSessionIds: [],
      clonedSourceRepoPath: null,
    });
    repositoryManager = await RepositoryManager.create({ repository: repositoryRepo });
    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository: new SqliteSessionRepository(db),
      agentManager,
      embeddedAgentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      annotationService: new AnnotationService(),
      userRepository: new SqliteUserRepository(db),
      repositoryLookup: repositoryLookupFromSlug(async (id: string) => repositoryManager.getRepositorySlug(id)),
      repositoryEnvLookup: {
        getRepositoryInfo: (id: string) => {
          const r = repositoryManager.getRepository(id);
          return r ? { name: r.name, path: r.path, envVars: r.envVars } : undefined;
        },
        getWorktreeIndexNumber: async () => 0,
      },
    });
  });

  afterEach(async () => {
    await closeDatabase();
    cleanupMemfs();
    delete process.env.AGENT_CONSOLE_HOME;
  });

  function initialize(): void {
    initializeInboundIntegration({
      db: getDatabase(),
      jobQueue: asJobQueue({
        registerHandler: <T>(type: string, handler: JobHandler<T>) => {
          registered.set(type, handler as JobHandler<never>);
        },
      }),
      sessionManager,
      repositoryManager,
      broadcastToApp: () => {},
    });
  }

  function payloadFor(endpointId: string): InboundWebhookProcessPayload {
    return {
      jobId: `inbound-webhook:${endpointId}:wh-1`,
      endpointId,
      rawPayload: JSON.stringify({ message: 'hello' }),
      receivedAt: '2026-11-08T00:00:00.000Z',
    };
  }

  it('registers a handler for both inbound job types on the queue it is given', () => {
    initialize();
    expect([...registered.keys()].sort()).toEqual([JOB_TYPES.INBOUND_EVENT_PROCESS, JOB_TYPES.INBOUND_WEBHOOK_PROCESS].sort());
  });

  it('the webhook handler completes without throwing for a deleted endpoint and never reaches the repository lookup', async () => {
    initialize();
    const lookup = spyOn(repositoryManager, 'getRepository');
    const handler = registered.get(JOB_TYPES.INBOUND_WEBHOOK_PROCESS) as JobHandler<InboundWebhookProcessPayload>;

    await expect(handler(payloadFor('ep-deleted'))).resolves.toBeUndefined();

    expect(lookup).not.toHaveBeenCalled();
  });

  it('the webhook handler reaches the action for a live endpoint', async () => {
    await new SqliteInboundWebhookEndpointRepository(getDatabase()).create({
      id: 'ep-live',
      label: 'Slack',
      repositoryId: REPO_ID,
      instructionText: 'Do it',
      secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
      now: '2026-11-07T00:00:00.000Z',
    });
    initialize();
    const lookup = spyOn(repositoryManager, 'getRepository');
    const handler = registered.get(JOB_TYPES.INBOUND_WEBHOOK_PROCESS) as JobHandler<InboundWebhookProcessPayload>;

    await handler(payloadFor('ep-live'));

    expect(lookup).toHaveBeenCalledWith(REPO_ID);
  });
});
