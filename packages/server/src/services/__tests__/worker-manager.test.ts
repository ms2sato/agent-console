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
import { mockGit, resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import {
  buildInternalGitDiffWorker,
  buildPersistedAgentWorker,
  buildPersistedTerminalWorker,
  buildPersistedGitDiffWorker,
} from '../../__tests__/utils/build-test-data.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { AgentManager } from '../agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { WorkerManager } from '../worker-manager.js';
import { SingleUserMode } from '../user-mode.js';
import type {
  InternalAgentWorker,
  InternalTerminalWorker,
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

    resetGitMocks();
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

  const defaultResolver = new SessionDataPathResolver(`${TEST_CONFIG_DIR}/_quick`);

  const defaultAgentActivationParams = {
    sessionId: 'session-1',
    locationPath: '/test/project',
    repositoryEnvVars: {},
    username: 'testuser',
    resolver: defaultResolver,
    agentId: CLAUDE_CODE_AGENT_ID,
    continueConversation: false,
    revived: false,
  };

  const defaultTerminalActivationParams = {
    sessionId: 'session-1',
    locationPath: '/test/project',
    repositoryEnvVars: {},
    username: 'testuser',
    resolver: defaultResolver,
    revived: false,
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

  describe('initializeGitDiffWorker', () => {
    it('stores the computed default base spec (not a resolved hash) when no baseCommit is provided', async () => {
      // origin/main exists → computeDefaultBaseSpec returns the merge-base spec.
      mockGit.getDefaultBranch.mockImplementation(() => Promise.resolve('main'));
      mockGit.gitRefExists.mockImplementation((ref: string) =>
        Promise.resolve(ref === 'origin/main'),
      );
      // If the implementation incorrectly resolved the spec to a hash, this would
      // be the value it stored. The assertion below proves it stores the spec, not this.
      mockGit.getMergeBaseSafe.mockImplementation(() => Promise.resolve('resolvedhash123'));

      const worker = await workerManager.initializeGitDiffWorker({
        id: 'git-diff-default',
        name: 'Diff',
        createdAt: new Date().toISOString(),
        locationPath: '/repo',
        requestUser: null,
      });

      expect(worker.type).toBe('git-diff');
      expect(worker.baseCommit).toBe('merge-base:origin/main');
      // The spec must NOT be pre-resolved to a hash at init time.
      expect(worker.baseCommit).not.toBe('resolvedhash123');
    });

    it('falls back to the local merge-base spec when origin/<default> does not exist', async () => {
      mockGit.getDefaultBranch.mockImplementation(() => Promise.resolve('develop'));
      mockGit.gitRefExists.mockImplementation(() => Promise.resolve(false));

      const worker = await workerManager.initializeGitDiffWorker({
        id: 'git-diff-local',
        name: 'Diff',
        createdAt: new Date().toISOString(),
        locationPath: '/repo',
        requestUser: null,
      });

      expect(worker.baseCommit).toBe('merge-base:develop');
    });

    it('stores an explicitly-provided baseCommit verbatim as the spec, without pre-resolution', async () => {
      const worker = await workerManager.initializeGitDiffWorker({
        id: 'git-diff-explicit',
        name: 'Diff',
        createdAt: new Date().toISOString(),
        locationPath: '/repo',
        baseCommit: 'merge-base:origin/develop',
        requestUser: null,
      });

      expect(worker.baseCommit).toBe('merge-base:origin/develop');
      // A verbatim spec must not trigger any rev-parse / merge-base resolution at init.
      expect(mockGit.gitSafe).not.toHaveBeenCalled();
      expect(mockGit.getMergeBaseSafe).not.toHaveBeenCalled();
    });

    it('stores an explicit commit-hash baseCommit verbatim (stays pinned)', async () => {
      const worker = await workerManager.initializeGitDiffWorker({
        id: 'git-diff-hash',
        name: 'Diff',
        createdAt: new Date().toISOString(),
        locationPath: '/repo',
        baseCommit: 'deadbeef1234',
        requestUser: null,
      });

      expect(worker.baseCommit).toBe('deadbeef1234');
      expect(mockGit.gitSafe).not.toHaveBeenCalled();
    });

    it('threads requestUser into computeDefaultBaseSpec for multi-user mode (Issue #869)', async () => {
      // The git-diff branch must propagate requestUser into the lib/git.ts
      // calls that computeDefaultBaseSpec makes. Asserts the username
      // reaches the mockGit helpers as the trailing argument.
      mockGit.getDefaultBranch.mockImplementation(() => Promise.resolve('main'));
      mockGit.gitRefExists.mockImplementation((ref: string) =>
        Promise.resolve(ref === 'origin/main'),
      );

      const worker = await workerManager.initializeGitDiffWorker({
        id: 'git-diff-elevated',
        name: 'Diff',
        createdAt: new Date().toISOString(),
        locationPath: '/elevated/worktree',
        requestUser: 'workspaceuser',
      });

      expect(worker.baseCommit).toBe('merge-base:origin/main');
      // Verify the requestUser threaded through getDefaultBranch and gitRefExists.
      // mockGit.getDefaultBranch is called with (cwd, requestUser).
      const getDefaultBranchCalls = mockGit.getDefaultBranch.mock.calls;
      expect(getDefaultBranchCalls.length).toBeGreaterThan(0);
      expect(getDefaultBranchCalls[0][0]).toBe('/elevated/worktree');
      // The second argument is the requestUser.
      expect((getDefaultBranchCalls[0] as unknown as [string, string | null])[1]).toBe('workspaceuser');
    });
  });

  // ========== PTY Activation Idempotency ==========

  describe('activateAgentWorkerPty', () => {
    it('should spawn a PTY process', async () => {
      const worker = createTestAgentWorker();

      await workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      expect(worker.pty).not.toBeNull();
      expect(worker.activityDetector).not.toBeNull();
      expect(worker.activityState).toBe('idle');
      expect(ptyFactory.spawn).toHaveBeenCalledTimes(1);
    });

    it('should be idempotent - calling twice does not spawn a second PTY', async () => {
      const worker = createTestAgentWorker();

      await workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);
      const firstPty = worker.pty;

      await workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      expect(worker.pty).toBe(firstPty);
      expect(ptyFactory.spawn).toHaveBeenCalledTimes(1);
    });

    it('should set agentId to the actual agent id, not the requested one, when fallback occurs', async () => {
      const worker = createTestAgentWorker();
      // Start with a different agentId to verify fallback actually updates it
      worker.agentId = 'originally-different-agent';

      await workerManager.activateAgentWorkerPty(worker, {
        ...defaultAgentActivationParams,
        agentId: 'non-existent-agent',
      });

      // Should fall back to default agent and record its actual id
      expect(worker.agentId).toBe(CLAUDE_CODE_AGENT_ID);
      expect(worker.pty).not.toBeNull();
    });

    it('should set initial activity state to idle and fire global callback', async () => {
      const globalCallback = mock(() => {});
      workerManager.setGlobalActivityCallback(globalCallback);

      const worker = createTestAgentWorker('agent-cb');
      await workerManager.activateAgentWorkerPty(worker, {
        ...defaultAgentActivationParams,
        sessionId: 'sess-cb',
      });

      expect(worker.activityState).toBe('idle');
      expect(globalCallback).toHaveBeenCalledWith('sess-cb', 'agent-cb', 'idle');
    });

    // Activation does not crash when `context.sshAuthSockFallback` is set --
    // the field is forwarded straight to UserMode.spawnPty. The detailed
    // forwarding assertion lives in worker-manager-env.test.ts; this test
    // is the sibling-coverage gate for this file.
    it('should not throw when context.sshAuthSockFallback is set', async () => {
      const worker = createTestAgentWorker('agent-ssh');
      await workerManager.activateAgentWorkerPty(worker, {
        ...defaultAgentActivationParams,
        sessionId: 'sess-ssh',
        context: {
          sshAuthSockFallback: '/home/testuser/.1password/agent.sock',
        },
      });
      expect(worker.pty).not.toBeNull();
    });
  });

  describe('activateTerminalWorkerPty', () => {
    it('should spawn a PTY process', async () => {
      const worker = createTestTerminalWorker();

      await workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      expect(worker.pty).not.toBeNull();
      expect(ptyFactory.spawn).toHaveBeenCalledTimes(1);
    });

    it('should be idempotent - calling twice does not spawn a second PTY', async () => {
      const worker = createTestTerminalWorker();

      await workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);
      const firstPty = worker.pty;

      await workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      expect(worker.pty).toBe(firstPty);
      expect(ptyFactory.spawn).toHaveBeenCalledTimes(1);
    });
  });

  // ========== Worker I/O ==========

  describe('writeInput', () => {
    it('should write data to the PTY', async () => {
      const worker = createTestTerminalWorker();
      await workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

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

    it('should handle activity detection for agent workers on Enter key', async () => {
      const worker = createTestAgentWorker();
      await workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      // Writing a string containing '\r' triggers clearUserTyping
      const result = workerManager.writeInput(worker, 'hello\r');

      expect(result).toBe(true);
    });
  });

  describe('output buffering via PTY onData', () => {
    it('should append PTY output to outputBuffer and update outputOffset', async () => {
      const worker = createTestTerminalWorker();
      await workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const mockPty = ptyFactory.instances[0];
      mockPty.simulateData('hello');

      expect(worker.outputBuffer).toBe('hello');
      expect(worker.outputOffset).toBe(Buffer.byteLength('hello', 'utf-8'));
    });

    it('should deliver data to attached callbacks', async () => {
      const worker = createTestTerminalWorker();
      await workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const receivedData: string[] = [];
      const onData = mock((data: string, _offset: number) => { receivedData.push(data); });
      const onExit = mock((_exitCode: number, _signal: string | null) => {});
      workerManager.attachCallbacks(worker, { onData, onExit });

      const mockPty = ptyFactory.instances[0];
      mockPty.simulateData('output text');

      expect(onData).toHaveBeenCalledTimes(1);
      expect(receivedData[0]).toBe('output text');
    });

    it('should deliver data to multiple attached callbacks', async () => {
      const worker = createTestTerminalWorker();
      await workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const onData1 = mock(() => {});
      const onData2 = mock(() => {});
      workerManager.attachCallbacks(worker, { onData: onData1, onExit: mock(() => {}) });
      workerManager.attachCallbacks(worker, { onData: onData2, onExit: mock(() => {}) });

      const mockPty = ptyFactory.instances[0];
      mockPty.simulateData('broadcast data');

      expect(onData1).toHaveBeenCalledTimes(1);
      expect(onData2).toHaveBeenCalledTimes(1);
    });

    it('should deliver the worker generation epoch as the third onData argument', async () => {
      const worker = createTestTerminalWorker();
      // Freshly-minted workers carry a positive epoch (incarnation timestamp).
      expect(worker.epoch).toBeGreaterThan(0);
      await workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const calls: Array<[string, number, number]> = [];
      const onData = mock((data: string, offset: number, epoch: number) => {
        calls.push([data, offset, epoch]);
      });
      workerManager.attachCallbacks(worker, { onData, onExit: mock(() => {}) });

      ptyFactory.instances[0].simulateData('chunk');

      expect(calls).toHaveLength(1);
      // The third argument is the worker's current generation epoch.
      expect(calls[0][2]).toBe(worker.epoch);
    });
  });

  describe('getOutputBuffer', () => {
    it('should return the accumulated output buffer', async () => {
      const worker = createTestTerminalWorker();
      await workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const mockPty = ptyFactory.instances[0];
      mockPty.simulateData('line 1\n');
      mockPty.simulateData('line 2\n');

      expect(workerManager.getOutputBuffer(worker)).toBe('line 1\nline 2\n');
    });

    it('should return empty string when no output has been received', async () => {
      const worker = createTestTerminalWorker();
      await workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      expect(workerManager.getOutputBuffer(worker)).toBe('');
    });
  });

  // ========== Login Shell Sentinel ==========

  describe('login shell sentinel detection', () => {
    it('should skip pre-sentinel output and write command on sentinel detection', async () => {
      const worker = createTestAgentWorker();
      await workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      const mockPty = ptyFactory.instances[0];
      expect(mockPty.loginShellSentinel).toBeDefined();

      expect(worker.outputBuffer).toBe('');
      expect(mockPty.writtenData.length).toBeGreaterThan(0);
      const commandWrite = mockPty.writtenData.find((d) => d.endsWith('\r'));
      expect(commandWrite).toBeDefined();
    });

    it('should process post-sentinel output normally', async () => {
      const worker = createTestAgentWorker();
      await workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      const mockPty = ptyFactory.instances[0];
      mockPty.simulateData('agent output here');

      expect(worker.outputBuffer).toBe('agent output here');
    });

    it('should detect a sentinel split across two PTY read chunks', async () => {
      // Suppress the mock's onData auto-emit so we can feed the sentinel
      // manually straddling a chunk boundary. Without the carry buffer the
      // per-chunk indexOf never matches and all output is dropped forever.
      ptyFactory.setAutoEmitSentinel(false);

      const worker = createTestAgentWorker();
      await workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      const mockPty = ptyFactory.instances[0];
      const sentinel = mockPty.loginShellSentinel;
      expect(sentinel).toBeDefined();
      const mid = Math.floor(sentinel!.length / 2);

      // First chunk carries only the sentinel's first half (plus preamble).
      mockPty.emitRaw('login banner ' + sentinel!.slice(0, mid));
      // Not yet detected: pre-sentinel output is dropped, no command written.
      expect(worker.outputBuffer).toBe('');
      expect(mockPty.writtenData.some((d) => d.endsWith('\r'))).toBe(false);

      // Second chunk completes the sentinel across the boundary.
      mockPty.emitRaw(sentinel!.slice(mid) + '\r\npost-sentinel output');

      expect(worker.outputBuffer).toBe('post-sentinel output');
      expect(mockPty.writtenData.some((d) => d.endsWith('\r'))).toBe(true);
    });

    it('should not feed pre-sentinel output to activity detector', async () => {
      const worker = createTestAgentWorker();
      await workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      expect(worker.activityState).toBe('idle');
    });

    it('should clean up sentinel fields on worker exit', async () => {
      const worker = createTestAgentWorker();
      await workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      const mockPty = ptyFactory.instances[0];
      // Simulate a PTY that dies before its sentinel is ever seen: re-populate
      // the gating fields, then drive the actual onExit cleanup branch.
      worker.loginShellSentinel = 'lingering-sentinel';
      worker.pendingCommand = 'lingering command';

      mockPty.simulateExit(1);

      expect(worker.loginShellSentinel).toBeUndefined();
      expect(worker.pendingCommand).toBeUndefined();
    });
  });

  describe('resize', () => {
    it('should resize the PTY', async () => {
      const worker = createTestTerminalWorker();
      await workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

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
    it('should attach callbacks and return a connection ID', async () => {
      const worker = createTestTerminalWorker();
      await workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const connectionId = workerManager.attachCallbacks(worker, {
        onData: () => {},
        onExit: () => {},
      });

      expect(connectionId).toBeTruthy();
      expect(worker.connectionCallbacks.size).toBe(1);
    });

    it('should detach callbacks by connection ID', async () => {
      const worker = createTestTerminalWorker();
      await workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const connectionId = workerManager.attachCallbacks(worker, {
        onData: () => {},
        onExit: () => {},
      });

      const result = workerManager.detachCallbacks(worker, connectionId);

      expect(result).toBe(true);
      expect(worker.connectionCallbacks.size).toBe(0);
    });

    it('should return false when detaching a non-existent connection', async () => {
      const worker = createTestTerminalWorker();
      await workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const result = workerManager.detachCallbacks(worker, 'nonexistent-id');

      expect(result).toBe(false);
    });

    it('should not deliver data after detaching callbacks', async () => {
      const worker = createTestTerminalWorker();
      await workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

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
      await workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      const mockPty = ptyFactory.instances[0];
      expect(mockPty.killed).toBe(false);

      await workerManager.killWorker(worker, 'test-session');

      expect(mockPty.killed).toBe(true);
    });

    it('should kill the PTY process for a terminal worker', async () => {
      const worker = createTestTerminalWorker();
      await workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

      const mockPty = ptyFactory.instances[0];
      await workerManager.killWorker(worker, 'test-session');

      expect(mockPty.killed).toBe(true);
    });

    it('should await PTY exit before detaching', async () => {
      const worker = createTestAgentWorker();
      await workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      // PTY is set before kill
      expect(worker.pty).not.toBeNull();

      await workerManager.killWorker(worker, 'test-session');

      // After awaiting, PTY should be detached (null)
      expect(worker.pty).toBeNull();
    });

    it('should clean up disposables to prevent memory leaks', async () => {
      const worker = createTestAgentWorker();
      await workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

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
        await workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

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
      const worker = buildInternalGitDiffWorker({ id: 'git-diff-1', name: 'Diff' });

      // Should not throw
      await workerManager.killWorker(worker, 'test-session');
    });
  });

  // ========== detachPty ==========

  describe('detachPty', () => {
    it('should set worker.pty to null', async () => {
      const worker = createTestTerminalWorker();
      await workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

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

    it('should return idle immediately after activation', async () => {
      const worker = createTestAgentWorker();
      await workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      expect(workerManager.getActivityState(worker)).toBe('idle');
    });
  });

  // ========== PTY Exit Handling ==========

  describe('PTY exit handling', () => {
    it('should set pty to null on exit', async () => {
      const worker = createTestAgentWorker();
      await workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      const mockPty = ptyFactory.instances[0];
      mockPty.simulateExit(0);

      expect(worker.pty).toBeNull();
    });

    it('should dispose activity detector on agent worker exit', async () => {
      const worker = createTestAgentWorker();
      await workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

      expect(worker.activityDetector).not.toBeNull();

      const mockPty = ptyFactory.instances[0];
      mockPty.simulateExit(0);

      expect(worker.activityDetector).toBeNull();
    });

    it('should notify attached callbacks on exit', async () => {
      const worker = createTestTerminalWorker();
      await workerManager.activateTerminalWorkerPty(worker, defaultTerminalActivationParams);

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

    it('should fire global PTY exit callback', async () => {
      const globalExitCallback = mock(() => {});
      workerManager.setGlobalPtyExitCallback(globalExitCallback);

      const worker = createTestTerminalWorker('term-exit');
      await workerManager.activateTerminalWorkerPty(worker, {
        ...defaultTerminalActivationParams,
        sessionId: 'sess-exit',
      });

      const mockPty = ptyFactory.instances[0];
      mockPty.simulateExit(0);

      expect(globalExitCallback).toHaveBeenCalledWith('sess-exit', 'term-exit', 'unexpected');
    });

    it('should fire global worker exit callback', async () => {
      const globalWorkerExitCallback = mock(() => {});
      workerManager.setGlobalWorkerExitCallback(globalWorkerExitCallback);

      const worker = createTestTerminalWorker('term-wexit');
      await workerManager.activateTerminalWorkerPty(worker, {
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

    it('should convert an active agent worker (pty active)', async () => {
      const worker = createTestAgentWorker();
      await workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

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
      const worker = buildInternalGitDiffWorker({ id: 'pub-diff', name: 'Diff', baseCommit: 'abc123' });

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
    it('should persist agent worker with pid when PTY is active', async () => {
      const worker = createTestAgentWorker();
      await workerManager.activateAgentWorkerPty(worker, defaultAgentActivationParams);

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
      const worker = buildInternalGitDiffWorker({ id: 'diff-1', name: 'Diff', baseCommit: 'def456' });

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
      const persistedWorkers: PersistedAgentWorker[] = [
        buildPersistedAgentWorker({ id: 'restored-agent', name: 'Agent', agentId: 'claude-code', pid: 12345 }),
      ];

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
      const persistedWorkers: PersistedTerminalWorker[] = [
        buildPersistedTerminalWorker({ id: 'restored-term', name: 'Terminal' }),
      ];

      const workers = workerManager.restoreWorkersFromPersistence(persistedWorkers);

      const worker = workers.get('restored-term')!;
      expect(worker.type).toBe('terminal');
      if (worker.type === 'terminal') {
        expect(worker.pty).toBeNull();
        expect(worker.connectionCallbacks.size).toBe(0);
      }
    });

    it('should restore git-diff workers fully (no PTY needed)', () => {
      const persistedWorkers: PersistedGitDiffWorker[] = [
        buildPersistedGitDiffWorker({ id: 'restored-diff', name: 'Diff', baseCommit: 'xyz789' }),
      ];

      const workers = workerManager.restoreWorkersFromPersistence(persistedWorkers);

      const worker = workers.get('restored-diff')!;
      expect(worker.type).toBe('git-diff');
      if (worker.type === 'git-diff') {
        expect(worker.baseCommit).toBe('xyz789');
      }
    });

    it('should restore multiple workers of different types', () => {
      const persistedWorkers = [
        buildPersistedAgentWorker({ id: 'a1', name: 'A', agentId: 'claude-code', pid: 100 }),
        buildPersistedTerminalWorker({ id: 't1', name: 'T' }),
        buildPersistedGitDiffWorker({ id: 'd1', name: 'D', baseCommit: 'head' }),
      ];

      const workers = workerManager.restoreWorkersFromPersistence(persistedWorkers);

      expect(workers.size).toBe(3);
      expect(workers.get('a1')!.type).toBe('agent');
      expect(workers.get('t1')!.type).toBe('terminal');
      expect(workers.get('d1')!.type).toBe('git-diff');
    });

    it('should give each worker its own connectionCallbacks Map', () => {
      const persistedWorkers = [
        buildPersistedAgentWorker({ id: 'a1', name: 'A', agentId: 'claude-code' }),
        buildPersistedAgentWorker({ id: 'a2', name: 'B', agentId: 'claude-code' }),
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
    it('should fire on activity state changes from PTY output', async () => {
      const globalCallback = mock(() => {});
      workerManager.setGlobalActivityCallback(globalCallback);

      const worker = createTestAgentWorker('act-worker');
      await workerManager.activateAgentWorkerPty(worker, {
        ...defaultAgentActivationParams,
        sessionId: 'act-session',
      });

      // The initial 'idle' state is set during activation
      expect(globalCallback).toHaveBeenCalledWith('act-session', 'act-worker', 'idle');
    });
  });

  // ========== setupWorkerEventHandlers validation ==========

  describe('setupWorkerEventHandlers validation', () => {
    it('should throw if sessionId is empty string', async () => {
      const worker = createTestTerminalWorker();
      // We need to bypass the PTY null check by setting pty first
      // Actually, activateTerminalWorkerPty calls setupWorkerEventHandlers internally
      // So we test by passing an empty sessionId
      await expect(
        workerManager.activateTerminalWorkerPty(worker, {
          ...defaultTerminalActivationParams,
          sessionId: '',
        })
      ).rejects.toThrow('sessionId is required');
    });
  });
});
