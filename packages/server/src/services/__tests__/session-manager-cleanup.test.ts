import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PersistedSession } from '../persistence-service.js';

// Test directory for isolated tests
const TEST_CONFIG_DIR = path.join(os.tmpdir(), 'agent-console-cleanup-test-' + Date.now());

// Mock persistence service that uses test directory
class MockPersistenceService {
  private sessionsFile: string;

  constructor() {
    if (!fs.existsSync(TEST_CONFIG_DIR)) {
      fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });
    }
    this.sessionsFile = path.join(TEST_CONFIG_DIR, 'sessions.json');
  }

  loadSessions(): PersistedSession[] {
    try {
      if (fs.existsSync(this.sessionsFile)) {
        return JSON.parse(fs.readFileSync(this.sessionsFile, 'utf-8'));
      }
    } catch {
      // ignore
    }
    return [];
  }

  saveSessions(sessions: PersistedSession[]): void {
    fs.writeFileSync(this.sessionsFile, JSON.stringify(sessions, null, 2));
  }
}

// Extracted cleanup logic for testing
function cleanupOrphanProcesses(
  persistenceService: MockPersistenceService,
  _currentServerPid: number,
  isProcessAlive: (pid: number) => boolean,
  killProcess: (pid: number) => void
): { killed: string[]; preserved: string[]; warnings: string[] } {
  const persistedSessions = persistenceService.loadSessions();
  const killed: string[] = [];
  const preserved: string[] = [];
  const warnings: string[] = [];

  for (const session of persistedSessions) {
    // If serverPid is not set (legacy session), don't kill it - be safe
    if (!session.serverPid) {
      warnings.push(`Session ${session.id} has no serverPid (legacy session), skipping cleanup`);
      preserved.push(session.id);
      continue;
    }

    // Check if the server that created this session is still alive
    if (isProcessAlive(session.serverPid)) {
      // Parent server is still running, don't touch this session
      preserved.push(session.id);
      continue;
    }

    // Parent server is dead, kill the orphan process
    try {
      killProcess(session.pid);
      killed.push(session.id);
    } catch {
      // Process doesn't exist, that's fine
    }
  }

  return { killed, preserved, warnings };
}

describe('cleanupOrphanProcesses', () => {
  let persistenceService: MockPersistenceService;

  beforeEach(() => {
    if (fs.existsSync(TEST_CONFIG_DIR)) {
      fs.rmSync(TEST_CONFIG_DIR, { recursive: true });
    }
    persistenceService = new MockPersistenceService();
  });

  afterEach(() => {
    if (fs.existsSync(TEST_CONFIG_DIR)) {
      fs.rmSync(TEST_CONFIG_DIR, { recursive: true });
    }
  });

  it('should skip sessions without serverPid (legacy sessions)', () => {
    const sessions: PersistedSession[] = [
      {
        id: 'legacy-session',
        worktreePath: '/path/to/worktree',
        repositoryId: 'repo-1',
        pid: 12345,
        serverPid: undefined as unknown as number, // Legacy session without serverPid
        createdAt: '2024-01-01T00:00:00.000Z',
      },
    ];
    persistenceService.saveSessions(sessions);

    const killProcess = vi.fn();
    const isProcessAlive = vi.fn().mockReturnValue(true);

    const result = cleanupOrphanProcesses(
      persistenceService,
      99999,
      isProcessAlive,
      killProcess
    );

    expect(result.killed).toEqual([]);
    expect(result.preserved).toEqual(['legacy-session']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('legacy session');
    expect(killProcess).not.toHaveBeenCalled();
  });

  it('should preserve sessions when parent server is still alive', () => {
    const sessions: PersistedSession[] = [
      {
        id: 'active-session',
        worktreePath: '/path/to/worktree',
        repositoryId: 'repo-1',
        pid: 12345,
        serverPid: 11111, // Parent server PID
        createdAt: '2024-01-01T00:00:00.000Z',
      },
    ];
    persistenceService.saveSessions(sessions);

    const killProcess = vi.fn();
    const isProcessAlive = vi.fn().mockReturnValue(true); // Parent server is alive

    const result = cleanupOrphanProcesses(
      persistenceService,
      99999, // Current server PID (different from parent)
      isProcessAlive,
      killProcess
    );

    expect(result.killed).toEqual([]);
    expect(result.preserved).toEqual(['active-session']);
    expect(result.warnings).toHaveLength(0);
    expect(killProcess).not.toHaveBeenCalled();
    expect(isProcessAlive).toHaveBeenCalledWith(11111);
  });

  it('should kill sessions when parent server is dead', () => {
    const sessions: PersistedSession[] = [
      {
        id: 'orphan-session',
        worktreePath: '/path/to/worktree',
        repositoryId: 'repo-1',
        pid: 12345,
        serverPid: 11111, // Dead parent server PID
        createdAt: '2024-01-01T00:00:00.000Z',
      },
    ];
    persistenceService.saveSessions(sessions);

    const killProcess = vi.fn();
    const isProcessAlive = vi.fn().mockReturnValue(false); // Parent server is dead

    const result = cleanupOrphanProcesses(
      persistenceService,
      99999,
      isProcessAlive,
      killProcess
    );

    expect(result.killed).toEqual(['orphan-session']);
    expect(result.preserved).toEqual([]);
    expect(result.warnings).toHaveLength(0);
    expect(killProcess).toHaveBeenCalledWith(12345);
  });

  it('should handle mixed sessions correctly', () => {
    const sessions: PersistedSession[] = [
      {
        id: 'legacy-session',
        worktreePath: '/path/1',
        repositoryId: 'repo-1',
        pid: 10001,
        serverPid: undefined as unknown as number,
        createdAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'active-session',
        worktreePath: '/path/2',
        repositoryId: 'repo-1',
        pid: 10002,
        serverPid: 20001, // Alive server
        createdAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'orphan-session',
        worktreePath: '/path/3',
        repositoryId: 'repo-1',
        pid: 10003,
        serverPid: 20002, // Dead server
        createdAt: '2024-01-01T00:00:00.000Z',
      },
    ];
    persistenceService.saveSessions(sessions);

    const killProcess = vi.fn();
    const isProcessAlive = vi.fn().mockImplementation((pid: number) => {
      return pid === 20001; // Only server 20001 is alive
    });

    const result = cleanupOrphanProcesses(
      persistenceService,
      99999,
      isProcessAlive,
      killProcess
    );

    expect(result.killed).toEqual(['orphan-session']);
    expect(result.preserved).toContain('legacy-session');
    expect(result.preserved).toContain('active-session');
    expect(result.warnings).toHaveLength(1);
    expect(killProcess).toHaveBeenCalledTimes(1);
    expect(killProcess).toHaveBeenCalledWith(10003);
  });

  it('should handle empty sessions list', () => {
    persistenceService.saveSessions([]);

    const killProcess = vi.fn();
    const isProcessAlive = vi.fn();

    const result = cleanupOrphanProcesses(
      persistenceService,
      99999,
      isProcessAlive,
      killProcess
    );

    expect(result.killed).toEqual([]);
    expect(result.preserved).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(killProcess).not.toHaveBeenCalled();
    expect(isProcessAlive).not.toHaveBeenCalled();
  });
});
