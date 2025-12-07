import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PersistedSession } from '../persistence-service.js';
import { MockPty, createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';

// Create mock PTY factory
const ptyFactory = createMockPtyFactory(10000);

// Mock data storage
let mockPersistedSessions: PersistedSession[] = [];

// Mock node-pty
vi.mock('node-pty', () => ptyFactory.createMock());

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
    it('should create a new session with correct properties', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const onData = vi.fn();
      const onExit = vi.fn();

      const session = manager.createSession('/test/path', 'repo-1', onData, onExit);

      expect(session.id).toBeDefined();
      expect(session.worktreePath).toBe('/test/path');
      expect(session.repositoryId).toBe('repo-1');
      expect(session.status).toBe('running');
      expect(session.activityState).toBe('idle');
      expect(session.pid).toBeDefined();
      expect(session.agentId).toBe('claude-code');
    });

    it('should persist session to storage', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const { persistenceService } = await import('../persistence-service.js');
      const manager = new SessionManager();

      manager.createSession('/test/path', 'repo-1', vi.fn(), vi.fn());

      expect(vi.mocked(persistenceService.saveSessions)).toHaveBeenCalled();
      expect(mockPersistedSessions.length).toBe(1);
      expect(mockPersistedSessions[0].worktreePath).toBe('/test/path');
      expect(mockPersistedSessions[0].serverPid).toBe(99999);
    });

    it('should call onData callback when PTY outputs data', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const onData = vi.fn();
      manager.createSession('/test/path', 'repo-1', onData, vi.fn());

      // Simulate PTY output
      const pty = ptyFactory.instances[0];
      pty.simulateData('Hello World');

      expect(onData).toHaveBeenCalledWith('Hello World');
    });

    it('should call onExit callback when PTY exits', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const onExit = vi.fn();
      manager.createSession('/test/path', 'repo-1', vi.fn(), onExit);

      // Simulate PTY exit
      const pty = ptyFactory.instances[0];
      pty.simulateExit(0);

      expect(onExit).toHaveBeenCalledWith(0, null);
    });

    it('should buffer output for reconnection', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const session = manager.createSession('/test/path', 'repo-1', vi.fn(), vi.fn());

      // Simulate PTY output
      const pty = ptyFactory.instances[0];
      pty.simulateData('Line 1\n');
      pty.simulateData('Line 2\n');

      const buffer = manager.getOutputBuffer(session.id);
      expect(buffer).toBe('Line 1\nLine 2\n');
    });

    it('should spawn PTY with continue args when continueConversation is true', async () => {
      const pty = await import('node-pty');
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      manager.createSession('/test/path', 'repo-1', vi.fn(), vi.fn(), true);

      expect(vi.mocked(pty.spawn)).toHaveBeenCalled();
      const callArgs = vi.mocked(pty.spawn).mock.calls[0];
      expect(callArgs[0]).toBe('claude');
      expect(callArgs[1]).toEqual(['-c']);
      expect(callArgs[2]).toMatchObject({ cwd: '/test/path' });
    });
  });

  describe('getSession', () => {
    it('should return session by id', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const created = manager.createSession('/test/path', 'repo-1', vi.fn(), vi.fn());
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

      manager.createSession('/path/1', 'repo-1', vi.fn(), vi.fn());
      manager.createSession('/path/2', 'repo-2', vi.fn(), vi.fn());

      const sessions = manager.getAllSessions();
      expect(sessions.length).toBe(2);
    });
  });

  describe('getSessionMetadata', () => {
    it('should return metadata from persistence service', async () => {
      mockPersistedSessions = [
        {
          id: 'test-session',
          worktreePath: '/test/path',
          repositoryId: 'repo-1',
          pid: 12345,
          serverPid: 99999,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ];

      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const metadata = manager.getSessionMetadata('test-session');
      expect(metadata).toBeDefined();
      expect(metadata?.worktreePath).toBe('/test/path');
    });
  });

  describe('restartSession', () => {
    it('should restart a dead session with same ID', async () => {
      mockPersistedSessions = [
        {
          id: 'dead-session',
          worktreePath: '/test/path',
          repositoryId: 'repo-1',
          pid: 12345,
          serverPid: 88888, // Different server - session is dead
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ];

      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const session = manager.restartSession('dead-session', vi.fn(), vi.fn());

      expect(session).not.toBeNull();
      expect(session?.id).toBe('dead-session');
      expect(session?.status).toBe('running');
    });

    it('should return null if session is already active', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const created = manager.createSession('/test/path', 'repo-1', vi.fn(), vi.fn());
      const restarted = manager.restartSession(created.id, vi.fn(), vi.fn());

      expect(restarted).toBeNull();
    });

    it('should return null if no metadata exists', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const session = manager.restartSession('non-existent', vi.fn(), vi.fn());
      expect(session).toBeNull();
    });

    it('should restart with continueConversation flag', async () => {
      mockPersistedSessions = [
        {
          id: 'dead-session',
          worktreePath: '/test/path',
          repositoryId: 'repo-1',
          pid: 12345,
          serverPid: 88888,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ];

      const pty = await import('node-pty');
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      manager.restartSession('dead-session', vi.fn(), vi.fn(), true); // continueConversation = true

      // Verify -c flag was passed
      const callArgs = vi.mocked(pty.spawn).mock.calls[0];
      expect(callArgs[1]).toEqual(['-c']);
    });
  });

  describe('writeInput', () => {
    it('should write input to PTY', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const session = manager.createSession('/test/path', 'repo-1', vi.fn(), vi.fn());
      const result = manager.writeInput(session.id, 'hello');

      expect(result).toBe(true);
      expect(ptyFactory.instances[0].writtenData).toContain('hello');
    });

    it('should return false for non-existent session', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const result = manager.writeInput('non-existent', 'hello');
      expect(result).toBe(false);
    });

    it('should handle Enter key (CR) as submit', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const session = manager.createSession('/test/path', 'repo-1', vi.fn(), vi.fn());
      manager.writeInput(session.id, '\r'); // Enter key

      expect(ptyFactory.instances[0].writtenData).toContain('\r');
    });

    it('should handle ESC key', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const session = manager.createSession('/test/path', 'repo-1', vi.fn(), vi.fn());
      manager.writeInput(session.id, '\x1b'); // ESC key

      expect(ptyFactory.instances[0].writtenData).toContain('\x1b');
    });

    it('should ignore focus in/out events for activity detection', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const session = manager.createSession('/test/path', 'repo-1', vi.fn(), vi.fn());

      // Focus in event
      manager.writeInput(session.id, '\x1b[I');
      // Focus out event
      manager.writeInput(session.id, '\x1b[O');

      expect(ptyFactory.instances[0].writtenData).toContain('\x1b[I');
      expect(ptyFactory.instances[0].writtenData).toContain('\x1b[O');
    });
  });

  describe('resize', () => {
    it('should resize PTY', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const session = manager.createSession('/test/path', 'repo-1', vi.fn(), vi.fn());
      const result = manager.resize(session.id, 80, 24);

      expect(result).toBe(true);
      expect(ptyFactory.instances[0].currentCols).toBe(80);
      expect(ptyFactory.instances[0].currentRows).toBe(24);
    });

    it('should return false for non-existent session', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const result = manager.resize('non-existent', 80, 24);
      expect(result).toBe(false);
    });
  });

  describe('killSession', () => {
    it('should kill session and remove from storage', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const { persistenceService } = await import('../persistence-service.js');
      const manager = new SessionManager();

      const session = manager.createSession('/test/path', 'repo-1', vi.fn(), vi.fn());
      const result = manager.killSession(session.id);

      expect(result).toBe(true);
      expect(ptyFactory.instances[0].killed).toBe(true);
      expect(manager.getSession(session.id)).toBeUndefined();
      expect(vi.mocked(persistenceService.removeSession)).toHaveBeenCalledWith(session.id);
    });

    it('should return false for non-existent session', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const result = manager.killSession('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('attachCallbacks / detachCallbacks', () => {
    it('should update callbacks on attach', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const session = manager.createSession('/test/path', 'repo-1', vi.fn(), vi.fn());

      const newOnData = vi.fn();
      const newOnExit = vi.fn();
      const result = manager.attachCallbacks(session.id, newOnData, newOnExit);

      expect(result).toBe(true);

      // Verify new callbacks are used
      ptyFactory.instances[0].simulateData('new data');
      expect(newOnData).toHaveBeenCalledWith('new data');
    });

    it('should detach callbacks', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const onData = vi.fn();
      const session = manager.createSession('/test/path', 'repo-1', onData, vi.fn());

      manager.detachCallbacks(session.id);

      // Data should not trigger original callback after detach
      onData.mockClear();
      ptyFactory.instances[0].simulateData('after detach');

      // Original callback should not be called
      expect(onData).not.toHaveBeenCalled();
    });

    it('should return false for non-existent session', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      expect(manager.attachCallbacks('non-existent', vi.fn(), vi.fn())).toBe(false);
      expect(manager.detachCallbacks('non-existent')).toBe(false);
    });
  });

  describe('getActivityState', () => {
    it('should return activity state', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const session = manager.createSession('/test/path', 'repo-1', vi.fn(), vi.fn());
      const state = manager.getActivityState(session.id);

      expect(state).toBe('idle');
    });

    it('should return undefined for non-existent session', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const state = manager.getActivityState('non-existent');
      expect(state).toBeUndefined();
    });
  });

  describe('setGlobalActivityCallback', () => {
    it('should call global callback on activity state change', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const globalCallback = vi.fn();
      manager.setGlobalActivityCallback(globalCallback);

      const session = manager.createSession('/test/path', 'repo-1', vi.fn(), vi.fn());

      // Generate enough output to trigger 'active' state
      const pty = ptyFactory.instances[0];
      for (let i = 0; i < 25; i++) {
        pty.simulateData('output\n');
      }

      // Global callback should have been called with 'active' state
      expect(globalCallback).toHaveBeenCalledWith(session.id, 'active');
    });
  });

  describe('getOutputBuffer', () => {
    it('should return empty string for non-existent session', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const buffer = manager.getOutputBuffer('non-existent');
      expect(buffer).toBe('');
    });

    it('should truncate buffer when exceeding max size', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const session = manager.createSession('/test/path', 'repo-1', vi.fn(), vi.fn());

      // Generate large output (> 100KB)
      const pty = ptyFactory.instances[0];
      const largeData = 'x'.repeat(60000);
      pty.simulateData(largeData);
      pty.simulateData(largeData);

      const buffer = manager.getOutputBuffer(session.id);
      expect(buffer.length).toBeLessThanOrEqual(100000);
    });
  });

  describe('edge cases', () => {
    it('should handle empty input string', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const session = manager.createSession('/test/path', 'repo-1', vi.fn(), vi.fn());

      // Empty string should still be written
      const result = manager.writeInput(session.id, '');
      expect(result).toBe(true);
    });

    it('should handle binary data in output', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const onData = vi.fn();
      const session = manager.createSession('/test/path', 'repo-1', onData, vi.fn());

      // Simulate binary-like output with null bytes
      const pty = ptyFactory.instances[0];
      const binaryLike = 'Hello\x00World\x1b[0m';
      pty.simulateData(binaryLike);

      expect(onData).toHaveBeenCalledWith(binaryLike);
      expect(manager.getOutputBuffer(session.id)).toBe(binaryLike);
    });

    it('should handle unicode output', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const onData = vi.fn();
      const session = manager.createSession('/test/path', 'repo-1', onData, vi.fn());

      const pty = ptyFactory.instances[0];
      const unicode = '日本語テスト 🎉 émoji';
      pty.simulateData(unicode);

      expect(onData).toHaveBeenCalledWith(unicode);
      expect(manager.getOutputBuffer(session.id)).toBe(unicode);
    });

    it('should handle rapid consecutive outputs', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const onData = vi.fn();
      const session = manager.createSession('/test/path', 'repo-1', onData, vi.fn());

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

      const session = manager.createSession('/path/with spaces/project', 'repo-1', vi.fn(), vi.fn());

      expect(session.worktreePath).toBe('/path/with spaces/project');
    });
  });

  describe('error recovery', () => {
    it('should propagate callback errors (caller is responsible for error handling)', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const throwingCallback = vi.fn(() => {
        throw new Error('Callback error');
      });

      const session = manager.createSession('/test/path', 'repo-1', throwingCallback, vi.fn());

      // Callback errors propagate - this documents the expected behavior
      // Callers (e.g., WebSocket handlers) should wrap callbacks with try-catch
      expect(() => {
        ptyFactory.instances[0].simulateData('test');
      }).toThrow('Callback error');
    });

    it('should mark session as stopped on PTY exit', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const onExit = vi.fn();
      const session = manager.createSession('/test/path', 'repo-1', vi.fn(), onExit);

      // Simulate PTY crash with non-zero exit (signal 9 = SIGKILL)
      ptyFactory.instances[0].simulateExit(1, 9);

      expect(onExit).toHaveBeenCalledWith(1, '9');
    });

    it('should handle killing already exited session gracefully', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      const session = manager.createSession('/test/path', 'repo-1', vi.fn(), vi.fn());

      // Simulate PTY exit
      ptyFactory.instances[0].simulateExit(0);

      // Killing already exited session should still return true (session exists in map until killed)
      const result = manager.killSession(session.id);
      expect(result).toBe(true);
    });

    it('should continue operating after one session crashes', async () => {
      const { SessionManager } = await import('../session-manager.js');
      const manager = new SessionManager();

      // Create two sessions
      const session1 = manager.createSession('/path/1', 'repo-1', vi.fn(), vi.fn());
      const session2 = manager.createSession('/path/2', 'repo-1', vi.fn(), vi.fn());

      // First session crashes (signal 11 = SIGSEGV)
      ptyFactory.instances[0].simulateExit(1, 11);

      // Second session should still work
      expect(manager.getSession(session2.id)).toBeDefined();
      expect(manager.writeInput(session2.id, 'test')).toBe(true);
    });
  });
});
