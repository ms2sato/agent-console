/**
 * `initializeInboundIntegration` wiring tests.
 *
 * This function previously had no direct sibling test (only exercised
 * transitively through server startup). Adding `getAllRepositories` to the
 * `resolveTargets` closure (for `issue:labeled` routing) is a real behavior
 * change to this file, so this suite drives the actual registered job
 * handler end-to-end -- real `RepositoryManager` and real `SessionManager`,
 * a capture-only fake `JobQueue` (mirrors the pattern documented in
 * `repository-manager.test.ts`'s `runLatestCleanupRepositoryJob`) -- and
 * asserts a labeled-Issue webhook reaches the repository's designated
 * Orchestrator session via the real `resolveTargets` wiring, not a
 * re-implementation of it.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { InboundEventJobPayload } from '@agent-console/shared';
import { setupMemfs, cleanupMemfs } from '../../../__tests__/utils/mock-fs-helper.js';
import { createMockPtyFactory } from '../../../__tests__/utils/mock-pty.js';
import { mockProcess, resetProcessMock } from '../../../__tests__/utils/mock-process-helper.js';
import { resetGitMocks } from '../../../__tests__/utils/mock-git-helper.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../../database/connection.js';
import type { JobQueue } from '../../../jobs/job-queue.js';
import type { JobHandler } from '../../../jobs/job-queue.js';
import { JOB_TYPES } from '../../../jobs/index.js';
import { SessionManager } from '../../session-manager.js';
import { RepositoryManager } from '../../repository-manager.js';
import { AgentManager } from '../../agent-manager.js';
import { EmbeddedAgentManager } from '../../embedded-agent-manager.js';
import { SqliteAgentRepository } from '../../../repositories/sqlite-agent-repository.js';
import { SqliteEmbeddedAgentRepository } from '../../../repositories/sqlite-embedded-agent-repository.js';
import { SqliteRepositoryRepository } from '../../../repositories/sqlite-repository-repository.js';
import { SqliteSessionRepository } from '../../../repositories/sqlite-session-repository.js';
import { SqliteUserRepository } from '../../../repositories/sqlite-user-repository.js';
import { SingleUserMode } from '../../user-mode.js';
import { McpTokenRegistry } from '../../../mcp/mcp-auth.js';
import { AnnotationService } from '../../annotation-service.js';
import { initializeInboundIntegration } from '../index.js';

/**
 * `JobQueue` has private fields, so a stub object literal cannot satisfy it
 * structurally. `Partial<JobQueue>` retains the same private brand, so this
 * single-step cast type-checks without bridging through `unknown`.
 */
function asJobQueue(stub: Partial<JobQueue>): JobQueue {
  return stub as JobQueue;
}

const TEST_CONFIG_DIR = '/test/config-inbound-index';
const TEST_REPO_PATH = '/test/repo-inbound-index';
const TEST_REPO_ID = 'repo-inbound-index';

describe('initializeInboundIntegration', () => {
  const ptyFactory = createMockPtyFactory();
  let sessionManager: SessionManager;
  let repositoryManager: RepositoryManager;
  let capturedHandler: JobHandler<InboundEventJobPayload> | undefined;

  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({
      [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    await initializeDatabase(':memory:');
    resetProcessMock();
    mockProcess.markAlive(process.pid);
    ptyFactory.reset();
    resetGitMocks();

    const db = getDatabase();
    const agentManager = await AgentManager.create(new SqliteAgentRepository(db));
    const embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(db));
    const userRepository = new SqliteUserRepository(db);

    const sqliteRepoRepo = new SqliteRepositoryRepository(db);
    await sqliteRepoRepo.save({
      id: TEST_REPO_ID,
      name: 'test-repo',
      path: TEST_REPO_PATH,
      createdAt: new Date().toISOString(),
      orchestratorSessionIds: [],
      clonedSourceRepoPath: null,
    });
    repositoryManager = await RepositoryManager.create({ repository: sqliteRepoRepo });

    const sessionRepository = new SqliteSessionRepository(db);
    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      agentManager,
      embeddedAgentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      annotationService: new AnnotationService(),
      userRepository,
      repositoryLookup: { getRepositorySlug: async (id: string) => repositoryManager.getRepositorySlug(id) },
      repositoryEnvLookup: {
        getRepositoryInfo: (id: string) => {
          const r = repositoryManager.getRepository(id);
          return r ? { name: r.name, path: r.path, envVars: r.envVars } : undefined;
        },
        getWorktreeIndexNumber: async () => 0,
      },
    });

    capturedHandler = undefined;
  });

  afterEach(async () => {
    await closeDatabase();
    cleanupMemfs();
    delete process.env.AGENT_CONSOLE_HOME;
  });

  function createFakeJobQueue(): JobQueue {
    return asJobQueue({
      registerHandler: <T>(type: string, handler: JobHandler<T>) => {
        if (type === JOB_TYPES.INBOUND_EVENT_PROCESS) {
          capturedHandler = handler as JobHandler<InboundEventJobPayload>;
        }
      },
    });
  }

  function buildLabeledIssuePayload(): InboundEventJobPayload {
    return {
      jobId: 'job-1',
      service: 'github',
      rawPayload: JSON.stringify({
        action: 'labeled',
        label: { name: 'orchestrator-trigger' },
        issue: { number: 1, title: 'Some issue' },
        repository: { full_name: 'owner/repo' },
      }),
      headers: { 'x-github-event': 'issues' },
      receivedAt: new Date().toISOString(),
    };
  }

  it('registers the github service parser', () => {
    const instance = initializeInboundIntegration({
      db: getDatabase(),
      jobQueue: createFakeJobQueue(),
      sessionManager,
      repositoryManager,
      broadcastToApp: () => {},
    });

    expect(instance.parserRegistry.get('github')).not.toBeNull();
  });

  it('routes a labeled-Issue webhook to the repository designated Orchestrator session via the real resolveTargets wiring', async () => {
    const orchestratorSession = await sessionManager.createSession({
      type: 'worktree',
      locationPath: TEST_REPO_PATH,
      repositoryId: TEST_REPO_ID,
      worktreeId: 'main',
    });
    await repositoryManager.addOrchestratorSession(TEST_REPO_ID, orchestratorSession.id);
    await repositoryManager.updateRepository(TEST_REPO_ID, { issueTriggerLabels: 'orchestrator-trigger' });

    const broadcastToApp = mock(() => {});
    initializeInboundIntegration({
      db: getDatabase(),
      jobQueue: createFakeJobQueue(),
      sessionManager,
      repositoryManager,
      broadcastToApp,
    });

    expect(capturedHandler).toBeDefined();
    await capturedHandler!(buildLabeledIssuePayload());

    // UINotificationHandler broadcasts `inbound-event` for the resolved
    // target session -- this is the observable that proves
    // `getAllRepositories` reached resolveTargets and the repository/label
    // match resolved to the designated Orchestrator session, not a
    // re-implementation of resolveTargets' own unit tests.
    expect(broadcastToApp).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'inbound-event',
        sessionId: orchestratorSession.id,
        event: expect.objectContaining({ type: 'issue:labeled' }),
      }),
    );
  });

  it('does not route a labeled-Issue webhook when no repository matches the configured trigger label', async () => {
    const orchestratorSession = await sessionManager.createSession({
      type: 'worktree',
      locationPath: TEST_REPO_PATH,
      repositoryId: TEST_REPO_ID,
      worktreeId: 'main',
    });
    await repositoryManager.addOrchestratorSession(TEST_REPO_ID, orchestratorSession.id);
    // issueTriggerLabels intentionally left unset.

    const broadcastToApp = mock(() => {});
    initializeInboundIntegration({
      db: getDatabase(),
      jobQueue: createFakeJobQueue(),
      sessionManager,
      repositoryManager,
      broadcastToApp,
    });

    await capturedHandler!(buildLabeledIssuePayload());

    expect(broadcastToApp).not.toHaveBeenCalled();
  });
});
