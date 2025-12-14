import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'fs';
import type { PersistedSession } from '../persistence-service.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';

// Test config directory
const TEST_CONFIG_DIR = '/test/config';

// Track process states for mocking
let killedPids: number[] = [];
const alivePids = new Set<number>();

// Mock process-utils module
mock.module('../../lib/process-utils.js', () => ({
  processKill: (pid: number) => {
    killedPids.push(pid);
    return true;
  },
  isProcessAlive: (pid: number) => alivePids.has(pid),
}));

// Helper to check if a PID was killed
function isKilled(pid: number): boolean {
  return killedPids.includes(pid);
}

// Helper to mark a PID as alive
function markPidAlive(pid: number): void {
  alivePids.add(pid);
}

// Import counter for cache busting
let importCounter = 0;

// Shared mock PTY factory for the test module
let ptyFactory: ReturnType<typeof createMockPtyFactory>;

describe('SessionManager cleanup on initialization', () => {
  beforeEach(() => {
    // Setup memfs with config directory structure
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    // Reset tracking
    killedPids = [];
    alivePids.clear();

    // Create fresh PTY factory
    ptyFactory = createMockPtyFactory();
  });

  afterEach(() => {
    cleanupMemfs();
    delete process.env.AGENT_CONSOLE_HOME;
  });

  // Helper to persist sessions to memfs
  function persistSessions(sessions: PersistedSession[]): void {
    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(`${TEST_CONFIG_DIR}/sessions.json`, JSON.stringify(sessions));
  }

  // Helper to persist agents config
  function persistAgents(): void {
    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(`${TEST_CONFIG_DIR}/agents.json`, JSON.stringify([]));
  }

  // Helper to get fresh SessionManager class
  async function getSessionManager() {
    const module = await import(`../session-manager.js?v=${++importCounter}`);
    return module.SessionManager;
  }

  it('should skip sessions without serverPid (legacy sessions)', async () => {
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
    persistSessions([legacySession]);
    persistAgents();

    // Mark the session process as alive
    markPidAlive(11111);

    // Create SessionManager - cleanup runs in constructor
    const SessionManager = await getSessionManager();
    new SessionManager(ptyFactory.provider);

    // Legacy session should NOT be killed
    expect(isKilled(11111)).toBe(false);
  });

  it('should preserve sessions when parent server is still alive', async () => {
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
    persistSessions([activeSession]);
    persistAgents();

    // Mark both session process and parent server as alive
    markPidAlive(22222);
    markPidAlive(33333);

    const SessionManager = await getSessionManager();
    new SessionManager(ptyFactory.provider);

    // Session should NOT be killed because parent server is alive
    expect(isKilled(22222)).toBe(false);
  });

  it('should kill sessions when parent server is dead and remove from persistence', async () => {
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
    persistSessions([orphanSession]);
    persistAgents();

    // Mark session process as alive, but parent server as dead
    markPidAlive(44444);
    // Note: 55555 is NOT in alivePids, so it's dead

    const SessionManager = await getSessionManager();
    new SessionManager(ptyFactory.provider);

    // Orphan session should be killed
    expect(isKilled(44444)).toBe(true);

    // Orphan session should be removed from persistence
    const savedData = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
    expect(savedData.find((s: PersistedSession) => s.id === 'orphan-session')).toBeUndefined();
  });

  it('should handle mixed sessions correctly', async () => {
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
    persistSessions(sessions);
    persistAgents();

    // Set up process states
    markPidAlive(10001); // Legacy session process
    markPidAlive(10002); // Active session process
    markPidAlive(10003); // Orphan session process
    markPidAlive(20001); // Alive parent server
    // 20002 is dead (not in alivePids)

    const SessionManager = await getSessionManager();
    new SessionManager(ptyFactory.provider);

    // Only orphan session should be killed
    expect(isKilled(10003)).toBe(true);
    expect(isKilled(10001)).toBe(false);
    expect(isKilled(10002)).toBe(false);

    // Only orphan session should be removed from persistence
    const savedData = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
    expect(savedData.find((s: PersistedSession) => s.id === 'legacy-session')).toBeDefined();
    expect(savedData.find((s: PersistedSession) => s.id === 'active-session')).toBeDefined();
    expect(savedData.find((s: PersistedSession) => s.id === 'orphan-session')).toBeUndefined();
  });

  it('should handle empty sessions list', async () => {
    persistSessions([]);
    persistAgents();

    const SessionManager = await getSessionManager();
    new SessionManager(ptyFactory.provider);

    // No processes should be killed
    expect(killedPids.length).toBe(0);
  });
});
