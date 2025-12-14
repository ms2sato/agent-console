import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { setupTestConfigDir, cleanupTestConfigDir, setupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import type { PersistedSession } from '../persistence-service.js';
import type { SessionValidationResult } from '@agent-console/shared';

// Mock gitRefExists to avoid actual git commands
let mockGitRefExists: () => Promise<boolean> = () => Promise.resolve(true);

mock.module('../../lib/git.js', () => ({
  gitRefExists: () => mockGitRefExists(),
}));

describe('SessionValidationService', () => {
  const TEST_CONFIG_DIR = '/test/config';
  let importCounter = 0;

  beforeEach(() => {
    // Reset the mock
    mockGitRefExists = () => Promise.resolve(true);
  });

  afterEach(() => {
    cleanupTestConfigDir();
  });

  async function getServices() {
    const module = await import(`../session-validation-service.js?v=${++importCounter}`);
    const persistenceModule = await import(`../persistence-service.js?v=${importCounter}`);
    return {
      validationService: new module.SessionValidationService(),
      persistenceService: new persistenceModule.PersistenceService(),
    };
  }

  describe('validateSession', () => {
    it('should pass validation for valid quick session with existing directory', async () => {
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        '/projects/my-project/README.md': 'test',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      const { validationService } = await getServices();

      const session: PersistedSession = {
        id: 'test-session',
        type: 'quick',
        locationPath: '/projects/my-project',
        workers: [],
        serverPid: 1234,
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      const result = await validationService.validateSession(session);

      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.sessionId).toBe('test-session');
    });

    it('should fail validation when directory does not exist', async () => {
      setupTestConfigDir(TEST_CONFIG_DIR);

      const { validationService } = await getServices();

      const session: PersistedSession = {
        id: 'test-session',
        type: 'quick',
        locationPath: '/non-existent/path',
        workers: [],
        serverPid: 1234,
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      const result = await validationService.validateSession(session);

      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe('directory_not_found');
    });

    it('should fail validation for worktree session when not a git repository', async () => {
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        '/projects/my-project/README.md': 'test',
        // No .git directory
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      const { validationService } = await getServices();

      const session: PersistedSession = {
        id: 'test-session',
        type: 'worktree',
        locationPath: '/projects/my-project',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        workers: [],
        serverPid: 1234,
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      const result = await validationService.validateSession(session);

      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe('not_git_repository');
    });

    it('should fail validation when branch does not exist', async () => {
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        '/projects/my-project/.git': 'gitdir: ...',
        '/projects/my-project/README.md': 'test',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      // Mock gitRefExists to return false for this test
      mockGitRefExists = () => Promise.resolve(false);

      const { validationService } = await getServices();

      const session: PersistedSession = {
        id: 'test-session',
        type: 'worktree',
        locationPath: '/projects/my-project',
        repositoryId: 'repo-1',
        worktreeId: 'non-existent-branch',
        workers: [],
        serverPid: 1234,
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      const result = await validationService.validateSession(session);

      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe('branch_not_found');
    });

    it('should pass validation for worktree session with existing directory, git repo, and branch', async () => {
      setupMemfs({
        [`${TEST_CONFIG_DIR}/.keep`]: '',
        '/projects/my-project/.git': 'gitdir: ...',
        '/projects/my-project/README.md': 'test',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      // Mock gitRefExists to return true
      mockGitRefExists = () => Promise.resolve(true);

      const { validationService } = await getServices();

      const session: PersistedSession = {
        id: 'test-session',
        type: 'worktree',
        locationPath: '/projects/my-project',
        repositoryId: 'repo-1',
        worktreeId: 'main',
        workers: [],
        serverPid: 1234,
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      const result = await validationService.validateSession(session);

      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should include session info in result', async () => {
      setupTestConfigDir(TEST_CONFIG_DIR);

      const { validationService } = await getServices();

      const session: PersistedSession = {
        id: 'test-session',
        type: 'worktree',
        locationPath: '/non-existent/path',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        workers: [],
        serverPid: 1234,
        createdAt: '2024-01-01T00:00:00.000Z',
        title: 'My Session',
      };

      const result = await validationService.validateSession(session);

      expect(result.session.type).toBe('worktree');
      expect(result.session.locationPath).toBe('/non-existent/path');
      expect(result.session.worktreeId).toBe('feature-branch');
      expect(result.session.title).toBe('My Session');
    });
  });

  describe('validateAllSessions', () => {
    it('should return hasIssues=false when all sessions are valid', async () => {
      setupMemfs({
        [`${TEST_CONFIG_DIR}/sessions.json`]: JSON.stringify([
          {
            id: 's1',
            type: 'quick',
            locationPath: '/projects/p1',
            workers: [],
            serverPid: 1234,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ]),
        '/projects/p1/README.md': 'test',
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      const { validationService } = await getServices();
      const response = await validationService.validateAllSessions();

      expect(response.hasIssues).toBe(false);
      expect(response.results).toHaveLength(1);
      expect(response.results[0].valid).toBe(true);
    });

    it('should return hasIssues=true when some sessions are invalid', async () => {
      setupMemfs({
        [`${TEST_CONFIG_DIR}/sessions.json`]: JSON.stringify([
          {
            id: 's1',
            type: 'quick',
            locationPath: '/projects/valid',
            workers: [],
            serverPid: 1234,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
          {
            id: 's2',
            type: 'quick',
            locationPath: '/projects/invalid',
            workers: [],
            serverPid: 1234,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ]),
        '/projects/valid/README.md': 'test',
        // /projects/invalid does not exist
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      const { validationService } = await getServices();
      const response = await validationService.validateAllSessions();

      expect(response.hasIssues).toBe(true);
      expect(response.results).toHaveLength(2);

      const validResult = response.results.find((r: SessionValidationResult) => r.sessionId === 's1');
      const invalidResult = response.results.find((r: SessionValidationResult) => r.sessionId === 's2');

      expect(validResult?.valid).toBe(true);
      expect(invalidResult?.valid).toBe(false);
    });

    it('should return empty results when no sessions exist', async () => {
      setupTestConfigDir(TEST_CONFIG_DIR);

      const { validationService } = await getServices();
      const response = await validationService.validateAllSessions();

      expect(response.hasIssues).toBe(false);
      expect(response.results).toHaveLength(0);
    });
  });

  describe('getInvalidSessions', () => {
    it('should return only invalid sessions', async () => {
      setupMemfs({
        [`${TEST_CONFIG_DIR}/sessions.json`]: JSON.stringify([
          {
            id: 's1',
            type: 'quick',
            locationPath: '/projects/valid',
            workers: [],
            serverPid: 1234,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
          {
            id: 's2',
            type: 'quick',
            locationPath: '/projects/invalid1',
            workers: [],
            serverPid: 1234,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
          {
            id: 's3',
            type: 'quick',
            locationPath: '/projects/invalid2',
            workers: [],
            serverPid: 1234,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ]),
        '/projects/valid/README.md': 'test',
        // invalid1 and invalid2 do not exist
      });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

      const { validationService } = await getServices();
      const invalidSessions = await validationService.getInvalidSessions();

      expect(invalidSessions).toHaveLength(2);
      expect(invalidSessions.map((s: SessionValidationResult) => s.sessionId).sort()).toEqual(['s2', 's3']);
    });
  });
});
