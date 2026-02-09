import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentDefinition } from '@agent-console/shared';
import type { PersistedSession } from '../persistence-service.js';
import { setupTestConfigDir, cleanupTestConfigDir, getTestConfigDir } from '../../__tests__/utils/mock-fs-helper.js';

describe('PersistenceService', () => {
  const TEST_CONFIG_DIR = '/test/config';
  let importCounter = 0;

  beforeEach(() => {
    setupTestConfigDir(TEST_CONFIG_DIR);
  });

  afterEach(() => {
    cleanupTestConfigDir();
  });

  // Helper to get a fresh instance of PersistenceService
  async function getPersistenceService() {
    const module = await import(`../persistence-service.js?v=${++importCounter}`);
    return new module.PersistenceService();
  }

  describe('repositories', () => {
    it('should return empty array when no repositories file exists', async () => {
      const service = await getPersistenceService();

      const repos = await service.loadRepositories();
      expect(repos).toEqual([]);
    });

    it('should save and load repositories', async () => {
      const service = await getPersistenceService();

      const testRepos = [
        {
          id: 'test-id-1',
          name: 'test-repo',
          path: '/path/to/repo',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ];

      await service.saveRepositories(testRepos);
      const loaded = await service.loadRepositories();

      expect(loaded).toEqual(testRepos);
    });

    it('should overwrite repositories on save', async () => {
      const service = await getPersistenceService();

      const repos1 = [
        { id: '1', name: 'repo1', path: '/path1', createdAt: '2024-01-01T00:00:00.000Z' },
      ];
      const repos2 = [
        { id: '2', name: 'repo2', path: '/path2', createdAt: '2024-01-02T00:00:00.000Z' },
      ];

      await service.saveRepositories(repos1);
      await service.saveRepositories(repos2);

      const loaded = await service.loadRepositories();
      expect(loaded).toEqual(repos2);
    });
  });

  describe('sessions', () => {
    it('should return empty array when no sessions file exists', async () => {
      const service = await getPersistenceService();

      const sessions = await service.loadSessions();
      expect(sessions).toEqual([]);
    });

    it('should save and load sessions', async () => {
      const service = await getPersistenceService();

      const testSessions: PersistedSession[] = [
        {
          id: 'session-1',
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
              pid: 12345,
              createdAt: '2024-01-01T00:00:00.000Z',
            },
          ],
          serverPid: 99999,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ];

      await service.saveSessions(testSessions);
      const loaded = await service.loadSessions();

      expect(loaded).toEqual(testSessions);
    });

    it('should save and load sessions with serverPid', async () => {
      const service = await getPersistenceService();

      const testSessions: PersistedSession[] = [
        {
          id: 'session-with-server-pid',
          type: 'quick',
          locationPath: '/path/to/worktree',
          workers: [
            {
              id: 'worker-1',
              type: 'terminal',
              name: 'Shell',
              pid: 12345,
              createdAt: '2024-01-01T00:00:00.000Z',
            },
          ],
          serverPid: 67890,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ];

      await service.saveSessions(testSessions);
      const loaded = await service.loadSessions();

      expect(loaded[0].serverPid).toBe(67890);
    });

    it('should get session metadata by id', async () => {
      const service = await getPersistenceService();

      const testSessions: PersistedSession[] = [
        {
          id: 's1',
          type: 'worktree',
          locationPath: '/p1',
          repositoryId: 'r1',
          worktreeId: 'main',
          workers: [],
          serverPid: 100,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 's2',
          type: 'quick',
          locationPath: '/p2',
          workers: [],
          serverPid: 100,
          createdAt: '2024-01-02T00:00:00.000Z',
        },
      ];

      await service.saveSessions(testSessions);

      const session = await service.getSessionMetadata('s1');
      expect(session?.id).toBe('s1');
      expect(session?.locationPath).toBe('/p1');
      expect(session?.serverPid).toBe(100);
    });

    it('should return undefined for non-existent session', async () => {
      const service = await getPersistenceService();

      const session = await service.getSessionMetadata('non-existent');
      expect(session).toBeUndefined();
    });

    it('should remove session by id', async () => {
      const service = await getPersistenceService();

      const testSessions: PersistedSession[] = [
        {
          id: 's1',
          type: 'quick',
          locationPath: '/p1',
          workers: [],
          serverPid: 100,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 's2',
          type: 'quick',
          locationPath: '/p2',
          workers: [],
          serverPid: 100,
          createdAt: '2024-01-02T00:00:00.000Z',
        },
      ];

      await service.saveSessions(testSessions);
      await service.removeSession('s1');

      const loaded = await service.loadSessions();
      expect(loaded.length).toBe(1);
      expect(loaded[0].id).toBe('s2');
    });

    it('should clear all sessions', async () => {
      const service = await getPersistenceService();

      const testSessions: PersistedSession[] = [
        {
          id: 's1',
          type: 'quick',
          locationPath: '/p1',
          workers: [],
          serverPid: 100,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 's2',
          type: 'quick',
          locationPath: '/p2',
          workers: [],
          serverPid: 100,
          createdAt: '2024-01-02T00:00:00.000Z',
        },
      ];

      await service.saveSessions(testSessions);
      await service.clearSessions();

      const loaded = await service.loadSessions();
      expect(loaded).toEqual([]);
    });
  });

  describe('atomic write', () => {
    it('should not leave temp files on successful write', async () => {
      const service = await getPersistenceService();

      await service.saveRepositories([
        { id: '1', name: 'repo', path: '/path', createdAt: '2024-01-01T00:00:00.000Z' },
      ]);

      // Check for temp files
      const files = fs.readdirSync(TEST_CONFIG_DIR);
      expect(files).not.toContain('repositories.json.tmp');
    });
  });

  describe('agents', () => {
    const createValidAgent = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
      id: 'test-agent-1',
      name: 'Test Agent',
      commandTemplate: 'test {{prompt}}',
      isBuiltIn: false,
      createdAt: '2024-01-01T00:00:00.000Z',
      capabilities: {
        supportsContinue: false,
        supportsHeadlessMode: false,
        supportsActivityDetection: false,
      },
      ...overrides,
    });

    it('should return empty array when no agents file exists', async () => {
      const service = await getPersistenceService();

      const agents = await service.loadAgents();
      expect(agents).toEqual([]);
    });

    it('should save and load valid agents', async () => {
      const service = await getPersistenceService();

      const testAgents = [createValidAgent()];

      await service.saveAgents(testAgents);
      const loaded = await service.loadAgents();

      expect(loaded).toEqual(testAgents);
    });

    it('should load agents with optional fields', async () => {
      const service = await getPersistenceService();

      const testAgents = [
        createValidAgent({
          description: 'Test description',
          continueTemplate: 'test --continue',
          headlessTemplate: 'test --headless {{prompt}}',
          activityPatterns: {
            askingPatterns: ['Do you want.*\\?'],
          },
          capabilities: {
            supportsContinue: true,
            supportsHeadlessMode: true,
            supportsActivityDetection: true,
          },
        }),
      ];

      await service.saveAgents(testAgents);
      const loaded = await service.loadAgents();

      expect(loaded).toEqual(testAgents);
    });

    it('should skip agents with missing required fields', async () => {
      const service = await getPersistenceService();

      // Write raw JSON with invalid agents directly to file
      const agentsFile = path.join(getTestConfigDir(), 'agents.json');
      const invalidAgents = [
        { id: 'valid', name: 'Valid', commandTemplate: 'test {{prompt}}', isBuiltIn: false, createdAt: '2024-01-01', capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false } },
        { name: 'Missing ID', commandTemplate: 'test {{prompt}}' }, // Missing id
        { id: 'missing-name', commandTemplate: 'test {{prompt}}' }, // Missing name
        { id: 'missing-template', name: 'Missing Template' }, // Missing commandTemplate
      ];
      fs.writeFileSync(agentsFile, JSON.stringify(invalidAgents));

      const loaded = await service.loadAgents();

      // Should only load the valid agent, invalid ones are logged and skipped
      expect(loaded.length).toBe(1);
      expect(loaded[0].id).toBe('valid');
    });

    it('should skip agents with invalid askingPatterns regex', async () => {
      const service = await getPersistenceService();

      // Write raw JSON with invalid regex directly to file
      const agentsFile = path.join(getTestConfigDir(), 'agents.json');
      const agentsWithInvalidRegex = [
        {
          id: 'valid-agent',
          name: 'Valid Agent',
          commandTemplate: 'test {{prompt}}',
          isBuiltIn: false,
          createdAt: '2024-01-01',
          capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
        },
        {
          id: 'invalid-regex-agent',
          name: 'Invalid Regex Agent',
          commandTemplate: 'test {{prompt}}',
          isBuiltIn: false,
          createdAt: '2024-01-01',
          activityPatterns: {
            askingPatterns: ['[invalid regex'],
          },
          capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: true },
        },
      ];
      fs.writeFileSync(agentsFile, JSON.stringify(agentsWithInvalidRegex));

      const loaded = await service.loadAgents();

      // Should only load the valid agent, invalid regex agents are logged and skipped
      expect(loaded.length).toBe(1);
      expect(loaded[0].id).toBe('valid-agent');
    });

    it('should get agent by id', async () => {
      const service = await getPersistenceService();

      const testAgents = [
        createValidAgent({ id: 'agent-1', name: 'Agent 1' }),
        createValidAgent({ id: 'agent-2', name: 'Agent 2' }),
      ];

      await service.saveAgents(testAgents);

      const agent = await service.getAgent('agent-1');
      expect(agent?.name).toBe('Agent 1');
    });

    it('should return undefined for non-existent agent', async () => {
      const service = await getPersistenceService();

      const agent = await service.getAgent('non-existent');
      expect(agent).toBeUndefined();
    });

    it('should remove custom agent', async () => {
      const service = await getPersistenceService();

      const testAgents = [
        createValidAgent({ id: 'agent-1', name: 'Agent 1' }),
        createValidAgent({ id: 'agent-2', name: 'Agent 2' }),
      ];

      await service.saveAgents(testAgents);
      const removed = await service.removeAgent('agent-1');

      expect(removed).toBe(true);
      const loaded = await service.loadAgents();
      expect(loaded.length).toBe(1);
      expect(loaded[0].id).toBe('agent-2');
    });

    it('should not remove built-in agent', async () => {
      const service = await getPersistenceService();

      const testAgents = [createValidAgent({ id: 'built-in-1', name: 'Built-in', isBuiltIn: true })];

      await service.saveAgents(testAgents);
      const removed = await service.removeAgent('built-in-1');

      expect(removed).toBe(false);
      const loaded = await service.loadAgents();
      expect(loaded.length).toBe(1);
    });
  });
});
