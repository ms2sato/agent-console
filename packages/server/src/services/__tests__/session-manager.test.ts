import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'fs';
import { JOB_TYPES } from '@agent-console/shared';
import type { CreateSessionRequest, CreateWorkerParams, Session, Worker } from '@agent-console/shared';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { mockGit, resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { AgentManager } from '../agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import type { PersistedWorker } from '../persistence-service.js';
import { JobQueue } from '../../jobs/index.js';
import type { PtyProvider, PtySpawnOptions } from '../../lib/pty-provider.js';

// Test config directory
const TEST_CONFIG_DIR = '/test/config';

// Test JobQueue instance (created fresh for each test)
let testJobQueue: JobQueue | null = null;

// Create mock PTY factory (will be reset in beforeEach)
const ptyFactory = createMockPtyFactory(10000);

let importCounter = 0;
let agentManager: AgentManager;

describe('SessionManager', () => {
  beforeEach(async () => {
    // Close any existing database connection first
    await closeDatabase();

    // Setup memfs with config directory structure
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    // Initialize in-memory database (bypasses native file operations)
    await initializeDatabase(':memory:');

    // Create a test JobQueue with the shared database connection
    testJobQueue = new JobQueue(getDatabase());

    // Reset process mock and mark current process as alive
    // This ensures sessions created with serverPid=process.pid are not cleaned up
    resetProcessMock();
    mockProcess.markAlive(process.pid);

    // Reset PTY factory
    ptyFactory.reset();

    // Reset git mocks to default implementations
    resetGitMocks();

    // Create AgentManager for dependency injection
    const db = getDatabase();
    agentManager = await AgentManager.create(new SqliteAgentRepository(db));
  });

  afterEach(async () => {
    // Clean up test JobQueue
    if (testJobQueue) {
      await testJobQueue.stop();
      testJobQueue = null;
    }
    await closeDatabase();
    cleanupMemfs();
  });

  // Mock pathExists that always returns true (test paths don't exist on real filesystem)
  const mockPathExists = async (_path: string): Promise<boolean> => true;

  // Helper to get fresh module instance with DI using the factory pattern
  async function getSessionManager() {
    const module = await import(`../session-manager.js?v=${++importCounter}`);
    // Use the factory pattern for async initialization with jobQueue
    return module.SessionManager.create({
      ptyProvider: ptyFactory.provider,
      pathExists: mockPathExists,
      jobQueue: testJobQueue,
      agentManager,
    });
  }

  // Helper to simulate server restart
  // Marks current process as dead and creates a new SessionManager instance
  // that loads sessions from persistence (mimicking server restart behavior)
  async function simulateServerRestart() {
    mockProcess.markDead(process.pid);
    return getSessionManager();
  }

  describe('createSession', () => {
    it('should create a new worktree session with correct properties', async () => {
      const manager = await getSessionManager();

      const request: CreateSessionRequest = {
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'main',
        agentId: 'claude-code',
      };

      const session = await manager.createSession(request);

      expect(session.id).toBeDefined();
      expect(session.type).toBe('worktree');
      expect(session.locationPath).toBe('/test/path');
      if (session.type === 'worktree') {
        expect(session.repositoryId).toBe('repo-1');
        // repositoryName is 'Unknown' when RepositoryManager is not initialized
        expect(session.repositoryName).toBe('Unknown');
        expect(session.worktreeId).toBe('main');
      }
      expect(session.status).toBe('active');
      // createSession creates both agent and git-diff workers
      expect(session.workers.length).toBe(2);
      expect(session.workers.some((w: Worker) => w.type === 'agent')).toBe(true);
      expect(session.workers.some((w: Worker) => w.type === 'git-diff')).toBe(true);
    });

    it('should create a worktree session with parentSessionId and parentWorkerId', async () => {
      const manager = await getSessionManager();

      const request: CreateSessionRequest = {
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'main',
        agentId: 'claude-code',
        parentSessionId: 'parent-sess-123',
        parentWorkerId: 'parent-wkr-456',
      };

      const session = await manager.createSession(request);

      expect(session.parentSessionId).toBe('parent-sess-123');
      expect(session.parentWorkerId).toBe('parent-wkr-456');
    });

    it('should create a new quick session with correct properties', async () => {
      const manager = await getSessionManager();

      const request: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      const session = await manager.createSession(request);

      expect(session.id).toBeDefined();
      expect(session.type).toBe('quick');
      expect(session.locationPath).toBe('/test/path');
      expect(session.status).toBe('active');
      // createSession creates both agent and git-diff workers
      expect(session.workers.length).toBe(2);
    });

    it('should persist session to storage', async () => {
      const manager = await getSessionManager();

      const request: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      await manager.createSession(request);

      // Check persisted data
      const savedData = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
      expect(savedData.length).toBe(1);
      expect(savedData[0].locationPath).toBe('/test/path');
      expect(savedData[0].serverPid).toBeDefined();
    });

    it('should call onData callback when PTY outputs data', async () => {
      const manager = await getSessionManager();

      const onData = mock(() => {});
      const request: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      const session = await manager.createSession(request);
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;
      manager.attachWorkerCallbacks(session.id, workerId, {
        onData,
        onExit: mock(() => {}),
      });

      // Simulate PTY output
      const pty = ptyFactory.instances[0];
      pty.simulateData('Hello World');

      // onData is called with (data, offset) where offset is the cumulative byte offset
      expect(onData).toHaveBeenCalledWith('Hello World', expect.any(Number));
    });

    it('should call onExit callback when PTY exits', async () => {
      const manager = await getSessionManager();

      const onExit = mock(() => {});
      const request: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      const session = await manager.createSession(request);
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;
      manager.attachWorkerCallbacks(session.id, workerId, {
        onData: mock(() => {}),
        onExit,
      });

      // Simulate PTY exit
      const pty = ptyFactory.instances[0];
      pty.simulateExit(0);

      expect(onExit).toHaveBeenCalledWith(0, null);
    });

    it('should buffer output for reconnection', async () => {
      const manager = await getSessionManager();

      const request: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      const session = await manager.createSession(request);
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      // Simulate PTY output
      const pty = ptyFactory.instances[0];
      pty.simulateData('Line 1\n');
      pty.simulateData('Line 2\n');

      const buffer = manager.getWorkerOutputBuffer(session.id, workerId);
      expect(buffer).toBe('Line 1\nLine 2\n');
    });
  });

  describe('createWorker', () => {
    it('should create a terminal worker in existing session', async () => {
      const manager = await getSessionManager();

      const sessionRequest: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      const session = await manager.createSession(sessionRequest);

      const workerRequest: CreateWorkerParams = {
        type: 'terminal',
        name: 'Shell',
      };

      const worker = await manager.createWorker(session.id, workerRequest);

      expect(worker).not.toBeNull();
      expect(worker?.type).toBe('terminal');
      expect(worker?.name).toBe('Shell');
    });

    it('should return null for non-existent session', async () => {
      const manager = await getSessionManager();

      const workerRequest: CreateWorkerParams = {
        type: 'terminal',
        name: 'Shell',
      };

      const worker = await manager.createWorker('non-existent', workerRequest);
      expect(worker).toBeNull();
    });
  });

  describe('deleteWorker', () => {
    it('should delete a worker from session', async () => {
      const manager = await getSessionManager();

      const sessionRequest: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      const session = await manager.createSession(sessionRequest);
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      const result = await manager.deleteWorker(session.id, workerId);

      expect(result).toBe(true);
      const updatedSession = manager.getSession(session.id);
      expect(updatedSession?.workers.find((w: Worker) => w.id === workerId)).toBeUndefined();
    });

    it('should return false for non-existent worker', async () => {
      const manager = await getSessionManager();

      const sessionRequest: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      const session = await manager.createSession(sessionRequest);
      const result = await manager.deleteWorker(session.id, 'non-existent');
      expect(result).toBe(false);
    });
  });

  describe('getSession', () => {
    it('should return session by id', async () => {
      const manager = await getSessionManager();

      const request: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      const created = await manager.createSession(request);
      const retrieved = manager.getSession(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
    });

    it('should return undefined for non-existent session', async () => {
      const manager = await getSessionManager();

      const session = manager.getSession('non-existent');
      expect(session).toBeUndefined();
    });

    it('should preserve parent fields when retrieving session', async () => {
      const manager = await getSessionManager();

      const created = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'main',
        agentId: 'claude-code',
        parentSessionId: 'parent-sess-abc',
        parentWorkerId: 'parent-wkr-xyz',
      });

      const retrieved = manager.getSession(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.parentSessionId).toBe('parent-sess-abc');
      expect(retrieved?.parentWorkerId).toBe('parent-wkr-xyz');
    });
  });

  describe('getAllSessions', () => {
    it('should return empty array when no sessions', async () => {
      const manager = await getSessionManager();

      const sessions = manager.getAllSessions();
      expect(sessions).toEqual([]);
    });

    it('should return all sessions', async () => {
      const manager = await getSessionManager();

      await manager.createSession({ type: 'quick', locationPath: '/path/1', agentId: 'claude-code' });
      await manager.createSession({ type: 'quick', locationPath: '/path/2', agentId: 'claude-code' });

      const sessions = manager.getAllSessions();
      expect(sessions.length).toBe(2);
    });
  });

  describe('writeWorkerInput', () => {
    it('should write input to PTY', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      const result = manager.writeWorkerInput(session.id, workerId, 'hello');

      expect(result).toBe(true);
      expect(ptyFactory.instances[0].writtenData).toContain('hello');
    });

    it('should return false for non-existent session', async () => {
      const manager = await getSessionManager();

      const result = manager.writeWorkerInput('non-existent', 'worker-1', 'hello');
      expect(result).toBe(false);
    });
  });

  describe('sendMessage', () => {
    it('should inject content only when no files provided', async () => {
      const manager = await getSessionManager();
      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;

      const message = manager.sendMessage(session.id, null, agentWorker.id, 'hello world');
      expect(message).not.toBeNull();
      expect(ptyFactory.instances[0].writtenData).toContain('hello world');
    });

    it('should inject content with file paths when files provided', async () => {
      const manager = await getSessionManager();
      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;

      const message = manager.sendMessage(session.id, null, agentWorker.id, 'check these', ['/tmp/file1.txt', '/tmp/file2.txt']);
      expect(message).not.toBeNull();

      // First part is sent immediately
      const pty = ptyFactory.instances[0];
      expect(pty.writtenData).toContain('check these');

      // Wait for delayed parts (150ms * 3 = content, file1, file2, enter)
      await new Promise(resolve => setTimeout(resolve, 700));
      expect(pty.writtenData).toContain('\r/tmp/file1.txt');
      expect(pty.writtenData).toContain('\r/tmp/file2.txt');
    });

    it('should inject files only when content is empty', async () => {
      const manager = await getSessionManager();
      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;

      const message = manager.sendMessage(session.id, null, agentWorker.id, '', ['/tmp/file1.txt']);
      expect(message).not.toBeNull();

      // First part (file path) is sent immediately
      const pty = ptyFactory.instances[0];
      expect(pty.writtenData).toContain('/tmp/file1.txt');

      // Wait for final Enter
      await new Promise(resolve => setTimeout(resolve, 300));
    });

    it('should return null for non-existent session', async () => {
      const manager = await getSessionManager();
      const result = manager.sendMessage('non-existent', null, 'worker-1', 'hello');
      expect(result).toBeNull();
    });

    it('should not throw when session is deleted before delayed writes fire', async () => {
      const manager = await getSessionManager();
      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;

      // Send a message with file paths, which schedules delayed writes via setTimeout
      const message = manager.sendMessage(session.id, null, agentWorker.id, 'check these', ['/tmp/file1.txt', '/tmp/file2.txt']);
      expect(message).not.toBeNull();

      const pty = ptyFactory.instances[0];
      const writtenCountBeforeDelete = pty.writtenData.length;

      // Immediately delete the session before the delayed writes fire
      await manager.deleteSession(session.id);

      // Wait long enough for all delayed writes to have fired (150ms * 4 parts = 600ms)
      await new Promise(resolve => setTimeout(resolve, 800));

      // No additional PTY writes should have occurred after deletion
      expect(pty.writtenData.length).toBe(writtenCountBeforeDelete);
    });

    it('should not throw when worker is deleted before delayed writes fire', async () => {
      const manager = await getSessionManager();
      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      // Create a second worker so the session remains valid after deleting one
      await manager.createWorker(session.id, { type: 'terminal' });

      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;

      // Send a message with file paths targeting the agent worker, which schedules delayed writes
      const message = manager.sendMessage(session.id, null, agentWorker.id, 'check these', ['/tmp/file1.txt', '/tmp/file2.txt']);
      expect(message).not.toBeNull();

      const pty = ptyFactory.instances[0];
      const writtenCountBeforeDelete = pty.writtenData.length;

      // Delete only the target worker (not the whole session) before delayed writes fire
      await manager.deleteWorker(session.id, agentWorker.id);

      // Session should still exist (the terminal worker remains)
      expect(manager.getSession(session.id)).toBeDefined();

      // Wait long enough for all delayed writes to have fired (150ms * 4 parts = 600ms)
      await new Promise(resolve => setTimeout(resolve, 800));

      // No additional PTY writes should have occurred after the worker was deleted
      expect(pty.writtenData.length).toBe(writtenCountBeforeDelete);
    });
  });

  describe('resizeWorker', () => {
    it('should resize PTY', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      const result = manager.resizeWorker(session.id, workerId, 80, 24);

      expect(result).toBe(true);
      expect(ptyFactory.instances[0].currentCols).toBe(80);
      expect(ptyFactory.instances[0].currentRows).toBe(24);
    });

    it('should return false for non-existent session', async () => {
      const manager = await getSessionManager();

      const result = manager.resizeWorker('non-existent', 'worker-1', 80, 24);
      expect(result).toBe(false);
    });
  });

  describe('deleteSession', () => {
    it('should delete session and remove from storage', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const result = await manager.deleteSession(session.id);

      expect(result).toBe(true);
      expect(ptyFactory.instances[0].killed).toBe(true);
      expect(manager.getSession(session.id)).toBeUndefined();

      // Check session was removed from persistence
      const savedData = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
      expect(savedData.length).toBe(0);
    });

    it('should return false for non-existent session', async () => {
      const manager = await getSessionManager();

      const result = await manager.deleteSession('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('attachWorkerCallbacks / detachWorkerCallbacks', () => {
    it('should update callbacks on attach and return connection ID', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      const newOnData = mock(() => {});
      const newOnExit = mock(() => {});
      const connectionId = manager.attachWorkerCallbacks(session.id, workerId, {
        onData: newOnData,
        onExit: newOnExit,
      });

      // Returns a connection ID (UUID string)
      expect(connectionId).not.toBeNull();
      expect(typeof connectionId).toBe('string');

      // Verify new callbacks are used
      ptyFactory.instances[0].simulateData('new data');
      // onData is called with (data, offset) where offset is the cumulative byte offset
      expect(newOnData).toHaveBeenCalledWith('new data', expect.any(Number));
    });

    it('should detach callbacks by connection ID', async () => {
      const manager = await getSessionManager();

      const onData = mock(() => {});
      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      const connectionId = manager.attachWorkerCallbacks(session.id, workerId, {
        onData,
        onExit: mock(() => {}),
      });

      expect(connectionId).not.toBeNull();
      manager.detachWorkerCallbacks(session.id, workerId, connectionId!);

      // Data should not trigger original callback after detach
      onData.mockClear();
      ptyFactory.instances[0].simulateData('after detach');

      // Original callback should not be called
      expect(onData).not.toHaveBeenCalled();
    });

    it('should support multiple concurrent connections', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      const onData1 = mock(() => {});
      const onData2 = mock(() => {});

      const connId1 = manager.attachWorkerCallbacks(session.id, workerId, {
        onData: onData1,
        onExit: mock(() => {}),
      });

      const connId2 = manager.attachWorkerCallbacks(session.id, workerId, {
        onData: onData2,
        onExit: mock(() => {}),
      });

      // Both connections should have unique IDs
      expect(connId1).not.toBeNull();
      expect(connId2).not.toBeNull();
      expect(connId1).not.toBe(connId2);

      // Data should trigger both callbacks (with offset as second argument)
      ptyFactory.instances[0].simulateData('shared data');
      expect(onData1).toHaveBeenCalledWith('shared data', expect.any(Number));
      expect(onData2).toHaveBeenCalledWith('shared data', expect.any(Number));

      // Detaching one should not affect the other
      manager.detachWorkerCallbacks(session.id, workerId, connId1!);
      onData1.mockClear();
      onData2.mockClear();

      ptyFactory.instances[0].simulateData('after detach 1');
      expect(onData1).not.toHaveBeenCalled();
      expect(onData2).toHaveBeenCalledWith('after detach 1', expect.any(Number));
    });

    it('should return null for non-existent session', async () => {
      const manager = await getSessionManager();

      expect(manager.attachWorkerCallbacks('non-existent', 'worker-1', {
        onData: mock(() => {}),
        onExit: mock(() => {}),
      })).toBeNull();
      expect(manager.detachWorkerCallbacks('non-existent', 'worker-1', 'fake-conn-id')).toBe(false);
    });
  });

  describe('getWorkerActivityState', () => {
    it('should return idle state after PTY activation', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      const state = manager.getWorkerActivityState(session.id, workerId);

      // Initial state is 'idle' after PTY activation (ActivityDetector starts with 'idle')
      expect(state).toBe('idle');
    });

    it('should return undefined for non-existent session', async () => {
      const manager = await getSessionManager();

      const state = manager.getWorkerActivityState('non-existent', 'worker-1');
      expect(state).toBeUndefined();
    });
  });

  describe('setGlobalActivityCallback', () => {
    it('should call global callback with idle state on PTY activation', async () => {
      const manager = await getSessionManager();

      const globalCallback = mock(() => {});
      manager.setGlobalActivityCallback(globalCallback);

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      // Global callback should have been called with 'idle' state on PTY activation
      // (ActivityDetector starts with 'idle', so we notify immediately)
      expect(globalCallback).toHaveBeenCalledWith(session.id, workerId, 'idle');
    });

    it('should call global callback on activity state change', async () => {
      const manager = await getSessionManager();

      const globalCallback = mock(() => {});
      manager.setGlobalActivityCallback(globalCallback);

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      // Generate enough output to trigger 'active' state
      const pty = ptyFactory.instances[0];
      for (let i = 0; i < 25; i++) {
        pty.simulateData('output\n');
      }

      // Global callback should have been called with 'active' state
      expect(globalCallback).toHaveBeenCalledWith(session.id, workerId, 'active');
    });
  });

  describe('setGlobalWorkerExitCallback', () => {
    it('should call global callback on worker exit', async () => {
      const manager = await getSessionManager();

      const exitCallback = mock(() => {});
      manager.setGlobalWorkerExitCallback(exitCallback);

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      // Simulate PTY exit
      const pty = ptyFactory.instances[0];
      pty.simulateExit(0);

      // Global exit callback should have been called with session and worker info
      expect(exitCallback).toHaveBeenCalledWith(session.id, workerId, 0);
    });

    it('should call global callback with non-zero exit code', async () => {
      const manager = await getSessionManager();

      const exitCallback = mock(() => {});
      manager.setGlobalWorkerExitCallback(exitCallback);

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      // Simulate PTY exit with non-zero code
      const pty = ptyFactory.instances[0];
      pty.simulateExit(1);

      // Global exit callback should have been called with the exit code
      expect(exitCallback).toHaveBeenCalledWith(session.id, workerId, 1);
    });

    it('should call global callback for terminal worker exit', async () => {
      const manager = await getSessionManager();

      const exitCallback = mock(() => {});
      manager.setGlobalWorkerExitCallback(exitCallback);

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Create a terminal worker (index 1, since agent is index 0)
      const terminalWorker = await manager.createWorker(session.id, {
        type: 'terminal',
        name: 'Shell',
      });
      expect(terminalWorker).not.toBeNull();

      // Find the terminal PTY (it should be the second one created)
      const terminalPtyIndex = ptyFactory.instances.length - 1;
      const terminalPty = ptyFactory.instances[terminalPtyIndex];
      terminalPty.simulateExit(0);

      // Global exit callback should have been called for the terminal worker
      expect(exitCallback).toHaveBeenCalledWith(session.id, terminalWorker!.id, 0);
    });
  });

  describe('setSessionLifecycleCallbacks', () => {
    it('should call onSessionCreated when a session is created', async () => {
      const manager = await getSessionManager();

      const onSessionCreated = mock(() => {});
      manager.setSessionLifecycleCallbacks({ onSessionCreated });

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      expect(onSessionCreated).toHaveBeenCalledTimes(1);
      expect(onSessionCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          id: session.id,
          type: 'quick',
          locationPath: '/test/path',
        })
      );
    });

    it('should call onSessionDeleted when a session is deleted', async () => {
      const manager = await getSessionManager();

      const onSessionDeleted = mock(() => {});
      manager.setSessionLifecycleCallbacks({ onSessionDeleted });

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      await manager.deleteSession(session.id);

      expect(onSessionDeleted).toHaveBeenCalledTimes(1);
      expect(onSessionDeleted).toHaveBeenCalledWith(session.id);
    });

    it('should call onSessionUpdated when session metadata is updated', async () => {
      const manager = await getSessionManager();

      const onSessionUpdated = mock(() => {});
      manager.setSessionLifecycleCallbacks({ onSessionUpdated });

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      await manager.updateSessionMetadata(session.id, { title: 'New Title' });

      expect(onSessionUpdated).toHaveBeenCalledTimes(1);
      expect(onSessionUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          id: session.id,
          title: 'New Title',
        })
      );
    });

    it('should not call onSessionUpdated if session does not exist', async () => {
      const manager = await getSessionManager();

      const onSessionUpdated = mock(() => {});
      manager.setSessionLifecycleCallbacks({ onSessionUpdated });

      await manager.updateSessionMetadata('non-existent', { title: 'New Title' });

      expect(onSessionUpdated).not.toHaveBeenCalled();
    });

    it('should not call onSessionDeleted if session does not exist', async () => {
      const manager = await getSessionManager();

      const onSessionDeleted = mock(() => {});
      manager.setSessionLifecycleCallbacks({ onSessionDeleted });

      await manager.deleteSession('non-existent');

      expect(onSessionDeleted).not.toHaveBeenCalled();
    });

    it('should support partial callbacks (only onSessionCreated)', async () => {
      const manager = await getSessionManager();

      const onSessionCreated = mock(() => {});
      manager.setSessionLifecycleCallbacks({ onSessionCreated });

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Should not throw when deleting (onSessionDeleted is not set)
      const result = await manager.deleteSession(session.id);
      expect(result).toBe(true);
      expect(onSessionCreated).toHaveBeenCalledTimes(1);
    });

    it('should support all callbacks together', async () => {
      const manager = await getSessionManager();

      const onSessionCreated = mock(() => {});
      const onSessionUpdated = mock(() => {});
      const onSessionDeleted = mock(() => {});
      manager.setSessionLifecycleCallbacks({
        onSessionCreated,
        onSessionUpdated,
        onSessionDeleted,
      });

      // Create
      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      expect(onSessionCreated).toHaveBeenCalledTimes(1);

      // Update
      await manager.updateSessionMetadata(session.id, { title: 'Updated' });
      expect(onSessionUpdated).toHaveBeenCalledTimes(1);

      // Delete
      await manager.deleteSession(session.id);
      expect(onSessionDeleted).toHaveBeenCalledTimes(1);
    });
  });

  describe('getWorkerOutputBuffer', () => {
    it('should return empty string for non-existent session', async () => {
      const manager = await getSessionManager();

      const buffer = manager.getWorkerOutputBuffer('non-existent', 'worker-1');
      expect(buffer).toBe('');
    });

    it('should truncate buffer when exceeding max size', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      // Generate large output (> 100KB)
      const pty = ptyFactory.instances[0];
      const largeData = 'x'.repeat(60000);
      pty.simulateData(largeData);
      pty.simulateData(largeData);

      const buffer = manager.getWorkerOutputBuffer(session.id, workerId);
      expect(buffer!.length).toBeLessThanOrEqual(100000);
    });
  });

  describe('edge cases', () => {
    it('should handle empty input string', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      // Empty string should still be written
      const result = manager.writeWorkerInput(session.id, workerId, '');
      expect(result).toBe(true);
    });

    it('should handle binary data in output', async () => {
      const manager = await getSessionManager();

      const onData = mock(() => {});
      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;
      manager.attachWorkerCallbacks(session.id, workerId, {
        onData,
        onExit: mock(() => {}),
      });

      // Simulate binary-like output with null bytes
      const pty = ptyFactory.instances[0];
      const binaryLike = 'Hello\x00World\x1b[0m';
      pty.simulateData(binaryLike);

      // onData is called with (data, offset) where offset is the cumulative byte offset
      expect(onData).toHaveBeenCalledWith(binaryLike, expect.any(Number));
      expect(manager.getWorkerOutputBuffer(session.id, workerId)).toBe(binaryLike);
    });

    it('should handle unicode output', async () => {
      const manager = await getSessionManager();

      const onData = mock(() => {});
      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;
      manager.attachWorkerCallbacks(session.id, workerId, {
        onData,
        onExit: mock(() => {}),
      });

      const pty = ptyFactory.instances[0];
      const unicode = '日本語テスト 🎉 émoji';
      pty.simulateData(unicode);

      // onData is called with (data, offset) where offset is the cumulative byte offset
      expect(onData).toHaveBeenCalledWith(unicode, expect.any(Number));
      expect(manager.getWorkerOutputBuffer(session.id, workerId)).toBe(unicode);
    });

    it('should handle rapid consecutive outputs', async () => {
      const manager = await getSessionManager();

      const onData = mock(() => {});
      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;
      manager.attachWorkerCallbacks(session.id, workerId, {
        onData,
        onExit: mock(() => {}),
      });

      const pty = ptyFactory.instances[0];

      // Rapid fire outputs
      for (let i = 0; i < 100; i++) {
        pty.simulateData(`line ${i}\n`);
      }

      expect(onData).toHaveBeenCalledTimes(100);
    });

    it('should handle session creation with path containing spaces', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/path/with spaces/project',
        agentId: 'claude-code',
      });

      expect(session.locationPath).toBe('/path/with spaces/project');
    });
  });

  describe('restoreWorker', () => {
    it('should return existing internal worker if it exists', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      // PTY count before restore
      const ptyCountBefore = ptyFactory.instances.length;

      // Restore should return existing worker without creating new PTY
      const result = await manager.restoreWorker(session.id, workerId);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.worker.type).toBe('agent');
      }
      // No new PTY should be created
      expect(ptyFactory.instances.length).toBe(ptyCountBefore);
    });

    it('should resume paused session and restore agent worker with new PTY', async () => {
      const manager = await getSessionManager();

      // Create session and get persisted data
      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      // Get persisted session count before
      const savedDataBefore = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
      expect(savedDataBefore.length).toBe(1);

      // Simulate server restart: mark the previous server as dead
      // Dead-server sessions are marked as paused (not loaded into memory)
      mockProcess.markDead(process.pid);

      // Create new manager that marks dead-server sessions as paused
      const manager2 = await getSessionManager();

      // Session is NOT in memory (paused), getSession returns undefined
      expect(manager2.getSession(session.id)).toBeUndefined();

      // PTY count before resume
      const ptyCountBefore = ptyFactory.instances.length;

      // Resume the paused session (loads from DB and activates all workers)
      const resumedSession = await manager2.resumeSession(session.id);

      expect(resumedSession).not.toBeNull();
      const resumedAgent = resumedSession!.workers.find((w: Worker) => w.type === 'agent');
      expect(resumedAgent).toBeDefined();
      expect(resumedAgent!.id).toBe(workerId);

      // New PTY should be created for the agent worker
      expect(ptyFactory.instances.length).toBeGreaterThan(ptyCountBefore);

      // Persistence should be updated (not added as new entry)
      const savedDataAfter = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
      expect(savedDataAfter.length).toBe(1); // Still 1 session, not 2
    });

    it('should resume paused session and restore terminal worker with new PTY', async () => {
      const manager = await getSessionManager();

      // Create session with terminal worker
      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const terminalWorker = await manager.createWorker(session.id, {
        type: 'terminal',
        name: 'Shell',
      });
      const terminalWorkerId = terminalWorker!.id;

      // Simulate server restart: mark the previous server as dead
      // Dead-server sessions are marked as paused (not loaded into memory)
      mockProcess.markDead(process.pid);

      const manager2 = await getSessionManager();

      // Session is NOT in memory (paused)
      expect(manager2.getSession(session.id)).toBeUndefined();

      // PTY count before resume
      const ptyCountBefore = ptyFactory.instances.length;

      // Resume the paused session (loads from DB and activates all workers)
      const resumedSession = await manager2.resumeSession(session.id);

      expect(resumedSession).not.toBeNull();
      const resumedTerminal = resumedSession!.workers.find((w: Worker) => w.id === terminalWorkerId);
      expect(resumedTerminal).toBeDefined();
      expect(resumedTerminal!.type).toBe('terminal');

      // New PTYs should be created (for agent + terminal workers)
      expect(ptyFactory.instances.length).toBeGreaterThan(ptyCountBefore);
    });

    it('should return error for git-diff worker (does not need PTY restoration)', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Explicitly create git-diff worker (createSession's git-diff is async and may not be ready)
      const gitDiffWorker = await manager.createWorker(session.id, {
        type: 'git-diff',
        name: 'Test Diff',
      });
      expect(gitDiffWorker).toBeDefined();

      // Simulate server restart: mark the previous server as dead
      mockProcess.markDead(process.pid);

      const manager2 = await getSessionManager();

      // After server restart, session is paused (not in memory).
      // restoreWorker returns SESSION_DELETED because the session is unavailable.
      const result = await manager2.restoreWorker(session.id, gitDiffWorker!.id);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errorCode).toBe('SESSION_DELETED');
      }
    });

    it('should return error for non-existent session', async () => {
      const manager = await getSessionManager();

      const result = await manager.restoreWorker('non-existent', 'worker-1');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errorCode).toBe('SESSION_DELETED');
      }
    });

    it('should return error if worker not found in persisted metadata', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Simulate server restart: mark the previous server as dead
      mockProcess.markDead(process.pid);

      const manager2 = await getSessionManager();

      // After server restart, session is paused (not in memory).
      // restoreWorker returns SESSION_DELETED because the session is unavailable.
      const result = await manager2.restoreWorker(session.id, 'non-existent-worker');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errorCode).toBe('SESSION_DELETED');
      }
    });

    it('should create new PTY processes after session resume', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Record PTY count after initial session creation
      const ptyCountAfterCreate = ptyFactory.instances.length;
      expect(ptyCountAfterCreate).toBeGreaterThan(0);

      // Simulate server restart: mark the previous server as dead
      // Dead-server sessions are marked as paused (not loaded into memory)
      mockProcess.markDead(process.pid);

      const manager2 = await getSessionManager();

      // Record PTY count before resume
      const ptyCountBeforeResume = ptyFactory.instances.length;

      // Resume the paused session (activates all workers with new PTYs)
      const resumedSession = await manager2.resumeSession(session.id);
      expect(resumedSession).not.toBeNull();

      // New PTY processes should have been created for the resumed workers
      expect(ptyFactory.instances.length).toBeGreaterThan(ptyCountBeforeResume);

      // The session should now be active with workers
      const activeSession = manager2.getSession(session.id);
      expect(activeSession).toBeDefined();
      expect(activeSession!.workers.length).toBeGreaterThan(0);
    });

    it('should return all workers after resuming paused session', async () => {
      const manager = await getSessionManager();

      // Create session with agent worker
      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorkerId = session.workers.find((w: Worker) => w.type === 'agent')!.id;

      // Add terminal worker
      const terminalWorker = await manager.createWorker(session.id, {
        type: 'terminal',
        name: 'Shell',
      });
      const terminalWorkerId = terminalWorker!.id;

      // Get actual worker count before restart
      const sessionBefore = manager.getSession(session.id);
      const workerCountBefore = sessionBefore!.workers.length;
      expect(workerCountBefore).toBeGreaterThanOrEqual(2); // At least agent + terminal

      // Simulate server restart (session becomes paused, not in memory)
      const manager2 = await simulateServerRestart();

      // Session is NOT in memory (paused)
      expect(manager2.getSession(session.id)).toBeUndefined();

      // Resume the paused session (loads all workers and activates PTYs)
      const resumedSession = await manager2.resumeSession(session.id);
      expect(resumedSession).not.toBeNull();

      // After resume, getSession should return all workers
      const sessionAfterResume = manager2.getSession(session.id);
      expect(sessionAfterResume?.workers.length).toBe(workerCountBefore);

      // Verify both agent and terminal workers are present
      const workerIds = sessionAfterResume?.workers.map((w: Worker) => w.id);
      expect(workerIds).toContain(agentWorkerId);
      expect(workerIds).toContain(terminalWorkerId);
    });
  });

  describe('restoreWorker - double-activation prevention (idempotency)', () => {
    it('should not create duplicate PTY when restoreWorker called on active worker', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      // PTY count after initial creation
      const ptyCountAfterCreate = ptyFactory.instances.length;

      // Call restoreWorker on an already-active worker (PTY exists)
      const result = await manager.restoreWorker(session.id, workerId);

      // Should return the worker successfully
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.worker.type).toBe('agent');
      }

      // No new PTY should be created (idempotent behavior)
      expect(ptyFactory.instances.length).toBe(ptyCountAfterCreate);
    });

    it('should not increase PTY count when restoreWorker called multiple times', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      // PTY count after initial creation
      const ptyCountAfterCreate = ptyFactory.instances.length;

      // Call restoreWorker multiple times (simulating concurrent WebSocket connections)
      await Promise.all([
        manager.restoreWorker(session.id, workerId),
        manager.restoreWorker(session.id, workerId),
        manager.restoreWorker(session.id, workerId),
      ]);

      // No new PTYs should be created (all calls should be idempotent)
      expect(ptyFactory.instances.length).toBe(ptyCountAfterCreate);
    });

    it('should not throw errors for concurrent restoreWorker calls on same worker', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      // Concurrent calls should not throw (idempotent behavior prevents resource leaks)
      await expect(Promise.all([
        manager.restoreWorker(session.id, workerId),
        manager.restoreWorker(session.id, workerId),
        manager.restoreWorker(session.id, workerId),
      ])).resolves.toBeDefined();
    });

    it('should be idempotent for terminal workers as well', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const terminalWorker = await manager.createWorker(session.id, {
        type: 'terminal',
        name: 'Shell',
      });
      expect(terminalWorker).not.toBeNull();

      // PTY count after terminal worker creation
      const ptyCountAfterCreate = ptyFactory.instances.length;

      // Call restoreWorker on an already-active terminal worker
      const result = await manager.restoreWorker(session.id, terminalWorker!.id);

      // Should return the worker successfully
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.worker.type).toBe('terminal');
      }

      // No new PTY should be created
      expect(ptyFactory.instances.length).toBe(ptyCountAfterCreate);
    });
  });

  describe('resumeSession - path validation', () => {
    // Helper to get SessionManager with custom pathExists mock using factory pattern
    async function getSessionManagerWithPathExists(pathExistsFn: (path: string) => Promise<boolean>) {
      const module = await import(`../session-manager.js?v=${++importCounter}`);
      return module.SessionManager.create({ ptyProvider: ptyFactory.provider, pathExists: pathExistsFn, agentManager });
    }

    it('should return null from resumeSession when session path no longer exists', async () => {
      // First, create a session with a manager that says path exists
      const managerForCreate = await getSessionManager();

      const session = await managerForCreate.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Simulate server restart (session becomes paused)
      mockProcess.markDead(process.pid);

      // Create a new manager where pathExists always returns false
      // This simulates: path was deleted before the user tries to resume
      const mockPathNotFound = async (_path: string): Promise<boolean> => false;
      const managerAfterRestart = await getSessionManagerWithPathExists(mockPathNotFound);

      // PTY count before resume attempt
      const ptyCountBefore = ptyFactory.instances.length;

      // resumeSession should return null because path no longer exists
      const result = await managerAfterRestart.resumeSession(session.id);

      expect(result).toBeNull();

      // No new PTY should be created
      expect(ptyFactory.instances.length).toBe(ptyCountBefore);
    });

    it('should not create PTY when resumeSession fails due to missing path for session with terminal worker', async () => {
      // First, create a session with terminal worker
      const managerForCreate = await getSessionManager();

      const session = await managerForCreate.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      await managerForCreate.createWorker(session.id, {
        type: 'terminal',
        name: 'Shell',
      });

      // Simulate server restart (session becomes paused)
      mockProcess.markDead(process.pid);

      // Create a new manager where pathExists always returns false
      const mockPathNotFound = async (_path: string): Promise<boolean> => false;
      const managerAfterRestart = await getSessionManagerWithPathExists(mockPathNotFound);

      // PTY count before resume attempt
      const ptyCountBefore = ptyFactory.instances.length;

      // resumeSession should return null because path no longer exists
      const result = await managerAfterRestart.resumeSession(session.id);

      expect(result).toBeNull();

      // No new PTY should be created
      expect(ptyFactory.instances.length).toBe(ptyCountBefore);
    });

    it('should successfully resume session when path still exists', async () => {
      // Create a session
      const managerForCreate = await getSessionManager();

      const session = await managerForCreate.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      // Simulate server restart (session becomes paused)
      mockProcess.markDead(process.pid);

      // Create a new manager where path validation succeeds
      const mockPathStillExists = async (_path: string): Promise<boolean> => true;
      const managerAfterRestart = await getSessionManagerWithPathExists(mockPathStillExists);

      // PTY count before resume
      const ptyCountBefore = ptyFactory.instances.length;

      // Resume should succeed
      const result = await managerAfterRestart.resumeSession(session.id);

      expect(result).not.toBeNull();
      const resumedAgent = result!.workers.find((w: Worker) => w.id === workerId);
      expect(resumedAgent).toBeDefined();
      expect(resumedAgent!.type).toBe('agent');

      // New PTY should be created (workers activated during resume)
      expect(ptyFactory.instances.length).toBeGreaterThan(ptyCountBefore);
    });
  });

  describe('restartAgentWorker', () => {
    it('should restart agent worker with same ID', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const originalWorkerId = agentWorker.id;

      const ptyCountBefore = ptyFactory.instances.length;

      const restarted = await manager.restartAgentWorker(session.id, originalWorkerId, false);

      expect(restarted).not.toBeNull();
      expect(restarted?.id).toBe(originalWorkerId);
      expect(restarted?.type).toBe('agent');
      // New PTY should be created
      expect(ptyFactory.instances.length).toBe(ptyCountBefore + 1);
      // Old PTY should be killed
      expect(ptyFactory.instances[0].killed).toBe(true);
    });

    it('should preserve createdAt for tab order', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const originalWorkerId = agentWorker.id;
      const originalCreatedAt = agentWorker.createdAt;

      // Wait a bit to ensure time passes
      await new Promise(resolve => setTimeout(resolve, 10));

      const restarted = await manager.restartAgentWorker(session.id, originalWorkerId, false);

      expect(restarted).not.toBeNull();
      // createdAt should be preserved (not updated to current time)
      expect(restarted?.createdAt).toBe(originalCreatedAt);
    });

    it('should preserve worker order after restart in multi-worker session', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      // createSession creates both agent and git-diff workers
      const agentWorkerId = session.workers.find((w: Worker) => w.type === 'agent')!.id;

      // Add a terminal worker
      const terminalWorker = await manager.createWorker(session.id, {
        type: 'terminal',
        name: 'Shell',
      });
      expect(terminalWorker).not.toBeNull();

      // Get worker order before restart (sorted by createdAt)
      const sessionBefore = manager.getSession(session.id)!;
      const workerOrderBefore = sessionBefore.workers.map((w: Worker) => w.id);
      // Session should have 3 workers: agent, git-diff, terminal
      expect(workerOrderBefore.length).toBe(3);
      expect(workerOrderBefore).toContain(agentWorkerId);
      expect(workerOrderBefore).toContain(terminalWorker!.id);

      // Restart agent worker
      await manager.restartAgentWorker(session.id, agentWorkerId, false);

      // Worker order should be preserved (sorted by createdAt)
      const sessionAfter = manager.getSession(session.id)!;
      const workerOrderAfter = sessionAfter.workers.map((w: Worker) => w.id);
      expect(workerOrderAfter).toEqual(workerOrderBefore);
    });

    it('should return null for non-existent session', async () => {
      const manager = await getSessionManager();

      const result = await manager.restartAgentWorker('non-existent', 'worker-1', false);
      expect(result).toBeNull();
    });

    it('should return null for non-existent worker', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const result = await manager.restartAgentWorker(session.id, 'non-existent', false);
      expect(result).toBeNull();
    });

    it('should return null for non-agent worker', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const terminalWorker = await manager.createWorker(session.id, {
        type: 'terminal',
        name: 'Shell',
      });

      const result = await manager.restartAgentWorker(session.id, terminalWorker!.id, false);
      expect(result).toBeNull();
    });

    it('should restart with a different agent when agentId is provided', async () => {
      const manager = await getSessionManager();

      // Register a custom agent using the injected agentManager
      const customAgent = await agentManager.registerAgent({
        name: 'Custom Agent',
        commandTemplate: 'custom-agent',
      });

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const originalAgentId = agentWorker.agentId;
      expect(originalAgentId).not.toBe(customAgent.id);

      const restarted = await manager.restartAgentWorker(session.id, agentWorker.id, false, customAgent.id);

      expect(restarted).not.toBeNull();
      expect(restarted?.id).toBe(agentWorker.id);
      expect(restarted?.agentId).toBe(customAgent.id);
    });

    it('should update worker name when agent changes', async () => {
      const manager = await getSessionManager();

      // Register a custom agent using the injected agentManager
      const customAgent = await agentManager.registerAgent({
        name: 'Custom Agent',
        commandTemplate: 'custom-agent',
      });

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;

      const restarted = await manager.restartAgentWorker(session.id, agentWorker.id, false, customAgent.id);

      expect(restarted).not.toBeNull();
      expect(restarted?.name).toBe('Custom Agent');
    });

    it('should keep same agent when agentId is not provided', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const originalAgentId = agentWorker.agentId;
      const originalName = agentWorker.name;

      const restarted = await manager.restartAgentWorker(session.id, agentWorker.id, false);

      expect(restarted).not.toBeNull();
      expect(restarted?.agentId).toBe(originalAgentId);
      expect(restarted?.name).toBe(originalName);
    });

    it('should return null for invalid agentId', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;

      const result = await manager.restartAgentWorker(session.id, agentWorker.id, false, 'non-existent-agent');
      expect(result).toBeNull();
    });

    it('should broadcast session-updated after agent switch', async () => {
      const manager = await getSessionManager();

      // Register a custom agent using the injected agentManager
      const customAgent = await agentManager.registerAgent({
        name: 'Custom Agent',
        commandTemplate: 'custom-agent',
      });

      const onSessionUpdated = mock(() => {});
      manager.setSessionLifecycleCallbacks({ onSessionUpdated });

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;

      await manager.restartAgentWorker(session.id, agentWorker.id, false, customAgent.id);

      // onSessionUpdated should be called for agent switch
      expect(onSessionUpdated).toHaveBeenCalledTimes(1);
      expect(onSessionUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          id: session.id,
        }),
      );
    });

    it('should not broadcast session-updated when restarting with same agent', async () => {
      const manager = await getSessionManager();

      const onSessionUpdated = mock(() => {});
      manager.setSessionLifecycleCallbacks({ onSessionUpdated });

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;

      await manager.restartAgentWorker(session.id, agentWorker.id, false);

      // onSessionUpdated should NOT be called when agent stays the same
      expect(onSessionUpdated).not.toHaveBeenCalled();
    });

    it('should rename branch when branch parameter is provided for worktree session', async () => {
      const manager = await getSessionManager();

      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('old-branch'));

      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'old-branch',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;

      const ptyCountBefore = ptyFactory.instances.length;

      const restarted = await manager.restartAgentWorker(session.id, agentWorker.id, false, undefined, 'new-branch');

      expect(restarted).not.toBeNull();
      expect(restarted?.id).toBe(agentWorker.id);
      // Git operations should have been called
      expect(mockGit.getCurrentBranch).toHaveBeenCalledWith('/test/path');
      expect(mockGit.renameBranch).toHaveBeenCalledWith('old-branch', 'new-branch', '/test/path');
      // New PTY should be created
      expect(ptyFactory.instances.length).toBe(ptyCountBefore + 1);
      // worktreeId should be updated
      const updatedSession = manager.getSession(session.id);
      if (updatedSession?.type === 'worktree') {
        expect(updatedSession.worktreeId).toBe('new-branch');
      }
    });

    it('should not rename branch when branch matches current branch', async () => {
      const manager = await getSessionManager();

      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('same-branch'));

      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'same-branch',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;

      await manager.restartAgentWorker(session.id, agentWorker.id, false, undefined, 'same-branch');

      // renameBranch should NOT be called when branch name matches
      expect(mockGit.renameBranch).not.toHaveBeenCalled();
    });

    it('should broadcast session-updated when branch is renamed', async () => {
      const manager = await getSessionManager();

      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('old-branch'));

      const onSessionUpdated = mock(() => {});
      manager.setSessionLifecycleCallbacks({ onSessionUpdated });

      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'old-branch',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;

      await manager.restartAgentWorker(session.id, agentWorker.id, false, undefined, 'new-branch');

      // onSessionUpdated should be called for branch rename
      expect(onSessionUpdated).toHaveBeenCalledTimes(1);
      expect(onSessionUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          id: session.id,
        }),
      );
    });

    it('should ignore branch parameter for quick sessions', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;

      // Passing branch to a quick session should not cause errors
      const restarted = await manager.restartAgentWorker(session.id, agentWorker.id, false, undefined, 'new-branch');

      expect(restarted).not.toBeNull();
      // Git operations should NOT be called for quick sessions
      expect(mockGit.getCurrentBranch).not.toHaveBeenCalled();
      expect(mockGit.renameBranch).not.toHaveBeenCalled();
    });

    it('should sync worktreeId and broadcast when AI agent externally renamed the git branch', async () => {
      const manager = await getSessionManager();

      // Scenario: An AI agent (e.g. Claude Code) renamed the git branch from
      // 'stale-branch' to 'new-branch' during its session. The user then uses
      // RestartSession with branch='new-branch' to sync the session state.
      // The git branch already matches, so no git rename is needed,
      // but session.worktreeId must be updated from the stale value.
      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('new-branch'));

      const onSessionUpdated = mock(() => {});
      manager.setSessionLifecycleCallbacks({ onSessionUpdated });

      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'stale-branch',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;

      await manager.restartAgentWorker(session.id, agentWorker.id, false, undefined, 'new-branch');

      // renameBranch should NOT be called since git branch already matches
      expect(mockGit.renameBranch).not.toHaveBeenCalled();

      // worktreeId should be updated from 'stale-branch' to 'new-branch'
      const updatedSession = manager.getSession(session.id);
      expect(updatedSession?.type).toBe('worktree');
      if (updatedSession?.type === 'worktree') {
        expect(updatedSession.worktreeId).toBe('new-branch');
      }

      // onSessionUpdated should broadcast the updated worktreeId
      expect(onSessionUpdated).toHaveBeenCalledTimes(1);
      expect(onSessionUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          id: session.id,
          worktreeId: 'new-branch',
        }),
      );
    });

    it('should rename git branch and sync worktreeId when all three values differ', async () => {
      const manager = await getSessionManager();

      // Edge case: worktreeId='stale-branch', actual git branch='intermediate-branch',
      // requested='final-branch'. Both git rename AND worktreeId sync must happen.
      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('intermediate-branch'));

      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'stale-branch',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;

      await manager.restartAgentWorker(session.id, agentWorker.id, false, undefined, 'final-branch');

      // renameBranch should be called to rename from the actual git branch to the requested name
      expect(mockGit.renameBranch).toHaveBeenCalledWith('intermediate-branch', 'final-branch', '/test/path');

      // worktreeId should be updated to the requested branch
      const updatedSession = manager.getSession(session.id);
      expect(updatedSession?.type).toBe('worktree');
      if (updatedSession?.type === 'worktree') {
        expect(updatedSession.worktreeId).toBe('final-branch');
      }
    });
  });

  describe('updateSessionMetadata - no auto-restart on branch rename', () => {
    it('should rename branch without restarting agent worker', async () => {
      const manager = await getSessionManager();

      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('old-branch'));

      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'old-branch',
        agentId: 'claude-code',
      });

      const ptyCountBefore = ptyFactory.instances.length;

      const result = await manager.updateSessionMetadata(session.id, { branch: 'new-branch' });

      expect(result.success).toBe(true);
      expect(result.branch).toBe('new-branch');
      // Git operations should have been called
      expect(mockGit.renameBranch).toHaveBeenCalledWith('old-branch', 'new-branch', '/test/path');
      // No new PTY should be created (no auto-restart)
      expect(ptyFactory.instances.length).toBe(ptyCountBefore);
      // No old PTY should be killed (no auto-restart)
      const agentPty = ptyFactory.instances[0];
      expect(agentPty.killed).toBe(false);
    });

    it('should recalculate git-diff worker baseCommit for active sessions', async () => {
      const manager = await getSessionManager();

      // Create session first with default getMergeBaseSafe (returns 'abc1234')
      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'old-branch',
        agentId: 'claude-code',
      });

      const gitDiffWorker = session.workers.find((w: Worker) => w.type === 'git-diff')!;
      expect(gitDiffWorker).toBeDefined();
      // Confirm initial baseCommit is the default mock value
      if (gitDiffWorker.type === 'git-diff') {
        expect(gitDiffWorker.baseCommit).toBe('abc1234');
      }

      // Now configure mocks for branch rename: getCurrentBranch returns old branch,
      // and getMergeBaseSafe returns a new hash (simulating recalculation after rename)
      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('old-branch'));
      mockGit.getMergeBaseSafe.mockImplementation(() => Promise.resolve('new-merge-base-hash'));

      const result = await manager.updateSessionMetadata(session.id, { branch: 'new-branch' });

      expect(result.success).toBe(true);

      // Verify the git-diff worker's baseCommit has been updated to the new merge-base
      const updatedSession = manager.getSession(session.id);
      const updatedGitDiffWorker = updatedSession?.workers.find((w: Worker) => w.type === 'git-diff');
      expect(updatedGitDiffWorker?.type).toBe('git-diff');
      if (updatedGitDiffWorker?.type === 'git-diff') {
        expect(updatedGitDiffWorker.baseCommit).toBe('new-merge-base-hash');
      }
    });

    it('should fire onDiffBaseCommitChanged callback for active sessions after branch rename', async () => {
      const manager = await getSessionManager();

      const onDiffBaseCommitChanged = mock(() => {});
      manager.setSessionLifecycleCallbacks({ onDiffBaseCommitChanged });

      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'old-branch',
        agentId: 'claude-code',
      });

      const gitDiffWorker = session.workers.find((w: Worker) => w.type === 'git-diff')!;

      // Set mocks AFTER session creation so the rename triggers recalculation
      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('old-branch'));
      mockGit.getMergeBaseSafe.mockImplementation(() => Promise.resolve('new-merge-base-hash'));

      await manager.updateSessionMetadata(session.id, { branch: 'new-branch' });

      expect(onDiffBaseCommitChanged).toHaveBeenCalledTimes(1);
      expect(onDiffBaseCommitChanged).toHaveBeenCalledWith(
        session.id,
        gitDiffWorker.id,
        'new-merge-base-hash',
      );
    });

    it('should update persisted git-diff worker baseCommit for inactive sessions', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'old-branch',
        agentId: 'claude-code',
      });

      // Pause the session to make it inactive (removed from memory, persisted only)
      await manager.pauseSession(session.id);
      expect(manager.getSession(session.id)).toBeUndefined();

      // Configure mocks for the branch rename on the inactive session
      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('old-branch'));
      mockGit.getMergeBaseSafe.mockImplementation(() => Promise.resolve('new-merge-base-for-inactive'));

      const result = await manager.updateSessionMetadata(session.id, { branch: 'new-branch' });

      expect(result.success).toBe(true);
      expect(result.branch).toBe('new-branch');

      // Read the persisted session and verify the git-diff worker's baseCommit was updated
      const persisted = await manager.getSessionMetadata(session.id);
      expect(persisted).not.toBeNull();
      const persistedGitDiffWorker = persisted!.workers.find((w: PersistedWorker) => w.type === 'git-diff');
      expect(persistedGitDiffWorker).toBeDefined();
      expect(persistedGitDiffWorker!.type).toBe('git-diff');
      if (persistedGitDiffWorker!.type === 'git-diff') {
        expect(persistedGitDiffWorker!.baseCommit).toBe('new-merge-base-for-inactive');
      }
    });
  });

  describe('updateSessionMetadata - error isolation for git-diff updates', () => {
    it('should succeed branch rename for active session even when git-diff update fails', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'old-branch',
        agentId: 'claude-code',
      });

      // Configure mocks: getCurrentBranch returns old branch, renameBranch succeeds,
      // but getMergeBaseSafe throws (causing calculateBaseCommit to fail)
      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('old-branch'));
      mockGit.getMergeBaseSafe.mockImplementation(() => {
        throw new Error('git merge-base failed');
      });

      const result = await manager.updateSessionMetadata(session.id, { branch: 'new-branch' });

      // Branch rename should still succeed despite git-diff update failure
      expect(result.success).toBe(true);
      expect(result.branch).toBe('new-branch');

      // Verify the session's worktreeId was updated
      const updatedSession = manager.getSession(session.id);
      expect(updatedSession?.type).toBe('worktree');
      if (updatedSession?.type === 'worktree') {
        expect(updatedSession.worktreeId).toBe('new-branch');
      }
    });

    it('should succeed branch rename for inactive session even when calculateBaseCommit fails', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'old-branch',
        agentId: 'claude-code',
      });

      // Pause the session to make it inactive
      await manager.pauseSession(session.id);
      expect(manager.getSession(session.id)).toBeUndefined();

      // Configure mocks: getCurrentBranch returns old branch, renameBranch succeeds,
      // but getDefaultBranch throws (causing calculateBaseCommit to fail)
      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('old-branch'));
      mockGit.getDefaultBranch.mockImplementation(() => {
        throw new Error('git default branch lookup failed');
      });

      const result = await manager.updateSessionMetadata(session.id, { branch: 'new-branch' });

      // Branch rename should still succeed
      expect(result.success).toBe(true);
      expect(result.branch).toBe('new-branch');

      // Verify the persisted session has the new branch name
      const persisted = await manager.getSessionMetadata(session.id);
      expect(persisted).not.toBeNull();
      expect(persisted!.type).toBe('worktree');
      if (persisted!.type === 'worktree') {
        expect(persisted!.worktreeId).toBe('new-branch');
      }
    });

    it('should preserve original workers when calculateBaseCommit throws for inactive session', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'old-branch',
        agentId: 'claude-code',
      });

      // Record original workers before pausing (git-diff worker has its initial baseCommit)
      const originalMetadata = await manager.getSessionMetadata(session.id);
      expect(originalMetadata).not.toBeNull();
      const originalGitDiffWorker = originalMetadata!.workers.find((w: PersistedWorker) => w.type === 'git-diff');
      expect(originalGitDiffWorker).toBeDefined();
      const originalBaseCommit = originalGitDiffWorker!.type === 'git-diff' ? originalGitDiffWorker!.baseCommit : undefined;

      // Pause the session to make it inactive
      await manager.pauseSession(session.id);
      expect(manager.getSession(session.id)).toBeUndefined();

      // Configure mocks: getCurrentBranch returns old branch, renameBranch succeeds,
      // but getDefaultBranch throws (causing calculateBaseCommit to fail)
      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('old-branch'));
      mockGit.getDefaultBranch.mockImplementation(() => {
        throw new Error('calculateBaseCommit failure');
      });

      // Update both title and branch
      const result = await manager.updateSessionMetadata(session.id, {
        title: 'New Title',
        branch: 'new-branch',
      });

      // Branch rename and title update should still succeed
      expect(result.success).toBe(true);
      expect(result.title).toBe('New Title');
      expect(result.branch).toBe('new-branch');

      // Verify the persisted session preserves original workers (baseCommit unchanged)
      const persisted = await manager.getSessionMetadata(session.id);
      expect(persisted).not.toBeNull();
      expect(persisted!.title).toBe('New Title');
      const persistedGitDiffWorker = persisted!.workers.find((w: PersistedWorker) => w.type === 'git-diff');
      expect(persistedGitDiffWorker).toBeDefined();
      if (persistedGitDiffWorker!.type === 'git-diff') {
        expect(persistedGitDiffWorker!.baseCommit).toBe(originalBaseCommit);
      }
    });

    it('should use HEAD as fallback when calculateBaseCommit returns null for inactive session', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'old-branch',
        agentId: 'claude-code',
      });

      // Pause the session to make it inactive
      await manager.pauseSession(session.id);

      // Configure mocks: getCurrentBranch returns old branch, renameBranch succeeds,
      // getDefaultBranch returns null AND gitSafe returns null (calculateBaseCommit returns null)
      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('old-branch'));
      mockGit.getDefaultBranch.mockImplementation(() => Promise.resolve(null));
      mockGit.gitSafe.mockImplementation(() => Promise.resolve(null));

      const result = await manager.updateSessionMetadata(session.id, { branch: 'new-branch' });

      expect(result.success).toBe(true);

      // Verify the persisted git-diff worker's baseCommit was updated to 'HEAD' (not skipped)
      const persisted = await manager.getSessionMetadata(session.id);
      expect(persisted).not.toBeNull();
      const persistedGitDiffWorker = persisted!.workers.find((w: PersistedWorker) => w.type === 'git-diff');
      expect(persistedGitDiffWorker).toBeDefined();
      expect(persistedGitDiffWorker!.type).toBe('git-diff');
      if (persistedGitDiffWorker!.type === 'git-diff') {
        expect(persistedGitDiffWorker!.baseCommit).toBe('HEAD');
      }
    });
  });

  describe('updateSessionMetadata - paused session with both title and branch', () => {
    it('should persist both title and branch changes for a paused session', async () => {
      const manager = await getSessionManager();

      // Create a worktree session and pause it
      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'old-branch',
        agentId: 'claude-code',
      });

      await manager.pauseSession(session.id);
      expect(manager.getSession(session.id)).toBeUndefined();

      // Configure mocks for branch rename
      mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('old-branch'));

      // Update both title and branch at once
      const result = await manager.updateSessionMetadata(session.id, {
        title: 'New Title',
        branch: 'new-branch',
      });

      expect(result.success).toBe(true);
      expect(result.title).toBe('New Title');
      expect(result.branch).toBe('new-branch');

      // Verify BOTH changes are persisted
      const persisted = await manager.getSessionMetadata(session.id);
      expect(persisted).not.toBeNull();
      expect(persisted!.title).toBe('New Title');
      expect(persisted!.type).toBe('worktree');
      if (persisted!.type === 'worktree') {
        expect(persisted!.worktreeId).toBe('new-branch');
      }
    });
  });

  describe('updateSessionMetadata - title-only update on paused session', () => {
    it('should persist title change for inactive session without affecting worktreeId', async () => {
      const manager = await getSessionManager();

      // Create a worktree session and pause it
      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });
      await manager.pauseSession(session.id);

      // Confirm session is no longer in memory
      expect(manager.getSession(session.id)).toBeUndefined();

      // Update only the title (no branch change)
      const result = await manager.updateSessionMetadata(session.id, { title: 'New Title' });

      expect(result.success).toBe(true);
      expect(result.title).toBe('New Title');

      // Verify the persisted metadata reflects the title change
      const persisted = await manager.getSessionMetadata(session.id);
      expect(persisted).not.toBeNull();
      expect(persisted!.title).toBe('New Title');

      // Verify the worktreeId was NOT changed (preserves original value)
      expect(persisted!.type).toBe('worktree');
      if (persisted!.type === 'worktree') {
        expect(persisted!.worktreeId).toBe('feature-branch');
      }
    });
  });

  describe('pauseSession', () => {
    it('should call notifySessionPaused before killing PTY workers', async () => {
      const manager = await getSessionManager();

      const callOrder: string[] = [];

      // Set WebSocket callbacks with spy on notifySessionPaused
      const notifySessionPaused = mock((_sessionId: string) => {
        callOrder.push('notifySessionPaused');
      });
      manager.setWebSocketCallbacks({
        notifySessionDeleted: mock(() => {}),
        notifySessionPaused,
        broadcastToApp: mock(() => {}),
      });

      // Create worktree session
      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      // Track when PTY is killed to verify call order
      const ptyIndex = ptyFactory.instances.length - 1;
      const originalKill = ptyFactory.instances[ptyIndex].kill.bind(ptyFactory.instances[ptyIndex]);
      ptyFactory.instances[ptyIndex].kill = (...args: Parameters<typeof originalKill>) => {
        callOrder.push('ptyKill');
        return originalKill(...args);
      };

      await manager.pauseSession(session.id);

      // Verify notifySessionPaused was called
      expect(notifySessionPaused).toHaveBeenCalledTimes(1);
      expect(notifySessionPaused).toHaveBeenCalledWith(session.id);

      // Verify notifySessionPaused was called BEFORE PTY kill
      expect(callOrder.indexOf('notifySessionPaused')).toBeLessThan(callOrder.indexOf('ptyKill'));
    });

    it('should return false for non-existent session', async () => {
      const manager = await getSessionManager();

      const result = await manager.pauseSession('non-existent');
      expect(result).toBe(false);
    });

    it('should return false for quick session (quick sessions cannot be paused)', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const result = await manager.pauseSession(session.id);
      expect(result).toBe(false);

      // Session should still be in memory
      expect(manager.getSession(session.id)).toBeDefined();
    });

    it('should not change session state when pause fails for quick session', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const result = await manager.pauseSession(session.id);
      expect(result).toBe(false);

      // Verify session exists and remains active
      const retrievedSession = manager.getSession(session.id);
      expect(retrievedSession).toBeDefined();
      expect(retrievedSession?.status).toBe('active');
    });

    it('should return false when pausing an already paused session (not in memory)', async () => {
      const manager = await getSessionManager();

      // Create and pause a worktree session
      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      // First pause should succeed
      const firstPauseResult = await manager.pauseSession(session.id);
      expect(firstPauseResult).toBe(true);
      expect(manager.getSession(session.id)).toBeUndefined();

      // Second pause should return false (session is not in memory)
      const secondPauseResult = await manager.pauseSession(session.id);
      expect(secondPauseResult).toBe(false);
    });

    it('should pause session with git-diff worker', async () => {
      const manager = await getSessionManager();

      // Create worktree session (automatically includes git-diff worker)
      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      // Verify git-diff worker exists
      const gitDiffWorker = session.workers.find((w: Worker) => w.type === 'git-diff');
      expect(gitDiffWorker).toBeDefined();

      // Pause should succeed
      const result = await manager.pauseSession(session.id);
      expect(result).toBe(true);

      // Session should be removed from memory
      expect(manager.getSession(session.id)).toBeUndefined();
    });

    it('should kill workers and remove from memory for worktree session', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      // Verify session is in memory
      expect(manager.getSession(session.id)).toBeDefined();

      // Get PTY index before pausing
      const ptyIndex = ptyFactory.instances.length - 1;
      expect(ptyFactory.instances[ptyIndex].killed).toBe(false);

      const result = await manager.pauseSession(session.id);

      expect(result).toBe(true);
      // Session should be removed from memory
      expect(manager.getSession(session.id)).toBeUndefined();
      // PTY should be killed
      expect(ptyFactory.instances[ptyIndex].killed).toBe(true);
    });

    it('should update serverPid to null in persistence', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      // Verify serverPid is set before pausing
      const savedDataBefore = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
      expect(savedDataBefore[0].serverPid).toBeDefined();

      await manager.pauseSession(session.id);

      // serverPid should be null after pausing
      const savedDataAfter = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
      expect(savedDataAfter[0].serverPid).toBeNull();
    });

    it('should call onSessionPaused callback', async () => {
      const manager = await getSessionManager();

      const onSessionPaused = mock(() => {});
      manager.setSessionLifecycleCallbacks({ onSessionPaused });

      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      await manager.pauseSession(session.id);

      expect(onSessionPaused).toHaveBeenCalledTimes(1);
      expect(onSessionPaused).toHaveBeenCalledWith(session.id, expect.any(String));
    });

    it('should persist all worker entries with pid: null after pausing', async () => {
      const manager = await getSessionManager();

      // Create worktree session with agent worker (auto-created) and add a terminal worker
      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      await manager.createWorker(session.id, {
        type: 'terminal',
        name: 'Shell',
      });

      // Verify workers have non-null PIDs before pausing
      const savedDataBefore = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
      const ptyWorkersBefore = savedDataBefore[0].workers.filter(
        (w: PersistedWorker) => w.type === 'agent' || w.type === 'terminal'
      );
      expect(ptyWorkersBefore.length).toBeGreaterThanOrEqual(2);
      for (const w of ptyWorkersBefore) {
        expect(w.pid).not.toBeNull();
      }

      await manager.pauseSession(session.id);

      // After pausing, all worker entries should have pid: null
      const savedDataAfter = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
      const allWorkers = savedDataAfter[0].workers as PersistedWorker[];
      for (const worker of allWorkers) {
        if (worker.type === 'agent' || worker.type === 'terminal') {
          expect(worker.pid).toBeNull();
        }
      }
    });
  });

  describe('forceDeleteSession', () => {
    it('should delete an in-memory session (delegates to deleteSession)', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Session is in memory
      expect(manager.getSession(session.id)).toBeDefined();

      const result = await manager.forceDeleteSession(session.id);

      expect(result).toBe(true);
      // Session should be removed from memory
      expect(manager.getSession(session.id)).toBeUndefined();
      // PTY should be killed
      expect(ptyFactory.instances[0].killed).toBe(true);
    });

    it('should delete a persistence-only session and enqueue CLEANUP_SESSION_OUTPUTS job', async () => {
      const manager = await getSessionManager();

      // Create and pause a worktree session so it only exists in persistence
      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });
      await manager.pauseSession(session.id);

      // Session is not in memory but exists in persistence
      expect(manager.getSession(session.id)).toBeUndefined();
      const metadataBefore = await manager.getSessionMetadata(session.id);
      expect(metadataBefore).not.toBeNull();

      const onSessionDeleted = mock(() => {});
      manager.setSessionLifecycleCallbacks({ onSessionDeleted });

      const result = await manager.forceDeleteSession(session.id);

      expect(result).toBe(true);
      // Session should be removed from persistence
      const metadataAfter = await manager.getSessionMetadata(session.id);
      expect(metadataAfter).toBeNull();
      // onSessionDeleted should be called
      expect(onSessionDeleted).toHaveBeenCalledTimes(1);
      expect(onSessionDeleted).toHaveBeenCalledWith(session.id);
      // CLEANUP_SESSION_OUTPUTS job should be enqueued
      const jobs = await testJobQueue!.getJobs({ type: JOB_TYPES.CLEANUP_SESSION_OUTPUTS });
      expect(jobs.length).toBeGreaterThanOrEqual(1);
      const cleanupJob = jobs.find(j => JSON.parse(j.payload).sessionId === session.id);
      expect(cleanupJob).toBeDefined();
    });

    it('should return false when session does not exist anywhere', async () => {
      const manager = await getSessionManager();

      const result = await manager.forceDeleteSession('non-existent-id');

      expect(result).toBe(false);
    });

    it('should delete persistence-only session without error when jobQueue is null', async () => {
      // Create a manager WITH jobQueue first, so we can create and pause a session
      const managerWithQueue = await getSessionManager();

      const session = await managerWithQueue.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });
      await managerWithQueue.pauseSession(session.id);

      // Create a new manager WITHOUT jobQueue, sharing the same database
      const module = await import(`../session-manager.js?v=${++importCounter}`);
      const managerWithoutQueue = await module.SessionManager.create({
        ptyProvider: ptyFactory.provider,
        pathExists: mockPathExists,
        jobQueue: null,
        agentManager,
      });

      // Verify session exists in persistence
      const metadataBefore = await managerWithoutQueue.getSessionMetadata(session.id);
      expect(metadataBefore).not.toBeNull();

      // forceDeleteSession should succeed even without jobQueue
      const result = await managerWithoutQueue.forceDeleteSession(session.id);

      expect(result).toBe(true);
      // Session should be removed from persistence
      const metadataAfter = await managerWithoutQueue.getSessionMetadata(session.id);
      expect(metadataAfter).toBeNull();
    });
  });

  describe('resumeSession', () => {
    it('should return existing session if already active', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      // PTY count before resume attempt
      const ptyCountBefore = ptyFactory.instances.length;

      const result = await manager.resumeSession(session.id);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(session.id);
      // No new PTY should be created since session is already active
      expect(ptyFactory.instances.length).toBe(ptyCountBefore);
    });

    it('should return null for non-existent session', async () => {
      const manager = await getSessionManager();

      const result = await manager.resumeSession('non-existent');
      expect(result).toBeNull();
    });

    it('should load and restore paused session', async () => {
      const manager = await getSessionManager();

      // Create and pause a session
      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });
      const sessionId = session.id;
      const agentWorkerId = session.workers.find((w: Worker) => w.type === 'agent')!.id;

      await manager.pauseSession(sessionId);

      // Verify session is not in memory
      expect(manager.getSession(sessionId)).toBeUndefined();

      // PTY count before resume
      const ptyCountBefore = ptyFactory.instances.length;

      // Resume the session
      const resumed = await manager.resumeSession(sessionId);

      expect(resumed).not.toBeNull();
      expect(resumed?.id).toBe(sessionId);
      expect(resumed?.type).toBe('worktree');

      // Session should be back in memory
      expect(manager.getSession(sessionId)).toBeDefined();

      // New PTY should be created for the agent worker
      expect(ptyFactory.instances.length).toBe(ptyCountBefore + 1);

      // Workers should be restored
      expect(resumed?.workers.length).toBeGreaterThan(0);
      expect(resumed?.workers.some((w: Worker) => w.id === agentWorkerId)).toBe(true);
    });

    it('should update serverPid to process.pid in persistence', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      await manager.pauseSession(session.id);

      // Verify serverPid is null after pausing
      const savedDataBefore = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
      expect(savedDataBefore[0].serverPid).toBeNull();

      await manager.resumeSession(session.id);

      // serverPid should be set to current process.pid after resuming
      const savedDataAfter = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
      expect(savedDataAfter[0].serverPid).toBe(process.pid);
    });

    it('should spawn workers with continueConversation: true', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      await manager.pauseSession(session.id);

      // Resume and verify PTY was spawned
      const resumed = await manager.resumeSession(session.id);
      expect(resumed).not.toBeNull();

      // The new PTY should have been created (meaning continueConversation was passed)
      // We can verify this by checking that a new PTY instance exists
      const lastPty = ptyFactory.instances[ptyFactory.instances.length - 1];
      expect(lastPty).toBeDefined();
      expect(lastPty.killed).toBe(false);
    });

    it('should call onSessionResumed callback', async () => {
      const manager = await getSessionManager();

      const onSessionResumed = mock(() => {});
      manager.setSessionLifecycleCallbacks({ onSessionResumed });

      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      await manager.pauseSession(session.id);
      await manager.resumeSession(session.id);

      expect(onSessionResumed).toHaveBeenCalledTimes(1);
      expect(onSessionResumed).toHaveBeenCalledWith(
        expect.objectContaining({
          id: session.id,
          type: 'worktree',
        })
      );
    });

    it('should return null if session path no longer exists', async () => {
      // First create a session with normal pathExists
      const managerForCreate = await getSessionManager();

      const session = await managerForCreate.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      await managerForCreate.pauseSession(session.id);

      // Create new manager with pathExists that returns true during initialization
      // but false during resumeSession (simulating path deleted after init)
      let initComplete = false;
      const pathExistsOnlyDuringInit = async (_path: string): Promise<boolean> => {
        if (!initComplete) {
          return true; // Return true during initialization
        }
        return false; // Return false for subsequent calls (resumeSession)
      };

      const module = await import(`../session-manager.js?v=${++importCounter}`);
      const managerWithMissingPath = await module.SessionManager.create({
        ptyProvider: ptyFactory.provider,
        pathExists: pathExistsOnlyDuringInit,
        jobQueue: testJobQueue,
        agentManager,
      });

      // Mark initialization as complete so subsequent pathExists calls return false
      initComplete = true;

      const result = await managerWithMissingPath.resumeSession(session.id);
      expect(result).toBeNull();
    });

    it('should restore paused state in DB if PTY activation fails', async () => {
      const manager = await getSessionManager();

      // Create and pause a worktree session
      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });
      const sessionId = session.id;

      await manager.pauseSession(sessionId);

      // Verify session is paused in persistence (serverPid is null)
      const savedDataBeforeResume = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
      expect(savedDataBeforeResume[0].serverPid).toBeNull();
      expect(savedDataBeforeResume[0].pausedAt).toBeDefined();

      // Create a new manager with a PTY provider that throws on spawn
      // This simulates PTY activation failure during resume
      const failingPtyProvider: PtyProvider = {
        spawn: (_command: string, _args: string[], _options: PtySpawnOptions) => {
          throw new Error('PTY spawn failed');
        },
      };

      const module = await import(`../session-manager.js?v=${++importCounter}`);
      const managerWithFailingPty = await module.SessionManager.create({
        ptyProvider: failingPtyProvider,
        pathExists: mockPathExists,
        jobQueue: testJobQueue,
        agentManager,
      });

      // Resume should fail because PTY activation throws
      const result = await managerWithFailingPty.resumeSession(sessionId);
      expect(result).toBeNull();

      // Session should NOT be in memory
      expect(managerWithFailingPty.getSession(sessionId)).toBeUndefined();

      // DB should be restored to paused state (serverPid cleared, pausedAt set)
      // The session should still be findable as "paused" for future resume attempts
      const pausedSessions = await managerWithFailingPty.getAllPausedSessions();
      const failedSession = pausedSessions.find((s: Session) => s.id === sessionId);
      expect(failedSession).toBeDefined();
      expect(failedSession?.pausedAt).toBeDefined();
    });

    it('should prevent concurrent resume attempts for the same session', async () => {
      const manager = await getSessionManager();

      // Create and pause a worktree session
      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });
      const sessionId = session.id;

      await manager.pauseSession(sessionId);

      // PTY count before resume
      const ptyCountBefore = ptyFactory.instances.length;

      // Call resumeSession concurrently - both should not cause orphan PTYs
      const [result1, result2] = await Promise.all([
        manager.resumeSession(sessionId),
        manager.resumeSession(sessionId),
      ]);

      // One should succeed and the other should return null (blocked by guard)
      const successCount = [result1, result2].filter((r) => r !== null).length;
      expect(successCount).toBe(1);

      // Session should be in memory exactly once
      expect(manager.getSession(sessionId)).toBeDefined();

      // Only one set of PTYs should have been created (not two)
      // Each resume creates 1 PTY for the agent worker
      const ptysCreated = ptyFactory.instances.length - ptyCountBefore;
      expect(ptysCreated).toBe(1);
    });
  });

  describe('getAllPausedSessions', () => {
    it('should return paused sessions with pausedAt timestamp', async () => {
      const manager = await getSessionManager();

      // Create and pause a worktree session
      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      await manager.pauseSession(session.id);

      // Get paused sessions
      const pausedSessions = await manager.getAllPausedSessions();

      expect(pausedSessions.length).toBe(1);
      expect(pausedSessions[0].id).toBe(session.id);
      expect(pausedSessions[0].pausedAt).toBeDefined();
      expect(pausedSessions[0].activationState).toBe('hibernated');
    });

    it('should not set pausedAt on active in-memory sessions', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
      });

      // Active sessions via getAllSessions should not have pausedAt set
      const allSessions: Session[] = manager.getAllSessions();
      const activeSession = allSessions.find((s) => s.id === session.id);
      expect(activeSession).toBeDefined();
      expect(activeSession?.pausedAt).toBeUndefined();
    });

    it('should preserve parent fields on paused sessions', async () => {
      const manager = await getSessionManager();

      // Create a worktree session with parent fields and pause it
      const session = await manager.createSession({
        type: 'worktree',
        locationPath: '/test/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        agentId: 'claude-code',
        parentSessionId: 'parent-sess-paused',
        parentWorkerId: 'parent-wkr-paused',
      });

      await manager.pauseSession(session.id);

      // Get paused sessions and verify parent fields are preserved
      const pausedSessions = await manager.getAllPausedSessions();

      expect(pausedSessions.length).toBe(1);
      expect(pausedSessions[0].parentSessionId).toBe('parent-sess-paused');
      expect(pausedSessions[0].parentWorkerId).toBe('parent-wkr-paused');
    });
  });

  describe('error recovery', () => {
    it('should propagate callback errors (caller is responsible for error handling)', async () => {
      const manager = await getSessionManager();

      const throwingCallback = mock(() => {
        throw new Error('Callback error');
      });

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;
      manager.attachWorkerCallbacks(session.id, workerId, {
        onData: throwingCallback,
        onExit: mock(() => {}),
      });

      // Callback errors propagate - this documents the expected behavior
      // Callers (e.g., WebSocket handlers) should wrap callbacks with try-catch
      expect(() => {
        ptyFactory.instances[0].simulateData('test');
      }).toThrow('Callback error');
    });

    it('should mark worker as stopped on PTY exit', async () => {
      const manager = await getSessionManager();

      const onExit = mock(() => {});
      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;
      manager.attachWorkerCallbacks(session.id, workerId, {
        onData: mock(() => {}),
        onExit,
      });

      // Simulate PTY crash with non-zero exit (signal 9 = SIGKILL)
      ptyFactory.instances[0].simulateExit(1, 9);

      expect(onExit).toHaveBeenCalledWith(1, '9');
    });

    it('should continue operating after one session crashes', async () => {
      const manager = await getSessionManager();

      // Create two sessions
      await manager.createSession({ type: 'quick', locationPath: '/path/1', agentId: 'claude-code' });
      const session2 = await manager.createSession({ type: 'quick', locationPath: '/path/2', agentId: 'claude-code' });
      const agentWorker2 = session2.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId2 = agentWorker2.id;

      // First session crashes (signal 11 = SIGSEGV)
      ptyFactory.instances[0].simulateExit(1, 11);

      // Second session should still work
      expect(manager.getSession(session2.id)).toBeDefined();
      expect(manager.writeWorkerInput(session2.id, workerId2, 'test')).toBe(true);
    });
  });
});
