import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'fs';
import type { CreateSessionRequest, CreateWorkerParams, Worker } from '@agent-console/shared';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';

// Test config directory
const TEST_CONFIG_DIR = '/test/config';

// Create mock PTY factory (will be reset in beforeEach)
const ptyFactory = createMockPtyFactory(10000);

let importCounter = 0;

describe('SessionManager', () => {
  beforeEach(() => {
    // Setup memfs with config directory structure
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
      [`${TEST_CONFIG_DIR}/agents.json`]: JSON.stringify([]),
      [`${TEST_CONFIG_DIR}/sessions.json`]: JSON.stringify([]),
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    // Reset PTY factory
    ptyFactory.reset();
  });

  afterEach(() => {
    cleanupMemfs();
  });

  // Helper to get fresh module instance with DI
  async function getSessionManager() {
    const module = await import(`../session-manager.js?v=${++importCounter}`);
    return new module.SessionManager(ptyFactory.provider);
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

      const session = manager.createSession(request);

      expect(session.id).toBeDefined();
      expect(session.type).toBe('worktree');
      expect(session.locationPath).toBe('/test/path');
      if (session.type === 'worktree') {
        expect(session.repositoryId).toBe('repo-1');
        expect(session.worktreeId).toBe('main');
      }
      expect(session.status).toBe('active');
      expect(session.workers.length).toBe(1);
      expect(session.workers[0].type).toBe('agent');
    });

    it('should create a new quick session with correct properties', async () => {
      const manager = await getSessionManager();

      const request: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      const session = manager.createSession(request);

      expect(session.id).toBeDefined();
      expect(session.type).toBe('quick');
      expect(session.locationPath).toBe('/test/path');
      expect(session.status).toBe('active');
      expect(session.workers.length).toBe(1);
    });

    it('should persist session to storage', async () => {
      const manager = await getSessionManager();

      const request: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      manager.createSession(request);

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

      const session = manager.createSession(request);
      const workerId = session.workers[0].id;
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

      const session = manager.createSession(request);
      const workerId = session.workers[0].id;
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

      const session = manager.createSession(request);
      const workerId = session.workers[0].id;

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

      const session = manager.createSession(sessionRequest);

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

      const session = manager.createSession(sessionRequest);
      const workerId = session.workers[0].id;

      const result = manager.deleteWorker(session.id, workerId);

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

      const session = manager.createSession(sessionRequest);
      const result = manager.deleteWorker(session.id, 'non-existent');
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

      const created = manager.createSession(request);
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

      manager.createSession({ type: 'quick', locationPath: '/path/1', agentId: 'claude-code' });
      manager.createSession({ type: 'quick', locationPath: '/path/2', agentId: 'claude-code' });

      const sessions = manager.getAllSessions();
      expect(sessions.length).toBe(2);
    });
  });

  describe('writeWorkerInput', () => {
    it('should write input to PTY', async () => {
      const manager = await getSessionManager();

      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;

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

      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;

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

      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const result = manager.deleteSession(session.id);

      expect(result).toBe(true);
      expect(ptyFactory.instances[0].killed).toBe(true);
      expect(manager.getSession(session.id)).toBeUndefined();

      // Check session was removed from persistence
      const savedData = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
      expect(savedData.length).toBe(0);
    });

    it('should return false for non-existent session', async () => {
      const manager = await getSessionManager();

      const result = manager.deleteSession('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('attachWorkerCallbacks / detachWorkerCallbacks', () => {
    it('should update callbacks on attach', async () => {
      const manager = await getSessionManager();

      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;

      const newOnData = mock(() => {});
      const newOnExit = mock(() => {});
      const result = manager.attachWorkerCallbacks(session.id, workerId, {
        onData: newOnData,
        onExit: newOnExit,
      });

      expect(result).toBe(true);

      // Verify new callbacks are used
      ptyFactory.instances[0].simulateData('new data');
      expect(newOnData).toHaveBeenCalledWith('new data');
    });

    it('should detach callbacks', async () => {
      const manager = await getSessionManager();

      const onData = mock(() => {});
      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;

      manager.attachWorkerCallbacks(session.id, workerId, {
        onData,
        onExit: mock(() => {}),
      });

      manager.detachWorkerCallbacks(session.id, workerId);

      // Data should not trigger original callback after detach
      onData.mockClear();
      ptyFactory.instances[0].simulateData('after detach');

      // Original callback should not be called
      expect(onData).not.toHaveBeenCalled();
    });

    it('should return false for non-existent session', async () => {
      const manager = await getSessionManager();

      expect(manager.attachWorkerCallbacks('non-existent', 'worker-1', {
        onData: mock(() => {}),
        onExit: mock(() => {}),
      })).toBe(false);
      expect(manager.detachWorkerCallbacks('non-existent', 'worker-1')).toBe(false);
    });
  });

  describe('getWorkerActivityState', () => {
    it('should return activity state', async () => {
      const manager = await getSessionManager();

      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;

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

      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;

      // Generate enough output to trigger 'active' state
      const pty = ptyFactory.instances[0];
      for (let i = 0; i < 25; i++) {
        pty.simulateData('output\n');
      }

      // Global callback should have been called with 'active' state
      expect(globalCallback).toHaveBeenCalledWith(session.id, workerId, 'active');
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

      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;

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

      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;

      // Empty string should still be written
      const result = manager.writeWorkerInput(session.id, workerId, '');
      expect(result).toBe(true);
    });

    it('should handle binary data in output', async () => {
      const manager = await getSessionManager();

      const onData = mock(() => {});
      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;
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
      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;
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
      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;
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

      const session = manager.createSession({
        type: 'quick',
        locationPath: '/path/with spaces/project',
        agentId: 'claude-code',
      });

      expect(session.locationPath).toBe('/path/with spaces/project');
    });
  });

  describe('error recovery', () => {
    it('should propagate callback errors (caller is responsible for error handling)', async () => {
      const manager = await getSessionManager();

      const throwingCallback = mock(() => {
        throw new Error('Callback error');
      });

      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;
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
      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;
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
      manager.createSession({ type: 'quick', locationPath: '/path/1', agentId: 'claude-code' });
      const session2 = manager.createSession({ type: 'quick', locationPath: '/path/2', agentId: 'claude-code' });
      const workerId2 = session2.workers[0].id;

      // First session crashes (signal 11 = SIGSEGV)
      ptyFactory.instances[0].simulateExit(1, 11);

      // Second session should still work
      expect(manager.getSession(session2.id)).toBeDefined();
      expect(manager.writeWorkerInput(session2.id, workerId2, 'test')).toBe(true);
    });
  });
});
