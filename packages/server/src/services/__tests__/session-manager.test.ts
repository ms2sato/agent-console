import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PersistedSession } from '../persistence-service.js';
import type { CreateSessionRequest, CreateWorkerRequest } from '@agent-console/shared';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';

// Create mock PTY factory
const ptyFactory = createMockPtyFactory(10000);

// Mock data storage
let mockPersistedSessions: PersistedSession[] = [];

// Mock bun-pty
vi.mock('bun-pty', () => ptyFactory.createMock());

// Mock persistence service
vi.mock('../persistence-service.js', () => ({
  persistenceService: {
    loadSessions: vi.fn(() => mockPersistedSessions),
    saveSessions: vi.fn((sessions: PersistedSession[]) => {
      mockPersistedSessions = sessions;
    }),
    getSessionMetadata: vi.fn((id: string) => mockPersistedSessions.find(s => s.id === id)),
    removeSession: vi.fn((id: string) => {
      mockPersistedSessions = mockPersistedSessions.filter(s => s.id !== id);
    }),
    loadAgents: vi.fn(() => []),
    saveAgents: vi.fn(),
    getAgent: vi.fn(),
    removeAgent: vi.fn(),
    loadRepositories: vi.fn(() => []),
    saveRepositories: vi.fn(),
  },
}));

// Mock agent manager
vi.mock('../agent-manager.js', () => ({
  agentManager: {
    getAgent: vi.fn(() => ({
      id: 'claude-code',
      name: 'Claude Code',
      command: 'claude',
      isBuiltIn: true,
      continueArgs: ['-c'],
    })),
    getDefaultAgent: vi.fn(() => ({
      id: 'claude-code',
      name: 'Claude Code',
      command: 'claude',
      isBuiltIn: true,
      continueArgs: ['-c'],
    })),
  },
  CLAUDE_CODE_AGENT_ID: 'claude-code',
}));

// Mock config
vi.mock('../../lib/config.js', () => ({
  getServerPid: vi.fn(() => 99999),
}));

// Mock env filter
vi.mock('../env-filter.js', () => ({
  getChildProcessEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
}));

describe('SessionManager', () => {
  beforeEach(() => {
    vi.resetModules();
    mockPersistedSessions = [];
    ptyFactory.reset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createSession', () => {
    it('should create a new worktree session with correct properties', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

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
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

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
      const { SessionManager } = await import('../session-manager.js');
      const { persistenceService } = await import('../persistence-service.js');
      const manager = new SessionManager();

      const request: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      manager.createSession(request);

      expect(vi.mocked(persistenceService.saveSessions)).toHaveBeenCalled();
      expect(mockPersistedSessions.length).toBe(1);
      expect(mockPersistedSessions[0].locationPath).toBe('/test/path');
      expect(mockPersistedSessions[0].serverPid).toBe(99999);
    });

    it('should call onData callback when PTY outputs data', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const onData = vi.fn();
      const request: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      const session = manager.createSession(request);
      const workerId = session.workers[0].id;
      manager.attachWorkerCallbacks(session.id, workerId, {
        onData,
        onExit: vi.fn(),
      });

      // Simulate PTY output
      const pty = ptyFactory.instances[0];
      pty.simulateData('Hello World');

      expect(onData).toHaveBeenCalledWith('Hello World');
    });

    it('should call onExit callback when PTY exits', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const onExit = vi.fn();
      const request: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      const session = manager.createSession(request);
      const workerId = session.workers[0].id;
      manager.attachWorkerCallbacks(session.id, workerId, {
        onData: vi.fn(),
        onExit,
      });

      // Simulate PTY exit
      const pty = ptyFactory.instances[0];
      pty.simulateExit(0);

      expect(onExit).toHaveBeenCalledWith(0, null);
    });

    it('should buffer output for reconnection', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

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
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const sessionRequest: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      const session = manager.createSession(sessionRequest);

      const workerRequest: CreateWorkerRequest = {
        type: 'terminal',
        name: 'Shell',
      };

      const worker = manager.createWorker(session.id, workerRequest);

      expect(worker).not.toBeNull();
      expect(worker?.type).toBe('terminal');
      expect(worker?.name).toBe('Shell');
    });

    it('should return null for non-existent session', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const workerRequest: CreateWorkerRequest = {
        type: 'terminal',
        name: 'Shell',
      };

      const worker = manager.createWorker('non-existent', workerRequest);
      expect(worker).toBeNull();
    });
  });

  describe('deleteWorker', () => {
    it('should delete a worker from session', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

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
      expect(updatedSession?.workers.find(w => w.id === workerId)).toBeUndefined();
    });

    it('should return false for non-existent worker', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

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
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

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
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const session = manager.getSession('non-existent');
      expect(session).toBeUndefined();
    });
  });

  describe('getAllSessions', () => {
    it('should return empty array when no sessions', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const sessions = manager.getAllSessions();
      expect(sessions).toEqual([]);
    });

    it('should return all sessions', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      manager.createSession({ type: 'quick', locationPath: '/path/1', agentId: 'claude-code' });
      manager.createSession({ type: 'quick', locationPath: '/path/2', agentId: 'claude-code' });

      const sessions = manager.getAllSessions();
      expect(sessions.length).toBe(2);
    });
  });

  describe('writeWorkerInput', () => {
    it('should write input to PTY', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

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
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const result = manager.writeWorkerInput('non-existent', 'worker-1', 'hello');
      expect(result).toBe(false);
    });
  });

  describe('resizeWorker', () => {
    it('should resize PTY', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

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
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const result = manager.resizeWorker('non-existent', 'worker-1', 80, 24);
      expect(result).toBe(false);
    });
  });

  describe('deleteSession', () => {
    it('should delete session and remove from storage', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const { persistenceService } = await import('../persistence-service.js');
      const manager = new SessionManager();

      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });

      const result = manager.deleteSession(session.id);

      expect(result).toBe(true);
      expect(ptyFactory.instances[0].killed).toBe(true);
      expect(manager.getSession(session.id)).toBeUndefined();
      expect(vi.mocked(persistenceService.removeSession)).toHaveBeenCalledWith(session.id);
    });

    it('should return false for non-existent session', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const result = manager.deleteSession('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('attachWorkerCallbacks / detachWorkerCallbacks', () => {
    it('should update callbacks on attach', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;

      const newOnData = vi.fn();
      const newOnExit = vi.fn();
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
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const onData = vi.fn();
      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;

      manager.attachWorkerCallbacks(session.id, workerId, {
        onData,
        onExit: vi.fn(),
      });

      manager.detachWorkerCallbacks(session.id, workerId);

      // Data should not trigger original callback after detach
      onData.mockClear();
      ptyFactory.instances[0].simulateData('after detach');

      // Original callback should not be called
      expect(onData).not.toHaveBeenCalled();
    });

    it('should return false for non-existent session', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      expect(manager.attachWorkerCallbacks('non-existent', 'worker-1', {
        onData: vi.fn(),
        onExit: vi.fn(),
      })).toBe(false);
      expect(manager.detachWorkerCallbacks('non-existent', 'worker-1')).toBe(false);
    });
  });

  describe('getWorkerActivityState', () => {
    it('should return activity state', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

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
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const state = manager.getWorkerActivityState('non-existent', 'worker-1');
      expect(state).toBeUndefined();
    });
  });

  describe('setGlobalActivityCallback', () => {
    it('should call global callback on activity state change', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const globalCallback = vi.fn();
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
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const buffer = manager.getWorkerOutputBuffer('non-existent', 'worker-1');
      expect(buffer).toBe('');
    });

    it('should truncate buffer when exceeding max size', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

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
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

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
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const onData = vi.fn();
      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;
      manager.attachWorkerCallbacks(session.id, workerId, {
        onData,
        onExit: vi.fn(),
      });

      // Simulate binary-like output with null bytes
      const pty = ptyFactory.instances[0];
      const binaryLike = 'Hello\x00World\x1b[0m';
      pty.simulateData(binaryLike);

      expect(onData).toHaveBeenCalledWith(binaryLike);
      expect(manager.getWorkerOutputBuffer(session.id, workerId)).toBe(binaryLike);
    });

    it('should handle unicode output', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const onData = vi.fn();
      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;
      manager.attachWorkerCallbacks(session.id, workerId, {
        onData,
        onExit: vi.fn(),
      });

      const pty = ptyFactory.instances[0];
      const unicode = '日本語テスト 🎉 émoji';
      pty.simulateData(unicode);

      expect(onData).toHaveBeenCalledWith(unicode);
      expect(manager.getWorkerOutputBuffer(session.id, workerId)).toBe(unicode);
    });

    it('should handle rapid consecutive outputs', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const onData = vi.fn();
      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;
      manager.attachWorkerCallbacks(session.id, workerId, {
        onData,
        onExit: vi.fn(),
      });

      const pty = ptyFactory.instances[0];

      // Rapid fire outputs
      for (let i = 0; i < 100; i++) {
        pty.simulateData(`line ${i}\n`);
      }

      expect(onData).toHaveBeenCalledTimes(100);
    });

    it('should handle session creation with path containing spaces', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

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
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const throwingCallback = vi.fn(() => {
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
        onExit: vi.fn(),
      });

      // Callback errors propagate - this documents the expected behavior
      // Callers (e.g., WebSocket handlers) should wrap callbacks with try-catch
      expect(() => {
        ptyFactory.instances[0].simulateData('test');
      }).toThrow('Callback error');
    });

    it('should mark worker as stopped on PTY exit', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const onExit = vi.fn();
      const session = manager.createSession({
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      });
      const workerId = session.workers[0].id;
      manager.attachWorkerCallbacks(session.id, workerId, {
        onData: vi.fn(),
        onExit,
      });

      // Simulate PTY crash with non-zero exit (signal 9 = SIGKILL)
      ptyFactory.instances[0].simulateExit(1, 9);

      expect(onExit).toHaveBeenCalledWith(1, '9');
    });

    it('should continue operating after one session crashes', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

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
