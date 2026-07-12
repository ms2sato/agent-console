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
  buildInternalEmbeddedAgentWorker,
  buildPersistedAgentWorker,
  buildPersistedTerminalWorker,
  buildPersistedGitDiffWorker,
  buildPersistedEmbeddedAgentWorker,
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
import type { LookupOsUserFn } from '../os-user-lookup.js';
import type { runAsUser, RunAsUserOpts } from '../privilege-elevation.js';

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

    it('should attach and detach callbacks on an embedded-agent worker (isStreamWorker widening)', () => {
      const worker = buildInternalEmbeddedAgentWorker();

      const connectionId = workerManager.attachCallbacks(worker, {
        onData: () => {},
        onExit: () => {},
      });

      expect(connectionId).toBeTruthy();
      expect(worker.connectionCallbacks.size).toBe(1);

      const result = workerManager.detachCallbacks(worker, connectionId);

      expect(result).toBe(true);
      expect(worker.connectionCallbacks.size).toBe(0);
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

    it('should convert an embedded-agent worker with activated: false when subprocess is null', () => {
      const worker = buildInternalEmbeddedAgentWorker({ id: 'pub-embedded', embeddedAgentId: 'def-1', subprocess: null });

      const publicWorker = workerManager.toPublicWorker(worker);

      expect(publicWorker.id).toBe('pub-embedded');
      expect(publicWorker.type).toBe('embedded-agent');
      if (publicWorker.type === 'embedded-agent') {
        expect(publicWorker.embeddedAgentId).toBe('def-1');
        expect(publicWorker.activated).toBe(false);
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

    it('should persist embedded-agent worker with pid: null when subprocess is null', () => {
      const worker = buildInternalEmbeddedAgentWorker({ id: 'embedded-1', embeddedAgentId: 'def-1', subprocess: null });

      const persisted = workerManager.toPersistedWorker(worker);

      expect(persisted.type).toBe('embedded-agent');
      if (persisted.type === 'embedded-agent') {
        expect(persisted.embeddedAgentId).toBe('def-1');
        expect(persisted.pid).toBeNull();
      }
    });
  });

  // ========== initializeEmbeddedAgentWorker ==========

  describe('initializeEmbeddedAgentWorker', () => {
    it('creates a deactivated worker (no subprocess, no stdin)', () => {
      const worker = workerManager.initializeEmbeddedAgentWorker({
        id: 'init-embedded',
        name: 'Embedded Agent',
        createdAt: '2026-01-01T00:00:00.000Z',
        embeddedAgentId: 'def-1',
      });

      expect(worker.type).toBe('embedded-agent');
      expect(worker.embeddedAgentId).toBe('def-1');
      expect(worker.subprocess).toBeNull();
      expect(worker.stdin).toBeNull();
      expect(worker.activityState).toBe('unknown');
      expect(worker.outputOffset).toBe(0);
      expect(worker.connectionCallbacks.size).toBe(0);
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

    it('should restore embedded-agent workers with subprocess: null', () => {
      const persistedWorkers = [
        buildPersistedEmbeddedAgentWorker({ id: 'restored-embedded', embeddedAgentId: 'def-1', pid: 4321 }),
      ];

      const workers = workerManager.restoreWorkersFromPersistence(persistedWorkers);

      const worker = workers.get('restored-embedded')!;
      expect(worker.type).toBe('embedded-agent');
      if (worker.type === 'embedded-agent') {
        expect(worker.subprocess).toBeNull();
        expect(worker.stdin).toBeNull();
        expect(worker.embeddedAgentId).toBe('def-1');
        expect(worker.activityState).toBe('unknown');
        expect(worker.outputOffset).toBe(0);
        expect(worker.connectionCallbacks.size).toBe(0);
      }
    });

    it('should restore multiple workers of different types', () => {
      const persistedWorkers = [
        buildPersistedAgentWorker({ id: 'a1', name: 'A', agentId: 'claude-code', pid: 100 }),
        buildPersistedTerminalWorker({ id: 't1', name: 'T' }),
        buildPersistedGitDiffWorker({ id: 'd1', name: 'D', baseCommit: 'head' }),
        buildPersistedEmbeddedAgentWorker({ id: 'e1', embeddedAgentId: 'def-1' }),
      ];

      const workers = workerManager.restoreWorkersFromPersistence(persistedWorkers);

      expect(workers.size).toBe(4);
      expect(workers.get('a1')!.type).toBe('agent');
      expect(workers.get('t1')!.type).toBe('terminal');
      expect(workers.get('d1')!.type).toBe('git-diff');
      expect(workers.get('e1')!.type).toBe('embedded-agent');
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

  // ========== MCP token lifecycle (Issue #1030 workstream 2) ==========
  //
  // For each terminal-agent worker activated in AUTH_MODE=multi-user, the
  // server mints an MCP bearer token, writes it to a user-owned 0600 file,
  // and passes ONLY the file path via AGENT_CONSOLE_MCP_TOKEN_FILE. The raw
  // token must never appear in argv/env (docs/design/embedded-agent-worker.md
  // § "MCP caller identity"). See privilege-elevation.ts:writeUserOwnedSecretFile.
  describe('MCP token lifecycle (multi-user mode)', () => {
    const originalAuthMode = process.env.AUTH_MODE;

    afterEach(() => {
      if (originalAuthMode === undefined) {
        delete process.env.AUTH_MODE;
      } else {
        process.env.AUTH_MODE = originalAuthMode;
      }
    });

    interface FakeMcpTokenRegistry {
      mint: ReturnType<typeof mock>;
      revokeByWorker: ReturnType<typeof mock>;
      mintedIdentities: Array<{ sessionId: string; workerId: string; userId: string }>;
      revokedWorkerIds: string[];
    }

    function createFakeMcpTokenRegistry(mintedToken = 'fake-mcp-token-value'): FakeMcpTokenRegistry {
      const mintedIdentities: Array<{ sessionId: string; workerId: string; userId: string }> = [];
      const revokedWorkerIds: string[] = [];
      return {
        mint: mock((identity: { sessionId: string; workerId: string; userId: string }) => {
          mintedIdentities.push(identity);
          return mintedToken;
        }),
        revokeByWorker: mock((workerId: string) => {
          revokedWorkerIds.push(workerId);
        }),
        mintedIdentities,
        revokedWorkerIds,
      };
    }

    /**
     * Command-discriminating fake `runAsUser`. writeUserOwnedSecretFile's
     * command contains `cat >`; rmRecursiveAsUser's command contains `rm -rf`.
     * Splitting responders per shape avoids one generic mock breaking either
     * flow (see memory: wrapper-consumer test responder splitting).
     */
    function createCommandDiscriminatingRunAsUser(opts: {
      writeExitCode?: number;
      writeTimedOut?: boolean;
    } = {}) {
      const writeCalls: RunAsUserOpts[] = [];
      const rmCalls: RunAsUserOpts[] = [];
      const fake: typeof runAsUser = async (callOpts) => {
        if (callOpts.command.includes('cat >')) {
          writeCalls.push(callOpts);
          return {
            stdout: '',
            stderr: '',
            exitCode: opts.writeExitCode ?? 0,
            timedOut: opts.writeTimedOut ?? false,
          };
        }
        rmCalls.push(callOpts);
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      };
      return { fake, writeCalls, rmCalls };
    }

    function buildManagerWithSeams(seams: {
      mcpTokenRegistry?: FakeMcpTokenRegistry;
      lookupOsUserFn?: LookupOsUserFn;
      runAsUserImpl?: typeof runAsUser;
    }): WorkerManager {
      const userMode = new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' });
      return new WorkerManager(
        userMode,
        agentManager,
        new WorkerOutputFileManager(),
        seams.mcpTokenRegistry,
        seams.lookupOsUserFn,
        seams.runAsUserImpl,
      );
    }

    function getLastSpawnEnv(): Record<string, string> | undefined {
      const calls = ptyFactory.spawn.mock.calls as unknown as Array<[string, string[], { env?: Record<string, string> }]>;
      const lastCall = calls[calls.length - 1];
      return lastCall[2]?.env;
    }

    function getLastSpawnArgv(): string[] | undefined {
      const calls = ptyFactory.spawn.mock.calls as unknown as Array<[string, string[], { env?: Record<string, string> }]>;
      const lastCall = calls[calls.length - 1];
      return lastCall[1];
    }

    const defaultLookupOsUserFn: LookupOsUserFn = async (username) => ({
      uid: 1000,
      homeDir: `/home/${username}`,
    });

    it('multi-user + valid createdByUserId + successful write: injects AGENT_CONSOLE_MCP_TOKEN_FILE, mints correct identity, and never leaks the raw token into argv/env', async () => {
      process.env.AUTH_MODE = 'multi-user';
      const registry = createFakeMcpTokenRegistry();
      const { fake: runAsUserImpl, writeCalls } = createCommandDiscriminatingRunAsUser();
      const wm = buildManagerWithSeams({
        mcpTokenRegistry: registry,
        lookupOsUserFn: defaultLookupOsUserFn,
        runAsUserImpl,
      });

      const worker = wm.initializeAgentWorker({
        id: 'mcp-agent-1',
        name: 'Agent',
        createdAt: new Date().toISOString(),
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      await wm.activateAgentWorkerPty(worker, {
        ...defaultAgentActivationParams,
        username: 'alice',
        createdByUserId: 'user-uuid-1',
      });

      expect(registry.mintedIdentities).toEqual([
        { sessionId: 'session-1', workerId: 'mcp-agent-1', userId: 'user-uuid-1' },
      ]);
      expect(worker.mcpToken).toEqual({
        filePath: '/home/alice/.agent-console/mcp-tokens/mcp-agent-1.token',
        username: 'alice',
      });

      const env = getLastSpawnEnv();
      expect(env).toBeDefined();
      expect(env!.AGENT_CONSOLE_MCP_TOKEN_FILE).toBe(
        '/home/alice/.agent-console/mcp-tokens/mcp-agent-1.token',
      );

      // Negative assertions (mandatory per os-environment-coupling.md): the
      // raw token must not appear in the PTY env, nor in the elevated
      // write's command string (it travels only via stdin).
      expect(Object.values(env!)).not.toContain('fake-mcp-token-value');
      expect(writeCalls.length).toBe(1);
      expect(writeCalls[0].command).not.toContain('fake-mcp-token-value');
      expect(writeCalls[0].command).toContain("cat > '/home/alice/.agent-console/mcp-tokens/mcp-agent-1.token'");
      expect(writeCalls[0].stdin).toBe('fake-mcp-token-value');

      // Negative assertion on the PTY spawn argv itself: only the file-path
      // env var may carry MCP identity info; the raw token string must never
      // appear anywhere in the argv passed to the underlying spawn.
      const argv = getLastSpawnArgv();
      expect(argv).toBeDefined();
      expect(argv!.join(' ')).not.toContain('fake-mcp-token-value');
    });

    it('single-user mode: does not mint a token or inject the env var (polarity: fails if the AUTH_MODE gate is removed)', async () => {
      delete process.env.AUTH_MODE;
      const registry = createFakeMcpTokenRegistry();
      const { fake: runAsUserImpl } = createCommandDiscriminatingRunAsUser();
      const wm = buildManagerWithSeams({
        mcpTokenRegistry: registry,
        lookupOsUserFn: defaultLookupOsUserFn,
        runAsUserImpl,
      });

      const worker = wm.initializeAgentWorker({
        id: 'mcp-agent-2',
        name: 'Agent',
        createdAt: new Date().toISOString(),
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      await wm.activateAgentWorkerPty(worker, {
        ...defaultAgentActivationParams,
        username: 'alice',
        createdByUserId: 'user-uuid-1',
      });

      expect(registry.mint).not.toHaveBeenCalled();
      expect(worker.mcpToken).toBeNull();
      const env = getLastSpawnEnv();
      expect(env!.AGENT_CONSOLE_MCP_TOKEN_FILE).toBeUndefined();
    });

    it('multi-user + missing createdByUserId: skips minting but activation still succeeds (worker gets a pty)', async () => {
      process.env.AUTH_MODE = 'multi-user';
      const registry = createFakeMcpTokenRegistry();
      const { fake: runAsUserImpl } = createCommandDiscriminatingRunAsUser();
      const wm = buildManagerWithSeams({
        mcpTokenRegistry: registry,
        lookupOsUserFn: defaultLookupOsUserFn,
        runAsUserImpl,
      });

      const worker = wm.initializeAgentWorker({
        id: 'mcp-agent-3',
        name: 'Agent',
        createdAt: new Date().toISOString(),
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      await wm.activateAgentWorkerPty(worker, {
        ...defaultAgentActivationParams,
        username: 'alice',
        // createdByUserId intentionally omitted (legacy / ownerless session)
      });

      expect(registry.mint).not.toHaveBeenCalled();
      expect(worker.mcpToken).toBeNull();
      expect(worker.pty).not.toBeNull();
      const env = getLastSpawnEnv();
      expect(env!.AGENT_CONSOLE_MCP_TOKEN_FILE).toBeUndefined();
    });

    it('multi-user + writeUserOwnedSecretFile failure: activation throws and revokes the just-minted token', async () => {
      process.env.AUTH_MODE = 'multi-user';
      const registry = createFakeMcpTokenRegistry();
      const { fake: runAsUserImpl } = createCommandDiscriminatingRunAsUser({ writeExitCode: 1 });
      const wm = buildManagerWithSeams({
        mcpTokenRegistry: registry,
        lookupOsUserFn: defaultLookupOsUserFn,
        runAsUserImpl,
      });

      const worker = wm.initializeAgentWorker({
        id: 'mcp-agent-4',
        name: 'Agent',
        createdAt: new Date().toISOString(),
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      await expect(
        wm.activateAgentWorkerPty(worker, {
          ...defaultAgentActivationParams,
          username: 'alice',
          createdByUserId: 'user-uuid-1',
        }),
      ).rejects.toThrow();

      expect(registry.mintedIdentities.length).toBe(1);
      expect(registry.revokedWorkerIds).toEqual(['mcp-agent-4']);
      expect(worker.mcpToken).toBeNull();
    });

    it('multi-user + lookupOsUserFn resolving null: skips minting without throwing', async () => {
      process.env.AUTH_MODE = 'multi-user';
      const registry = createFakeMcpTokenRegistry();
      const { fake: runAsUserImpl } = createCommandDiscriminatingRunAsUser();
      const wm = buildManagerWithSeams({
        mcpTokenRegistry: registry,
        lookupOsUserFn: async () => null,
        runAsUserImpl,
      });

      const worker = wm.initializeAgentWorker({
        id: 'mcp-agent-5',
        name: 'Agent',
        createdAt: new Date().toISOString(),
        agentId: CLAUDE_CODE_AGENT_ID,
      });

      await wm.activateAgentWorkerPty(worker, {
        ...defaultAgentActivationParams,
        username: 'alice',
        createdByUserId: 'user-uuid-1',
      });

      expect(registry.mint).not.toHaveBeenCalled();
      expect(worker.mcpToken).toBeNull();
      expect(worker.pty).not.toBeNull();
    });

    describe('cleanup on kill / exit', () => {
      async function activateWithToken(id: string): Promise<{
        wm: WorkerManager;
        worker: InternalAgentWorker;
        registry: FakeMcpTokenRegistry;
        rmCalls: RunAsUserOpts[];
      }> {
        process.env.AUTH_MODE = 'multi-user';
        const registry = createFakeMcpTokenRegistry();
        const { fake: runAsUserImpl, rmCalls } = createCommandDiscriminatingRunAsUser();
        const wm = buildManagerWithSeams({
          mcpTokenRegistry: registry,
          lookupOsUserFn: defaultLookupOsUserFn,
          runAsUserImpl,
        });

        const worker = wm.initializeAgentWorker({
          id,
          name: 'Agent',
          createdAt: new Date().toISOString(),
          agentId: CLAUDE_CODE_AGENT_ID,
        });

        await wm.activateAgentWorkerPty(worker, {
          ...defaultAgentActivationParams,
          username: 'alice',
          createdByUserId: 'user-uuid-1',
        });

        expect(worker.mcpToken).not.toBeNull();
        return { wm, worker, registry, rmCalls };
      }

      it('killWorker revokes the token and deletes its file', async () => {
        const { wm, worker, registry, rmCalls } = await activateWithToken('mcp-kill-1');
        const filePath = worker.mcpToken!.filePath;

        await wm.killWorker(worker, 'session-1');

        expect(registry.revokedWorkerIds).toEqual(['mcp-kill-1']);
        expect(worker.mcpToken).toBeNull();
        expect(rmCalls.length).toBe(1);
        expect(rmCalls[0].command).toContain(`rm -rf -- '${filePath}'`);
        // The cleanup must run as the token file's OWNING user ('alice',
        // the worker's elevated identity from activateWithToken), not the
        // server process user -- otherwise the elevated rm would fail
        // against a file it doesn't own.
        expect(rmCalls[0].username).toBe('alice');
      });

      it('PTY exit (unexpected) revokes the token and deletes its file', async () => {
        const { worker, registry, rmCalls } = await activateWithToken('mcp-exit-1');
        const filePath = worker.mcpToken!.filePath;

        const mockPty = ptyFactory.instances[ptyFactory.instances.length - 1];
        mockPty.simulateExit(1);

        // revokeByWorker fires synchronously (before the first await inside
        // revokeAndDeleteMcpToken), so no tick is needed for this assertion.
        expect(registry.revokedWorkerIds).toEqual(['mcp-exit-1']);
        expect(worker.mcpToken).toBeNull();

        // The file deletion itself is fire-and-forget from the sync PTY exit
        // callback; flush microtasks so the awaited rmRecursiveAsUser call
        // inside revokeAndDeleteMcpToken has a chance to run.
        await Promise.resolve();
        await Promise.resolve();
        expect(rmCalls.length).toBe(1);
        expect(rmCalls[0].command).toContain(`rm -rf -- '${filePath}'`);
      });

      it('killWorker on a worker with mcpToken: null is a no-op for token cleanup (no crash, no revoke/delete)', async () => {
        const registry = createFakeMcpTokenRegistry();
        const { fake: runAsUserImpl, rmCalls } = createCommandDiscriminatingRunAsUser();
        const wm = buildManagerWithSeams({
          mcpTokenRegistry: registry,
          lookupOsUserFn: defaultLookupOsUserFn,
          runAsUserImpl,
        });
        // Single-user activation: no token minted.
        delete process.env.AUTH_MODE;
        const worker = wm.initializeAgentWorker({
          id: 'mcp-none-1',
          name: 'Agent',
          createdAt: new Date().toISOString(),
          agentId: CLAUDE_CODE_AGENT_ID,
        });
        await wm.activateAgentWorkerPty(worker, {
          ...defaultAgentActivationParams,
          username: 'alice',
        });
        expect(worker.mcpToken).toBeNull();

        await wm.killWorker(worker, 'session-1');

        expect(registry.revokeByWorker).not.toHaveBeenCalled();
        expect(rmCalls.length).toBe(0);
      });
    });
  });
});
