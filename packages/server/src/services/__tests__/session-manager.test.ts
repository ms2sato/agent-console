import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'fs';
import type { CreateSessionRequest, CreateWorkerParams, Worker } from '@agent-console/shared';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { JobQueue } from '../../jobs/index.js';

// Test config directory
const TEST_CONFIG_DIR = '/test/config';

// Test JobQueue instance (created fresh for each test)
let testJobQueue: JobQueue | null = null;

// Create mock PTY factory (will be reset in beforeEach)
const ptyFactory = createMockPtyFactory(10000);

let importCounter = 0;

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
        expect(session.worktreeId).toBe('main');
      }
      expect(session.status).toBe('active');
      // createSession creates both agent and git-diff workers
      expect(session.workers.length).toBe(2);
      expect(session.workers.some((w: Worker) => w.type === 'agent')).toBe(true);
      expect(session.workers.some((w: Worker) => w.type === 'git-diff')).toBe(true);
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

      expect(onData).toHaveBeenCalledWith('Hello World');
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
      expect(newOnData).toHaveBeenCalledWith('new data');
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

      // Data should trigger both callbacks
      ptyFactory.instances[0].simulateData('shared data');
      expect(onData1).toHaveBeenCalledWith('shared data');
      expect(onData2).toHaveBeenCalledWith('shared data');

      // Detaching one should not affect the other
      manager.detachWorkerCallbacks(session.id, workerId, connId1!);
      onData1.mockClear();
      onData2.mockClear();

      ptyFactory.instances[0].simulateData('after detach 1');
      expect(onData1).not.toHaveBeenCalled();
      expect(onData2).toHaveBeenCalledWith('after detach 1');
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
    it('should return activity state', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      const state = manager.getWorkerActivityState(session.id, workerId);

      // Initial state is 'unknown' until activity is detected
      expect(state).toBe('unknown');
    });

    it('should return undefined for non-existent session', async () => {
      const manager = await getSessionManager();

      const state = manager.getWorkerActivityState('non-existent', 'worker-1');
      expect(state).toBeUndefined();
    });
  });

  describe('setGlobalActivityCallback', () => {
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

      expect(onData).toHaveBeenCalledWith(binaryLike);
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

      expect(onData).toHaveBeenCalledWith(unicode);
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
      const restored = await manager.restoreWorker(session.id, workerId);

      expect(restored).not.toBeNull();
      expect(restored?.id).toBe(workerId);
      // No new PTY should be created
      expect(ptyFactory.instances.length).toBe(ptyCountBefore);
    });

    it('should restore agent worker from persisted metadata when internal worker does not exist', async () => {
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
      // so the new manager will inherit the session
      mockProcess.markDead(process.pid);

      // Create new manager that loads from persistence
      const manager2 = await getSessionManager();

      // Session exists but internal worker map is empty
      const session2 = manager2.getSession(session.id);
      expect(session2).toBeDefined();

      // PTY count before restore
      const ptyCountBefore = ptyFactory.instances.length;

      // Restore worker
      const restored = await manager2.restoreWorker(session.id, workerId);

      expect(restored).not.toBeNull();
      expect(restored?.id).toBe(workerId);
      expect(restored?.type).toBe('agent');

      // New PTY should be created
      expect(ptyFactory.instances.length).toBe(ptyCountBefore + 1);

      // Persistence should be updated (not added as new entry)
      const savedDataAfter = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
      expect(savedDataAfter.length).toBe(1); // Still 1 session, not 2
    });

    it('should restore terminal worker from persisted metadata', async () => {
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
      mockProcess.markDead(process.pid);

      const manager2 = await getSessionManager();

      // PTY count before restore
      const ptyCountBefore = ptyFactory.instances.length;

      // Restore terminal worker
      const restored = await manager2.restoreWorker(session.id, terminalWorkerId);

      expect(restored).not.toBeNull();
      expect(restored?.id).toBe(terminalWorkerId);
      expect(restored?.type).toBe('terminal');

      // New PTY should be created
      expect(ptyFactory.instances.length).toBe(ptyCountBefore + 1);
    });

    it('should return null for git-diff worker (does not need PTY restoration)', async () => {
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

      // Restore should return null for git-diff worker
      const restored = await manager2.restoreWorker(session.id, gitDiffWorker!.id);
      expect(restored).toBeNull();
    });

    it('should return null for non-existent session', async () => {
      const manager = await getSessionManager();

      const restored = await manager.restoreWorker('non-existent', 'worker-1');
      expect(restored).toBeNull();
    });

    it('should return null if worker not found in persisted metadata', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      // Simulate server restart: mark the previous server as dead
      mockProcess.markDead(process.pid);

      const manager2 = await getSessionManager();

      // Try to restore non-existent worker
      const restored = await manager2.restoreWorker(session.id, 'non-existent-worker');
      expect(restored).toBeNull();
    });

    it('should update persistence with new PID after restoration', async () => {
      const manager = await getSessionManager();

      const session = await manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      // Get original PID from persistence
      const savedDataBefore = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
      const originalPid = savedDataBefore[0].workers.find((w: { id: string }) => w.id === workerId)?.pid;
      expect(originalPid).toBeDefined();

      // Simulate server restart: mark the previous server as dead
      mockProcess.markDead(process.pid);

      const manager2 = await getSessionManager();

      // Restore worker
      await manager2.restoreWorker(session.id, workerId);

      // Check that PID was updated in persistence
      const savedDataAfter = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
      const newPid = savedDataAfter[0].workers.find((w: { id: string }) => w.id === workerId)?.pid;
      expect(newPid).toBeDefined();
      expect(newPid).not.toBe(originalPid); // PID should be different
    });

    it('should return all workers from getSession even when only some are restored', async () => {
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

      // Simulate server restart
      const manager2 = await simulateServerRestart();

      // Before any restoration, getSession should return all workers from persistence
      const sessionAfterRestart = manager2.getSession(session.id);
      expect(sessionAfterRestart?.workers.length).toBe(workerCountBefore);

      // Restore only ONE worker (agent)
      await manager2.restoreWorker(session.id, agentWorkerId);

      // getSession should STILL return all workers (not just the restored one)
      const sessionAfterPartialRestore = manager2.getSession(session.id);
      expect(sessionAfterPartialRestore?.workers.length).toBe(workerCountBefore);

      // Verify both agent and terminal workers are present
      const workerIds = sessionAfterPartialRestore?.workers.map((w: Worker) => w.id);
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
      const restored = await manager.restoreWorker(session.id, workerId);

      // Should return the worker successfully
      expect(restored).not.toBeNull();
      expect(restored?.id).toBe(workerId);

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
      const restored = await manager.restoreWorker(session.id, terminalWorker!.id);

      // Should return the worker successfully
      expect(restored).not.toBeNull();
      expect(restored?.id).toBe(terminalWorker!.id);

      // No new PTY should be created
      expect(ptyFactory.instances.length).toBe(ptyCountAfterCreate);
    });
  });

  describe('restoreWorker - path validation', () => {
    // Helper to get SessionManager with custom pathExists mock using factory pattern
    async function getSessionManagerWithPathExists(pathExistsFn: (path: string) => Promise<boolean>) {
      const module = await import(`../session-manager.js?v=${++importCounter}`);
      return module.SessionManager.create({ ptyProvider: ptyFactory.provider, pathExists: pathExistsFn });
    }

    it('should return null when session path no longer exists', async () => {
      // First, create a session with a manager that says path exists
      const managerForCreate = await getSessionManager();

      const session = await managerForCreate.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      // Simulate server restart and path no longer exists
      mockProcess.markDead(process.pid);

      // Create a new manager where path validation will fail
      const mockPathNotExists = async (_path: string): Promise<boolean> => false;
      const managerAfterRestart = await getSessionManagerWithPathExists(mockPathNotExists);

      // PTY count before restore attempt
      const ptyCountBefore = ptyFactory.instances.length;

      // Restore should return null because path no longer exists
      const restored = await managerAfterRestart.restoreWorker(session.id, workerId);

      expect(restored).toBeNull();

      // No new PTY should be created
      expect(ptyFactory.instances.length).toBe(ptyCountBefore);
    });

    it('should not create PTY when path validation fails for terminal worker', async () => {
      // First, create a session with terminal worker
      const managerForCreate = await getSessionManager();

      const session = await managerForCreate.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const terminalWorker = await managerForCreate.createWorker(session.id, {
        type: 'terminal',
        name: 'Shell',
      });
      const terminalWorkerId = terminalWorker!.id;

      // Simulate server restart and path no longer exists
      mockProcess.markDead(process.pid);

      const mockPathNotExists = async (_path: string): Promise<boolean> => false;
      const managerAfterRestart = await getSessionManagerWithPathExists(mockPathNotExists);

      // PTY count before restore attempt
      const ptyCountBefore = ptyFactory.instances.length;

      // Restore should return null because path no longer exists
      const restored = await managerAfterRestart.restoreWorker(session.id, terminalWorkerId);

      expect(restored).toBeNull();

      // No new PTY should be created
      expect(ptyFactory.instances.length).toBe(ptyCountBefore);
    });

    it('should successfully restore worker when path still exists', async () => {
      // Create a session
      const managerForCreate = await getSessionManager();

      const session = await managerForCreate.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const agentWorker = session.workers.find((w: Worker) => w.type === 'agent')!;
      const workerId = agentWorker.id;

      // Simulate server restart but path still exists
      mockProcess.markDead(process.pid);

      // Create a new manager where path validation succeeds
      const mockPathStillExists = async (_path: string): Promise<boolean> => true;
      const managerAfterRestart = await getSessionManagerWithPathExists(mockPathStillExists);

      // PTY count before restore
      const ptyCountBefore = ptyFactory.instances.length;

      // Restore should succeed
      const restored = await managerAfterRestart.restoreWorker(session.id, workerId);

      expect(restored).not.toBeNull();
      expect(restored?.id).toBe(workerId);

      // New PTY should be created (since internal worker had no PTY after restart)
      expect(ptyFactory.instances.length).toBe(ptyCountBefore + 1);
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
