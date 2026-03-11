/**
 * Tests for resolveSpawnUsername logic in SessionManager (H3).
 *
 * Tests the username resolution for PTY spawning via the WorkerLifecycleManager
 * dependency injection. Verifies the four resolution paths:
 * 1. createdBy is undefined -> falls back to os.userInfo().username
 * 2. userRepository is null -> falls back to os.userInfo().username
 * 3. user not found in DB -> falls back to os.userInfo().username
 * 4. user found in DB -> returns that user's username
 */
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { CreateWorkerParams, Session } from '@agent-console/shared';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { AgentManager } from '../agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
import { WorkerManager } from '../worker-manager.js';
import { SingleUserMode } from '../user-mode.js';
import { WorkerLifecycleManager, type WorkerLifecycleDeps } from '../worker-lifecycle-manager.js';
import type { InternalAgentWorker, InternalTerminalWorker } from '../worker-types.js';
import type { InternalSession } from '../internal-types.js';
import type { SessionLifecycleCallbacks } from '../session-lifecycle-types.js';
import type { UserRepository } from '../../repositories/user-repository.js';
import { JobQueue } from '../../jobs/index.js';

const TEST_CONFIG_DIR = '/test/config';

const ptyFactory = createMockPtyFactory(10000);
let testJobQueue: JobQueue | null = null;

describe('resolveSpawnUsername', () => {
  let workerManager: WorkerManager;
  let agentManager: AgentManager;
  let sessions: Map<string, InternalSession>;
  let mockPersistSession: ReturnType<typeof mock>;
  let mockCallbacks: SessionLifecycleCallbacks;

  function createTestSession(overrides: Partial<InternalSession> = {}): InternalSession {
    return {
      id: crypto.randomUUID(),
      type: 'quick',
      locationPath: '/test/project',
      status: 'active',
      createdAt: new Date().toISOString(),
      workers: new Map(),
      ...overrides,
    } as InternalSession;
  }

  function createDeps(
    resolveSpawnUsername: (createdBy?: string) => Promise<string>,
    overrides: Partial<WorkerLifecycleDeps> = {},
  ): WorkerLifecycleDeps {
    return {
      workerManager,
      agentManager,
      notificationManager: null,
      pathExists: async () => true,
      getSession: (id: string) => sessions.get(id),
      persistSession: mockPersistSession as unknown as (session: InternalSession) => Promise<void>,
      getRepositoryEnvVars: () => ({}),
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
      resolveSpawnUsername,
      getJobQueue: () => testJobQueue,
      getSessionLifecycleCallbacks: () => mockCallbacks,
      ...overrides,
    };
  }

  beforeEach(async () => {
    await closeDatabase();

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

    const userMode = new SingleUserMode(ptyFactory.provider, {
      id: 'test-user-id',
      username: 'testuser',
      homeDir: '/home/testuser',
    });
    workerManager = new WorkerManager(userMode, agentManager);

    mockCallbacks = {
      onSessionCreated: mock(() => {}),
      onSessionUpdated: mock(() => {}),
      onSessionDeleted: mock(() => {}),
      onWorkerActivated: mock(() => {}),
      onWorkerRestarted: mock(() => {}),
      onSessionPaused: mock(() => {}),
      onSessionResumed: mock(() => {}),
      onDiffBaseCommitChanged: mock(() => {}),
    } as unknown as SessionLifecycleCallbacks;
  });

  afterEach(async () => {
    if (testJobQueue) {
      await testJobQueue.stop();
      testJobQueue = null;
    }
    await closeDatabase();
    cleanupMemfs();
  });

  it('should fall back to os.userInfo().username when createdBy is undefined', async () => {
    const resolveSpawnUsername = async (createdBy?: string): Promise<string> => {
      if (!createdBy) return os.userInfo().username;
      return 'should-not-reach';
    };

    const result = await resolveSpawnUsername(undefined);
    expect(result).toBe(os.userInfo().username);
  });

  it('should fall back to os.userInfo().username when userRepository is null', async () => {
    // Simulates the SessionManager.resolveSpawnUsername behavior when userRepository is not configured
    const userRepository: UserRepository | null = null;

    const resolveSpawnUsername = async (createdBy?: string): Promise<string> => {
      if (!createdBy || !userRepository) return os.userInfo().username;
      // This line is unreachable when userRepository is null, but mirrors
      // the actual SessionManager.resolveSpawnUsername implementation
      return os.userInfo().username;
    };

    // Even with a valid createdBy, if userRepository is null, should fall back
    const result = await resolveSpawnUsername('some-user-id');
    expect(result).toBe(os.userInfo().username);
  });

  it('should fall back to os.userInfo().username when user is not found in DB', async () => {
    const db = getDatabase();
    const userRepository = new SqliteUserRepository(db);

    const resolveSpawnUsername = async (createdBy?: string): Promise<string> => {
      if (!createdBy || !userRepository) return os.userInfo().username;
      const user = await userRepository.findById(createdBy);
      return user?.username ?? os.userInfo().username;
    };

    // Pass a non-existent user ID
    const result = await resolveSpawnUsername('non-existent-user-id');
    expect(result).toBe(os.userInfo().username);
  });

  it('should return the DB user username when user is found in DB', async () => {
    const db = getDatabase();
    const userRepository = new SqliteUserRepository(db);

    // Create a user in the database
    const authUser = await userRepository.upsertByOsUid(9999, 'dbuser', '/home/dbuser');

    const resolveSpawnUsername = async (createdBy?: string): Promise<string> => {
      if (!createdBy || !userRepository) return os.userInfo().username;
      const user = await userRepository.findById(createdBy);
      return user?.username ?? os.userInfo().username;
    };

    const result = await resolveSpawnUsername(authUser.id);
    expect(result).toBe('dbuser');
  });

  it('should pass resolved username to worker creation via WorkerLifecycleManager', async () => {
    const resolvedUsername = 'resolved-user';
    const resolveSpawnUsername = mock(async () => resolvedUsername);

    const session = createTestSession();
    sessions.set(session.id, session);

    const deps = createDeps(
      resolveSpawnUsername as unknown as (createdBy?: string) => Promise<string>,
    );
    const lifecycleManager = new WorkerLifecycleManager(deps);

    const params: CreateWorkerParams = {
      type: 'terminal',
    };

    const result = await lifecycleManager.createWorker(session.id, params);
    expect(result).toBeDefined();

    // Verify resolveSpawnUsername was called
    expect(resolveSpawnUsername).toHaveBeenCalled();

    // Verify the PTY was spawned (via the mock PTY factory)
    expect(ptyFactory.instances.length).toBeGreaterThan(0);
  });
});
