import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PersistedSession } from '../persistence-service.js';

// Track which PIDs were killed
const killedPids: number[] = [];
const alivePids = new Set<number>();

// Mock persistence service
vi.mock('../persistence-service.js', () => ({
  persistenceService: {
    loadSessions: vi.fn(() => []),
    saveSessions: vi.fn(),
    removeSession: vi.fn(),
    getSessionMetadata: vi.fn(),
    clearSessions: vi.fn(),
    loadRepositories: vi.fn(() => []),
    saveRepositories: vi.fn(),
    loadAgents: vi.fn(() => []),
    saveAgents: vi.fn(),
    getAgent: vi.fn(),
    removeAgent: vi.fn(),
  },
}));

// Mock bun-pty to prevent actual PTY spawning
vi.mock('bun-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 99999,
    onData: vi.fn(() => ({ dispose: () => {} })),
    onExit: vi.fn(() => ({ dispose: () => {} })),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

// Mock agent-manager
vi.mock('./agent-manager.js', () => ({
  agentManager: {
    getAgent: vi.fn(() => ({
      id: 'claude-code',
      name: 'Claude Code',
      command: 'claude',
      isBuiltIn: true,
    })),
    getDefaultAgent: vi.fn(() => ({
      id: 'claude-code',
      name: 'Claude Code',
      command: 'claude',
      isBuiltIn: true,
    })),
  },
  CLAUDE_CODE_AGENT_ID: 'claude-code',
}));

// Mock config
vi.mock('../lib/config.js', () => ({
  getServerPid: vi.fn(() => 12345),
  getConfigDir: vi.fn(() => '/tmp/test-config'),
}));

// Mock process.kill to track kills and simulate process existence
const originalProcessKill = process.kill;
beforeEach(() => {
  // Reset modules FIRST to ensure fresh imports
  vi.resetModules();

  killedPids.length = 0;
  alivePids.clear();

  // @ts-expect-error - mocking process.kill
  process.kill = vi.fn((pid: number, signal?: string | number) => {
    if (signal === 0) {
      // Check if process exists
      if (!alivePids.has(pid)) {
        const error = new Error('Process does not exist');
        (error as NodeJS.ErrnoException).code = 'ESRCH';
        throw error;
      }
      return true;
    }
    // Actual kill
    killedPids.push(pid);
    return true;
  });
});

afterEach(() => {
  process.kill = originalProcessKill;
});

describe('SessionManager cleanup on initialization', () => {
  // Note: session-manager.ts exports a singleton `sessionManager` which is created
  // when the module is imported. The cleanup runs in the constructor, so we test
  // by setting up mocks BEFORE importing the module.

  it('should skip sessions without serverPid (legacy sessions)', async () => {
    const { persistenceService } = await import('../persistence-service.js');

    const legacySession: PersistedSession = {
      id: 'legacy-session',
      type: 'quick',
      locationPath: '/path/to/worktree',
      workers: [
        {
          id: 'worker-1',
          type: 'agent',
          name: 'Claude',
          agentId: 'claude-code',
          pid: 11111,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ],
      serverPid: undefined as unknown as number,
      createdAt: '2024-01-01T00:00:00.000Z',
    };
    vi.mocked(persistenceService.loadSessions).mockReturnValue([legacySession]);

    // Mark the session process as alive
    alivePids.add(11111);

    // Import session-manager - singleton is created and cleanup runs
    await import('../session-manager.js');

    // Legacy session should NOT be killed
    expect(killedPids).not.toContain(11111);
  });

  it('should preserve sessions when parent server is still alive', async () => {
    const { persistenceService } = await import('../persistence-service.js');

    const activeSession: PersistedSession = {
      id: 'active-session',
      type: 'worktree',
      locationPath: '/path/to/worktree',
      repositoryId: 'repo-1',
      worktreeId: 'main',
      workers: [
        {
          id: 'worker-1',
          type: 'agent',
          name: 'Claude',
          agentId: 'claude-code',
          pid: 22222,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ],
      serverPid: 33333, // Parent server PID
      createdAt: '2024-01-01T00:00:00.000Z',
    };
    vi.mocked(persistenceService.loadSessions).mockReturnValue([activeSession]);

    // Mark both session process and parent server as alive
    alivePids.add(22222);
    alivePids.add(33333);

    await import('../session-manager.js');

    // Session should NOT be killed because parent server is alive
    expect(killedPids).not.toContain(22222);
  });

  it('should kill sessions when parent server is dead', async () => {
    const { persistenceService } = await import('../persistence-service.js');

    const orphanSession: PersistedSession = {
      id: 'orphan-session',
      type: 'quick',
      locationPath: '/path/to/worktree',
      workers: [
        {
          id: 'worker-1',
          type: 'agent',
          name: 'Claude',
          agentId: 'claude-code',
          pid: 44444,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ],
      serverPid: 55555, // Dead parent server
      createdAt: '2024-01-01T00:00:00.000Z',
    };
    vi.mocked(persistenceService.loadSessions).mockReturnValue([orphanSession]);

    // Mark session process as alive, but parent server as dead
    alivePids.add(44444);
    // Note: 55555 is NOT in alivePids, so it's dead

    await import('../session-manager.js');

    // Orphan session should be killed
    expect(killedPids).toContain(44444);
  });

  it('should handle mixed sessions correctly', async () => {
    const { persistenceService } = await import('../persistence-service.js');

    const sessions: PersistedSession[] = [
      {
        id: 'legacy-session',
        type: 'quick',
        locationPath: '/path/1',
        workers: [
          {
            id: 'worker-1',
            type: 'agent',
            name: 'Claude',
            agentId: 'claude-code',
            pid: 10001,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        serverPid: undefined as unknown as number,
        createdAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'active-session',
        type: 'worktree',
        locationPath: '/path/2',
        repositoryId: 'repo-1',
        worktreeId: 'main',
        workers: [
          {
            id: 'worker-2',
            type: 'agent',
            name: 'Claude',
            agentId: 'claude-code',
            pid: 10002,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        serverPid: 20001, // Alive server
        createdAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'orphan-session',
        type: 'quick',
        locationPath: '/path/3',
        workers: [
          {
            id: 'worker-3',
            type: 'agent',
            name: 'Claude',
            agentId: 'claude-code',
            pid: 10003,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        serverPid: 20002, // Dead server
        createdAt: '2024-01-01T00:00:00.000Z',
      },
    ];
    vi.mocked(persistenceService.loadSessions).mockReturnValue(sessions);

    // Set up process states
    alivePids.add(10001); // Legacy session process
    alivePids.add(10002); // Active session process
    alivePids.add(10003); // Orphan session process
    alivePids.add(20001); // Alive parent server
    // 20002 is dead (not in alivePids)

    await import('../session-manager.js');

    // Only orphan session should be killed
    expect(killedPids).toContain(10003);
    expect(killedPids).not.toContain(10001);
    expect(killedPids).not.toContain(10002);
  });

  it('should handle empty sessions list', async () => {
    const { persistenceService } = await import('../persistence-service.js');
    vi.mocked(persistenceService.loadSessions).mockReturnValue([]);

    await import('../session-manager.js');

    // No processes should be killed
    expect(killedPids.length).toBe(0);
  });
});
