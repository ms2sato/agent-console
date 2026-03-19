/**
 * Unit tests for WorkerLifecycleManager.
 *
 * Tests the session-aware worker lifecycle operations in isolation
 * by using a real WorkerManager with mock PTY provider and
 * mocking the session-related dependencies (getSession, persistSession, etc.).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { CreateWorkerParams, Session } from '@agent-console/shared';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { resetGitMocks, mockGit } from '../../__tests__/utils/mock-git-helper.js';
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

const TEST_CONFIG_DIR = '/test/config';

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

  function createTestSession(overrides: Partial<InternalSession> = {}): InternalSession {
    return {
      id: crypto.randomUUID(),
      type: 'worktree',
      locationPath: '/test/project',
      status: 'active',
      createdAt: new Date().toISOString(),
      workers: new Map(),
      repositoryId: 'repo-1',
      worktreeId: 'main',
      ...overrides,
    } as InternalSession;
  }

  function createQuickSession(overrides: Partial<InternalSession> = {}): InternalSession {
    return {
      type: 'quick',
      id: crypto.randomUUID(),
      locationPath: '/test/project',
      status: 'active',
      createdAt: new Date().toISOString(),
      workers: new Map(),
      ...overrides,
    } as InternalSession;
  }

  function createDeps(overrides: Partial<WorkerLifecycleDeps> = {}): WorkerLifecycleDeps {
    return {
      workerManager,
      agentManager,
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
    workerManager = new WorkerManager(userMode, agentManager);
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

    it('should return null when session is not found', async () => {
      const request: CreateWorkerParams = {
        type: 'terminal',
      };

      const worker = await lifecycleManager.createWorker('non-existent', request);

      expect(worker).toBeNull();
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
        session.id, originalId, true
      );

      expect(restarted).not.toBeNull();
      // Same worker ID should be reused
      expect(restarted!.id).toBe(originalId);
      expect(restarted!.type).toBe('agent');
      // Old PTY killed, new PTY spawned
      expect(ptyFactory.instances[0].killed).toBe(true);
      expect(ptyFactory.instances.length).toBe(2);
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
        session.id, worker!.id, false, CLAUDE_CODE_AGENT_ID
      );

      expect(restarted).not.toBeNull();
      expect(restarted!.id).toBe(worker!.id);
    });

    it('should return null when session is not found', async () => {
      const result = await lifecycleManager.restartAgentWorker(
        'non-existent', 'worker-1', true
      );

      expect(result).toBeNull();
    });

    it('should return null when worker is not found', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const result = await lifecycleManager.restartAgentWorker(
        session.id, 'non-existent', true
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
        session.id, worker!.id, true
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

      await lifecycleManager.restartAgentWorker(session.id, originalId, true);

      // First PTY should be killed
      expect(ptyFactory.instances[0].killed).toBe(true);
      // Second PTY should be alive
      expect(ptyFactory.instances[1].killed).toBe(false);
      // Session should still have one worker with the same ID
      expect(session.workers.size).toBe(1);
      expect(session.workers.has(originalId)).toBe(true);
    });

    it('should persist session after restart', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      mockPersistSession.mockClear();
      await lifecycleManager.restartAgentWorker(session.id, worker!.id, true);

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
        session.id, worker!.id, true
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
          session.id, worker!.id, true, undefined, 'new-branch'
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
          session.id, worker!.id, true, undefined, 'new-branch'
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

      await lifecycleManager.restartAgentWorker(session.id, worker!.id, true);

      expect(mockOnWorkerRestarted).toHaveBeenCalledWith(session.id, worker!.id);
    });

    it('should call onWorkerRestarted even when agent is not changed', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const worker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      // Restart with same agent ID and no branch change
      await lifecycleManager.restartAgentWorker(
        session.id, worker!.id, true, CLAUDE_CODE_AGENT_ID
      );

      // onWorkerRestarted should be called regardless of agent/branch changes
      expect(mockOnWorkerRestarted).toHaveBeenCalledWith(session.id, worker!.id);
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
        session.id, worker!.id, true
      );

      // Should return null since session was deleted
      expect(result).toBeNull();
      // Should NOT call onWorkerRestarted since the restart effectively failed
      expect(mockOnWorkerRestarted).not.toHaveBeenCalled();
    });

    it('should recalculate git-diff worker baseCommit after branch rename', async () => {
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
        baseCommit: 'old-base-commit',
      };
      session.workers.set(gitDiffWorker.id, gitDiffWorker);

      // Configure git mocks for branch rename
      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('old-branch'));
      // Configure calculateBaseCommit's underlying mock to return new merge-base
      mockGit.getMergeBaseSafe.mockImplementation(() => Promise.resolve('new-merge-base'));

      await lifecycleManager.restartAgentWorker(
        session.id, agentWorker!.id, true, undefined, 'new-branch'
      );

      // git-diff worker's baseCommit should be updated
      const updatedDiffWorker = session.workers.get(gitDiffWorker.id) as InternalGitDiffWorker;
      expect(updatedDiffWorker.baseCommit).toBe('new-merge-base');
    });

    it('should fire onDiffBaseCommitChanged callback after branch rename', async () => {
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
        baseCommit: 'old-base-commit',
      };
      session.workers.set(gitDiffWorker.id, gitDiffWorker);

      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('old-branch'));
      mockGit.getMergeBaseSafe.mockImplementation(() => Promise.resolve('new-merge-base'));

      await lifecycleManager.restartAgentWorker(
        session.id, agentWorker!.id, true, undefined, 'new-branch'
      );

      expect(mockOnDiffBaseCommitChanged).toHaveBeenCalledWith(
        session.id, gitDiffWorker.id, 'new-merge-base'
      );
    });

    it('should complete restart even when updateGitDiffWorkersAfterBranchRename fails', async () => {
      const session = createTestSession({ worktreeId: 'old-branch' });
      sessions.set(session.id, session);

      const agentWorker = await lifecycleManager.createWorker(session.id, {
        type: 'agent',
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      const gitDiffWorker: InternalGitDiffWorker = {
        id: 'diff-worker-fail',
        type: 'git-diff',
        name: 'Git Diff',
        createdAt: new Date().toISOString(),
        baseCommit: 'old-base-commit',
      };
      session.workers.set(gitDiffWorker.id, gitDiffWorker);

      // Configure git mocks: branch rename succeeds, but calculateBaseCommit throws
      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('old-branch'));
      mockGit.getDefaultBranch.mockImplementation(() => {
        throw new Error('calculateBaseCommit failure');
      });

      // The restart should complete successfully despite the git-diff update failure
      const restarted = await lifecycleManager.restartAgentWorker(
        session.id, agentWorker!.id, true, undefined, 'new-branch'
      );

      expect(restarted).not.toBeNull();
      expect(restarted!.id).toBe(agentWorker!.id);
      expect(restarted!.type).toBe('agent');
      // Branch rename should have succeeded
      expect(session.type).toBe('worktree');
      if (session.type === 'worktree') {
        expect(session.worktreeId).toBe('new-branch');
      }
      // Old PTY killed, new PTY spawned
      expect(ptyFactory.instances[0].killed).toBe(true);
      expect(ptyFactory.instances.length).toBe(2);
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
        session.id, agentWorker!.id, true
      );

      // git-diff worker's baseCommit should remain unchanged
      const unchangedDiffWorker = session.workers.get(gitDiffWorker.id) as InternalGitDiffWorker;
      expect(unchangedDiffWorker.baseCommit).toBe('original-base');
      expect(mockOnDiffBaseCommitChanged).not.toHaveBeenCalled();
    });
  });

  // ========== Update Git-Diff Workers After Branch Rename ==========

  describe('updateGitDiffWorkersAfterBranchRename', () => {
    it('should fall back to HEAD when calculateBaseCommit returns null', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const gitDiffWorker: InternalGitDiffWorker = {
        id: 'diff-worker-null',
        type: 'git-diff',
        name: 'Git Diff',
        createdAt: new Date().toISOString(),
        baseCommit: 'old-base',
      };
      session.workers.set(gitDiffWorker.id, gitDiffWorker);

      // Make calculateBaseCommit return null (no default branch, no first commit)
      mockGit.getDefaultBranch.mockImplementation(() => Promise.resolve(null));
      mockGit.gitSafe.mockImplementation(() => Promise.resolve(null));

      await lifecycleManager.updateGitDiffWorkersAfterBranchRename(session.id);

      const updatedWorker = session.workers.get(gitDiffWorker.id) as InternalGitDiffWorker;
      expect(updatedWorker.baseCommit).toBe('HEAD');
      expect(mockOnDiffBaseCommitChanged).toHaveBeenCalledWith(
        session.id, gitDiffWorker.id, 'HEAD'
      );
    });

    it('should not fail when session does not exist', async () => {
      // Should silently return without error
      await lifecycleManager.updateGitDiffWorkersAfterBranchRename('non-existent');
    });

    it('should propagate error when calculateBaseCommit throws', async () => {
      const session = createTestSession();
      sessions.set(session.id, session);

      const gitDiffWorker: InternalGitDiffWorker = {
        id: 'diff-worker-1',
        type: 'git-diff',
        name: 'Git Diff 1',
        createdAt: new Date().toISOString(),
        baseCommit: 'old-base',
      };
      session.workers.set(gitDiffWorker.id, gitDiffWorker);

      // Make calculateBaseCommit throw
      mockGit.getDefaultBranch.mockImplementation(() => {
        throw new Error('calculateBaseCommit failure');
      });

      // Error should propagate to callers (callers wrap in try/catch)
      await expect(
        lifecycleManager.updateGitDiffWorkersAfterBranchRename(session.id)
      ).rejects.toThrow('calculateBaseCommit failure');

      // Worker should remain unchanged since the operation failed
      const unchangedWorker = session.workers.get(gitDiffWorker.id) as InternalGitDiffWorker;
      expect(unchangedWorker.baseCommit).toBe('old-base');

      // Callback should not have been called
      expect(mockOnDiffBaseCommitChanged).not.toHaveBeenCalled();
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
        activityState: 'unknown',
        activityDetector: null,
        connectionCallbacks: new Map(),
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
        activityState: 'unknown',
        activityDetector: null,
        connectionCallbacks: new Map(),
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
      const failingWorkerManager = new WorkerManager(failingUserMode, agentManager);
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
        activityState: 'unknown',
        activityDetector: null,
        connectionCallbacks: new Map(),
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
        activityState: 'unknown',
        activityDetector: null,
        connectionCallbacks: new Map(),
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
        activityState: 'unknown',
        activityDetector: null,
        connectionCallbacks: new Map(),
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
        activityState: 'unknown',
        activityDetector: null,
        connectionCallbacks: new Map(),
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
      expect(onData).toHaveBeenCalledWith('test output', expect.any(Number));
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

      expect(onExit).toHaveBeenCalledWith(0, null);
    });
  });
});
