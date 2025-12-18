import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
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

      const repos = service.loadRepositories();
      expect(repos).toEqual([]);
    });

    it('should save and load repositories', async () => {
      const service = await getPersistenceService();

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
      const service = await getPersistenceService();

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
      const service = await getPersistenceService();

      const sessions = service.loadSessions();
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

      service.saveSessions(testSessions);
      const loaded = service.loadSessions();

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

      service.saveSessions(testSessions);
      const loaded = service.loadSessions();

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

      service.saveSessions(testSessions);

      const session = service.getSessionMetadata('s1');
      expect(session?.id).toBe('s1');
      expect(session?.locationPath).toBe('/p1');
      expect(session?.serverPid).toBe(100);
    });

    it('should return undefined for non-existent session', async () => {
      const service = await getPersistenceService();

      const session = service.getSessionMetadata('non-existent');
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

      service.saveSessions(testSessions);
      service.removeSession('s1');

      const loaded = service.loadSessions();
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

      service.saveSessions(testSessions);
      service.clearSessions();

      const loaded = service.loadSessions();
      expect(loaded).toEqual([]);
    });
  });

  describe('atomic write', () => {
    it('should not leave temp files on successful write', async () => {
      const service = await getPersistenceService();

      service.saveRepositories([
        { id: '1', name: 'repo', path: '/path', registeredAt: '2024-01-01T00:00:00.000Z' },
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
      registeredAt: '2024-01-01T00:00:00.000Z',
      capabilities: {
        supportsContinue: false,
        supportsHeadlessMode: false,
        supportsActivityDetection: false,
      },
      ...overrides,
    });

    it('should return empty array when no agents file exists', async () => {
      const service = await getPersistenceService();

      const agents = service.loadAgents();
      expect(agents).toEqual([]);
    });

    it('should save and load valid agents', async () => {
      const service = await getPersistenceService();

      const testAgents = [createValidAgent()];

      service.saveAgents(testAgents);
      const loaded = service.loadAgents();

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

      service.saveAgents(testAgents);
      const loaded = service.loadAgents();

      expect(loaded).toEqual(testAgents);
    });

    it('should skip agents with missing required fields', async () => {
      const service = await getPersistenceService();
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

      // Write raw JSON with invalid agents directly to file
      const agentsFile = path.join(getTestConfigDir(), 'agents.json');
      const invalidAgents = [
        { id: 'valid', name: 'Valid', commandTemplate: 'test {{prompt}}', isBuiltIn: false, registeredAt: '2024-01-01', capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false } },
        { name: 'Missing ID', commandTemplate: 'test {{prompt}}' }, // Missing id
        { id: 'missing-name', commandTemplate: 'test {{prompt}}' }, // Missing name
        { id: 'missing-template', name: 'Missing Template' }, // Missing commandTemplate
      ];
      fs.writeFileSync(agentsFile, JSON.stringify(invalidAgents));

      const loaded = service.loadAgents();

      expect(loaded.length).toBe(1);
      expect(loaded[0].id).toBe('valid');
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('should skip agents with invalid askingPatterns regex', async () => {
      const service = await getPersistenceService();
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

      // Write raw JSON with invalid regex directly to file
      const agentsFile = path.join(getTestConfigDir(), 'agents.json');
      const agentsWithInvalidRegex = [
        {
          id: 'valid-agent',
          name: 'Valid Agent',
          commandTemplate: 'test {{prompt}}',
          isBuiltIn: false,
          registeredAt: '2024-01-01',
          capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
        },
        {
          id: 'invalid-regex-agent',
          name: 'Invalid Regex Agent',
          commandTemplate: 'test {{prompt}}',
          isBuiltIn: false,
          registeredAt: '2024-01-01',
          activityPatterns: {
            askingPatterns: ['[invalid regex'],
          },
          capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: true },
        },
      ];
      fs.writeFileSync(agentsFile, JSON.stringify(agentsWithInvalidRegex));

      const loaded = service.loadAgents();

      expect(loaded.length).toBe(1);
      expect(loaded[0].id).toBe('valid-agent');
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('should get agent by id', async () => {
      const service = await getPersistenceService();

      const testAgents = [
        createValidAgent({ id: 'agent-1', name: 'Agent 1' }),
        createValidAgent({ id: 'agent-2', name: 'Agent 2' }),
      ];

      service.saveAgents(testAgents);

      const agent = service.getAgent('agent-1');
      expect(agent?.name).toBe('Agent 1');
    });

    it('should return undefined for non-existent agent', async () => {
      const service = await getPersistenceService();

      const agent = service.getAgent('non-existent');
      expect(agent).toBeUndefined();
    });

    it('should remove custom agent', async () => {
      const service = await getPersistenceService();

      const testAgents = [
        createValidAgent({ id: 'agent-1', name: 'Agent 1' }),
        createValidAgent({ id: 'agent-2', name: 'Agent 2' }),
      ];

      service.saveAgents(testAgents);
      const removed = service.removeAgent('agent-1');

      expect(removed).toBe(true);
      const loaded = service.loadAgents();
      expect(loaded.length).toBe(1);
      expect(loaded[0].id).toBe('agent-2');
    });

    it('should not remove built-in agent', async () => {
      const service = await getPersistenceService();

      const testAgents = [createValidAgent({ id: 'built-in-1', name: 'Built-in', isBuiltIn: true })];

      service.saveAgents(testAgents);
      const removed = service.removeAgent('built-in-1');

      expect(removed).toBe(false);
      const loaded = service.loadAgents();
      expect(loaded.length).toBe(1);
    });
  });
});
