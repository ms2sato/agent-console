import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Test directory - unique per test run
const TEST_CONFIG_DIR = path.join(os.tmpdir(), 'agent-console-persistence-test-' + process.pid + '-' + Date.now());

describe('PersistenceService', () => {
  beforeEach(async () => {
    // Set up test config directory via environment variable
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    // Clear module cache to get fresh instance with new config dir
    vi.resetModules();
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_CONFIG_DIR)) {
      fs.rmSync(TEST_CONFIG_DIR, { recursive: true });
    }
    delete process.env.AGENT_CONSOLE_HOME;
  });

  describe('repositories', () => {
    it('should return empty array when no repositories file exists', async () => {
      const { PersistenceService } = await import('../persistence-service.js');
      const service = new PersistenceService();

      const repos = service.loadRepositories();
      expect(repos).toEqual([]);
    });

    it('should save and load repositories', async () => {
      const { PersistenceService } = await import('../persistence-service.js');
      const service = new PersistenceService();

      const testRepos = [
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

    it('should overwrite repositories on save', async () => {
      const { PersistenceService } = await import('../persistence-service.js');
      const service = new PersistenceService();

      const repos1 = [
        { id: '1', name: 'repo1', path: '/path1', registeredAt: '2024-01-01T00:00:00.000Z' },
      ];
      const repos2 = [
        { id: '2', name: 'repo2', path: '/path2', registeredAt: '2024-01-02T00:00:00.000Z' },
      ];

      service.saveRepositories(repos1);
      service.saveRepositories(repos2);

      const loaded = service.loadRepositories();
      expect(loaded).toEqual(repos2);
    });
  });

  describe('sessions', () => {
    it('should return empty array when no sessions file exists', async () => {
      const { PersistenceService } = await import('../persistence-service.js');
      const service = new PersistenceService();

      const sessions = service.loadSessions();
      expect(sessions).toEqual([]);
    });

    it('should save and load sessions', async () => {
      const { PersistenceService } = await import('../persistence-service.js');
      const service = new PersistenceService();

      const testSessions = [
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

    it('should save and load sessions with serverPid', async () => {
      const { PersistenceService } = await import('../persistence-service.js');
      const service = new PersistenceService();

      const testSessions = [
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

    it('should get session metadata by id', async () => {
      const { PersistenceService } = await import('../persistence-service.js');
      const service = new PersistenceService();

      const testSessions = [
        { id: 's1', worktreePath: '/p1', repositoryId: 'r1', pid: 1, serverPid: 100, createdAt: '2024-01-01T00:00:00.000Z' },
        { id: 's2', worktreePath: '/p2', repositoryId: 'r2', pid: 2, serverPid: 100, createdAt: '2024-01-02T00:00:00.000Z' },
      ];

      service.saveSessions(testSessions);

      const session = service.getSessionMetadata('s1');
      expect(session?.id).toBe('s1');
      expect(session?.worktreePath).toBe('/p1');
      expect(session?.serverPid).toBe(100);
    });

    it('should return undefined for non-existent session', async () => {
      const { PersistenceService } = await import('../persistence-service.js');
      const service = new PersistenceService();

      const session = service.getSessionMetadata('non-existent');
      expect(session).toBeUndefined();
    });

    it('should remove session by id', async () => {
      const { PersistenceService } = await import('../persistence-service.js');
      const service = new PersistenceService();

      const testSessions = [
        { id: 's1', worktreePath: '/p1', repositoryId: 'r1', pid: 1, serverPid: 100, createdAt: '2024-01-01T00:00:00.000Z' },
        { id: 's2', worktreePath: '/p2', repositoryId: 'r2', pid: 2, serverPid: 100, createdAt: '2024-01-02T00:00:00.000Z' },
      ];

      service.saveSessions(testSessions);
      service.removeSession('s1');

      const loaded = service.loadSessions();
      expect(loaded.length).toBe(1);
      expect(loaded[0].id).toBe('s2');
    });

    it('should clear all sessions', async () => {
      const { PersistenceService } = await import('../persistence-service.js');
      const service = new PersistenceService();

      const testSessions = [
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
    it('should not leave temp files on successful write', async () => {
      const { PersistenceService } = await import('../persistence-service.js');
      const service = new PersistenceService();

      service.saveRepositories([
        { id: '1', name: 'repo', path: '/path', registeredAt: '2024-01-01T00:00:00.000Z' },
      ]);

      const files = fs.readdirSync(TEST_CONFIG_DIR);
      expect(files).not.toContain('repositories.json.tmp');
    });
  });
});
