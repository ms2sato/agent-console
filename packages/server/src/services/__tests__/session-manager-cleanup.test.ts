import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import type { PersistedSession } from '../persistence-service.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { initializeDatabase, closeDatabase } from '../../database/connection.js';

// Test config directory
const TEST_CONFIG_DIR = '/test/config';

// Import counter for cache busting
let importCounter = 0;

// Shared mock PTY factory for the test module
let ptyFactory: ReturnType<typeof createMockPtyFactory>;

describe('SessionManager cleanup on initialization', () => {
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

    // Reset process mock tracking
    resetProcessMock();

    // Create fresh PTY factory
    ptyFactory = createMockPtyFactory();
  });

  afterEach(async () => {
    await closeDatabase();
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

  // Helper to get fresh SessionManager class and create an instance using the factory pattern
  async function getSessionManager() {
    const module = await import(`../session-manager.js?v=${++importCounter}`);
    return module.SessionManager;
  }

  // Helper to create a SessionManager instance using the factory pattern (async initialization)
  async function createSessionManager() {
    const SessionManager = await getSessionManager();
    return SessionManager.create({ ptyProvider: ptyFactory.provider });
  }

  it('should inherit sessions without serverPid (legacy sessions) and kill worker processes', async () => {
    // Create the location path that the session references
    fs.mkdirSync('/path/to/worktree', { recursive: true });

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
    mockProcess.markAlive(11111);

    // Create SessionManager - cleanup runs during async initialization
    await createSessionManager();

    // Legacy session worker should be killed (session is inherited)
    expect(mockProcess.wasKilled(11111)).toBe(true);

    // Session should be inherited with updated serverPid
    const savedData = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
    const inheritedSession = savedData.find((s: PersistedSession) => s.id === 'legacy-session');
    expect(inheritedSession).toBeDefined();
    expect(inheritedSession.serverPid).toBe(process.pid);
  });

  it('should preserve sessions when parent server is still alive', async () => {
    // Create the location path that the session references
    fs.mkdirSync('/path/to/worktree', { recursive: true });

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
    mockProcess.markAlive(22222);
    mockProcess.markAlive(33333);

    await createSessionManager();

    // Session should NOT be killed because parent server is alive
    expect(mockProcess.wasKilled(22222)).toBe(false);
  });

  it('should kill orphan worker processes and inherit session when parent server is dead', async () => {
    // Create the location path that the session references
    fs.mkdirSync('/path/to/worktree', { recursive: true });

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
    mockProcess.markAlive(44444);
    // Note: 55555 is NOT marked alive, so it's dead

    await createSessionManager();

    // Orphan worker process should be killed
    expect(mockProcess.wasKilled(44444)).toBe(true);

    // Session should be inherited (not removed), with serverPid updated to current server
    const savedData = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
    const inheritedSession = savedData.find((s: PersistedSession) => s.id === 'orphan-session');
    expect(inheritedSession).toBeDefined();
    expect(inheritedSession.serverPid).toBe(process.pid); // Updated to current server PID
  });

  it('should handle mixed sessions correctly', async () => {
    // Create the location paths that the sessions reference
    fs.mkdirSync('/path/1', { recursive: true });
    fs.mkdirSync('/path/2', { recursive: true });
    fs.mkdirSync('/path/3', { recursive: true });

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
    mockProcess.markAlive(10001); // Legacy session process
    mockProcess.markAlive(10002); // Active session process
    mockProcess.markAlive(10003); // Orphan session process
    mockProcess.markAlive(20001); // Alive parent server
    // 20002 is dead (not marked alive)

    await createSessionManager();

    // Only orphan worker process should be killed (legacy session worker is also killed because serverPid is missing)
    expect(mockProcess.wasKilled(10001)).toBe(true);  // Legacy session (serverPid missing = inherited)
    expect(mockProcess.wasKilled(10002)).toBe(false); // Active session (serverPid alive = not inherited)
    expect(mockProcess.wasKilled(10003)).toBe(true);  // Orphan session (serverPid dead = inherited)

    // All sessions should remain in persistence (orphan and legacy are inherited, active is untouched)
    const savedData = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8'));
    expect(savedData.find((s: PersistedSession) => s.id === 'legacy-session')).toBeDefined();
    expect(savedData.find((s: PersistedSession) => s.id === 'active-session')).toBeDefined();
    expect(savedData.find((s: PersistedSession) => s.id === 'orphan-session')).toBeDefined();

    // Inherited sessions should have updated serverPid
    const legacySession = savedData.find((s: PersistedSession) => s.id === 'legacy-session');
    const orphanSession = savedData.find((s: PersistedSession) => s.id === 'orphan-session');
    const activeSession = savedData.find((s: PersistedSession) => s.id === 'active-session');
    expect(legacySession.serverPid).toBe(process.pid);
    expect(orphanSession.serverPid).toBe(process.pid);
    expect(activeSession.serverPid).toBe(20001); // Unchanged
  });

  it('should handle empty sessions list', async () => {
    persistSessions([]);
    persistAgents();

    await createSessionManager();

    // No processes should be killed
    expect(mockProcess.getKillCount()).toBe(0);
  });
});
