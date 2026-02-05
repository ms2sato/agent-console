import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import type { PersistedSession, PersistedWorker } from '../../services/persistence-service.js';
import { JsonSessionRepository } from '../json-session-repository.js';
import {
  setupTestConfigDir,
  cleanupTestConfigDir,
} from '../../__tests__/utils/mock-fs-helper.js';

/**
 * Creates a test quick session with default values.
 */
function createTestSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    id: overrides.id ?? 'test-session-id',
    type: 'quick',
    locationPath: '/test/path',
    serverPid: process.pid,
    createdAt: new Date().toISOString(),
    workers: [],
    ...overrides,
  } as PersistedSession;
}

/**
 * Creates a test worktree session with default values.
 */
function createTestWorktreeSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    id: overrides.id ?? 'test-worktree-session-id',
    type: 'worktree',
    locationPath: '/test/worktree/path',
    repositoryId: 'test-repo-id',
    worktreeId: 'test-branch',
    serverPid: process.pid,
    createdAt: new Date().toISOString(),
    workers: [],
    ...overrides,
  } as PersistedSession;
}

/**
 * Creates a test worker with default values.
 */
function createTestWorker(overrides: Partial<PersistedWorker> = {}): PersistedWorker {
  return {
    id: 'test-worker-id',
    type: 'agent',
    name: 'Test Agent',
    agentId: 'claude-code-builtin',
    pid: 12345,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as PersistedWorker;
}

describe('JsonSessionRepository', () => {
  const TEST_CONFIG_DIR = '/test/config';
  let sessionsFilePath: string;
  let repository: JsonSessionRepository;

  beforeEach(() => {
    setupTestConfigDir(TEST_CONFIG_DIR);
    sessionsFilePath = path.join(TEST_CONFIG_DIR, 'sessions.json');
    repository = new JsonSessionRepository(sessionsFilePath);
  });

  afterEach(() => {
    cleanupTestConfigDir();
  });

  describe('findAll', () => {
    it('should return empty array when no sessions file exists', async () => {
      const sessions = await repository.findAll();
      expect(sessions).toEqual([]);
    });

    it('should return empty array when file contains empty array', async () => {
      fs.writeFileSync(sessionsFilePath, JSON.stringify([]));

      const sessions = await repository.findAll();
      expect(sessions).toEqual([]);
    });

    it('should return all sessions from file', async () => {
      const testSessions = [
        createTestSession({ id: 'session-1' }),
        createTestSession({ id: 'session-2' }),
        createTestWorktreeSession({ id: 'session-3' }),
      ];
      fs.writeFileSync(sessionsFilePath, JSON.stringify(testSessions, null, 2));

      const sessions = await repository.findAll();

      expect(sessions.length).toBe(3);
      expect(sessions[0].id).toBe('session-1');
      expect(sessions[1].id).toBe('session-2');
      expect(sessions[2].id).toBe('session-3');
    });

    it('should return sessions with workers', async () => {
      const testSession = createTestSession({
        id: 'session-with-workers',
        workers: [
          createTestWorker({ id: 'worker-1', name: 'Agent Worker' }),
          {
            id: 'worker-2',
            type: 'terminal',
            name: 'Terminal',
            pid: 54321,
            createdAt: new Date().toISOString(),
          } as PersistedWorker,
        ],
      });
      fs.writeFileSync(sessionsFilePath, JSON.stringify([testSession], null, 2));

      const sessions = await repository.findAll();

      expect(sessions.length).toBe(1);
      expect(sessions[0].workers.length).toBe(2);
      expect(sessions[0].workers[0].id).toBe('worker-1');
      expect(sessions[0].workers[1].type).toBe('terminal');
    });
  });

  describe('findById', () => {
    it('should return session if exists', async () => {
      const testSessions = [
        createTestSession({ id: 'session-1' }),
        createTestWorktreeSession({ id: 'session-2', repositoryId: 'repo-1' }),
      ];
      fs.writeFileSync(sessionsFilePath, JSON.stringify(testSessions, null, 2));

      const session = await repository.findById('session-2');

      expect(session).not.toBeNull();
      expect(session?.id).toBe('session-2');
      expect(session?.type).toBe('worktree');
      if (session?.type === 'worktree') {
        expect(session.repositoryId).toBe('repo-1');
      }
    });

    it('should return null if session not found', async () => {
      const testSessions = [createTestSession({ id: 'session-1' })];
      fs.writeFileSync(sessionsFilePath, JSON.stringify(testSessions, null, 2));

      const session = await repository.findById('non-existent');

      expect(session).toBeNull();
    });

    it("should return null when file doesn't exist", async () => {
      const session = await repository.findById('any-id');

      expect(session).toBeNull();
    });
  });

  describe('findByServerPid', () => {
    it('should return sessions matching the given PID', async () => {
      const testSessions = [
        createTestSession({ id: 'session-1', serverPid: 1000 }),
        createTestSession({ id: 'session-2', serverPid: 2000 }),
        createTestSession({ id: 'session-3', serverPid: 1000 }),
        createTestWorktreeSession({ id: 'session-4', serverPid: 3000 }),
      ];
      fs.writeFileSync(sessionsFilePath, JSON.stringify(testSessions, null, 2));

      const sessions = await repository.findByServerPid(1000);

      expect(sessions.length).toBe(2);
      expect(sessions.map((s) => s.id).sort()).toEqual(['session-1', 'session-3']);
    });

    it('should return empty array if no sessions match', async () => {
      const testSessions = [
        createTestSession({ id: 'session-1', serverPid: 1000 }),
        createTestSession({ id: 'session-2', serverPid: 2000 }),
      ];
      fs.writeFileSync(sessionsFilePath, JSON.stringify(testSessions, null, 2));

      const sessions = await repository.findByServerPid(9999);

      expect(sessions).toEqual([]);
    });

    it("should return empty array when file doesn't exist", async () => {
      const sessions = await repository.findByServerPid(1000);

      expect(sessions).toEqual([]);
    });
  });

  describe('findPaused', () => {
    it('should return sessions with null serverPid', async () => {
      const testSessions = [
        createTestSession({ id: 'session-1', serverPid: 1000 }),
        createTestSession({ id: 'session-2', serverPid: undefined }),
        createTestWorktreeSession({ id: 'session-3', serverPid: undefined }),
        createTestSession({ id: 'session-4', serverPid: 2000 }),
      ];
      fs.writeFileSync(sessionsFilePath, JSON.stringify(testSessions, null, 2));

      const sessions = await repository.findPaused();

      expect(sessions.length).toBe(2);
      expect(sessions.map((s) => s.id).sort()).toEqual(['session-2', 'session-3']);
    });

    it('should return empty array if no paused sessions', async () => {
      const testSessions = [
        createTestSession({ id: 'session-1', serverPid: 1000 }),
        createTestSession({ id: 'session-2', serverPid: 2000 }),
      ];
      fs.writeFileSync(sessionsFilePath, JSON.stringify(testSessions, null, 2));

      const sessions = await repository.findPaused();

      expect(sessions).toEqual([]);
    });

    it("should return empty array when file doesn't exist", async () => {
      const sessions = await repository.findPaused();

      expect(sessions).toEqual([]);
    });

    it('should include workers in paused sessions', async () => {
      const testSession = createTestWorktreeSession({
        id: 'paused-session',
        serverPid: undefined,
        workers: [
          createTestWorker({ id: 'worker-1', name: 'Agent Worker' }),
        ],
      });
      fs.writeFileSync(sessionsFilePath, JSON.stringify([testSession], null, 2));

      const sessions = await repository.findPaused();

      expect(sessions.length).toBe(1);
      expect(sessions[0].workers.length).toBe(1);
      expect(sessions[0].workers[0].id).toBe('worker-1');
    });
  });

  describe('save', () => {
    it("should create new session when it doesn't exist", async () => {
      const newSession = createTestSession({ id: 'new-session' });

      await repository.save(newSession);

      const fileContent = fs.readFileSync(sessionsFilePath, 'utf-8');
      const savedSessions = JSON.parse(fileContent);
      expect(savedSessions.length).toBe(1);
      expect(savedSessions[0].id).toBe('new-session');
    });

    it('should update existing session when it exists', async () => {
      const initialSession = createTestSession({ id: 'session-1', title: 'Original Title' });
      fs.writeFileSync(sessionsFilePath, JSON.stringify([initialSession], null, 2));

      const updatedSession = createTestSession({ id: 'session-1', title: 'Updated Title' });
      await repository.save(updatedSession);

      const fileContent = fs.readFileSync(sessionsFilePath, 'utf-8');
      const savedSessions = JSON.parse(fileContent);
      expect(savedSessions.length).toBe(1);
      expect(savedSessions[0].title).toBe('Updated Title');
    });

    it('should preserve other sessions when saving', async () => {
      const existingSessions = [
        createTestSession({ id: 'session-1' }),
        createTestSession({ id: 'session-2' }),
      ];
      fs.writeFileSync(sessionsFilePath, JSON.stringify(existingSessions, null, 2));

      const newSession = createTestSession({ id: 'session-3' });
      await repository.save(newSession);

      const fileContent = fs.readFileSync(sessionsFilePath, 'utf-8');
      const savedSessions = JSON.parse(fileContent);
      expect(savedSessions.length).toBe(3);
      expect(savedSessions.map((s: PersistedSession) => s.id).sort()).toEqual([
        'session-1',
        'session-2',
        'session-3',
      ]);
    });

    it("should create file if it doesn't exist", async () => {
      expect(fs.existsSync(sessionsFilePath)).toBe(false);

      const newSession = createTestSession({ id: 'first-session' });
      await repository.save(newSession);

      expect(fs.existsSync(sessionsFilePath)).toBe(true);
      const fileContent = fs.readFileSync(sessionsFilePath, 'utf-8');
      const savedSessions = JSON.parse(fileContent);
      expect(savedSessions.length).toBe(1);
    });

    it('should save session with workers', async () => {
      const sessionWithWorkers = createTestSession({
        id: 'session-with-workers',
        workers: [
          createTestWorker({ id: 'worker-1' }),
          createTestWorker({ id: 'worker-2', type: 'terminal' }),
        ],
      });

      await repository.save(sessionWithWorkers);

      const fileContent = fs.readFileSync(sessionsFilePath, 'utf-8');
      const savedSessions = JSON.parse(fileContent);
      expect(savedSessions[0].workers.length).toBe(2);
    });
  });

  describe('saveAll', () => {
    it('should replace all sessions in file', async () => {
      const initialSessions = [
        createTestSession({ id: 'old-1' }),
        createTestSession({ id: 'old-2' }),
      ];
      fs.writeFileSync(sessionsFilePath, JSON.stringify(initialSessions, null, 2));

      const newSessions = [
        createTestSession({ id: 'new-1' }),
        createTestWorktreeSession({ id: 'new-2' }),
        createTestSession({ id: 'new-3' }),
      ];
      await repository.saveAll(newSessions);

      const fileContent = fs.readFileSync(sessionsFilePath, 'utf-8');
      const savedSessions = JSON.parse(fileContent);
      expect(savedSessions.length).toBe(3);
      expect(savedSessions.map((s: PersistedSession) => s.id).sort()).toEqual([
        'new-1',
        'new-2',
        'new-3',
      ]);
    });

    it('should handle empty array', async () => {
      const initialSessions = [createTestSession({ id: 'session-1' })];
      fs.writeFileSync(sessionsFilePath, JSON.stringify(initialSessions, null, 2));

      await repository.saveAll([]);

      const fileContent = fs.readFileSync(sessionsFilePath, 'utf-8');
      const savedSessions = JSON.parse(fileContent);
      expect(savedSessions).toEqual([]);
    });

    it("should create file if it doesn't exist", async () => {
      expect(fs.existsSync(sessionsFilePath)).toBe(false);

      const sessions = [createTestSession({ id: 'session-1' })];
      await repository.saveAll(sessions);

      expect(fs.existsSync(sessionsFilePath)).toBe(true);
      const fileContent = fs.readFileSync(sessionsFilePath, 'utf-8');
      const savedSessions = JSON.parse(fileContent);
      expect(savedSessions.length).toBe(1);
    });
  });

  describe('delete', () => {
    it('should remove session by id', async () => {
      const testSessions = [
        createTestSession({ id: 'session-1' }),
        createTestSession({ id: 'session-2' }),
        createTestSession({ id: 'session-3' }),
      ];
      fs.writeFileSync(sessionsFilePath, JSON.stringify(testSessions, null, 2));

      await repository.delete('session-2');

      const fileContent = fs.readFileSync(sessionsFilePath, 'utf-8');
      const savedSessions = JSON.parse(fileContent);
      expect(savedSessions.length).toBe(2);
      expect(savedSessions.map((s: PersistedSession) => s.id).sort()).toEqual([
        'session-1',
        'session-3',
      ]);
    });

    it('should not affect other sessions', async () => {
      const testSessions = [
        createTestSession({ id: 'session-1', title: 'First' }),
        createTestWorktreeSession({ id: 'session-2', repositoryId: 'repo-1' }),
      ];
      fs.writeFileSync(sessionsFilePath, JSON.stringify(testSessions, null, 2));

      await repository.delete('session-1');

      const fileContent = fs.readFileSync(sessionsFilePath, 'utf-8');
      const savedSessions = JSON.parse(fileContent);
      expect(savedSessions.length).toBe(1);
      expect(savedSessions[0].id).toBe('session-2');
      expect(savedSessions[0].type).toBe('worktree');
      expect(savedSessions[0].repositoryId).toBe('repo-1');
    });

    it("should not fail if session doesn't exist", async () => {
      const testSessions = [createTestSession({ id: 'session-1' })];
      fs.writeFileSync(sessionsFilePath, JSON.stringify(testSessions, null, 2));

      // Should not throw
      await repository.delete('non-existent-session');

      const fileContent = fs.readFileSync(sessionsFilePath, 'utf-8');
      const savedSessions = JSON.parse(fileContent);
      expect(savedSessions.length).toBe(1);
      expect(savedSessions[0].id).toBe('session-1');
    });

    it("should not fail when file doesn't exist", async () => {
      // Should not throw even when file doesn't exist
      await expect(repository.delete('any-session')).resolves.toBeUndefined();
    });
  });

  describe('atomic write behavior', () => {
    it('should not leave temp files on successful write', async () => {
      await repository.save(createTestSession({ id: 'test' }));

      const files = fs.readdirSync(TEST_CONFIG_DIR);
      const tempFiles = files.filter((f: string) => f.endsWith('.tmp'));
      expect(tempFiles).toEqual([]);
    });

    it('should write formatted JSON', async () => {
      await repository.save(createTestSession({ id: 'test' }));

      const content = fs.readFileSync(sessionsFilePath, 'utf-8');
      // Should be formatted with indentation (2 spaces)
      expect(content).toContain('{\n  ');
    });
  });
});
