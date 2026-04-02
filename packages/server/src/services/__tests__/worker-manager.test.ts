/**
 * Unit tests for WorkerManager.
 *
 * Tests the core worker lifecycle: initialization, PTY activation (idempotency),
 * I/O operations, cleanup, PTY detachment, activity state detection, and public conversion.
 *
 * Uses mock PTY provider via dependency injection (no mock.module needed).
 */
import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { AgentManager } from '../agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { WorkerManager } from '../worker-manager.js';
import { SingleUserMode } from '../user-mode.js';
import type {
  InternalAgentWorker,
  InternalTerminalWorker,
  InternalGitDiffWorker,
} from '../worker-types.js';
import type { PersistedAgentWorker, PersistedTerminalWorker, PersistedGitDiffWorker } from '../persistence-service.js';
import { CLAUDE_CODE_AGENT_ID } from '../agent-manager.js';
import { SessionDataPathResolver } from '../../lib/session-data-path-resolver.js';
import { WorkerOutputFileManager } from '../../lib/worker-output-file.js';

const TEST_CONFIG_DIR = '/test/config';

describe('WorkerManager', () => {
  const ptyFactory = createMockPtyFactory(10000);
  let workerManager: WorkerManager;
  let agentManager: AgentManager;

  beforeEach(async () => {
    await closeDatabase();

    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    await initializeDatabase(':memory:');

    const db = getDatabase();
    agentManager = await AgentManager.create(new SqliteAgentRepository(db));

    ptyFactory.reset();
    const userMode = new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' });
    workerManager = new WorkerManager(userMode, agentManager, new WorkerOutputFileManager());
  });

  afterEach(async () => {
    await closeDatabase();
    cleanupMemfs();
  });

  // ========== Helpers ==========

  function createTestAgentWorker(id = 'agent-1'): InternalAgentWorker {
    return workerManager.initializeAgentWorker({
      id,
      name: 'Test Agent',
      createdAt: new Date().toISOString(),
      agentId: CLAUDE_CODE_AGENT_ID,
    });
  }

  function createTestTerminalWorker(id = 'terminal-1'): InternalTerminalWorker {
    return workerManager.initializeTerminalWorker({
      id,
      name: 'Test Terminal',
      createdAt: new Date().toISOString(),
    });
  }

  const defaultResolver = new SessionDataPathResolver();

  const defaultAgentActivationParams = {
    sessionId: 'session-1',
    locationPath: '/test/project',
    repositoryEnvVars: {},
    username: 'testuser',
    resolver: defaultResolver,
    agentId: CLAUDE_CODE_AGENT_ID,
    continueConversation: false,
  };

  const defaultTerminalActivationParams = {
    sessionId: 'session-1',
    locationPath: '/test/project',
    repositoryEnvVars: {},
    username: 'testuser',
    resolver: defaultResolver,
  };

  // ========== Worker Initialization ==========

  describe('initializeAgentWorker', () => {
    it('should create an agent worker with pty: null', () => {
      const worker = createTestAgentWorker();

      expect(worker.id).toBe('agent-1');
      expect(worker.type).toBe('agent');
      expect(worker.pty).toBeNull();
      expect(worker.outputBuffer).toBe('');
      expect(worker.outputOffset).toBe(0);
      expect(worker.activityState).toBe('unknown');
      expect(worker.activityDetector).toBeNull();
      expect(worker.connectionCallbacks.size).toBe(0);
    });

    it('should use provided agentId', () => {
      const worker = workerManager.initializeAgentWorker({
        id: 'w-1',
        name: 'Agent',
        createdAt: new Date().toISOString(),
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      expect(worker.agentId).toBe(CLAUDE_CODE_AGENT_ID);
    });
  });

  describe('initializeTerminalWorker', () => {
    it('should create a terminal worker with pty: null', () => {
      const worker = createTestTerminalWorker();

      expect(worker.id).toBe('terminal-1');
      expect(worker.type).toBe('terminal');
      expect(worker.pty).toBeNull();
      expect(worker.outputBuffer).toBe('');
      expect(worker.outputOffset).toBe(0);
      expect(worker.connectionCallbacks.size).toBe(0);
    });
  });

  // ========== PTY Activation Idempotency ==========

  describe('activateAgentWorkerPty', () => {
    it('should spawn a PTY process', () => {
      const worker = createTestAgentWorker();

      workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      expect(worker.pty).not.toBeNull();
      expect(worker.activityDetector).not.toBeNull();
      expect(worker.activityState).toBe('idle');
      expect(ptyFactory.spawn).toHaveBeenCalledTimes(1);
    });

    it('should be idempotent - calling twice does not spawn a second PTY', () => {
      const worker = createTestAgentWorker();

      workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);
      const firstPty = worker.pty;

      workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      expect(worker.pty).toBe(firstPty);
      expect(ptyFactory.spawn).toHaveBeenCalledTimes(1);
    });

    it('should set agentId to the actual agent id, not the requested one, when fallback occurs', () => {
      const worker = createTestAgentWorker();
      // Start with a different agentId to verify fallback actually updates it
      worker.agentId = 'originally-different-agent';

      workerManager.activateAgentWorkerPty(worker, {
        ...defaultAgentActivationParams,
        agentId: 'non-existent-agent',
      });

      // Should fall back to default agent and record its actual id
      expect(worker.agentId).toBe(CLAUDE_CODE_AGENT_ID);
      expect(worker.pty).not.toBeNull();
    });

    it('should set initial activity state to idle and fire global callback', () => {
      const globalCallback = mock(() => {});
      workerManager.setGlobalActivityCallback(globalCallback);

      const worker = createTestAgentWorker('agent-cb');
      workerManager.activateAgentWorkerPty(worker, {
        ...defaultAgentActivationParams,
        sessionId: 'sess-cb',
      });

      expect(worker.activityState).toBe('idle');
      expect(globalCallback).toHaveBeenCalledWith('sess-cb', 'agent-cb', 'idle');
    });
  });

  describe('activateTerminalWorkerPty', () => {
    it('should spawn a PTY process', () => {
      const worker = createTestTerminalWorker();

      workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      expect(worker.pty).not.toBeNull();
      expect(ptyFactory.spawn).toHaveBeenCalledTimes(1);
    });

    it('should be idempotent - calling twice does not spawn a second PTY', () => {
      const worker = createTestTerminalWorker();

      workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);
      const firstPty = worker.pty;

      workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      expect(worker.pty).toBe(firstPty);
      expect(ptyFactory.spawn).toHaveBeenCalledTimes(1);
    });
  });

  // ========== Worker I/O ==========

  describe('writeInput', () => {
    it('should write data to the PTY', () => {
      const worker = createTestTerminalWorker();
      workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const result = workerManager.writeInput(worker, 'ls -la\r');

      expect(result).toBe(true);
      const mockPty = ptyFactory.instances[0];
      expect(mockPty.writtenData).toContain('ls -la\r');
    });

    it('should return false when PTY is not active', () => {
      const worker = createTestTerminalWorker();
      // Worker not activated -- pty is null

      const result = workerManager.writeInput(worker, 'hello');

      expect(result).toBe(false);
    });

    it('should handle activity detection for agent workers on Enter key', () => {
      const worker = createTestAgentWorker();
      workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      // Writing a string containing '\r' triggers clearUserTyping
      const result = workerManager.writeInput(worker, 'hello\r');

      expect(result).toBe(true);
    });
  });

  describe('output buffering via PTY onData', () => {
    it('should append PTY output to outputBuffer and update outputOffset', () => {
      const worker = createTestTerminalWorker();
      workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const mockPty = ptyFactory.instances[0];
      mockPty.simulateData('hello');

      expect(worker.outputBuffer).toBe('hello');
      expect(worker.outputOffset).toBe(Buffer.byteLength('hello', 'utf-8'));
    });

    it('should deliver data to attached callbacks', () => {
      const worker = createTestTerminalWorker();
      workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const receivedData: string[] = [];
      const onData = mock((data: string, _offset: number) => { receivedData.push(data); });
      const onExit = mock((_exitCode: number, _signal: string | null) => {});
      workerManager.attachCallbacks(worker, { onData, onExit });

      const mockPty = ptyFactory.instances[0];
      mockPty.simulateData('output text');

      expect(onData).toHaveBeenCalledTimes(1);
      expect(receivedData[0]).toBe('output text');
    });

    it('should deliver data to multiple attached callbacks', () => {
      const worker = createTestTerminalWorker();
      workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const onData1 = mock(() => {});
      const onData2 = mock(() => {});
      workerManager.attachCallbacks(worker, { onData: onData1, onExit: mock(() => {}) });
      workerManager.attachCallbacks(worker, { onData: onData2, onExit: mock(() => {}) });

      const mockPty = ptyFactory.instances[0];
      mockPty.simulateData('broadcast data');

      expect(onData1).toHaveBeenCalledTimes(1);
      expect(onData2).toHaveBeenCalledTimes(1);
    });
  });

  describe('getOutputBuffer', () => {
    it('should return the accumulated output buffer', () => {
      const worker = createTestTerminalWorker();
      workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const mockPty = ptyFactory.instances[0];
      mockPty.simulateData('line 1\n');
      mockPty.simulateData('line 2\n');

      expect(workerManager.getOutputBuffer(worker)).toBe('line 1\nline 2\n');
    });

    it('should return empty string when no output has been received', () => {
      const worker = createTestTerminalWorker();
      workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      expect(workerManager.getOutputBuffer(worker)).toBe('');
    });
  });

  describe('resize', () => {
    it('should resize the PTY', () => {
      const worker = createTestTerminalWorker();
      workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const result = workerManager.resize(worker, 200, 50);

      expect(result).toBe(true);
      const mockPty = ptyFactory.instances[0];
      expect(mockPty.currentCols).toBe(200);
      expect(mockPty.currentRows).toBe(50);
    });

    it('should return false when PTY is not active', () => {
      const worker = createTestTerminalWorker();

      const result = workerManager.resize(worker, 200, 50);

      expect(result).toBe(false);
    });
  });

  // ========== Callback Attach/Detach ==========

  describe('attachCallbacks / detachCallbacks', () => {
    it('should attach callbacks and return a connection ID', () => {
      const worker = createTestTerminalWorker();
      workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const connectionId = workerManager.attachCallbacks(worker, {
        onData: () => {},
        onExit: () => {},
      });

      expect(connectionId).toBeTruthy();
      expect(worker.connectionCallbacks.size).toBe(1);
    });

    it('should detach callbacks by connection ID', () => {
      const worker = createTestTerminalWorker();
      workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const connectionId = workerManager.attachCallbacks(worker, {
        onData: () => {},
        onExit: () => {},
      });

      const result = workerManager.detachCallbacks(worker, connectionId);

      expect(result).toBe(true);
      expect(worker.connectionCallbacks.size).toBe(0);
    });

    it('should return false when detaching a non-existent connection', () => {
      const worker = createTestTerminalWorker();
      workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const result = workerManager.detachCallbacks(worker, 'nonexistent-id');

      expect(result).toBe(false);
    });

    it('should not deliver data after detaching callbacks', () => {
      const worker = createTestTerminalWorker();
      workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const onData = mock(() => {});
      const connectionId = workerManager.attachCallbacks(worker, {
        onData,
        onExit: () => {},
      });

      workerManager.detachCallbacks(worker, connectionId);

      const mockPty = ptyFactory.instances[0];
      mockPty.simulateData('after detach');

      expect(onData).not.toHaveBeenCalled();
    });
  });

  // ========== killWorker Cleanup ==========

  describe('killWorker', () => {
    it('should kill the PTY process for an agent worker', async () => {
      const worker = createTestAgentWorker();
      workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      const mockPty = ptyFactory.instances[0];
      expect(mockPty.killed).toBe(false);

      await workerManager.killWorker(worker, 'test-session');

      expect(mockPty.killed).toBe(true);
    });

    it('should kill the PTY process for a terminal worker', async () => {
      const worker = createTestTerminalWorker();
      workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const mockPty = ptyFactory.instances[0];
      await workerManager.killWorker(worker, 'test-session');

      expect(mockPty.killed).toBe(true);
    });

    it('should await PTY exit before detaching', async () => {
      const worker = createTestAgentWorker();
      workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      // PTY is set before kill
      expect(worker.pty).not.toBeNull();

      await workerManager.killWorker(worker, 'test-session');

      // After awaiting, PTY should be detached (null)
      expect(worker.pty).toBeNull();
    });

    it('should clean up disposables to prevent memory leaks', async () => {
      const worker = createTestAgentWorker();
      workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      // After activation, disposables should be set
      expect(worker.disposables).toBeDefined();
      expect(worker.disposables!.length).toBeGreaterThan(0);

      await workerManager.killWorker(worker, 'test-session');

      // After kill, disposables should be cleared
      expect(worker.disposables).toBeUndefined();
    });

    it('should be safe to call on a worker with no active PTY', async () => {
      const worker = createTestAgentWorker();
      // Worker not activated -- pty is null

      // Should not throw
      await workerManager.killWorker(worker, 'test-session');
    });

    it('should resolve with timeout when PTY does not exit', async () => {
      jest.useFakeTimers();
      try {
        const worker = createTestAgentWorker();
        workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

        const mockPty = ptyFactory.instances[0];
        // Override kill to NOT fire exit callback (simulates hung process)
        mockPty.kill = function (this: typeof mockPty, _signal?: number) {
          this.killed = true;
        };

        const killPromise = workerManager.killWorker(worker, 'test-session');

        // Advance past PTY_EXIT_TIMEOUT_MS (5000ms)
        jest.advanceTimersByTime(5000);

        await killPromise;

        expect(worker.pty).toBeNull();
        expect(mockPty.killed).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('should be safe to call on a git-diff worker (no PTY)', async () => {
      const worker: InternalGitDiffWorker = {
        id: 'git-diff-1',
        type: 'git-diff',
        name: 'Diff',
        createdAt: new Date().toISOString(),
        baseCommit: 'abc123',
      };

      // Should not throw
      await workerManager.killWorker(worker, 'test-session');
    });
  });

  // ========== detachPty ==========

  describe('detachPty', () => {
    it('should set worker.pty to null', () => {
      const worker = createTestTerminalWorker();
      workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      expect(worker.pty).not.toBeNull();

      workerManager.detachPty(worker);

      expect(worker.pty).toBeNull();
    });

    it('should be safe to call when pty is already null', () => {
      const worker = createTestTerminalWorker();
      expect(worker.pty).toBeNull();

      // Should not throw
      workerManager.detachPty(worker);
      expect(worker.pty).toBeNull();
    });
  });

  // ========== Activity State Detection ==========

  describe('getActivityState', () => {
    it('should return unknown for an unactivated agent worker', () => {
      const worker = createTestAgentWorker();

      expect(workerManager.getActivityState(worker)).toBe('unknown');
    });

    it('should return idle immediately after activation', () => {
      const worker = createTestAgentWorker();
      workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      expect(workerManager.getActivityState(worker)).toBe('idle');
    });
  });

  // ========== PTY Exit Handling ==========

  describe('PTY exit handling', () => {
    it('should set pty to null on exit', () => {
      const worker = createTestAgentWorker();
      workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      const mockPty = ptyFactory.instances[0];
      mockPty.simulateExit(0);

      expect(worker.pty).toBeNull();
    });

    it('should dispose activity detector on agent worker exit', () => {
      const worker = createTestAgentWorker();
      workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      expect(worker.activityDetector).not.toBeNull();

      const mockPty = ptyFactory.instances[0];
      mockPty.simulateExit(0);

      expect(worker.activityDetector).toBeNull();
    });

    it('should notify attached callbacks on exit', () => {
      const worker = createTestTerminalWorker();
      workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const exitCodes: number[] = [];
      const onExit = mock((exitCode: number, _signal: string | null) => { exitCodes.push(exitCode); });
      workerManager.attachCallbacks(worker, {
        onData: (_data: string, _offset: number) => {},
        onExit,
      });

      const mockPty = ptyFactory.instances[0];
      mockPty.simulateExit(42);

      expect(onExit).toHaveBeenCalledTimes(1);
      expect(exitCodes[0]).toBe(42);
    });

    it('should fire global PTY exit callback', () => {
      const globalExitCallback = mock(() => {});
      workerManager.setGlobalPtyExitCallback(globalExitCallback);

      const worker = createTestTerminalWorker('term-exit');
      workerManager.activateTerminalWorkerPty(worker, {
        ...defaultTerminalActivationParams,
        sessionId: 'sess-exit',
      });

      const mockPty = ptyFactory.instances[0];
      mockPty.simulateExit(0);

      expect(globalExitCallback).toHaveBeenCalledWith('sess-exit', 'term-exit', 'unexpected');
    });

    it('should fire global worker exit callback', () => {
      const globalWorkerExitCallback = mock(() => {});
      workerManager.setGlobalWorkerExitCallback(globalWorkerExitCallback);

      const worker = createTestTerminalWorker('term-wexit');
      workerManager.activateTerminalWorkerPty(worker, {
        ...defaultTerminalActivationParams,
        sessionId: 'sess-wexit',
      });

      const mockPty = ptyFactory.instances[0];
      mockPty.simulateExit(1);

      expect(globalWorkerExitCallback).toHaveBeenCalledWith('sess-wexit', 'term-wexit', 1, 'unexpected');
    });
  });

  // ========== toPublicWorker Conversion ==========

  describe('toPublicWorker', () => {
    it('should convert an inactive agent worker (pty: null)', () => {
      const worker = createTestAgentWorker('pub-agent');
      const publicWorker = workerManager.toPublicWorker(worker);

      expect(publicWorker.id).toBe('pub-agent');
      expect(publicWorker.type).toBe('agent');
      if (publicWorker.type === 'agent') {
        expect(publicWorker.agentId).toBe(CLAUDE_CODE_AGENT_ID);
        expect(publicWorker.activated).toBe(false);
      }
    });

    it('should convert an active agent worker (pty active)', () => {
      const worker = createTestAgentWorker();
      workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      const publicWorker = workerManager.toPublicWorker(worker);

      if (publicWorker.type === 'agent') {
        expect(publicWorker.activated).toBe(true);
      }
    });

    it('should convert a terminal worker', () => {
      const worker = createTestTerminalWorker('pub-term');
      const publicWorker = workerManager.toPublicWorker(worker);

      expect(publicWorker.id).toBe('pub-term');
      expect(publicWorker.type).toBe('terminal');
      if (publicWorker.type === 'terminal') {
        expect(publicWorker.activated).toBe(false);
      }
    });

    it('should convert a git-diff worker', () => {
      const worker: InternalGitDiffWorker = {
        id: 'pub-diff',
        type: 'git-diff',
        name: 'Diff',
        createdAt: '2024-01-01T00:00:00Z',
        baseCommit: 'abc123',
      };

      const publicWorker = workerManager.toPublicWorker(worker);

      expect(publicWorker.id).toBe('pub-diff');
      expect(publicWorker.type).toBe('git-diff');
      if (publicWorker.type === 'git-diff') {
        expect(publicWorker.baseCommit).toBe('abc123');
      }
    });
  });

  // ========== toPersistedWorker Conversion ==========

  describe('toPersistedWorker', () => {
    it('should persist agent worker with pid when PTY is active', () => {
      const worker = createTestAgentWorker();
      workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      const persisted = workerManager.toPersistedWorker(worker);

      expect(persisted.type).toBe('agent');
      if (persisted.type === 'agent') {
        expect(persisted.agentId).toBe(CLAUDE_CODE_AGENT_ID);
        expect(persisted.pid).toBe(ptyFactory.instances[0].pid);
      }
    });

    it('should persist agent worker with pid: null when PTY is not active', () => {
      const worker = createTestAgentWorker();

      const persisted = workerManager.toPersistedWorker(worker);

      if (persisted.type === 'agent') {
        expect(persisted.pid).toBeNull();
      }
    });

    it('should persist terminal worker', () => {
      const worker = createTestTerminalWorker();

      const persisted = workerManager.toPersistedWorker(worker);

      expect(persisted.type).toBe('terminal');
      if (persisted.type === 'terminal') {
        expect(persisted.pid).toBeNull();
      }
    });

    it('should persist git-diff worker with baseCommit', () => {
      const worker: InternalGitDiffWorker = {
        id: 'diff-1',
        type: 'git-diff',
        name: 'Diff',
        createdAt: '2024-01-01T00:00:00Z',
        baseCommit: 'def456',
      };

      const persisted = workerManager.toPersistedWorker(worker);

      expect(persisted.type).toBe('git-diff');
      if (persisted.type === 'git-diff') {
        expect(persisted.baseCommit).toBe('def456');
      }
    });
  });

  // ========== restoreWorkersFromPersistence ==========

  describe('restoreWorkersFromPersistence', () => {
    it('should restore agent workers with pty: null', () => {
      const persistedWorkers: PersistedAgentWorker[] = [{
        id: 'restored-agent',
        type: 'agent',
        name: 'Agent',
        createdAt: '2024-01-01T00:00:00Z',
        agentId: 'claude-code',
        pid: 12345,
      }];

      const workers = workerManager.restoreWorkersFromPersistence(persistedWorkers);

      expect(workers.size).toBe(1);
      const worker = workers.get('restored-agent')!;
      expect(worker.type).toBe('agent');
      if (worker.type === 'agent') {
        expect(worker.pty).toBeNull();
        expect(worker.activityState).toBe('unknown');
        expect(worker.activityDetector).toBeNull();
        expect(worker.connectionCallbacks.size).toBe(0);
      }
    });

    it('should restore terminal workers with pty: null', () => {
      const persistedWorkers: PersistedTerminalWorker[] = [{
        id: 'restored-term',
        type: 'terminal',
        name: 'Terminal',
        createdAt: '2024-01-01T00:00:00Z',
        pid: null,
      }];

      const workers = workerManager.restoreWorkersFromPersistence(persistedWorkers);

      const worker = workers.get('restored-term')!;
      expect(worker.type).toBe('terminal');
      if (worker.type === 'terminal') {
        expect(worker.pty).toBeNull();
        expect(worker.connectionCallbacks.size).toBe(0);
      }
    });

    it('should restore git-diff workers fully (no PTY needed)', () => {
      const persistedWorkers: PersistedGitDiffWorker[] = [{
        id: 'restored-diff',
        type: 'git-diff',
        name: 'Diff',
        createdAt: '2024-01-01T00:00:00Z',
        baseCommit: 'xyz789',
      }];

      const workers = workerManager.restoreWorkersFromPersistence(persistedWorkers);

      const worker = workers.get('restored-diff')!;
      expect(worker.type).toBe('git-diff');
      if (worker.type === 'git-diff') {
        expect(worker.baseCommit).toBe('xyz789');
      }
    });

    it('should restore multiple workers of different types', () => {
      const persistedWorkers = [
        { id: 'a1', type: 'agent' as const, name: 'A', createdAt: '2024-01-01T00:00:00Z', agentId: 'claude-code', pid: 100 },
        { id: 't1', type: 'terminal' as const, name: 'T', createdAt: '2024-01-01T00:00:00Z', pid: null },
        { id: 'd1', type: 'git-diff' as const, name: 'D', createdAt: '2024-01-01T00:00:00Z', baseCommit: 'head' },
      ];

      const workers = workerManager.restoreWorkersFromPersistence(persistedWorkers);

      expect(workers.size).toBe(3);
      expect(workers.get('a1')!.type).toBe('agent');
      expect(workers.get('t1')!.type).toBe('terminal');
      expect(workers.get('d1')!.type).toBe('git-diff');
    });

    it('should give each worker its own connectionCallbacks Map', () => {
      const persistedWorkers = [
        { id: 'a1', type: 'agent' as const, name: 'A', createdAt: '2024-01-01T00:00:00Z', agentId: 'claude-code', pid: null },
        { id: 'a2', type: 'agent' as const, name: 'B', createdAt: '2024-01-01T00:00:00Z', agentId: 'claude-code', pid: null },
      ];

      const workers = workerManager.restoreWorkersFromPersistence(persistedWorkers);

      const w1 = workers.get('a1')! as InternalAgentWorker;
      const w2 = workers.get('a2')! as InternalAgentWorker;
      // They should be separate Map instances
      expect(w1.connectionCallbacks).not.toBe(w2.connectionCallbacks);
    });
  });

  // ========== Global Callbacks ==========

  describe('setGlobalActivityCallback', () => {
    it('should fire on activity state changes from PTY output', () => {
      const globalCallback = mock(() => {});
      workerManager.setGlobalActivityCallback(globalCallback);

      const worker = createTestAgentWorker('act-worker');
      workerManager.activateAgentWorkerPty(worker, {
        ...defaultAgentActivationParams,
        sessionId: 'act-session',
      });

      // The initial 'idle' state is set during activation
      expect(globalCallback).toHaveBeenCalledWith('act-session', 'act-worker', 'idle');
    });
  });

  // ========== setupWorkerEventHandlers validation ==========

  describe('setupWorkerEventHandlers validation', () => {
    it('should throw if sessionId is empty string', () => {
      const worker = createTestTerminalWorker();
      // We need to bypass the PTY null check by setting pty first
      // Actually, activateTerminalWorkerPty calls setupWorkerEventHandlers internally
      // So we test by passing an empty sessionId
      expect(() => {
        workerManager.activateTerminalWorkerPty(worker, {
          ...defaultTerminalActivationParams,
          sessionId: '',
        });
      }).toThrow('sessionId is required');
    });
  });
});
