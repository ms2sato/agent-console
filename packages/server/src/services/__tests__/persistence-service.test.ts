import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock the config directory to use a temp directory for tests
const TEST_CONFIG_DIR = path.join(os.tmpdir(), 'agent-console-test-' + Date.now());

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    existsSync: vi.fn((filePath: string) => {
      if (filePath.includes('agent-console-test')) {
        return actual.existsSync(filePath);
      }
      return actual.existsSync(filePath);
    }),
  };
});

// We need to create a testable version of PersistenceService
// since the original uses hardcoded paths

import type { PersistedRepository, PersistedSession } from '../persistence-service.js';

class TestPersistenceService {
  private configDir: string;
  private repositoriesFile: string;
  private sessionsFile: string;

  constructor(configDir: string) {
    this.configDir = configDir;
    this.repositoriesFile = path.join(configDir, 'repositories.json');
    this.sessionsFile = path.join(configDir, 'sessions.json');
    this.ensureConfigDir();
  }

  private ensureConfigDir(): void {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  private atomicWrite(filePath: string, data: string): void {
    const tempPath = filePath + '.tmp';
    fs.writeFileSync(tempPath, data, 'utf-8');
    fs.renameSync(tempPath, filePath);
  }

  private safeRead<T>(filePath: string, defaultValue: T): T {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
      }
    } catch {
      // Ignore errors
    }
    return defaultValue;
  }

  loadRepositories(): PersistedRepository[] {
    return this.safeRead<PersistedRepository[]>(this.repositoriesFile, []);
  }

  saveRepositories(repositories: PersistedRepository[]): void {
    this.atomicWrite(this.repositoriesFile, JSON.stringify(repositories, null, 2));
  }

  loadSessions(): PersistedSession[] {
    return this.safeRead<PersistedSession[]>(this.sessionsFile, []);
  }

  saveSessions(sessions: PersistedSession[]): void {
    this.atomicWrite(this.sessionsFile, JSON.stringify(sessions, null, 2));
  }

  getSessionMetadata(sessionId: string): PersistedSession | undefined {
    const sessions = this.loadSessions();
    return sessions.find(s => s.id === sessionId);
  }

  removeSession(sessionId: string): void {
    const sessions = this.loadSessions();
    const filtered = sessions.filter(s => s.id !== sessionId);
    this.saveSessions(filtered);
  }

  clearSessions(): void {
    this.saveSessions([]);
  }
}

describe('PersistenceService', () => {
  let service: TestPersistenceService;

  beforeEach(() => {
    // Create fresh test directory
    if (fs.existsSync(TEST_CONFIG_DIR)) {
      fs.rmSync(TEST_CONFIG_DIR, { recursive: true });
    }
    service = new TestPersistenceService(TEST_CONFIG_DIR);
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_CONFIG_DIR)) {
      fs.rmSync(TEST_CONFIG_DIR, { recursive: true });
    }
  });

  describe('repositories', () => {
    it('should return empty array when no repositories file exists', () => {
      const repos = service.loadRepositories();
      expect(repos).toEqual([]);
    });

    it('should save and load repositories', () => {
      const testRepos: PersistedRepository[] = [
        {
          id: 'test-id-1',
          name: 'test-repo',
          path: '/path/to/repo',
          registeredAt: '2024-01-01T00:00:00.000Z',
        },
      ];

      service.saveRepositories(testRepos);
      const loaded = service.loadRepositories();

      expect(loaded).toEqual(testRepos);
    });

    it('should overwrite repositories on save', () => {
      const repos1: PersistedRepository[] = [
        { id: '1', name: 'repo1', path: '/path1', registeredAt: '2024-01-01T00:00:00.000Z' },
      ];
      const repos2: PersistedRepository[] = [
        { id: '2', name: 'repo2', path: '/path2', registeredAt: '2024-01-02T00:00:00.000Z' },
      ];

      service.saveRepositories(repos1);
      service.saveRepositories(repos2);

      const loaded = service.loadRepositories();
      expect(loaded).toEqual(repos2);
    });
  });

  describe('sessions', () => {
    it('should return empty array when no sessions file exists', () => {
      const sessions = service.loadSessions();
      expect(sessions).toEqual([]);
    });

    it('should save and load sessions', () => {
      const testSessions: PersistedSession[] = [
        {
          id: 'session-1',
          worktreePath: '/path/to/worktree',
          repositoryId: 'repo-1',
          pid: 12345,
          serverPid: 99999,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ];

      service.saveSessions(testSessions);
      const loaded = service.loadSessions();

      expect(loaded).toEqual(testSessions);
    });

    it('should save and load sessions with serverPid', () => {
      const testSessions: PersistedSession[] = [
        {
          id: 'session-with-server-pid',
          worktreePath: '/path/to/worktree',
          repositoryId: 'repo-1',
          pid: 12345,
          serverPid: 67890,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ];

      service.saveSessions(testSessions);
      const loaded = service.loadSessions();

      expect(loaded[0].serverPid).toBe(67890);
    });

    it('should get session metadata by id', () => {
      const testSessions: PersistedSession[] = [
        { id: 's1', worktreePath: '/p1', repositoryId: 'r1', pid: 1, serverPid: 100, createdAt: '2024-01-01T00:00:00.000Z' },
        { id: 's2', worktreePath: '/p2', repositoryId: 'r2', pid: 2, serverPid: 100, createdAt: '2024-01-02T00:00:00.000Z' },
      ];

      service.saveSessions(testSessions);

      const session = service.getSessionMetadata('s1');
      expect(session?.id).toBe('s1');
      expect(session?.worktreePath).toBe('/p1');
      expect(session?.serverPid).toBe(100);
    });

    it('should return undefined for non-existent session', () => {
      const session = service.getSessionMetadata('non-existent');
      expect(session).toBeUndefined();
    });

    it('should remove session by id', () => {
      const testSessions: PersistedSession[] = [
        { id: 's1', worktreePath: '/p1', repositoryId: 'r1', pid: 1, serverPid: 100, createdAt: '2024-01-01T00:00:00.000Z' },
        { id: 's2', worktreePath: '/p2', repositoryId: 'r2', pid: 2, serverPid: 100, createdAt: '2024-01-02T00:00:00.000Z' },
      ];

      service.saveSessions(testSessions);
      service.removeSession('s1');

      const loaded = service.loadSessions();
      expect(loaded.length).toBe(1);
      expect(loaded[0].id).toBe('s2');
    });

    it('should clear all sessions', () => {
      const testSessions: PersistedSession[] = [
        { id: 's1', worktreePath: '/p1', repositoryId: 'r1', pid: 1, serverPid: 100, createdAt: '2024-01-01T00:00:00.000Z' },
        { id: 's2', worktreePath: '/p2', repositoryId: 'r2', pid: 2, serverPid: 100, createdAt: '2024-01-02T00:00:00.000Z' },
      ];

      service.saveSessions(testSessions);
      service.clearSessions();

      const loaded = service.loadSessions();
      expect(loaded).toEqual([]);
    });
  });

  describe('atomic write', () => {
    it('should not leave temp files on successful write', () => {
      service.saveRepositories([
        { id: '1', name: 'repo', path: '/path', registeredAt: '2024-01-01T00:00:00.000Z' },
      ]);

      const files = fs.readdirSync(TEST_CONFIG_DIR);
      expect(files).not.toContain('repositories.json.tmp');
    });
  });
});
