/**
 * Unit tests for WorkerLifecycleManager.
 *
 * Tests the session-aware worker lifecycle operations in isolation
 * by using a real WorkerManager with mock PTY provider and
 * mocking the session-related dependencies (getSession, persistSession, etc.).
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import type { CreateWorkerParams, EmbeddedAgentDefinition, NotificationContext, Session, Worker } from '@agent-console/shared';
import { ValidationError } from '../../lib/errors.js';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { resetGitMocks, mockGit } from '../../__tests__/utils/mock-git-helper.js';
import { buildInternalWorktreeSession, buildInternalQuickSession } from '../../__tests__/utils/build-test-data.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { AgentManager, CLAUDE_CODE_AGENT_ID } from '../agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { WorkerManager } from '../worker-manager.js';
import { SingleUserMode } from '../user-mode.js';
import { WorkerLifecycleManager, type WorkerLifecycleDeps } from '../worker-lifecycle-manager.js';
import type { InternalAgentWorker, InternalTerminalWorker, InternalGitDiffWorker } from '../worker-types.js';
import type { InternalSession } from '../internal-types.js';
import type { SessionLifecycleCallbacks } from '../session-lifecycle-types.js';
import { JobQueue } from '../../jobs/index.js';
import { SessionDataPathResolver } from '../../lib/session-data-path-resolver.js';
import { InvalidSessionDataScopeError } from '../../lib/session-data-path.js';
import { AnnotationService } from '../annotation-service.js';
import { InterSessionMessageService } from '../inter-session-message-service.js';
import { WorkerOutputFileManager } from '../../lib/worker-output-file.js';
import * as gitDiffService from '../git-diff-service.js';
import type { InternalEmbeddedAgentWorker } from '../worker-types.js';
import { McpTokenRegistry } from '../../mcp/mcp-auth.js';
import { NotificationManager } from '../notifications/notification-manager.js';
import type { SlackHandler } from '../notifications/slack-handler.js';

const TEST_CONFIG_DIR = '/test/config';

// Embedded-agent definition the createWorker path resolves against. The stub
// below returns it only for its own id, so any other id is treated as dangling.
const EMBEDDED_AGENT_DEF: EmbeddedAgentDefinition = {
  id: 'def-1',
  name: 'My Local Model',
  engine: 'openai-api',
  provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
  isBuiltIn: false,
  createdBy: 'user-1',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

// A claude-sdk-engine sibling definition, used by the model/reasoningEffort
// capability-validation tests below (reasoningEffort's acceptedValues list is
// only non-null for claude-sdk in the production table).
const EMBEDDED_AGENT_DEF_SDK: EmbeddedAgentDefinition = {
  id: 'def-sdk',
  name: 'Claude SDK Agent',
  engine: 'claude-sdk',
  provider: { model: 'claude-opus-4-6' },
  isBuiltIn: true,
  createdBy: 'user-1',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const embeddedAgentManagerStub = {
  getEmbeddedAgent: (id: string): EmbeddedAgentDefinition | undefined => {
    if (id === EMBEDDED_AGENT_DEF.id) return EMBEDDED_AGENT_DEF;
    if (id === EMBEDDED_AGENT_DEF_SDK.id) return EMBEDDED_AGENT_DEF_SDK;
    return undefined;
  },
};

// Records embedded-agent deactivation calls so the deleteWorker embedded branch
// can be asserted (polarity guard for the deactivate-before-cleanup wiring).
const mockDeactivateEmbeddedAgentWorker = mock(async (_sessionId: string, _workerId: string) => {});

// Records embedded-agent activation calls so restartAgentWorkerAsEmbedded's
// "activate immediately after conversion" step can be asserted without
// spawning a real subprocess. Individual tests override this via
// createDeps({ activateEmbeddedAgentWorker: ... }) when they need to force a
// specific outcome (e.g. an activation failure).
const mockActivateEmbeddedAgentWorker = mock(async (_sessionId: string, _workerId: string) => {});

// Mock PTY factory
const ptyFactory = createMockPtyFactory(10000);

// Test JobQueue instance (created fresh for each test)
let testJobQueue: JobQueue | null = null;

describe('WorkerLifecycleManager', () => {
  let workerManager: WorkerManager;
  let lifecycleManager: WorkerLifecycleManager;
  let agentManager: AgentManager;
  let sessions: Map<string, InternalSession>;
  let mockPersistSession: ReturnType<typeof mock>;
  let mockPathExists: ReturnType<typeof mock>;
  let mockCallbacks: SessionLifecycleCallbacks;
  let mockOnSessionUpdated: ReturnType<typeof mock>;
  let mockOnWorkerActivated: ReturnType<typeof mock>;
  let mockOnWorkerRestarted: ReturnType<typeof mock>;
  let mockOnDiffBaseCommitChanged: ReturnType<typeof mock>;
  let originalAgentConsoleHome: string | undefined;

  function createTestSession(overrides?: Parameters<typeof buildInternalWorktreeSession>[1]) {
    return buildInternalWorktreeSession([], { locationPath: '/test/project', ...overrides });
  }

  function createQuickSession(overrides?: Parameters<typeof buildInternalQuickSession>[1]) {
    return buildInternalQuickSession([], { locationPath: '/test/project', ...overrides });
  }

  function createDeps(overrides: Partial<WorkerLifecycleDeps> = {}): WorkerLifecycleDeps {
    return {
      workerManager,
      agentManager,
      embeddedAgentManager: embeddedAgentManagerStub,
      deactivateEmbeddedAgentWorker: mockDeactivateEmbeddedAgentWorker,
      activateEmbeddedAgentWorker: mockActivateEmbeddedAgentWorker,
      notificationManager: null,
      pathExists: mockPathExists as unknown as (path: string) => Promise<boolean>,
      getSession: (id: string) => sessions.get(id),
      persistSession: mockPersistSession as unknown as (session: InternalSession) => Promise<void>,
      getRepositoryEnvVars: async () => ({}),
      toPublicSession: (session: InternalSession) => {
        const ptyWorkers = Array.from(session.workers.values()).filter(
          (w) => w.type === 'agent' || w.type === 'terminal'
        ) as Array<InternalAgentWorker | InternalTerminalWorker>;
        const activationState = ptyWorkers.length === 0
          ? 'running' as const
          : ptyWorkers.some((w) => w.pty !== null) ? 'running' as const : 'hibernated' as const;
        return {
          ...session,
          activationState,
          workers: Array.from(session.workers.values()).map((w) =>
            workerManager.toPublicWorker(w)
          ),
        } as Session;
      },
      resolveSpawnUsername: async () => 'testuser',
      getJobQueue: () => testJobQueue,
      getSessionLifecycleCallbacks: () => mockCallbacks,
      getPathResolver: () => new SessionDataPathResolver(`${TEST_CONFIG_DIR}/_quick`),
      getSessionScope: () => ({ scope: 'quick', slug: null }),
      getPathResolverByPersistedSessionId: async () => new SessionDataPathResolver(`${TEST_CONFIG_DIR}/_quick`),
      annotationService: new AnnotationService(),
      workerOutputFileManager: new WorkerOutputFileManager(),
      interSessionMessageService: new InterSessionMessageService(),
      ...overrides,
    };
  }

  beforeEach(async () => {
    await closeDatabase();

    originalAgentConsoleHome = process.env.AGENT_CONSOLE_HOME;

    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    await initializeDatabase(':memory:');

    testJobQueue = new JobQueue(getDatabase());

    resetProcessMock();
    mockProcess.markAlive(process.pid);

    ptyFactory.reset();
    resetGitMocks();

    const db = getDatabase();
    agentManager = await AgentManager.create(new SqliteAgentRepository(db));

    sessions = new Map();
    mockPersistSession = mock(() => Promise.resolve());
    mockPathExists = mock(() => Promise.resolve(true));
    mockOnSessionUpdated = mock(() => {});
    mockOnWorkerActivated = mock(() => {});
    mockOnWorkerRestarted = mock(() => {});
    mockOnDiffBaseCommitChanged = mock(() => {});
    mockCallbacks = {
      onSessionUpdated: mockOnSessionUpdated as any,
      onWorkerActivated: mockOnWorkerActivated as any,
      onWorkerRestarted: mockOnWorkerRestarted as any,
      onDiffBaseCommitChanged: mockOnDiffBaseCommitChanged as any,
    };

    const userMode = new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' });
    workerManager = new WorkerManager(userMode, agentManager, new WorkerOutputFileManager());
    lifecycleManager = new WorkerLifecycleManager(createDeps());
  });

  afterEach(async () => {
    if (testJobQueue) {
      await testJobQueue.stop();
      testJobQueue = null;
    }
    await closeDatabase();
    cleanupMemfs();

    // Restore original environment variable to prevent test pollution
    if (originalAgentConsoleHome !== undefined) {
      process.env.AGENT_CONSOLE_HOME = originalAgentConsoleHome;
    } else {
      delete process.env.AGENT_CONSOLE_HOME;
    }
  });

  // ========== Worker Creation ==========

  describe('createWorker', () => {
    it('should create an agent worker successfully', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const request: CreateWorkerParams = {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      };

      const worker = await lifecycleManager.createWorker(session.id, request);

      expect(worker).not.toBeNull();
      expect(worker!.type).toBe('agent');
      if (worker!.type === 'agent') {
        expect(worker!.agentId).toBe(CLAUDE_CODE_AGENT_ID);
      }
      expect(session.workers.size).toBe(1);
      expect(ptyFactory.instances.length).toBe(1);
    });

    it('should mark an agent worker eligible for initial-prompt redelivery when created with a non-empty initialPrompt (Issue #1236)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      // Mock out activation: this test only asserts the eligibility flag on
      // the initialized worker object, not the real prompt-file write --
      // a non-empty initialPrompt would otherwise trigger a real elevated
      // `cat >` subprocess spawn via the unmocked `runAsUser`.
      const spy = spyOn(workerManager, 'activateAgentWorkerPty').mockImplementation(async () => {});
      try {
        const request: CreateWorkerParams = {
          type: 'agent',
          agentId: CLAUDE_CODE_AGENT_ID,
        };

        // Mirrors SessionManager.createSession's initial-worker call shape:
        // createWorker(id, request, startupPreference, initialPrompt, templateVars).
        const worker = await lifecycleManager.createWorker(session.id, request, 'fresh', 'Do the thing');

        const internal = session.workers.get(worker!.id) as InternalAgentWorker;
        expect(internal.deliverInitialPromptOnActivation).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('should NOT mark an agent worker eligible when created without an initialPrompt (generic add-worker route shape) (Issue #1236)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const request: CreateWorkerParams = {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      };

      // Mirrors routes/workers.ts's generic add-worker call shape: no
      // initialPrompt argument is passed at all.
      const worker = await lifecycleManager.createWorker(session.id, request, 'fresh');

      const internal = session.workers.get(worker!.id) as InternalAgentWorker;
      expect(internal.deliverInitialPromptOnActivation).toBe(false);
    });

    it('should NOT mark an agent worker eligible when initialPrompt is whitespace-only (Issue #1236)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const request: CreateWorkerParams = {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      };

      const worker = await lifecycleManager.createWorker(session.id, request, 'fresh', '   ');

      const internal = session.workers.get(worker!.id) as InternalAgentWorker;
      expect(internal.deliverInitialPromptOnActivation).toBe(false);
    });

    it('should create a terminal worker successfully', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const request: CreateWorkerParams = {
        type: 'terminal',
        name: 'My Terminal',
      };

      const worker = await lifecycleManager.createWorker(session.id, request);

      expect(worker).not.toBeNull();
      expect(worker!.type).toBe('terminal');
      expect(worker!.name).toBe('My Terminal');
      expect(session.workers.size).toBe(1);
      expect(ptyFactory.instances.length).toBe(1);
    });

    it('should create a git-diff worker successfully', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const request: CreateWorkerParams = {
        type: 'git-diff',
      };

      const worker = await lifecycleManager.createWorker(session.id, request);

      expect(worker).not.toBeNull();
      expect(worker!.type).toBe('git-diff');
      expect(session.workers.size).toBe(1);
      // git-diff workers do not spawn PTY processes
      expect(ptyFactory.instances.length).toBe(0);
    });

    it('resolves the worktree-owning username for the initial computeDefaultBaseSpec call (Issue #869)', async () => {
      // The git-diff branch of createWorker must call resolveSpawnUsername so
      // multi-user mode runs the initial `git symbolic-ref / rev-parse` ops as
      // the worktree owner, not the server process user — otherwise git
      // refuses with "dubious ownership in repository".
      let resolveSpawnCalls = 0;
      const lifecycleWithSpy = new WorkerLifecycleManager(
        createDeps({
          resolveSpawnUsername: async (createdBy) => {
            resolveSpawnCalls++;
            expect(createdBy).toBeUndefined();
            return 'worktreeowner';
          },
        }),
      );

      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleWithSpy.createWorker(session.id, { type: 'git-diff' });

      expect(worker).not.toBeNull();
      expect(worker!.type).toBe('git-diff');
      expect(resolveSpawnCalls).toBe(1);
    });

    it('should create a deactivated embedded-agent worker without spawning anything', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const request: CreateWorkerParams = {
        type: 'embedded-agent',
        embeddedAgentId: 'def-1',
      };

      const worker = await lifecycleManager.createWorker(session.id, request);

      expect(worker).not.toBeNull();
      expect(worker!.type).toBe('embedded-agent');
      if (worker!.type === 'embedded-agent') {
        expect(worker!.embeddedAgentId).toBe('def-1');
        expect(worker!.activated).toBe(false);
      }
      // Name defaults to the resolved definition's name (parallel to agents).
      expect(worker!.name).toBe('My Local Model');
      expect(session.workers.size).toBe(1);
      // Phase 1: no subprocess is spawned and no PTY is created.
      expect(ptyFactory.instances.length).toBe(0);
      const internal = session.workers.get(worker!.id) as InternalEmbeddedAgentWorker;
      expect(internal.subprocess).toBeNull();
      expect(internal.stdin).toBeNull();
      // Persisted as part of creation.
      expect(mockPersistSession).toHaveBeenCalled();
    });

    it('should mark an embedded-agent worker eligible for initial-prompt delivery when created with a non-empty initialPrompt', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const request: CreateWorkerParams = {
        type: 'embedded-agent',
        embeddedAgentId: 'def-1',
      };

      // Mirrors SessionManager.createSession's initial-worker call shape:
      // createWorker(id, request, startupPreference, initialPrompt, templateVars).
      const worker = await lifecycleManager.createWorker(session.id, request, 'fresh', 'Do the thing');

      const internal = session.workers.get(worker!.id) as InternalEmbeddedAgentWorker;
      expect(internal.deliverInitialPromptOnActivation).toBe(true);
    });

    it('should NOT mark an embedded-agent worker eligible when created without an initialPrompt (generic add-worker route shape)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const request: CreateWorkerParams = {
        type: 'embedded-agent',
        embeddedAgentId: 'def-1',
      };

      // Mirrors routes/workers.ts's generic add-worker call shape: no
      // initialPrompt argument is passed at all.
      const worker = await lifecycleManager.createWorker(session.id, request, 'fresh');

      const internal = session.workers.get(worker!.id) as InternalEmbeddedAgentWorker;
      expect(internal.deliverInitialPromptOnActivation).toBe(false);
    });

    it('should NOT mark an embedded-agent worker eligible when initialPrompt is whitespace-only', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const request: CreateWorkerParams = {
        type: 'embedded-agent',
        embeddedAgentId: 'def-1',
      };

      const worker = await lifecycleManager.createWorker(session.id, request, 'fresh', '   ');

      const internal = session.workers.get(worker!.id) as InternalEmbeddedAgentWorker;
      expect(internal.deliverInitialPromptOnActivation).toBe(false);
    });

    it('should reject a dangling embeddedAgentId and persist nothing', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const request: CreateWorkerParams = {
        type: 'embedded-agent',
        embeddedAgentId: 'does-not-exist',
      };

      await expect(lifecycleManager.createWorker(session.id, request)).rejects.toBeInstanceOf(
        ValidationError,
      );

      // Nothing was persisted and no worker was added to the session.
      expect(mockPersistSession).not.toHaveBeenCalled();
      expect(session.workers.size).toBe(0);
      expect(ptyFactory.instances.length).toBe(0);
    });

    it('should honor an explicit worker name over the definition name', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const request: CreateWorkerParams = {
        type: 'embedded-agent',
        name: 'Custom Name',
        embeddedAgentId: 'def-1',
      };

      const worker = await lifecycleManager.createWorker(session.id, request);

      expect(worker!.name).toBe('Custom Name');
    });

    it('should return null when session is not found', async () => {
      const request: CreateWorkerParams = {
        type: 'terminal',
      };

      const worker = await lifecycleManager.createWorker('non-existent', request);

      expect(worker).toBeNull();
    });

    // Delegated sessions carry an optional sshAuthSockFallback on the
    // InternalSession; createWorker must thread that value into the
    // activation context so the user-mode layer can forward it to the
    // elevation helper. We spy on WorkerManager.activateAgentWorkerPty
    // and read the `context.sshAuthSockFallback` argument to prove
    // propagation -- not just that the worker was created.
    it('should propagate session.sshAuthSockFallback into agent worker activation context', async () => {
      const session = createTestSession();
      (session as unknown as { sshAuthSockFallback?: string }).sshAuthSockFallback =
        '/home/alice/.1password/agent.sock';
      sessions.set(session.id, session);

      const originalActivate = workerManager.activateAgentWorkerPty.bind(workerManager);
      const captured: { lastContext?: { sshAuthSockFallback?: string } } = {};
      const spy = spyOn(workerManager, 'activateAgentWorkerPty').mockImplementation(
        async (worker, params) => {
          captured.lastContext = params.context;
          return originalActivate(worker, params);
        },
      );

      try {
        const worker = await lifecycleManager.createWorker(session.id, {
          type: 'agent',
          agentId: CLAUDE_CODE_AGENT_ID,
        });

        expect(worker).not.toBeNull();
        expect(worker!.type).toBe('agent');
        expect(spy).toHaveBeenCalledTimes(1);
        expect(captured.lastContext?.sshAuthSockFallback).toBe(
          '/home/alice/.1password/agent.sock',
        );
      } finally {
        spy.mockRestore();
      }
    });

    // Multi-user embedded-agent MCP auth (Issue #1030 Phase 4) needs the
    // spawned worker's owning user threaded from session.createdBy through
    // activateAgentWorkerPty's createdByUserId param -- that's what the
    // MCP token gets minted for. This wiring had zero coverage before this
    // test: a silent regression (dropped field or wrong value) would leave
    // every existing test green while multi-user agents got no MCP token.
    it('should thread session.createdBy into activateAgentWorkerPty as createdByUserId', async () => {
      const session = createTestSession({ createdBy: 'user-42' });
      sessions.set(session.id, session);

      const spy = spyOn(workerManager, 'activateAgentWorkerPty');

      try {
        const worker = await lifecycleManager.createWorker(session.id, {
          type: 'agent',
          agentId: CLAUDE_CODE_AGENT_ID,
        });

        expect(worker).not.toBeNull();
        expect(spy).toHaveBeenCalledTimes(1);
        const params = spy.mock.calls[0][1];
        expect(params.createdByUserId).toBe('user-42');
      } finally {
        spy.mockRestore();
      }
    });

    it('should persist session after creating a worker', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const request: CreateWorkerParams = {
        type: 'terminal',
      };

      await lifecycleManager.createWorker(session.id, request);

      expect(mockPersistSession).toHaveBeenCalledTimes(1);
    });

    it('should add worker to session workers map', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const request: CreateWorkerParams = {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      };

      const worker = await lifecycleManager.createWorker(session.id, request);

      expect(session.workers.size).toBe(1);
      const internalWorker = session.workers.get(worker!.id);
      expect(internalWorker).toBeDefined();
      expect(internalWorker!.type).toBe('agent');
    });

    it('should use provided name instead of auto-generating', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const request: CreateWorkerParams = {
        type: 'terminal',
        name: 'Custom Shell',
      };

      const worker = await lifecycleManager.createWorker(session.id, request);

      expect(worker!.name).toBe('Custom Shell');
    });

    it('should auto-generate terminal worker name with incrementing number', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      // Create first terminal worker (auto-name)
      const worker1 = await lifecycleManager.createWorker(session.id, { type: 'terminal' });
      expect(worker1!.name).toBe('Terminal 1');

      // Create second terminal worker (auto-name)
      const worker2 = await lifecycleManager.createWorker(session.id, { type: 'terminal' });
      expect(worker2!.name).toBe('Terminal 2');
    });
  });

  // ========== onSessionUpdated broadcast on worker creation (Issue #1586) ==========
  //
  // createWorker must broadcast onSessionUpdated after persisting, mirroring
  // deleteWorker's existing broadcast-after-persist pattern (see the
  // 'should call onSessionUpdated after deletion...' test above). Without
  // this, a client's in-memory session.workers never learns about a worker
  // created in the current page session until a reload refetches it.

  describe('createWorker: onSessionUpdated broadcast (Issue #1586)', () => {
    it('should call onSessionUpdated after creating an agent worker, with the new worker present', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      mockOnSessionUpdated.mockClear();
      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      expect(mockOnSessionUpdated).toHaveBeenCalledTimes(1);
      const broadcastedSession = mockOnSessionUpdated.mock.calls[0][0] as Session;
      expect(broadcastedSession.workers.find((w) => w.id === worker!.id)).toBeDefined();
    });

    it('should call onSessionUpdated after creating a terminal worker, with the new worker present', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      mockOnSessionUpdated.mockClear();
      const worker = await lifecycleManager.createWorker(session.id, { type: 'terminal' });

      expect(mockOnSessionUpdated).toHaveBeenCalledTimes(1);
      const broadcastedSession = mockOnSessionUpdated.mock.calls[0][0] as Session;
      expect(broadcastedSession.workers.find((w) => w.id === worker!.id)).toBeDefined();
    });

    it('should call onSessionUpdated after creating an embedded-agent worker, with the new worker present', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      mockOnSessionUpdated.mockClear();
      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: EMBEDDED_AGENT_DEF.id,
      });

      expect(mockOnSessionUpdated).toHaveBeenCalledTimes(1);
      const broadcastedSession = mockOnSessionUpdated.mock.calls[0][0] as Session;
      expect(broadcastedSession.workers.find((w) => w.id === worker!.id)).toBeDefined();
    });

    it('should NOT call onSessionUpdated when worker creation fails validation (dangling embeddedAgentId)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      mockOnSessionUpdated.mockClear();
      await expect(
        lifecycleManager.createWorker(session.id, {
          type: 'embedded-agent',
          embeddedAgentId: 'does-not-exist',
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(mockOnSessionUpdated).not.toHaveBeenCalled();
    });
  });

  // ========== model / reasoningEffort parameter validation and persistence (Issue #1541) ==========

  describe('createWorker: model/reasoningEffort validation and PTY-command propagation', () => {
    let capableAgentId: string;
    let capableAgent2Id: string;
    let incapableAgentId: string;

    beforeEach(async () => {
      const capable = await agentManager.registerAgent({
        name: 'Capable Agent',
        commandTemplate: 'cli {{model:+--model}}{{effort:+--effort}}{{prompt}}',
      });
      capableAgentId = capable.id;

      const capable2 = await agentManager.registerAgent({
        name: 'Capable Agent 2',
        commandTemplate: 'cli2 {{model:+--model}}{{effort:+--effort}}{{prompt}}',
      });
      capableAgent2Id = capable2.id;

      const incapable = await agentManager.registerAgent({
        name: 'Incapable Agent',
        commandTemplate: 'cli {{prompt}}',
      });
      incapableAgentId = incapable.id;
    });

    // The real agent-worker PTY spawn is a login shell; the actual command
    // (containing --model / --effort) is injected later via
    // `pty.write(pendingCommand + '\r')` once the login-shell sentinel is
    // observed (worker-manager.ts's setupWorkerEventHandlers), not passed
    // directly in the spawn argv. Scoped to the MOST RECENTLY spawned PTY
    // instance only -- restart spawns a fresh login shell/PTY, so checking
    // only the latest instance (rather than accumulated history across all
    // instances) is what lets the "agent change drops the override" test
    // distinguish "the old worker never got it" from "the new worker did".
    function lastPtyInstanceWrittenCommand(): string {
      const lastInstance = ptyFactory.instances[ptyFactory.instances.length - 1];
      return lastInstance?.writtenData.join('') ?? '';
    }

    it('rejects a model param when the resolved agent has no {{model...}} placeholder', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      await expect(
        lifecycleManager.createWorker(session.id, {
          type: 'agent',
          agentId: incapableAgentId,
          model: 'claude-opus-4-6',
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        lifecycleManager.createWorker(session.id, {
          type: 'agent',
          agentId: incapableAgentId,
          model: 'claude-opus-4-6',
        }),
      ).rejects.toThrow(/model/);
    });

    it('rejects a reasoningEffort param when the resolved agent has no {{effort...}} placeholder', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      await expect(
        lifecycleManager.createWorker(session.id, {
          type: 'agent',
          agentId: incapableAgentId,
          reasoningEffort: 'high',
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        lifecycleManager.createWorker(session.id, {
          type: 'agent',
          agentId: incapableAgentId,
          reasoningEffort: 'high',
        }),
      ).rejects.toThrow(/reasoningEffort/);
    });

    it('accepts a model param for a capable agent and the value reaches the spawned PTY command', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: capableAgentId,
        model: 'claude-opus-4-6',
      });

      expect(worker).not.toBeNull();
      expect(lastPtyInstanceWrittenCommand()).toContain("--model 'claude-opus-4-6'");
    });

    it('accepts a reasoningEffort param for a capable agent and the value reaches the spawned PTY command', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: capableAgentId,
        reasoningEffort: 'high',
      });

      expect(worker).not.toBeNull();
      expect(lastPtyInstanceWrittenCommand()).toContain("--effort 'high'");
    });

    it("restart pin: a same-agent restart preserves the worker's model override verbatim", async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: capableAgentId,
        model: 'claude-opus-4-6',
      });

      await lifecycleManager.restartAgentWorker(session.id, worker!.id, 'fresh');

      expect(lastPtyInstanceWrittenCommand()).toContain("--model 'claude-opus-4-6'");
    });

    it("restart pin: a same-agent restart preserves the worker's reasoningEffort override verbatim", async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: capableAgentId,
        reasoningEffort: 'high',
      });

      await lifecycleManager.restartAgentWorker(session.id, worker!.id, 'fresh');

      expect(lastPtyInstanceWrittenCommand()).toContain("--effort 'high'");
    });

    it('an agent CHANGE on restart drops the model override (new agent may be incapable)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: capableAgentId,
        model: 'claude-opus-4-6',
      });

      await lifecycleManager.restartAgentWorker(session.id, worker!.id, 'fresh', capableAgent2Id);

      expect(lastPtyInstanceWrittenCommand()).not.toContain('claude-opus-4-6');
    });

    it(
      'single-writer pin: validation follows the (possibly DI-overridden) capability accessor, not an ' +
        'independent re-scan of agent.commandTemplate -- reach measured: this test fails (does not reject) ' +
        'if createWorker re-derives capability from commandTemplate instead of calling the injected accessor',
      async () => {
        const session = createTestSession();
        sessions.set(session.id, session);

        // capableAgentId's commandTemplate DOES contain {{model...}}, but the
        // injected accessor is stubbed to disagree and report model: false.
        const disagreeingCapabilities = () => ({ model: false, reasoningEffort: true });
        const lifecycleWithStub = new WorkerLifecycleManager(
          createDeps({ getAgentParameterCapabilitiesImpl: disagreeingCapabilities }),
        );

        await expect(
          lifecycleWithStub.createWorker(session.id, {
            type: 'agent',
            agentId: capableAgentId,
            model: 'claude-opus-4-6',
          }),
        ).rejects.toBeInstanceOf(ValidationError);
      },
    );
  });

  // ========== embedded-agent model/reasoningEffort/contextWindowTokens validation (Issue #1554) ==========

  describe('createWorker: embedded-agent model/reasoningEffort/contextWindowTokens validation', () => {
    it('accepts a model override for a capable engine and forwards it to initializeEmbeddedAgentWorker', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: EMBEDDED_AGENT_DEF.id,
        model: 'qwen3:14b',
      });

      expect(worker).not.toBeNull();
      const internal = session.workers.get(worker!.id) as InternalEmbeddedAgentWorker;
      expect(internal.model).toBe('qwen3:14b');
    });

    it('accepts a reasoningEffort override within the closed accepted-values list for claude-sdk', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: EMBEDDED_AGENT_DEF_SDK.id,
        reasoningEffort: 'high',
      });

      expect(worker).not.toBeNull();
      const internal = session.workers.get(worker!.id) as InternalEmbeddedAgentWorker;
      expect(internal.reasoningEffort).toBe('high');
    });

    it('rejects a reasoningEffort value outside the closed accepted-values list for claude-sdk', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      await expect(
        lifecycleManager.createWorker(session.id, {
          type: 'embedded-agent',
          embeddedAgentId: EMBEDDED_AGENT_DEF_SDK.id,
          reasoningEffort: 'ultra',
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        lifecycleManager.createWorker(session.id, {
          type: 'embedded-agent',
          embeddedAgentId: EMBEDDED_AGENT_DEF_SDK.id,
          reasoningEffort: 'ultra',
        }),
      ).rejects.toThrow(/"ultra"/);
    });

    it('rejects a model override when the injected capability accessor reports incapable (DI fixture -- production table has no incapable row today)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const incapableCapabilities = () => ({
        model: { capable: false as const, reason: 'test fixture: model overrides disabled for this engine' },
        reasoningEffort: { capable: true as const, acceptedValues: null, consumptionSite: 'test fixture' },
      });
      const lifecycleWithStub = new WorkerLifecycleManager(
        createDeps({ getEmbeddedAgentParameterCapabilitiesImpl: incapableCapabilities }),
      );

      await expect(
        lifecycleWithStub.createWorker(session.id, {
          type: 'embedded-agent',
          embeddedAgentId: EMBEDDED_AGENT_DEF.id,
          model: 'qwen3:14b',
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        lifecycleWithStub.createWorker(session.id, {
          type: 'embedded-agent',
          embeddedAgentId: EMBEDDED_AGENT_DEF.id,
          model: 'qwen3:14b',
        }),
      ).rejects.toThrow(/"model"/);
    });

    it('rejects a reasoningEffort override when the injected capability accessor reports incapable (DI fixture)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const incapableCapabilities = () => ({
        model: { capable: true as const, acceptedValues: null, consumptionSite: 'test fixture' },
        reasoningEffort: { capable: false as const, reason: 'test fixture: reasoningEffort disabled for this engine' },
      });
      const lifecycleWithStub = new WorkerLifecycleManager(
        createDeps({ getEmbeddedAgentParameterCapabilitiesImpl: incapableCapabilities }),
      );

      await expect(
        lifecycleWithStub.createWorker(session.id, {
          type: 'embedded-agent',
          embeddedAgentId: EMBEDDED_AGENT_DEF.id,
          reasoningEffort: 'high',
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        lifecycleWithStub.createWorker(session.id, {
          type: 'embedded-agent',
          embeddedAgentId: EMBEDDED_AGENT_DEF.id,
          reasoningEffort: 'high',
        }),
      ).rejects.toThrow(/"reasoningEffort"/);
    });

    it('rejects an empty or whitespace-only model, bypassing valibot the way MCP delegate_to_worktree does (its Zod schema has no .min(1)/trim)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      await expect(
        lifecycleManager.createWorker(session.id, {
          type: 'embedded-agent',
          embeddedAgentId: EMBEDDED_AGENT_DEF.id,
          model: '',
        }),
      ).rejects.toThrow(/model must not be empty/);
      await expect(
        lifecycleManager.createWorker(session.id, {
          type: 'embedded-agent',
          embeddedAgentId: EMBEDDED_AGENT_DEF.id,
          model: '   ',
        }),
      ).rejects.toThrow(/model must not be empty/);
    });

    it('rejects an empty or whitespace-only reasoningEffort, bypassing valibot the way MCP delegate_to_worktree does', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      // Uses EMBEDDED_AGENT_DEF (openai-api), whose reasoningEffort row has
      // acceptedValues: null (unrestricted pass-through) -- unlike
      // EMBEDDED_AGENT_DEF_SDK's closed accepted-values list, an empty
      // string here can ONLY be caught by the emptiness check itself, not by
      // falling through to the accepted-values rejection.
      await expect(
        lifecycleManager.createWorker(session.id, {
          type: 'embedded-agent',
          embeddedAgentId: EMBEDDED_AGENT_DEF.id,
          reasoningEffort: '',
        }),
      ).rejects.toThrow(/reasoningEffort must not be empty/);
      await expect(
        lifecycleManager.createWorker(session.id, {
          type: 'embedded-agent',
          embeddedAgentId: EMBEDDED_AGENT_DEF.id,
          reasoningEffort: '   ',
        }),
      ).rejects.toThrow(/reasoningEffort must not be empty/);
    });

    it('rejects contextWindowTokens accompanied only by an empty-string model (Ruling 4d: a declared window must not attach to a semantically-absent model)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      // request.model === '' is !== undefined, so without the emptiness check
      // this would satisfy the contextWindowTokens-requires-model gate and
      // persist a context window override against no real model change.
      // The empty-`model` check fires before the contextWindowTokens-requires-
      // model check (both live in the same block, model first), so the
      // rejection reason is the same as the plain empty-model case above.
      await expect(
        lifecycleManager.createWorker(session.id, {
          type: 'embedded-agent',
          embeddedAgentId: EMBEDDED_AGENT_DEF.id,
          model: '',
          contextWindowTokens: 32000,
        }),
      ).rejects.toThrow(/model must not be empty/);
    });

    it('rejects contextWindowTokens without an accompanying model override', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      await expect(
        lifecycleManager.createWorker(session.id, {
          type: 'embedded-agent',
          embeddedAgentId: EMBEDDED_AGENT_DEF.id,
          contextWindowTokens: 32000,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        lifecycleManager.createWorker(session.id, {
          type: 'embedded-agent',
          embeddedAgentId: EMBEDDED_AGENT_DEF.id,
          contextWindowTokens: 32000,
        }),
      ).rejects.toThrow(/contextWindowTokens/);
    });

    it('accepts contextWindowTokens when accompanied by a model override and forwards both', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: EMBEDDED_AGENT_DEF.id,
        model: 'qwen3:14b',
        contextWindowTokens: 32000,
      });

      expect(worker).not.toBeNull();
      const internal = session.workers.get(worker!.id) as InternalEmbeddedAgentWorker;
      expect(internal.model).toBe('qwen3:14b');
      expect(internal.contextWindowTokens).toBe(32000);
    });

    it('rejects contextWindowTokens on a terminal-agent worker (kind-level rejection, agent-surface.md Ruling 4)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      await expect(
        lifecycleManager.createWorker(session.id, {
          type: 'agent',
          agentId: CLAUDE_CODE_AGENT_ID,
          contextWindowTokens: 32000,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        lifecycleManager.createWorker(session.id, {
          type: 'agent',
          agentId: CLAUDE_CODE_AGENT_ID,
          contextWindowTokens: 32000,
        }),
      ).rejects.toThrow(/contextWindowTokens/);
    });

    it('still succeeds when embeddedAgentId is set alone (no model/reasoningEffort/contextWindowTokens) -- regression guard', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: EMBEDDED_AGENT_DEF.id,
      });

      expect(worker).not.toBeNull();
      const internal = session.workers.get(worker!.id) as InternalEmbeddedAgentWorker;
      expect(internal.model).toBeNull();
      expect(internal.reasoningEffort).toBeNull();
      expect(internal.contextWindowTokens).toBeNull();
    });
  });

  // ========== Worker Deletion ==========

  describe('deleteWorker', () => {
    it('should delete an agent worker (kill + cleanup)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      const result = await lifecycleManager.deleteWorker(session.id, worker!.id);

      expect(result).toBe(true);
      expect(session.workers.size).toBe(0);
      expect(ptyFactory.instances[0].killed).toBe(true);
    });

    it('should delete a terminal worker (kill + cleanup)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'terminal',
      });

      const result = await lifecycleManager.deleteWorker(session.id, worker!.id);

      expect(result).toBe(true);
      expect(session.workers.size).toBe(0);
      expect(ptyFactory.instances[0].killed).toBe(true);
    });

    it('should delete a git-diff worker', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'git-diff',
      });

      const result = await lifecycleManager.deleteWorker(session.id, worker!.id);

      expect(result).toBe(true);
      expect(session.workers.size).toBe(0);
    });

    it('should delete an embedded-agent worker without calling stopWatching', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: 'def-1',
      });

      const stopWatchingSpy = spyOn(gitDiffService, 'stopWatching');
      try {
        const result = await lifecycleManager.deleteWorker(session.id, worker!.id);

        expect(result).toBe(true);
        expect(session.workers.size).toBe(0);
        // stopWatching is a git-diff-only cleanup path; it must NOT run for
        // embedded-agent workers.
        expect(stopWatchingSpy).not.toHaveBeenCalled();
        // No PTY was ever spawned, so none should be killed.
        expect(ptyFactory.instances.length).toBe(0);
      } finally {
        stopWatchingSpy.mockRestore();
      }
    });

    it('should deactivate the embedded-agent subprocess when deleting (polarity guard)', async () => {
      mockDeactivateEmbeddedAgentWorker.mockClear();
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: 'def-1',
      });

      const result = await lifecycleManager.deleteWorker(session.id, worker!.id);

      expect(result).toBe(true);
      // If the embedded branch's deactivate call is removed, the subprocess and
      // its MCP token leak; this assertion fails.
      expect(mockDeactivateEmbeddedAgentWorker).toHaveBeenCalledWith(session.id, worker!.id);
    });

    it('should return false when session is not found', async () => {
      const result = await lifecycleManager.deleteWorker('non-existent', 'worker-1');

      expect(result).toBe(false);
    });

    it('should return false when worker is not found', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const result = await lifecycleManager.deleteWorker(session.id, 'non-existent');

      expect(result).toBe(false);
    });

    it('should persist session after deletion', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'terminal',
      });

      mockPersistSession.mockClear();
      await lifecycleManager.deleteWorker(session.id, worker!.id);

      expect(mockPersistSession).toHaveBeenCalledTimes(1);
    });

    it('should call onSessionUpdated after deletion to broadcast updated session', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'terminal',
      });
      const deletedWorkerId = worker!.id;

      mockOnSessionUpdated.mockClear();
      await lifecycleManager.deleteWorker(session.id, deletedWorkerId);

      expect(mockOnSessionUpdated).toHaveBeenCalledTimes(1);
      // The broadcast session should not contain the deleted worker
      const broadcastedSession = mockOnSessionUpdated.mock.calls[0][0] as Session;
      expect(broadcastedSession.workers.find(w => w.id === deletedWorkerId)).toBeUndefined();
    });
  });

  // ========== Worker Restart ==========

  describe('restartAgentWorker', () => {
    it('should restart with same agent ID', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });
      const originalId = worker!.id;

      const restarted = await lifecycleManager.restartAgentWorker(
        session.id, originalId, 'continue'
      );

      expect(restarted).not.toBeNull();
      // Same worker ID should be reused
      expect(restarted!.id).toBe(originalId);
      expect(restarted!.type).toBe('agent');
      // Old PTY killed, new PTY spawned
      expect(ptyFactory.instances[0].killed).toBe(true);
      expect(ptyFactory.instances.length).toBe(2);

      // Restart mints a new generation epoch; the new worker object adopts it so
      // live output and history reads agree (§3.4 / §4.5).
      const newEpoch = lifecycleManager.getWorkerEpoch(session.id, originalId);
      expect(typeof newEpoch).toBe('number');
      expect(newEpoch).toBeGreaterThan(0);
    });

    it('should restart with different agent ID', async () => {
      // For this test, we need to register a custom agent first
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      // Restart with same agent ID since we only have the built-in one available
      // The key behavior is that it kills old PTY and creates new one
      const restarted = await lifecycleManager.restartAgentWorker(
        session.id, worker!.id, 'fresh', CLAUDE_CODE_AGENT_ID
      );

      expect(restarted).not.toBeNull();
      expect(restarted!.id).toBe(worker!.id);
    });

    it('should return null when session is not found', async () => {
      const result = await lifecycleManager.restartAgentWorker(
        'non-existent', 'worker-1', 'continue'
      );

      expect(result).toBeNull();
    });

    it('should return null when worker is not found', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const result = await lifecycleManager.restartAgentWorker(
        session.id, 'non-existent', 'continue'
      );

      expect(result).toBeNull();
    });

    it('should return null when worker is not agent type', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'terminal',
      });

      const result = await lifecycleManager.restartAgentWorker(
        session.id, worker!.id, 'continue'
      );

      expect(result).toBeNull();
    });

    it('should kill old worker and create new one with same ID', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });
      const originalId = worker!.id;

      await lifecycleManager.restartAgentWorker(session.id, originalId, 'continue');

      // First PTY should be killed
      expect(ptyFactory.instances[0].killed).toBe(true);
      // Second PTY should be alive
      expect(ptyFactory.instances[1].killed).toBe(false);
      // Session should still have one worker with the same ID
      expect(session.workers.size).toBe(1);
      expect(session.workers.has(originalId)).toBe(true);
    });

    it('should await old PTY exit before spawning new PTY', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });
      const originalId = worker!.id;

      const operationOrder: string[] = [];

      // Track when old PTY exit fires by wrapping the exitCallback
      const oldMockPty = ptyFactory.instances[0];
      const originalOnExit = oldMockPty.onExit.bind(oldMockPty);
      oldMockPty.onExit = (callback: (event: { exitCode: number; signal?: number }) => void) => {
        const wrappedCallback = (event: { exitCode: number; signal?: number }) => {
          operationOrder.push('old-exited');
          callback(event);
        };
        return originalOnExit(wrappedCallback);
      };

      // Track when spawn is called for 2nd PTY
      const originalSpawnImpl = ptyFactory.spawn.getMockImplementation()!;
      ptyFactory.spawn.mockImplementation(() => {
        operationOrder.push('new-spawned');
        return originalSpawnImpl();
      });

      try {
        await lifecycleManager.restartAgentWorker(session.id, originalId, 'continue');
      } finally {
        ptyFactory.spawn.mockImplementation(originalSpawnImpl);
      }

      expect(operationOrder).toEqual(['old-exited', 'new-spawned']);
    });

    it('should persist session after restart', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      mockPersistSession.mockClear();
      await lifecycleManager.restartAgentWorker(session.id, worker!.id, 'continue');

      expect(mockPersistSession).toHaveBeenCalled();
    });

    it('should return null when session is deleted during async restart', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      // Create worker with the normal lifecycle manager first
      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      // Create a new lifecycle manager where getSession returns the session
      // on the first call but undefined on the second call (simulating deletion
      // during the async gap in restartAgentWorker)
      let getSessionCallCount = 0;
      const managerWithDelete = new WorkerLifecycleManager(createDeps({
        getSession: (id: string) => {
          getSessionCallCount++;
          // First call: initial lookup at start of restartAgentWorker
          // Second call: re-check after async operations
          if (getSessionCallCount >= 2) {
            return undefined;
          }
          return sessions.get(id);
        },
      }));

      const result = await managerWithDelete.restartAgentWorker(
        session.id, worker!.id, 'continue'
      );

      expect(result).toBeNull();
    });

    it('should throw and not update worktreeId when branch rename fails', async () => {
      const session = createTestSession({ worktreeId: 'original-branch' });
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      // Configure git mocks: getCurrentBranch returns the current branch,
      // renameBranch throws an error
      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('original-branch'));
      mockGit.renameBranch.mockImplementation(() => {
        throw new Error('git branch rename failed');
      });

      await expect(
        lifecycleManager.restartAgentWorker(
          session.id, worker!.id, 'continue', undefined, 'new-branch'
        )
      ).rejects.toThrow('git branch rename failed');

      // worktreeId should NOT have been updated since rename failed
      expect(session.type).toBe('worktree');
      if (session.type === 'worktree') {
        expect(session.worktreeId).toBe('original-branch');
      }
    });

    it('should not update worktreeId when getCurrentBranch fails', async () => {
      const session = createTestSession({ worktreeId: 'original-branch' });
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      // getCurrentBranch throws
      mockGit.getCurrentBranch.mockImplementation(() => {
        throw new Error('could not determine current branch');
      });

      await expect(
        lifecycleManager.restartAgentWorker(
          session.id, worker!.id, 'continue', undefined, 'new-branch'
        )
      ).rejects.toThrow('could not determine current branch');

      // worktreeId should remain unchanged
      expect(session.type).toBe('worktree');
      if (session.type === 'worktree') {
        expect(session.worktreeId).toBe('original-branch');
      }
    });

    it('should call onWorkerRestarted callback after successful restart', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      await lifecycleManager.restartAgentWorker(session.id, worker!.id, 'continue');

      expect(mockOnWorkerRestarted).toHaveBeenCalledWith(session.id, worker!.id, expect.any(String));
    });

    it('should call onWorkerRestarted even when agent is not changed', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      // createWorker itself broadcasts onSessionUpdated (Issue #1586) --
      // clear that call so this assertion isolates restartAgentWorker's own
      // (non-)broadcast behavior.
      mockOnSessionUpdated.mockClear();

      // Restart with same agent ID and no branch change
      await lifecycleManager.restartAgentWorker(
        session.id, worker!.id, 'continue', CLAUDE_CODE_AGENT_ID
      );

      // onWorkerRestarted should be called regardless of agent/branch changes
      expect(mockOnWorkerRestarted).toHaveBeenCalledWith(session.id, worker!.id, expect.any(String));
      // onSessionUpdated should NOT be called since agent and branch did not change
      expect(mockOnSessionUpdated).not.toHaveBeenCalled();
    });

    it('should NOT call onWorkerRestarted when session is deleted during restart', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      // Create a lifecycle manager where getSession returns undefined on the re-check
      let getSessionCallCount = 0;
      const managerWithDelete = new WorkerLifecycleManager(createDeps({
        getSession: (id: string) => {
          getSessionCallCount++;
          if (getSessionCallCount >= 2) {
            return undefined;
          }
          return sessions.get(id);
        },
      }));

      const result = await managerWithDelete.restartAgentWorker(
        session.id, worker!.id, 'continue'
      );

      // Should return null since session was deleted
      expect(result).toBeNull();
      // Should NOT call onWorkerRestarted since the restart effectively failed
      expect(mockOnWorkerRestarted).not.toHaveBeenCalled();
    });

    it('should keep the git-diff worker base spec unchanged after branch rename (Issue #800)', async () => {
      const session = createTestSession({ worktreeId: 'old-branch' });
      sessions.set(session.id, session);

      // Create an agent worker and a git-diff worker
      const agentWorker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      const gitDiffWorker: InternalGitDiffWorker = {
        id: 'diff-worker-1',
        type: 'git-diff',
        name: 'Git Diff',
        createdAt: new Date().toISOString(),
        baseCommit: 'merge-base:main',
      };
      session.workers.set(gitDiffWorker.id, gitDiffWorker);

      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('old-branch'));

      await lifecycleManager.restartAgentWorker(
        session.id, agentWorker!.id, 'continue', undefined, 'new-branch'
      );

      // The branch-agnostic spec re-resolves on every diff, so it must NOT be
      // frozen to a new hash here.
      const updatedDiffWorker = session.workers.get(gitDiffWorker.id) as InternalGitDiffWorker;
      expect(updatedDiffWorker.baseCommit).toBe('merge-base:main');
    });

    it('should fire onDiffBaseCommitChanged with the unchanged spec after branch rename', async () => {
      const session = createTestSession({ worktreeId: 'old-branch' });
      sessions.set(session.id, session);

      const agentWorker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      const gitDiffWorker: InternalGitDiffWorker = {
        id: 'diff-worker-cb',
        type: 'git-diff',
        name: 'Git Diff',
        createdAt: new Date().toISOString(),
        baseCommit: 'merge-base:main',
      };
      session.workers.set(gitDiffWorker.id, gitDiffWorker);

      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('old-branch'));

      await lifecycleManager.restartAgentWorker(
        session.id, agentWorker!.id, 'continue', undefined, 'new-branch'
      );

      // Fires with the unchanged spec so connected clients re-resolve the diff.
      expect(mockOnDiffBaseCommitChanged).toHaveBeenCalledWith(
        session.id, gitDiffWorker.id, 'merge-base:main'
      );
    });

    it('should NOT update git-diff workers when no branch parameter is provided', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const agentWorker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      const gitDiffWorker: InternalGitDiffWorker = {
        id: 'diff-worker-no-branch',
        type: 'git-diff',
        name: 'Git Diff',
        createdAt: new Date().toISOString(),
        baseCommit: 'original-base',
      };
      session.workers.set(gitDiffWorker.id, gitDiffWorker);

      // Restart without branch parameter
      await lifecycleManager.restartAgentWorker(
        session.id, agentWorker!.id, 'continue'
      );

      // git-diff worker's baseCommit should remain unchanged
      const unchangedDiffWorker = session.workers.get(gitDiffWorker.id) as InternalGitDiffWorker;
      expect(unchangedDiffWorker.baseCommit).toBe('original-base');
      expect(mockOnDiffBaseCommitChanged).not.toHaveBeenCalled();
    });

    it('resolves the path resolver before killing the existing PTY worker (call-order pin)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      const order: string[] = [];
      const originalKill = workerManager.killWorker.bind(workerManager);
      const killSpy = spyOn(workerManager, 'killWorker').mockImplementation(
        async (...args: Parameters<typeof originalKill>) => {
          order.push('kill');
          return originalKill(...args);
        }
      );

      const manager = new WorkerLifecycleManager(createDeps({
        getPathResolver: () => {
          order.push('resolver');
          return new SessionDataPathResolver(`${TEST_CONFIG_DIR}/_quick`);
        },
      }));

      try {
        await manager.restartAgentWorker(session.id, worker!.id, 'continue');
      } finally {
        killSpy.mockRestore();
      }

      expect(order).toEqual(['resolver', 'kill']);
    });

    it('leaves the existing PTY worker untouched when the path resolver throws (orphaned session)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      const resolverError = new Error('boom: orphaned session');
      const killSpy = spyOn(workerManager, 'killWorker');
      const manager = new WorkerLifecycleManager(createDeps({
        getPathResolver: () => {
          throw resolverError;
        },
      }));

      try {
        await expect(
          manager.restartAgentWorker(session.id, worker!.id, 'continue')
        ).rejects.toThrow(resolverError);
      } finally {
        killSpy.mockRestore();
      }

      expect(killSpy).not.toHaveBeenCalled();
      expect(ptyFactory.instances[0].killed).toBe(false);
      const internal = session.workers.get(worker!.id) as InternalAgentWorker;
      expect(internal.type).toBe('agent');
      expect(internal.pty).not.toBeNull();
    });
  });

  // ========== Restart Initial-Prompt Re-delivery (Issue #1236) ==========

  describe('restartAgentWorker initial-prompt re-delivery (Issue #1236)', () => {
    /**
     * Creates an agent worker via the real (unmocked) activation path (no
     * initialPrompt passed to createWorker, so no real prompt-file write is
     * ever triggered), then marks the resulting internal worker object
     * eligible directly -- mirrors this file's existing pattern of
     * hand-constructing InternalAgentWorker state for restart-path tests
     * (see e.g. the "restoreWorker" / "templateVars propagation" describe
     * blocks) rather than routing a real initialPrompt through creation's
     * own real activateAgentWorkerPty call, which would attempt a real
     * elevated `cat >` subprocess spawn via the unmocked `runAsUser`.
     */
    async function setupEligibleWorker(
      sessionOverrides: Parameters<typeof createTestSession>[0] = {},
    ): Promise<{ session: InternalSession; workerId: string }> {
      const session = createTestSession(sessionOverrides);
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });
      const internal = session.workers.get(worker!.id) as InternalAgentWorker;
      internal.deliverInitialPromptOnActivation = true;

      return { session, workerId: worker!.id };
    }

    it("redelivers session.initialPrompt on restart when eligible, undelivered, and preference is 'fresh' [POLARITY]", async () => {
      const { session, workerId } = await setupEligibleWorker({ initialPrompt: 'Do the important thing' });
      expect(session.initialPromptDelivered).toBeUndefined();

      const spy = spyOn(workerManager, 'activateAgentWorkerPty').mockImplementation(async () => {});
      try {
        await lifecycleManager.restartAgentWorker(session.id, workerId, 'fresh');

        expect(spy).toHaveBeenCalledTimes(1);
        const params = spy.mock.calls[0][1];
        expect(params.initialPrompt).toBe('Do the important thing');
      } finally {
        spy.mockRestore();
      }
    });

    it('does not redeliver when session.initialPromptDelivered is already true', async () => {
      const { session, workerId } = await setupEligibleWorker({ initialPrompt: 'Do the important thing' });
      session.initialPromptDelivered = true;

      const spy = spyOn(workerManager, 'activateAgentWorkerPty').mockImplementation(async () => {});
      try {
        await lifecycleManager.restartAgentWorker(session.id, workerId, 'fresh');

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][1].initialPrompt).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });

    it("does not redeliver when preference is 'continue', and does not consume eligibility for a later restart", async () => {
      const { session, workerId } = await setupEligibleWorker({ initialPrompt: 'Do the important thing' });

      const spy = spyOn(workerManager, 'activateAgentWorkerPty').mockImplementation(async () => {});
      try {
        await lifecycleManager.restartAgentWorker(session.id, workerId, 'continue');

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][1].initialPrompt).toBeUndefined();
        // preference 'continue' never flips the delivered flag itself --
        // only the injection-time callback (WorkerManager, separately
        // tested) does that.
        expect(session.initialPromptDelivered).not.toBe(true);

        // Same worker restarted again, this time with preference 'fresh'
        // and still undelivered -- the earlier continue-restart must not
        // have "used up" the eligibility.
        await lifecycleManager.restartAgentWorker(session.id, workerId, 'fresh');

        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy.mock.calls[1][1].initialPrompt).toBe('Do the important thing');
      } finally {
        spy.mockRestore();
      }
    });

    it.each([
      ['undefined', undefined],
      ['empty string', ''],
      ['whitespace-only', '   '],
    ])('does not redeliver when session.initialPrompt is %s, even though eligible and undelivered', async (_label, initialPromptValue) => {
      const { session, workerId } = await setupEligibleWorker({ initialPrompt: initialPromptValue });

      const spy = spyOn(workerManager, 'activateAgentWorkerPty').mockImplementation(async () => {});
      try {
        await lifecycleManager.restartAgentWorker(session.id, workerId, 'fresh');

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][1].initialPrompt).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });

    it("carries the original worker's deliverInitialPromptOnActivation across restart unchanged (eligible case)", async () => {
      const { session, workerId } = await setupEligibleWorker({ initialPrompt: 'Do the important thing' });
      // Already delivered, so this restart's redelivery gate is false --
      // but eligibility itself must still carry over unrecomputed.
      session.initialPromptDelivered = true;

      await lifecycleManager.restartAgentWorker(session.id, workerId, 'fresh');

      const newInternal = session.workers.get(workerId) as InternalAgentWorker;
      expect(newInternal.deliverInitialPromptOnActivation).toBe(true);
    });

    it('carries deliverInitialPromptOnActivation: false across restart when the original worker was never eligible', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });
      const before = session.workers.get(worker!.id) as InternalAgentWorker;
      expect(before.deliverInitialPromptOnActivation).toBe(false);

      await lifecycleManager.restartAgentWorker(session.id, worker!.id, 'fresh');

      const after = session.workers.get(worker!.id) as InternalAgentWorker;
      expect(after.deliverInitialPromptOnActivation).toBe(false);
    });
  });

  // ========== Cross-Type Worker Restart (agent -> embedded-agent) ==========

  describe('restartAgentWorkerAsEmbedded', () => {
    it('converts a PTY agent worker to an embedded-agent worker with every R2 identity field correct', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });
      const workerId = worker!.id;
      const originalCreatedAt = worker!.createdAt;

      mockPersistSession.mockClear();
      const converted = await lifecycleManager.restartAgentWorkerAsEmbedded(
        session.id, workerId, EMBEDDED_AGENT_DEF.id
      );

      expect(converted).not.toBeNull();
      expect(converted!.id).toBe(workerId);
      expect(converted!.type).toBe('embedded-agent');
      expect(converted!.createdAt).toBe(originalCreatedAt);

      // Old PTY killed.
      expect(ptyFactory.instances[0].killed).toBe(true);

      const internal = session.workers.get(workerId) as InternalEmbeddedAgentWorker;
      expect(internal.type).toBe('embedded-agent');
      expect(internal.id).toBe(workerId);
      expect(internal.createdAt).toBe(originalCreatedAt);
      // Name regenerated from the resolved definition's name.
      expect(internal.name).toBe(EMBEDDED_AGENT_DEF.name);
      // Eligibility carried over unchanged (worker was created without an
      // initialPrompt, so it started ineligible).
      expect(internal.deliverInitialPromptOnActivation).toBe(false);
      // No model/reasoningEffort/contextWindowTokens override survives a
      // conversion to a different kind of definition.
      expect(internal.model).toBeNull();
      expect(internal.reasoningEffort).toBeNull();
      expect(internal.contextWindowTokens).toBeNull();
      // Defaults from initializeEmbeddedAgentWorker.
      expect(internal.autoCompaction).toBe(true);
      expect(internal.sdkSessionId).toBeNull();
      expect(internal.subprocess).toBeNull();
      expect(typeof internal.epoch).toBe('number');

      // The session object handed to persistSession carries the converted
      // worker (this test's proxy for "the persisted row", per this file's
      // mocked persistSession).
      expect(mockPersistSession).toHaveBeenCalled();
      const persistedSession = mockPersistSession.mock.calls.at(-1)?.[0] as InternalSession;
      const persistedWorker = persistedSession.workers.get(workerId) as InternalEmbeddedAgentWorker;
      expect(persistedWorker.type).toBe('embedded-agent');
      expect(persistedWorker.embeddedAgentId).toBe(EMBEDDED_AGENT_DEF.id);

      // Activated immediately (the injected dep, not a real subprocess).
      expect(mockActivateEmbeddedAgentWorker).toHaveBeenCalledWith(session.id, workerId);
    });

    it('should mark eligibility carried over as true when the original PTY worker was eligible', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const spy = spyOn(workerManager, 'activateAgentWorkerPty').mockImplementation(async () => {});
      let worker: Awaited<ReturnType<typeof lifecycleManager.createWorker>>;
      try {
        worker = await lifecycleManager.createWorker(
          session.id,
          { type: 'agent', agentId: CLAUDE_CODE_AGENT_ID },
          'fresh',
          'Do the thing',
        );
      } finally {
        spy.mockRestore();
      }
      const before = session.workers.get(worker!.id) as InternalAgentWorker;
      expect(before.deliverInitialPromptOnActivation).toBe(true);

      await lifecycleManager.restartAgentWorkerAsEmbedded(session.id, worker!.id, EMBEDDED_AGENT_DEF.id);

      const after = session.workers.get(worker!.id) as InternalEmbeddedAgentWorker;
      expect(after.deliverInitialPromptOnActivation).toBe(true);
    });

    it('rejects a dangling embeddedAgentId with ValidationError, leaving the existing PTY worker completely untouched', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      const killSpy = spyOn(workerManager, 'killWorker');
      try {
        await expect(
          lifecycleManager.restartAgentWorkerAsEmbedded(session.id, worker!.id, 'does-not-exist')
        ).rejects.toThrow(ValidationError);
      } finally {
        killSpy.mockRestore();
      }

      expect(killSpy).not.toHaveBeenCalled();
      expect(ptyFactory.instances[0].killed).toBe(false);

      const internal = session.workers.get(worker!.id) as InternalAgentWorker;
      expect(internal.type).toBe('agent');
      expect(internal.agentId).toBe(CLAUDE_CODE_AGENT_ID);
    });

    it('deletes the output file (content + manifest) before initializing the embedded-agent worker (call-order pin)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const order: string[] = [];
      const wofm = new WorkerOutputFileManager();
      const originalDelete = wofm.deleteWorkerOutput.bind(wofm);
      const deleteSpy = spyOn(wofm, 'deleteWorkerOutput').mockImplementation(async (...args: Parameters<typeof originalDelete>) => {
        order.push('delete');
        return originalDelete(...args);
      });

      const manager = new WorkerLifecycleManager(createDeps({ workerOutputFileManager: wofm }));
      const worker = await manager.createWorker(session.id, { type: 'agent', agentId: CLAUDE_CODE_AGENT_ID });

      const originalInit = workerManager.initializeEmbeddedAgentWorker.bind(workerManager);
      const initSpy = spyOn(workerManager, 'initializeEmbeddedAgentWorker').mockImplementation((params) => {
        order.push('initialize');
        return originalInit(params);
      });

      try {
        await manager.restartAgentWorkerAsEmbedded(session.id, worker!.id, EMBEDDED_AGENT_DEF.id);
      } finally {
        initSpy.mockRestore();
        deleteSpy.mockRestore();
      }

      expect(order).toEqual(['delete', 'initialize']);
    });

    it('fires onSessionUpdated unconditionally, even with no branch change (unlike restartAgentWorker)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      mockOnSessionUpdated.mockClear();
      await lifecycleManager.restartAgentWorkerAsEmbedded(session.id, worker!.id, EMBEDDED_AGENT_DEF.id);

      expect(mockOnSessionUpdated).toHaveBeenCalled();
    });

    it('fires onWorkerRestarted', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      mockOnWorkerRestarted.mockClear();
      await lifecycleManager.restartAgentWorkerAsEmbedded(session.id, worker!.id, EMBEDDED_AGENT_DEF.id);

      expect(mockOnWorkerRestarted).toHaveBeenCalledWith(session.id, worker!.id, expect.anything());
    });

    it('fires onSessionUpdated, then onWorkerRestarted, then activates the embedded worker, in that order (tail call-order pin)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      const order: string[] = [];
      mockOnSessionUpdated.mockImplementation(() => {
        order.push('session-updated');
      });
      mockOnWorkerRestarted.mockImplementation(() => {
        order.push('worker-restarted');
      });
      const activateSpy = mock(async (_sessionId: string, _workerId: string) => {
        order.push('activate');
      });

      const manager = new WorkerLifecycleManager(createDeps({ activateEmbeddedAgentWorker: activateSpy }));
      await manager.restartAgentWorkerAsEmbedded(session.id, worker!.id, EMBEDDED_AGENT_DEF.id);

      expect(order).toEqual(['session-updated', 'worker-restarted', 'activate']);
    });

    it('returns null and mints no subprocess/token when the session is deleted during the async gap', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      let getSessionCallCount = 0;
      const activateSpy = mock(async (_sessionId: string, _workerId: string) => {});
      const managerWithDelete = new WorkerLifecycleManager(createDeps({
        getSession: (id: string) => {
          getSessionCallCount++;
          if (getSessionCallCount >= 2) {
            return undefined;
          }
          return sessions.get(id);
        },
        activateEmbeddedAgentWorker: activateSpy,
      }));

      const result = await managerWithDelete.restartAgentWorkerAsEmbedded(
        session.id, worker!.id, EMBEDDED_AGENT_DEF.id
      );

      expect(result).toBeNull();
      // Never reached activation -- no subprocess spawned, no MCP token minted.
      expect(activateSpy).not.toHaveBeenCalled();
    });

    it('propagates activation failure and leaves the worker persisted as a dormant embedded-agent worker, not reverted to PTY', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      const activationError = new Error('activation boom');
      const manager = new WorkerLifecycleManager(createDeps({
        activateEmbeddedAgentWorker: mock(async () => { throw activationError; }),
      }));

      await expect(
        manager.restartAgentWorkerAsEmbedded(session.id, worker!.id, EMBEDDED_AGENT_DEF.id)
      ).rejects.toThrow(activationError);

      // The worker is already flipped to embedded-agent and persisted --
      // dormant (no subprocess), not reverted to a PTY agent worker.
      const internal = session.workers.get(worker!.id) as InternalEmbeddedAgentWorker;
      expect(internal.type).toBe('embedded-agent');
      expect(internal.subprocess).toBeNull();
    });

    it('returns null when the session does not exist', async () => {
      const result = await lifecycleManager.restartAgentWorkerAsEmbedded(
        'non-existent-session', 'worker-1', EMBEDDED_AGENT_DEF.id
      );
      expect(result).toBeNull();
    });

    it('returns null when the worker does not exist', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const result = await lifecycleManager.restartAgentWorkerAsEmbedded(
        session.id, 'non-existent-worker', EMBEDDED_AGENT_DEF.id
      );
      expect(result).toBeNull();
    });

    it('returns null when the target worker is a terminal worker (not a PTY agent worker)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, { type: 'terminal' });

      const result = await lifecycleManager.restartAgentWorkerAsEmbedded(
        session.id, worker!.id, EMBEDDED_AGENT_DEF.id
      );
      expect(result).toBeNull();
    });

    it('returns null when the target worker is already an embedded-agent worker (reverse/repeat conversion out of scope)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: EMBEDDED_AGENT_DEF.id,
      });

      const result = await lifecycleManager.restartAgentWorkerAsEmbedded(
        session.id, worker!.id, EMBEDDED_AGENT_DEF_SDK.id
      );
      expect(result).toBeNull();
    });

    it('renames the worktree branch before converting, same as restartAgentWorker', async () => {
      const session = createTestSession({ worktreeId: 'original-branch' });
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('original-branch'));

      await lifecycleManager.restartAgentWorkerAsEmbedded(
        session.id, worker!.id, EMBEDDED_AGENT_DEF.id, 'new-branch'
      );

      expect(mockGit.renameBranch).toHaveBeenCalledWith('original-branch', 'new-branch', session.locationPath);
      expect(session.type).toBe('worktree');
      if (session.type === 'worktree') {
        expect(session.worktreeId).toBe('new-branch');
      }
    });

    it("revokes the old PTY worker's MCP token on conversion (positive control: the token exists pre-conversion, then is gone)", async () => {
      // A real multi-user PTY activation mints a token via a chain (AUTH_MODE
      // env, lookupOsUserFn, an elevated file write) this file's beforeEach
      // does not stand up -- mirrors session-manager.test.ts's "MCP token
      // registry sharing" test's own rationale for minting directly rather
      // than driving a real multi-user activation to isolate this test's
      // concern (revocation on conversion) from mint mechanics.
      const registry = new McpTokenRegistry();
      const wmWithRegistry = new WorkerManager(
        new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
        agentManager,
        new WorkerOutputFileManager(),
        registry,
      );
      const manager = new WorkerLifecycleManager(createDeps({ workerManager: wmWithRegistry }));

      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await manager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      // Simulate what a real multi-user PTY activation leaves behind: a
      // minted registry entry AND the worker object's own mcpToken field
      // (killWorker's revocation is gated on the latter being non-null).
      const token = registry.mint({ sessionId: session.id, workerId: worker!.id, userId: 'owner-1' });
      const internalBefore = session.workers.get(worker!.id) as InternalAgentWorker;
      internalBefore.mcpToken = { filePath: '/fake/mcp-tokens/token.txt', username: 'testuser' };

      // Positive control: the token exists before conversion.
      expect(registry.verify(token)).not.toBeNull();

      await manager.restartAgentWorkerAsEmbedded(session.id, worker!.id, EMBEDDED_AGENT_DEF.id);

      // Gone after conversion (killWorker's revokeAndDeleteMcpToken ran for
      // the old PTY worker as part of the conversion's step 4).
      expect(registry.verify(token)).toBeNull();
    });

    it('resolves the path resolver before killing the existing PTY worker (call-order pin)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      const order: string[] = [];
      const originalKill = workerManager.killWorker.bind(workerManager);
      const killSpy = spyOn(workerManager, 'killWorker').mockImplementation(
        async (...args: Parameters<typeof originalKill>) => {
          order.push('kill');
          return originalKill(...args);
        }
      );

      const manager = new WorkerLifecycleManager(createDeps({
        getPathResolver: () => {
          order.push('resolver');
          return new SessionDataPathResolver(`${TEST_CONFIG_DIR}/_quick`);
        },
      }));

      try {
        await manager.restartAgentWorkerAsEmbedded(session.id, worker!.id, EMBEDDED_AGENT_DEF.id);
      } finally {
        killSpy.mockRestore();
      }

      expect(order).toEqual(['resolver', 'kill']);
    });

    it('leaves the existing PTY worker untouched when the path resolver throws (orphaned session)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      const resolverError = new Error('boom: orphaned session');
      const killSpy = spyOn(workerManager, 'killWorker');
      const manager = new WorkerLifecycleManager(createDeps({
        getPathResolver: () => {
          throw resolverError;
        },
      }));

      try {
        await expect(
          manager.restartAgentWorkerAsEmbedded(session.id, worker!.id, EMBEDDED_AGENT_DEF.id)
        ).rejects.toThrow(resolverError);
      } finally {
        killSpy.mockRestore();
      }

      expect(killSpy).not.toHaveBeenCalled();
      expect(ptyFactory.instances[0].killed).toBe(false);
      const internal = session.workers.get(worker!.id) as InternalAgentWorker;
      expect(internal.type).toBe('agent');
      expect(internal.pty).not.toBeNull();
    });

    it('continues the conversion when deleteWorkerOutput fails after the PTY is already dead (non-fatal)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      const wofm = new WorkerOutputFileManager();
      const deleteError = new Error('boom: disk unavailable');
      const deleteSpy = spyOn(wofm, 'deleteWorkerOutput').mockImplementation(async () => {
        throw deleteError;
      });

      const activateSpy = mock(async (_sessionId: string, _workerId: string) => {});
      const manager = new WorkerLifecycleManager(createDeps({
        workerOutputFileManager: wofm,
        activateEmbeddedAgentWorker: activateSpy,
      }));

      let result: Worker | null;
      try {
        result = await manager.restartAgentWorkerAsEmbedded(session.id, worker!.id, EMBEDDED_AGENT_DEF.id);
      } finally {
        deleteSpy.mockRestore();
      }

      // The conversion completes despite the deletion failure -- nothing left
      // to abort to, since the PTY is already dead.
      expect(result).not.toBeNull();
      expect(result!.type).toBe('embedded-agent');

      expect(mockPersistSession).toHaveBeenCalled();
      const persistedSession = mockPersistSession.mock.calls.at(-1)?.[0] as InternalSession;
      const persistedWorker = persistedSession.workers.get(worker!.id) as InternalEmbeddedAgentWorker;
      expect(persistedWorker.type).toBe('embedded-agent');

      expect(activateSpy).toHaveBeenCalledWith(session.id, worker!.id);
    });

    it('propagates a persistSession failure with the in-memory map already updated and onSessionUpdated not yet fired', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      const persistError = new Error('boom: db unavailable');
      const failingPersist = mock(async () => { throw persistError; });
      mockOnSessionUpdated.mockClear();
      const manager = new WorkerLifecycleManager(createDeps({
        persistSession: failingPersist as unknown as (session: InternalSession) => Promise<void>,
      }));

      await expect(
        manager.restartAgentWorkerAsEmbedded(session.id, worker!.id, EMBEDDED_AGENT_DEF.id)
      ).rejects.toThrow(persistError);

      // In-memory map already holds the NEW embedded worker -- set before the
      // persistSession call that then threw.
      const internal = session.workers.get(worker!.id) as InternalEmbeddedAgentWorker;
      expect(internal.type).toBe('embedded-agent');

      // onSessionUpdated is called AFTER persistSession in the method body, so
      // it must not have fired.
      expect(mockOnSessionUpdated).not.toHaveBeenCalled();
    });

    it('clears NotificationManager state during the conversion so a pending PTY-side debounce timer does not fire', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      const slackHandler = {
        integrationType: 'slack' as const,
        canHandle: mock((_repositoryId: string) => Promise.resolve(true)),
        send: mock((_context: NotificationContext, _repositoryId: string) => Promise.resolve()),
        sendTest: mock((_message: string, _repositoryId: string) => Promise.resolve()),
        sendToWebhook: mock((_context: NotificationContext, _webhookUrl: string) => Promise.resolve()),
      };
      const notificationManager = new NotificationManager(slackHandler as unknown as SlackHandler, {
        debounceSeconds: 0.05, // 50ms -- short enough for a fast test
        triggers: {
          'agent:waiting': true,
          'agent:idle': true,
          'agent:active': true,
          'worker:error': true,
          'worker:exited': true,
        },
      });

      const manager = new WorkerLifecycleManager(createDeps({ notificationManager }));

      // Simulate a pending PTY-side debounce timer for this identity (e.g.
      // from an activity-state change observed just before the conversion
      // request arrived).
      notificationManager.onActivityChange(
        { id: session.id, repositoryId: session.repositoryId },
        { id: worker!.id },
        'idle',
      );
      expect(slackHandler.send).not.toHaveBeenCalled();

      await manager.restartAgentWorkerAsEmbedded(session.id, worker!.id, EMBEDDED_AGENT_DEF.id);

      // Wait past what would have been the debounce period. If the pending
      // timer survived the conversion, it fires here and calls
      // slackHandler.send -- proving the cleanup did NOT happen.
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(slackHandler.send).not.toHaveBeenCalled();
    });
  });

  // ========== Update Git-Diff Workers After Branch Rename ==========

  describe('updateGitDiffWorkersAfterBranchRename', () => {
    it('should keep the base spec unchanged and fire the callback with it (Issue #800)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const gitDiffWorker: InternalGitDiffWorker = {
        id: 'diff-worker-spec',
        type: 'git-diff',
        name: 'Git Diff',
        createdAt: new Date().toISOString(),
        baseCommit: 'merge-base:main',
      };
      session.workers.set(gitDiffWorker.id, gitDiffWorker);

      await lifecycleManager.updateGitDiffWorkersAfterBranchRename(session.id);

      // The branch-agnostic spec must NOT be frozen to a new hash; it stays as-is
      // and the callback re-pushes a freshly re-resolved diff.
      const updatedWorker = session.workers.get(gitDiffWorker.id) as InternalGitDiffWorker;
      expect(updatedWorker.baseCommit).toBe('merge-base:main');
      expect(mockOnDiffBaseCommitChanged).toHaveBeenCalledWith(
        session.id, gitDiffWorker.id, 'merge-base:main'
      );
    });

    it('should not fail when session does not exist', async () => {
      // Should silently return without error
      await lifecycleManager.updateGitDiffWorkersAfterBranchRename('non-existent');
    });

    it('should skip non-git-diff workers', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      // Create an agent worker only (no git-diff)
      await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      await lifecycleManager.updateGitDiffWorkersAfterBranchRename(session.id);

      // No callback should be fired since there are no git-diff workers
      expect(mockOnDiffBaseCommitChanged).not.toHaveBeenCalled();
    });
  });

  // ========== Worker Restoration ==========

  describe('restoreWorker', () => {
    it('should return success with wasRestored=false when PTY is already active', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      const result = await lifecycleManager.restoreWorker(session.id, worker!.id);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.wasRestored).toBe(false);
        expect(result.worker.type).toBe('agent');
      }
    });

    it('should activate PTY when worker has no PTY (wasRestored=true)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      // Manually create a worker without PTY (simulating persistence restore)
      const agentWorker: InternalAgentWorker = {
        id: 'restored-worker',
        type: 'agent',
        name: 'Restored Agent',
        createdAt: new Date().toISOString(),
        agentId: CLAUDE_CODE_AGENT_ID,
        pty: null,
        outputBuffer: '',
        outputOffset: 0,
        epoch: 1_700_000_000_000,
        activityState: 'unknown',
        activityDetector: null,
        connectionCallbacks: new Map(),
        mcpToken: null,
        promptFile: null,
        deliverInitialPromptOnActivation: false,
        model: null,
        reasoningEffort: null,
      };
      session.workers.set(agentWorker.id, agentWorker);

      const result = await lifecycleManager.restoreWorker(session.id, agentWorker.id);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.wasRestored).toBe(true);
        expect(result.worker.type).toBe('agent');
      }
      // PTY should have been spawned
      expect(ptyFactory.instances.length).toBe(1);
    });

    it('should activate PTY for terminal worker without PTY', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      // Manually create a terminal worker without PTY
      const terminalWorker: InternalTerminalWorker = {
        id: 'restored-terminal',
        type: 'terminal',
        name: 'Restored Terminal',
        createdAt: new Date().toISOString(),
        pty: null,
        outputBuffer: '',
        outputOffset: 0,
        epoch: 1_700_000_000_000,
        connectionCallbacks: new Map(),
      };
      session.workers.set(terminalWorker.id, terminalWorker);

      const result = await lifecycleManager.restoreWorker(session.id, terminalWorker.id);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.wasRestored).toBe(true);
        expect(result.worker.type).toBe('terminal');
      }
      expect(ptyFactory.instances.length).toBe(1);
    });

    it('should return error when session is not found', async () => {
      const result = await lifecycleManager.restoreWorker('non-existent', 'worker-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errorCode).toBe('SESSION_DELETED');
      }
    });

    it('should return error when worker is not found', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const result = await lifecycleManager.restoreWorker(session.id, 'non-existent');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errorCode).toBe('WORKER_NOT_FOUND');
      }
    });

    it('should return error for git-diff workers', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const gitDiffWorker: InternalGitDiffWorker = {
        id: 'git-diff-1',
        type: 'git-diff',
        name: 'Git Diff',
        createdAt: new Date().toISOString(),
        baseCommit: 'abc123',
      };
      session.workers.set(gitDiffWorker.id, gitDiffWorker);

      const result = await lifecycleManager.restoreWorker(session.id, gitDiffWorker.id);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errorCode).toBe('WORKER_NOT_FOUND');
      }
    });

    it('should return PATH_NOT_FOUND when session path does not exist', async () => {
      const pathExistsReturningFalse = mock(() => Promise.resolve(false));
      const manager = new WorkerLifecycleManager(createDeps({
        pathExists: pathExistsReturningFalse as unknown as (path: string) => Promise<boolean>,
      }));

      const session = createTestSession();
      sessions.set(session.id, session);

      // Manually create a worker without PTY
      const agentWorker: InternalAgentWorker = {
        id: 'worker-no-path',
        type: 'agent',
        name: 'Agent',
        createdAt: new Date().toISOString(),
        agentId: CLAUDE_CODE_AGENT_ID,
        pty: null,
        outputBuffer: '',
        outputOffset: 0,
        epoch: 1_700_000_000_000,
        activityState: 'unknown',
        activityDetector: null,
        connectionCallbacks: new Map(),
        mcpToken: null,
        promptFile: null,
        deliverInitialPromptOnActivation: false,
        model: null,
        reasoningEffort: null,
      };
      session.workers.set(agentWorker.id, agentWorker);

      const result = await manager.restoreWorker(session.id, agentWorker.id);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errorCode).toBe('PATH_NOT_FOUND');
      }
    });

    it('should return ACTIVATION_FAILED on PTY activation error', async () => {
      // Create a UserMode that throws on spawnPty
      const failingUserMode = new SingleUserMode({
        spawn: () => { throw new Error('PTY spawn failed'); },
      } as any, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' });
      const failingWorkerManager = new WorkerManager(failingUserMode, agentManager, new WorkerOutputFileManager());
      const manager = new WorkerLifecycleManager(createDeps({
        workerManager: failingWorkerManager,
      }));

      const session = createTestSession();
      sessions.set(session.id, session);

      const agentWorker: InternalAgentWorker = {
        id: 'worker-fail',
        type: 'agent',
        name: 'Agent',
        createdAt: new Date().toISOString(),
        agentId: CLAUDE_CODE_AGENT_ID,
        pty: null,
        outputBuffer: '',
        outputOffset: 0,
        epoch: 1_700_000_000_000,
        activityState: 'unknown',
        activityDetector: null,
        connectionCallbacks: new Map(),
        mcpToken: null,
        promptFile: null,
        deliverInitialPromptOnActivation: false,
        model: null,
        reasoningEffort: null,
      };
      session.workers.set(agentWorker.id, agentWorker);

      const result = await manager.restoreWorker(session.id, agentWorker.id);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errorCode).toBe('ACTIVATION_FAILED');
      }
    });

    it('should persist session after successful restoration', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const agentWorker: InternalAgentWorker = {
        id: 'restored-persist',
        type: 'agent',
        name: 'Agent',
        createdAt: new Date().toISOString(),
        agentId: CLAUDE_CODE_AGENT_ID,
        pty: null,
        outputBuffer: '',
        outputOffset: 0,
        epoch: 1_700_000_000_000,
        activityState: 'unknown',
        activityDetector: null,
        connectionCallbacks: new Map(),
        mcpToken: null,
        promptFile: null,
        deliverInitialPromptOnActivation: false,
        model: null,
        reasoningEffort: null,
      };
      session.workers.set(agentWorker.id, agentWorker);

      mockPersistSession.mockClear();
      await lifecycleManager.restoreWorker(session.id, agentWorker.id);

      expect(mockPersistSession).toHaveBeenCalled();
    });

    it('should call onSessionUpdated callback after restoration', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const agentWorker: InternalAgentWorker = {
        id: 'restored-session-update',
        type: 'agent',
        name: 'Agent',
        createdAt: new Date().toISOString(),
        agentId: CLAUDE_CODE_AGENT_ID,
        pty: null,
        outputBuffer: '',
        outputOffset: 0,
        epoch: 1_700_000_000_000,
        activityState: 'unknown',
        activityDetector: null,
        connectionCallbacks: new Map(),
        mcpToken: null,
        promptFile: null,
        deliverInitialPromptOnActivation: false,
        model: null,
        reasoningEffort: null,
      };
      session.workers.set(agentWorker.id, agentWorker);

      await lifecycleManager.restoreWorker(session.id, agentWorker.id);

      expect(mockOnSessionUpdated).toHaveBeenCalledTimes(1);
      const updatedSession = mockOnSessionUpdated.mock.calls[0][0] as Session;
      expect(updatedSession.id).toBe(session.id);
      expect(updatedSession.activationState).toBe('running');
    });

    it('should call onWorkerActivated callback after restoration', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const agentWorker: InternalAgentWorker = {
        id: 'restored-callback',
        type: 'agent',
        name: 'Agent',
        createdAt: new Date().toISOString(),
        agentId: CLAUDE_CODE_AGENT_ID,
        pty: null,
        outputBuffer: '',
        outputOffset: 0,
        epoch: 1_700_000_000_000,
        activityState: 'unknown',
        activityDetector: null,
        connectionCallbacks: new Map(),
        mcpToken: null,
        promptFile: null,
        deliverInitialPromptOnActivation: false,
        model: null,
        reasoningEffort: null,
      };
      session.workers.set(agentWorker.id, agentWorker);

      await lifecycleManager.restoreWorker(session.id, agentWorker.id);

      expect(mockOnWorkerActivated).toHaveBeenCalledWith(session.id, agentWorker.id);
    });
  });

  // ========== Available Worker ==========

  describe('getAvailableWorker', () => {
    it('should return worker when PTY is already active', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      const available = await lifecycleManager.getAvailableWorker(session.id, worker!.id);

      expect(available).not.toBeNull();
      expect(available!.id).toBe(worker!.id);
    });

    it('should activate PTY and return worker when PTY is inactive', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      // Manually create a worker without PTY
      const terminalWorker: InternalTerminalWorker = {
        id: 'inactive-terminal',
        type: 'terminal',
        name: 'Terminal',
        createdAt: new Date().toISOString(),
        pty: null,
        outputBuffer: '',
        outputOffset: 0,
        epoch: 1_700_000_000_000,
        connectionCallbacks: new Map(),
      };
      session.workers.set(terminalWorker.id, terminalWorker);

      const available = await lifecycleManager.getAvailableWorker(session.id, terminalWorker.id);

      expect(available).not.toBeNull();
      expect(available!.id).toBe(terminalWorker.id);
      // PTY should have been spawned
      expect(ptyFactory.instances.length).toBe(1);
    });

    it('should return null when session is not found', async () => {
      const result = await lifecycleManager.getAvailableWorker('non-existent', 'worker-1');

      expect(result).toBeNull();
    });

    it('should return null when worker is not found', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const result = await lifecycleManager.getAvailableWorker(session.id, 'non-existent');

      expect(result).toBeNull();
    });

    it('should return null for git-diff workers', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const gitDiffWorker: InternalGitDiffWorker = {
        id: 'git-diff-avail',
        type: 'git-diff',
        name: 'Git Diff',
        createdAt: new Date().toISOString(),
        baseCommit: 'abc123',
      };
      session.workers.set(gitDiffWorker.id, gitDiffWorker);

      const result = await lifecycleManager.getAvailableWorker(session.id, gitDiffWorker.id);

      expect(result).toBeNull();
    });

    it('should return null when session path does not exist', async () => {
      const pathExistsReturningFalse = mock(() => Promise.resolve(false));
      const manager = new WorkerLifecycleManager(createDeps({
        pathExists: pathExistsReturningFalse as unknown as (path: string) => Promise<boolean>,
      }));

      const session = createTestSession();
      sessions.set(session.id, session);

      const terminalWorker: InternalTerminalWorker = {
        id: 'no-path-terminal',
        type: 'terminal',
        name: 'Terminal',
        createdAt: new Date().toISOString(),
        pty: null,
        outputBuffer: '',
        outputOffset: 0,
        epoch: 1_700_000_000_000,
        connectionCallbacks: new Map(),
      };
      session.workers.set(terminalWorker.id, terminalWorker);

      const result = await manager.getAvailableWorker(session.id, terminalWorker.id);

      expect(result).toBeNull();
    });

    it('should call onSessionUpdated callback after activating PTY', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const terminalWorker: InternalTerminalWorker = {
        id: 'session-update-on-activate',
        type: 'terminal',
        name: 'Terminal',
        createdAt: new Date().toISOString(),
        pty: null,
        outputBuffer: '',
        outputOffset: 0,
        epoch: 1_700_000_000_000,
        connectionCallbacks: new Map(),
      };
      session.workers.set(terminalWorker.id, terminalWorker);

      await lifecycleManager.getAvailableWorker(session.id, terminalWorker.id);

      expect(mockOnSessionUpdated).toHaveBeenCalledTimes(1);
      const updatedSession = mockOnSessionUpdated.mock.calls[0][0] as Session;
      expect(updatedSession.id).toBe(session.id);
      expect(updatedSession.activationState).toBe('running');
    });

    it('should persist session after activating PTY', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const terminalWorker: InternalTerminalWorker = {
        id: 'persist-on-activate',
        type: 'terminal',
        name: 'Terminal',
        createdAt: new Date().toISOString(),
        pty: null,
        outputBuffer: '',
        outputOffset: 0,
        epoch: 1_700_000_000_000,
        connectionCallbacks: new Map(),
      };
      session.workers.set(terminalWorker.id, terminalWorker);

      mockPersistSession.mockClear();
      await lifecycleManager.getAvailableWorker(session.id, terminalWorker.id);

      expect(mockPersistSession).toHaveBeenCalled();
    });
  });

  // ========== Worker I/O (Thin Delegation) ==========

  describe('attachWorkerCallbacks', () => {
    it('should return connection ID for valid worker', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'terminal',
      });

      const connectionId = lifecycleManager.attachWorkerCallbacks(
        session.id, worker!.id,
        { onData: mock(() => {}), onExit: mock(() => {}) }
      );

      expect(connectionId).not.toBeNull();
      expect(typeof connectionId).toBe('string');
    });

    it('should return null for missing worker', () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const connectionId = lifecycleManager.attachWorkerCallbacks(
        session.id, 'non-existent',
        { onData: mock(() => {}), onExit: mock(() => {}) }
      );

      expect(connectionId).toBeNull();
    });

    it('should return null for git-diff worker', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const gitDiffWorker: InternalGitDiffWorker = {
        id: 'git-diff-cb',
        type: 'git-diff',
        name: 'Git Diff',
        createdAt: new Date().toISOString(),
        baseCommit: 'abc123',
      };
      session.workers.set(gitDiffWorker.id, gitDiffWorker);

      const connectionId = lifecycleManager.attachWorkerCallbacks(
        session.id, gitDiffWorker.id,
        { onData: mock(() => {}), onExit: mock(() => {}) }
      );

      expect(connectionId).toBeNull();
    });

    it('should return a connection ID for embedded-agent worker (isStreamWorker widening)', () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const embeddedWorker: InternalEmbeddedAgentWorker = {
        id: 'embedded-cb',
        type: 'embedded-agent',
        name: 'Embedded Agent',
        createdAt: new Date().toISOString(),
        embeddedAgentId: EMBEDDED_AGENT_DEF.id,
        subprocess: null,
        stdin: null,
        activityState: 'idle',
        outputOffset: 0,
        epoch: 1,
        connectionCallbacks: new Map(),
        deliverInitialPromptOnActivation: false,
        sdkSessionId: null,
        autoCompaction: true,
        model: null,
        reasoningEffort: null,
        contextWindowTokens: null,
      };
      session.workers.set(embeddedWorker.id, embeddedWorker);

      const connectionId = lifecycleManager.attachWorkerCallbacks(
        session.id, embeddedWorker.id,
        { onData: mock(() => {}), onExit: mock(() => {}) }
      );

      expect(connectionId).not.toBeNull();
      expect(typeof connectionId).toBe('string');
      expect(embeddedWorker.connectionCallbacks.size).toBe(1);
    });
  });

  describe('detachWorkerCallbacks', () => {
    it('should return true for valid detachment', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'terminal',
      });

      const connectionId = lifecycleManager.attachWorkerCallbacks(
        session.id, worker!.id,
        { onData: mock(() => {}), onExit: mock(() => {}) }
      );

      const result = lifecycleManager.detachWorkerCallbacks(
        session.id, worker!.id, connectionId!
      );

      expect(result).toBe(true);
    });

    it('should return false for missing worker', () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const result = lifecycleManager.detachWorkerCallbacks(
        session.id, 'non-existent', 'conn-1'
      );

      expect(result).toBe(false);
    });

    it('should return false for git-diff worker', () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const gitDiffWorker: InternalGitDiffWorker = {
        id: 'git-diff-detach',
        type: 'git-diff',
        name: 'Git Diff',
        createdAt: new Date().toISOString(),
        baseCommit: 'abc123',
      };
      session.workers.set(gitDiffWorker.id, gitDiffWorker);

      const result = lifecycleManager.detachWorkerCallbacks(
        session.id, gitDiffWorker.id, 'conn-1'
      );

      expect(result).toBe(false);
    });

    it('should return true for embedded-agent worker (isStreamWorker widening)', () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const embeddedWorker: InternalEmbeddedAgentWorker = {
        id: 'embedded-detach',
        type: 'embedded-agent',
        name: 'Embedded Agent',
        createdAt: new Date().toISOString(),
        embeddedAgentId: EMBEDDED_AGENT_DEF.id,
        subprocess: null,
        stdin: null,
        activityState: 'idle',
        outputOffset: 0,
        epoch: 1,
        connectionCallbacks: new Map(),
        deliverInitialPromptOnActivation: false,
        sdkSessionId: null,
        autoCompaction: true,
        model: null,
        reasoningEffort: null,
        contextWindowTokens: null,
      };
      session.workers.set(embeddedWorker.id, embeddedWorker);

      const connectionId = lifecycleManager.attachWorkerCallbacks(
        session.id, embeddedWorker.id,
        { onData: mock(() => {}), onExit: mock(() => {}) }
      );

      const result = lifecycleManager.detachWorkerCallbacks(
        session.id, embeddedWorker.id, connectionId!
      );

      expect(result).toBe(true);
      expect(embeddedWorker.connectionCallbacks.size).toBe(0);
    });
  });

  describe('writeWorkerInput', () => {
    it('should return true for valid write', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'terminal',
      });

      const result = lifecycleManager.writeWorkerInput(session.id, worker!.id, 'hello');

      expect(result).toBe(true);
      expect(ptyFactory.instances[0].writtenData).toContain('hello');
    });

    it('should return false for missing worker', () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const result = lifecycleManager.writeWorkerInput(session.id, 'non-existent', 'hello');

      expect(result).toBe(false);
    });

    it('should return false for git-diff worker', () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const gitDiffWorker: InternalGitDiffWorker = {
        id: 'git-diff-write',
        type: 'git-diff',
        name: 'Git Diff',
        createdAt: new Date().toISOString(),
        baseCommit: 'abc123',
      };
      session.workers.set(gitDiffWorker.id, gitDiffWorker);

      const result = lifecycleManager.writeWorkerInput(session.id, gitDiffWorker.id, 'hello');

      expect(result).toBe(false);
    });
  });

  describe('resizeWorker', () => {
    it('should return true for valid resize', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'terminal',
      });

      const result = lifecycleManager.resizeWorker(session.id, worker!.id, 80, 24);

      expect(result).toBe(true);
      expect(ptyFactory.instances[0].currentCols).toBe(80);
      expect(ptyFactory.instances[0].currentRows).toBe(24);
    });

    it('should return false for missing worker', () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const result = lifecycleManager.resizeWorker(session.id, 'non-existent', 80, 24);

      expect(result).toBe(false);
    });

    it('should return false for git-diff worker', () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const gitDiffWorker: InternalGitDiffWorker = {
        id: 'git-diff-resize',
        type: 'git-diff',
        name: 'Git Diff',
        createdAt: new Date().toISOString(),
        baseCommit: 'abc123',
      };
      session.workers.set(gitDiffWorker.id, gitDiffWorker);

      const result = lifecycleManager.resizeWorker(session.id, gitDiffWorker.id, 80, 24);

      expect(result).toBe(false);
    });
  });

  // ========== Worker State ==========

  describe('getWorkerOutputBuffer', () => {
    it('should return output buffer for PTY worker', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'terminal',
      });

      // Simulate some PTY output
      ptyFactory.instances[0].simulateData('Hello World');

      const buffer = lifecycleManager.getWorkerOutputBuffer(session.id, worker!.id);

      expect(buffer).toBe('Hello World');
    });

    it('should return empty string for missing worker', () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const buffer = lifecycleManager.getWorkerOutputBuffer(session.id, 'non-existent');

      expect(buffer).toBe('');
    });

    it('should return empty string for git-diff worker', () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const gitDiffWorker: InternalGitDiffWorker = {
        id: 'git-diff-buffer',
        type: 'git-diff',
        name: 'Git Diff',
        createdAt: new Date().toISOString(),
        baseCommit: 'abc123',
      };
      session.workers.set(gitDiffWorker.id, gitDiffWorker);

      const buffer = lifecycleManager.getWorkerOutputBuffer(session.id, gitDiffWorker.id);

      expect(buffer).toBe('');
    });
  });

  describe('getWorkerEpoch', () => {
    it('returns the worker generation epoch for a PTY worker', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, { type: 'terminal' });
      const epoch = lifecycleManager.getWorkerEpoch(session.id, worker!.id);

      expect(typeof epoch).toBe('number');
      expect(epoch).toBeGreaterThan(0);
    });

    it('returns null for a missing worker', () => {
      const session = createTestSession();
      sessions.set(session.id, session);
      expect(lifecycleManager.getWorkerEpoch(session.id, 'non-existent')).toBeNull();
    });

    it('returns null for a git-diff worker', () => {
      const session = createTestSession();
      sessions.set(session.id, session);
      const gitDiffWorker: InternalGitDiffWorker = {
        id: 'git-diff-epoch',
        type: 'git-diff',
        name: 'Git Diff',
        createdAt: new Date().toISOString(),
        baseCommit: 'abc123',
      };
      session.workers.set(gitDiffWorker.id, gitDiffWorker);
      expect(lifecycleManager.getWorkerEpoch(session.id, gitDiffWorker.id)).toBeNull();
    });
  });

  describe('getWorkerHistoryRange', () => {
    it('serves the trailing range for a PTY worker from the seeded output file', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const terminalWorker: InternalTerminalWorker = {
        id: 'range-terminal',
        type: 'terminal',
        name: 'Range Terminal',
        createdAt: new Date().toISOString(),
        pty: null,
        outputBuffer: '',
        outputOffset: 0,
        epoch: 1_700_000_000_000,
        connectionCallbacks: new Map(),
      };
      session.workers.set(terminalWorker.id, terminalWorker);

      // Seed the output file directly (the PTY→file flush path is not driven in
      // this harness; the outputOffset-alignment tests seed the same way).
      const content = 'Z'.repeat(200);
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${TEST_CONFIG_DIR}/_quick/outputs/${session.id}/${terminalWorker.id}.log`]: content,
      });

      const res = await lifecycleManager.getWorkerHistoryRange(session.id, terminalWorker.id, 200, 50);

      expect(res).not.toBeNull();
      expect(res!.endOffset).toBe(200);
      expect(res!.data).toBe('Z'.repeat(50));
      expect(res!.startOffset).toBe(150);
    });

    it('returns null for a missing worker', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);
      expect(await lifecycleManager.getWorkerHistoryRange(session.id, 'non-existent', 100)).toBeNull();
    });

    it('returns null for a git-diff worker', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);
      const gitDiffWorker: InternalGitDiffWorker = {
        id: 'git-diff-range',
        type: 'git-diff',
        name: 'Git Diff',
        createdAt: new Date().toISOString(),
        baseCommit: 'abc123',
      };
      session.workers.set(gitDiffWorker.id, gitDiffWorker);
      expect(await lifecycleManager.getWorkerHistoryRange(session.id, gitDiffWorker.id, 100)).toBeNull();
    });
  });

  describe('getWorkerOutputHistory (embedded-agent archive-aware routing, #1506)', () => {
    const line = (event: unknown): string => `${JSON.stringify(event)}\n`;

    /** Write rotated content: an early "marker" burst, then enough later
     * traffic to push it out of the live window (fileMaxSize small). */
    async function seedRotatedContent(fileManager: WorkerOutputFileManager, sessionId: string, workerId: string): Promise<void> {
      const resolver = new SessionDataPathResolver(`${TEST_CONFIG_DIR}/_quick`);
      const early = [
        line({ v: 1, type: 'user-message', id: 'm1', text: 'PRE-ROTATION-MARKER' }),
        line({ v: 1, type: 'assistant-message', turnId: 't1', text: 'ack' }),
      ].join('');
      const later = [
        line({ v: 1, type: 'user-message', id: 'm2', text: 'second question' }),
        line({ v: 1, type: 'assistant-message', turnId: 't2', text: 'x'.repeat(600) }),
        line({ v: 1, type: 'user-message', id: 'm3', text: 'third question' }),
        line({ v: 1, type: 'assistant-message', turnId: 't3', text: 'y'.repeat(600) }),
      ].join('');
      fileManager.bufferOutput(sessionId, workerId, early, resolver);
      await fileManager.flushAll();
      fileManager.bufferOutput(sessionId, workerId, later, resolver);
      await fileManager.flushAll();
    }

    it('walks the archive for an embedded-agent worker\'s initial load', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const embeddedWorker: InternalEmbeddedAgentWorker = {
        id: 'embedded-history',
        type: 'embedded-agent',
        name: 'Embedded Agent',
        createdAt: new Date().toISOString(),
        embeddedAgentId: EMBEDDED_AGENT_DEF.id,
        subprocess: null,
        stdin: null,
        activityState: 'idle',
        outputOffset: 0,
        epoch: 1,
        connectionCallbacks: new Map(),
        deliverInitialPromptOnActivation: false,
        sdkSessionId: null,
        autoCompaction: true,
        model: null,
        reasoningEffort: null,
        contextWindowTokens: null,
      };
      session.workers.set(embeddedWorker.id, embeddedWorker);

      const fileManager = new WorkerOutputFileManager({
        flushThreshold: 100_000_000,
        flushInterval: 100_000,
        fileMaxSize: 400,
        maxSegments: 0,
      });
      await seedRotatedContent(fileManager, session.id, embeddedWorker.id);

      const manager = new WorkerLifecycleManager(createDeps({ workerOutputFileManager: fileManager }));
      const result = await manager.getWorkerOutputHistory(session.id, embeddedWorker.id, undefined, 8);

      expect(result).not.toBeNull();
      expect(result!.data).toContain('PRE-ROTATION-MARKER');
    });

    it('does NOT archive-walk a PTY/terminal worker with the same rotated content -- routing stays type-scoped', async () => {
      // Same fixture, same maxLines, only the worker TYPE differs. Confirms
      // R2's routing is scoped to embedded-agent (which has no client-side
      // paging fallback) and PTY/terminal workers keep their existing
      // live-only initial window (they page backward themselves via
      // terminal-store.ts's requestOlderHistory -> readHistoryRange).
      const session = createTestSession();
      sessions.set(session.id, session);

      const terminalWorker: InternalTerminalWorker = {
        id: 'terminal-history',
        type: 'terminal',
        name: 'Terminal',
        createdAt: new Date().toISOString(),
        pty: null,
        outputBuffer: '',
        outputOffset: 0,
        epoch: 1,
        connectionCallbacks: new Map(),
      };
      session.workers.set(terminalWorker.id, terminalWorker);

      const fileManager = new WorkerOutputFileManager({
        flushThreshold: 100_000_000,
        flushInterval: 100_000,
        fileMaxSize: 400,
        maxSegments: 0,
      });
      await seedRotatedContent(fileManager, session.id, terminalWorker.id);

      const manager = new WorkerLifecycleManager(createDeps({ workerOutputFileManager: fileManager }));
      const result = await manager.getWorkerOutputHistory(session.id, terminalWorker.id, undefined, 8);

      expect(result).not.toBeNull();
      // Rotation genuinely happened (premise control).
      expect(result!.startOffset).toBeGreaterThan(0);
      expect(result!.data).not.toContain('PRE-ROTATION-MARKER');
    });
  });

  describe('getWorkerActivityState', () => {
    it('should return activity state for agent worker', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      const state = lifecycleManager.getWorkerActivityState(session.id, worker!.id);

      // After creation with active PTY, the initial state is 'idle'
      expect(state).toBe('idle');
    });

    it('should return undefined for terminal worker', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'terminal',
      });

      const state = lifecycleManager.getWorkerActivityState(session.id, worker!.id);

      expect(state).toBeUndefined();
    });

    it('should return undefined for missing worker', () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const state = lifecycleManager.getWorkerActivityState(session.id, 'non-existent');

      expect(state).toBeUndefined();
    });
  });

  describe('getWorker', () => {
    it('should return worker when it exists', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const publicWorker = await lifecycleManager.createWorker(session.id, {
        type: 'terminal',
      });

      const internalWorker = lifecycleManager.getWorker(session.id, publicWorker!.id);

      expect(internalWorker).toBeDefined();
      expect(internalWorker!.id).toBe(publicWorker!.id);
      expect(internalWorker!.type).toBe('terminal');
    });

    it('should return undefined when session is not found', () => {
      const result = lifecycleManager.getWorker('non-existent', 'worker-1');

      expect(result).toBeUndefined();
    });

    it('should return undefined when worker is not found', () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const result = lifecycleManager.getWorker(session.id, 'non-existent');

      expect(result).toBeUndefined();
    });
  });

  // ========== Edge Cases ==========

  describe('edge cases', () => {
    it('deleteWorker should succeed gracefully when jobQueue is not available', async () => {
      const managerNoQueue = new WorkerLifecycleManager(createDeps({
        getJobQueue: () => null,
      }));

      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await managerNoQueue.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      // deleteWorker should succeed even without jobQueue (cleanup is skipped with a warning)
      const result = await managerNoQueue.deleteWorker(session.id, worker!.id);
      expect(result).toBe(true);
      expect(session.workers.size).toBe(0);
    });

    it('should handle quick sessions (no repositoryId)', async () => {
      const session = createQuickSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      expect(worker).not.toBeNull();
      expect(worker!.type).toBe('agent');
    });

    it('should support multiple workers in the same session', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker1 = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });
      const worker2 = await lifecycleManager.createWorker(session.id, {
        type: 'terminal',
      });

      expect(session.workers.size).toBe(2);
      expect(worker1!.id).not.toBe(worker2!.id);
      expect(ptyFactory.instances.length).toBe(2);
    });

    it('should handle callbacks from PTY output', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'terminal',
      });

      const onData = mock(() => {});
      const onExit = mock(() => {});

      lifecycleManager.attachWorkerCallbacks(
        session.id, worker!.id,
        { onData, onExit }
      );

      ptyFactory.instances[0].simulateData('test output');

      // onData receives (data, offset) - the cumulative byte offset
      expect(onData).toHaveBeenCalledWith('test output', expect.any(Number), expect.any(Number));
    });

    it('should handle PTY exit callbacks', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'terminal',
      });

      const onData = mock(() => {});
      const onExit = mock(() => {});

      lifecycleManager.attachWorkerCallbacks(
        session.id, worker!.id,
        { onData, onExit }
      );

      ptyFactory.instances[0].simulateExit(0);

      expect(onExit).toHaveBeenCalledWith(0, null, 'unexpected');
    });
  });

  // ========== templateVars propagation ==========

  describe('templateVars propagation', () => {
    it('should pass session templateVars in context during restartAgentWorker', async () => {
      const templateVars = { model: 'gpt-4', temperature: '0.7' };
      const session = createTestSession({ templateVars });
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      const activateSpy = spyOn(workerManager, 'activateAgentWorkerPty');

      await lifecycleManager.restartAgentWorker(session.id, worker!.id, 'continue');

      expect(activateSpy).toHaveBeenCalledTimes(1);
      const params = activateSpy.mock.calls[0][1];
      expect(params.context?.templateVars).toEqual(templateVars);

      activateSpy.mockRestore();
    });

    it('should pass session templateVars in context during restoreWorker', async () => {
      const templateVars = { branch: 'feature-x' };
      const session = createTestSession({ templateVars });
      sessions.set(session.id, session);

      // Create a worker without PTY (simulating persistence restore)
      const agentWorker: InternalAgentWorker = {
        id: 'restored-worker-tv',
        type: 'agent',
        name: 'Restored Agent',
        createdAt: new Date().toISOString(),
        agentId: CLAUDE_CODE_AGENT_ID,
        pty: null,
        outputBuffer: '',
        outputOffset: 0,
        epoch: 1_700_000_000_000,
        activityState: 'unknown',
        activityDetector: null,
        connectionCallbacks: new Map(),
        mcpToken: null,
        promptFile: null,
        deliverInitialPromptOnActivation: false,
        model: null,
        reasoningEffort: null,
      };
      session.workers.set(agentWorker.id, agentWorker);

      const activateSpy = spyOn(workerManager, 'activateAgentWorkerPty');

      await lifecycleManager.restoreWorker(session.id, agentWorker.id);

      expect(activateSpy).toHaveBeenCalledTimes(1);
      const params = activateSpy.mock.calls[0][1];
      expect(params.context?.templateVars).toEqual(templateVars);

      activateSpy.mockRestore();
    });

    it('should pass session templateVars in context during getAvailableWorker', async () => {
      const templateVars = { env: 'staging' };
      const session = createTestSession({ templateVars });
      sessions.set(session.id, session);

      // Create a worker without PTY (simulating hibernated state)
      const agentWorker: InternalAgentWorker = {
        id: 'avail-worker-tv',
        type: 'agent',
        name: 'Agent',
        createdAt: new Date().toISOString(),
        agentId: CLAUDE_CODE_AGENT_ID,
        pty: null,
        outputBuffer: '',
        outputOffset: 0,
        epoch: 1_700_000_000_000,
        activityState: 'unknown',
        activityDetector: null,
        connectionCallbacks: new Map(),
        mcpToken: null,
        promptFile: null,
        deliverInitialPromptOnActivation: false,
        model: null,
        reasoningEffort: null,
      };
      session.workers.set(agentWorker.id, agentWorker);

      const activateSpy = spyOn(workerManager, 'activateAgentWorkerPty');

      await lifecycleManager.getAvailableWorker(session.id, agentWorker.id);

      expect(activateSpy).toHaveBeenCalledTimes(1);
      const params = activateSpy.mock.calls[0][1];
      expect(params.context?.templateVars).toEqual(templateVars);

      activateSpy.mockRestore();
    });

    it('should pass undefined templateVars when session has no templateVars', async () => {
      const session = createTestSession(); // no templateVars
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      const activateSpy = spyOn(workerManager, 'activateAgentWorkerPty');

      await lifecycleManager.restartAgentWorker(session.id, worker!.id, 'continue');

      expect(activateSpy).toHaveBeenCalledTimes(1);
      const params = activateSpy.mock.calls[0][1];
      expect(params.context?.templateVars).toBeUndefined();

      activateSpy.mockRestore();
    });
  });

  // ========== Output offset semantic alignment (Issue #769) ==========
  //
  // Activation paths must seed `worker.outputOffset` from the persisted output
  // file size when the worker is being revived (PTY died, session re-entered,
  // pause/resume). Otherwise the cumulative-from-zero counter on the server
  // diverges from the file-absolute offset the client persists in IndexedDB,
  // and the client's `request-history` reads against the stale (small)
  // cumulative offset at the next visit — producing the disguised
  // "100% reload" symptom in #762.
  //
  // Fresh creation (`createWorker`) and full reset (`restartAgentWorker`)
  // paths must keep the seed at 0 because the file is empty by construction
  // (or has just been truncated to empty by `resetWorkerOutput`).
  describe('outputOffset alignment on PTY activation', () => {
    const PRE_EXISTING_BYTES = 'restored-history-content-1234567890';
    const PRE_EXISTING_LENGTH = Buffer.byteLength(PRE_EXISTING_BYTES, 'utf-8');

    function seedOutputFile(sessionId: string, workerId: string, content: string): void {
      const dir = `${TEST_CONFIG_DIR}/_quick/outputs/${sessionId}`;
      // Re-seed the in-memory FS with the directory + file containing the
      // pre-existing output bytes. Resolver path matches the one used by
      // `createDeps` (always points at `${TEST_CONFIG_DIR}/_quick`).
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        [`${dir}/${workerId}.log`]: content,
      });
    }

    it('restoreWorker (agent) seeds outputOffset from existing output file size', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const agentWorker: InternalAgentWorker = {
        id: 'restored-agent-offset',
        type: 'agent',
        name: 'Restored Agent',
        createdAt: new Date().toISOString(),
        agentId: CLAUDE_CODE_AGENT_ID,
        pty: null,
        outputBuffer: '',
        outputOffset: 0,
        epoch: 1_700_000_000_000,
        activityState: 'unknown',
        activityDetector: null,
        connectionCallbacks: new Map(),
        mcpToken: null,
        promptFile: null,
        deliverInitialPromptOnActivation: false,
        model: null,
        reasoningEffort: null,
      };
      session.workers.set(agentWorker.id, agentWorker);

      seedOutputFile(session.id, agentWorker.id, PRE_EXISTING_BYTES);

      const result = await lifecycleManager.restoreWorker(session.id, agentWorker.id);

      expect(result.success).toBe(true);
      expect(agentWorker.outputOffset).toBe(PRE_EXISTING_LENGTH);
    });

    it('restoreWorker (terminal) seeds outputOffset from existing output file size', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const terminalWorker: InternalTerminalWorker = {
        id: 'restored-terminal-offset',
        type: 'terminal',
        name: 'Restored Terminal',
        createdAt: new Date().toISOString(),
        pty: null,
        outputBuffer: '',
        outputOffset: 0,
        epoch: 1_700_000_000_000,
        connectionCallbacks: new Map(),
      };
      session.workers.set(terminalWorker.id, terminalWorker);

      seedOutputFile(session.id, terminalWorker.id, PRE_EXISTING_BYTES);

      const result = await lifecycleManager.restoreWorker(session.id, terminalWorker.id);

      expect(result.success).toBe(true);
      expect(terminalWorker.outputOffset).toBe(PRE_EXISTING_LENGTH);
    });

    it('getAvailableWorker seeds outputOffset from existing output file size on first activation', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const terminalWorker: InternalTerminalWorker = {
        id: 'available-terminal-offset',
        type: 'terminal',
        name: 'Terminal',
        createdAt: new Date().toISOString(),
        pty: null,
        outputBuffer: '',
        outputOffset: 0,
        epoch: 1_700_000_000_000,
        connectionCallbacks: new Map(),
      };
      session.workers.set(terminalWorker.id, terminalWorker);

      seedOutputFile(session.id, terminalWorker.id, PRE_EXISTING_BYTES);

      const available = await lifecycleManager.getAvailableWorker(session.id, terminalWorker.id);

      expect(available).not.toBeNull();
      expect(available!.outputOffset).toBe(PRE_EXISTING_LENGTH);
    });

    it('createWorker keeps outputOffset at 0 (fresh worker, no pre-existing file)', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'terminal',
      });

      expect(worker).not.toBeNull();
      const internalWorker = session.workers.get(worker!.id);
      expect(internalWorker).toBeDefined();
      expect(internalWorker!.type).toBe('terminal');
      if (internalWorker!.type === 'terminal' || internalWorker!.type === 'agent') {
        expect(internalWorker!.outputOffset).toBe(0);
      }
    });
  });

  describe('getCurrentOutputOffset fallback branch (session not in memory)', () => {
    it('uses the DB-backed resolver when session is not in memory but persisted', async () => {
      // The in-memory `sessions` map is empty; the worker cannot be found
      // via `getWorker` so this test exercises the guard that returns 0 when
      // there is no worker. See design §"Call-site coverage" for the full
      // mandate that covers this branch.
      const dbResolver = new SessionDataPathResolver(`${TEST_CONFIG_DIR}/repositories/test-repo`);
      const manager = new WorkerLifecycleManager(createDeps({
        getSession: () => undefined,
        // The DB-backed lookup returns a resolver that points to a valid
        // repository path. With no worker present, offset is 0.
        getPathResolverByPersistedSessionId: async () => dbResolver,
      }));

      const offset = await manager.getCurrentOutputOffset('missing-session', 'missing-worker');
      expect(offset).toBe(0);
    });

    it('returns 0 and logs when the DB-backed lookup returns null (orphaned scope)', async () => {
      const manager = new WorkerLifecycleManager(createDeps({
        getSession: () => undefined,
        getPathResolverByPersistedSessionId: async () => null,
      }));

      const offset = await manager.getCurrentOutputOffset('orphaned-session', 'wid');
      expect(offset).toBe(0);
    });

    it('returns 0 and never reads from disk when in-memory session has invalid scope', async () => {
      // Construct an in-memory session that owns a real worker, then make
      // `getPathResolver` throw `InvalidSessionDataScopeError` (the situation
      // when a session was persisted with an invalid scope and is now active
      // again). The fallback contract: return 0 WITHOUT touching the
      // workerOutputFileManager, so we never accidentally read/write under
      // `_quick/`.
      const session = createTestSession();
      sessions.set(session.id, session);

      const agentWorker: InternalAgentWorker = {
        id: 'wid-invalid-scope',
        type: 'agent',
        name: 'Agent',
        createdAt: new Date().toISOString(),
        agentId: CLAUDE_CODE_AGENT_ID,
        pty: null,
        outputBuffer: '',
        outputOffset: 0,
        epoch: 1_700_000_000_000,
        activityState: 'unknown',
        activityDetector: null,
        connectionCallbacks: new Map(),
        mcpToken: null,
        promptFile: null,
        deliverInitialPromptOnActivation: false,
        model: null,
        reasoningEffort: null,
      };
      session.workers.set(agentWorker.id, agentWorker);

      // Fresh WorkerOutputFileManager so the spy is scoped to this test.
      const fileManager = new WorkerOutputFileManager();
      const getCurrentOffsetSpy = spyOn(fileManager, 'getCurrentOffset');
      // Likewise spy the persisted-fallback so we can assert it is NOT
      // consulted for an in-memory session with an invalid scope.
      const persistedResolverSpy: (sessionId: string) => Promise<SessionDataPathResolver | null> =
        mock(async () => new SessionDataPathResolver(`${TEST_CONFIG_DIR}/_quick`));

      const manager = new WorkerLifecycleManager(
        createDeps({
          workerOutputFileManager: fileManager,
          getPathResolver: () => {
            throw new InvalidSessionDataScopeError('invalid scope (test fixture)');
          },
          getPathResolverByPersistedSessionId: persistedResolverSpy,
        }),
      );

      const offset = await manager.getCurrentOutputOffset(session.id, agentWorker.id);
      expect(offset).toBe(0);

      // CRITICAL: must not have constructed an output path. If
      // `getCurrentOffset` were called, it would have used whatever resolver
      // was passed in — which in the bad pre-fix world would have been a
      // `_quick/` fallback resolver.
      expect(getCurrentOffsetSpy).not.toHaveBeenCalled();
      // For an in-memory session, the persisted-fallback must NOT be
      // consulted — `resolveOutputResolver` short-circuits to null on
      // in-memory failure.
      expect(persistedResolverSpy).not.toHaveBeenCalled();

      getCurrentOffsetSpy.mockRestore();
    });
  });
});
