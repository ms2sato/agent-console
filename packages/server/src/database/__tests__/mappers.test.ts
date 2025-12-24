import { describe, it, expect } from 'bun:test';
import {
  toSessionRow,
  toWorkerRow,
  toPersistedSession,
  toPersistedWorker,
  toRepositoryRow,
  toRepository,
  toAgentRow,
  toAgentDefinition,
  DataIntegrityError,
  assertNever,
} from '../mappers.js';
import type { Session, Worker, RepositoryRow, AgentRow } from '../schema.js';
import type {
  PersistedAgentWorker,
  PersistedTerminalWorker,
  PersistedGitDiffWorker,
  PersistedWorktreeSession,
  PersistedQuickSession,
  PersistedRepository,
} from '../../services/persistence-service.js';
import type { AgentDefinition } from '@agent-console/shared';

describe('mappers', () => {
  describe('toSessionRow', () => {
    it('should convert worktree session with all fields', () => {
      const session: PersistedWorktreeSession = {
        id: 'session-1',
        type: 'worktree',
        locationPath: '/path/to/worktree',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        serverPid: 1234,
        createdAt: '2024-01-01T00:00:00.000Z',
        workers: [],
        initialPrompt: 'Test prompt',
        title: 'Test Session',
      };

      const row = toSessionRow(session);

      expect(row.id).toBe('session-1');
      expect(row.type).toBe('worktree');
      expect(row.location_path).toBe('/path/to/worktree');
      expect(row.repository_id).toBe('repo-1');
      expect(row.worktree_id).toBe('feature-branch');
      expect(row.server_pid).toBe(1234);
      expect(row.initial_prompt).toBe('Test prompt');
      expect(row.title).toBe('Test Session');
    });

    it('should convert worktree session with optional fields undefined', () => {
      const session: PersistedWorktreeSession = {
        id: 'session-1',
        type: 'worktree',
        locationPath: '/path/to/worktree',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        createdAt: '2024-01-01T00:00:00.000Z',
        workers: [],
      };

      const row = toSessionRow(session);

      expect(row.server_pid).toBeNull();
      expect(row.initial_prompt).toBeNull();
      expect(row.title).toBeNull();
    });

    it('should convert quick session with all fields', () => {
      const session: PersistedQuickSession = {
        id: 'session-1',
        type: 'quick',
        locationPath: '/path/to/project',
        serverPid: 5678,
        createdAt: '2024-01-01T00:00:00.000Z',
        workers: [],
        initialPrompt: 'Quick prompt',
        title: 'Quick Session',
      };

      const row = toSessionRow(session);

      expect(row.id).toBe('session-1');
      expect(row.type).toBe('quick');
      expect(row.repository_id).toBeNull();
      expect(row.worktree_id).toBeNull();
    });
  });

  describe('toWorkerRow', () => {
    it('should convert agent worker with pid', () => {
      const worker: PersistedAgentWorker = {
        id: 'worker-1',
        type: 'agent',
        name: 'Claude',
        agentId: 'claude-code-builtin',
        pid: 9999,
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      const row = toWorkerRow(worker, 'session-1');

      expect(row.id).toBe('worker-1');
      expect(row.session_id).toBe('session-1');
      expect(row.type).toBe('agent');
      expect(row.agent_id).toBe('claude-code-builtin');
      expect(row.pid).toBe(9999);
      expect(row.base_commit).toBeNull();
    });

    it('should convert terminal worker', () => {
      const worker: PersistedTerminalWorker = {
        id: 'worker-1',
        type: 'terminal',
        name: 'Terminal',
        pid: 8888,
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      const row = toWorkerRow(worker, 'session-1');

      expect(row.type).toBe('terminal');
      expect(row.agent_id).toBeNull();
      expect(row.base_commit).toBeNull();
    });

    it('should convert git-diff worker', () => {
      const worker: PersistedGitDiffWorker = {
        id: 'worker-1',
        type: 'git-diff',
        name: 'Git Diff',
        baseCommit: 'abc123',
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      const row = toWorkerRow(worker, 'session-1');

      expect(row.type).toBe('git-diff');
      expect(row.pid).toBeNull();
      expect(row.agent_id).toBeNull();
      expect(row.base_commit).toBe('abc123');
    });
  });

  describe('toPersistedWorker - data integrity', () => {
    it('should throw DataIntegrityError when agent_id is missing for agent worker', () => {
      const dbWorker: Worker = {
        id: 'worker-1',
        session_id: 'session-1',
        type: 'agent',
        name: 'Agent',
        created_at: new Date().toISOString(),
        pid: null,
        agent_id: null, // Missing required field
        base_commit: null,
      };

      expect(() => toPersistedWorker(dbWorker)).toThrow(DataIntegrityError);
      expect(() => toPersistedWorker(dbWorker)).toThrow(/agent_id/);
    });

    it('should throw DataIntegrityError when base_commit is missing for git-diff worker', () => {
      const dbWorker: Worker = {
        id: 'worker-1',
        session_id: 'session-1',
        type: 'git-diff',
        name: 'Git Diff',
        created_at: new Date().toISOString(),
        pid: null,
        agent_id: null,
        base_commit: null, // Missing required field
      };

      expect(() => toPersistedWorker(dbWorker)).toThrow(DataIntegrityError);
      expect(() => toPersistedWorker(dbWorker)).toThrow(/base_commit/);
    });

    it('should convert valid agent worker', () => {
      const dbWorker: Worker = {
        id: 'worker-1',
        session_id: 'session-1',
        type: 'agent',
        name: 'Agent',
        created_at: '2024-01-01T00:00:00.000Z',
        pid: 1234,
        agent_id: 'claude-code-builtin',
        base_commit: null,
      };

      const worker = toPersistedWorker(dbWorker);

      expect(worker.type).toBe('agent');
      expect((worker as PersistedAgentWorker).agentId).toBe('claude-code-builtin');
    });

    it('should convert valid terminal worker', () => {
      const dbWorker: Worker = {
        id: 'worker-1',
        session_id: 'session-1',
        type: 'terminal',
        name: 'Terminal',
        created_at: '2024-01-01T00:00:00.000Z',
        pid: 5678,
        agent_id: null,
        base_commit: null,
      };

      const worker = toPersistedWorker(dbWorker);

      expect(worker.type).toBe('terminal');
      expect((worker as PersistedTerminalWorker).pid).toBe(5678);
    });

    it('should convert valid git-diff worker', () => {
      const dbWorker: Worker = {
        id: 'worker-1',
        session_id: 'session-1',
        type: 'git-diff',
        name: 'Git Diff',
        created_at: '2024-01-01T00:00:00.000Z',
        pid: null,
        agent_id: null,
        base_commit: 'abc123def456',
      };

      const worker = toPersistedWorker(dbWorker);

      expect(worker.type).toBe('git-diff');
      expect((worker as PersistedGitDiffWorker).baseCommit).toBe('abc123def456');
    });
  });

  describe('toPersistedSession - data integrity', () => {
    it('should throw DataIntegrityError when repository_id is missing for worktree session', () => {
      const dbSession: Session = {
        id: 'session-1',
        type: 'worktree',
        location_path: '/path',
        server_pid: 1234,
        created_at: new Date().toISOString(),
        initial_prompt: null,
        title: null,
        repository_id: null, // Missing required field
        worktree_id: 'branch',
      };

      expect(() => toPersistedSession(dbSession, [])).toThrow(DataIntegrityError);
      expect(() => toPersistedSession(dbSession, [])).toThrow(/repository_id/);
    });

    it('should throw DataIntegrityError when worktree_id is missing for worktree session', () => {
      const dbSession: Session = {
        id: 'session-1',
        type: 'worktree',
        location_path: '/path',
        server_pid: 1234,
        created_at: new Date().toISOString(),
        initial_prompt: null,
        title: null,
        repository_id: 'repo-1',
        worktree_id: null, // Missing required field
      };

      expect(() => toPersistedSession(dbSession, [])).toThrow(DataIntegrityError);
      expect(() => toPersistedSession(dbSession, [])).toThrow(/worktree_id/);
    });

    it('should convert valid quick session', () => {
      const dbSession: Session = {
        id: 'session-1',
        type: 'quick',
        location_path: '/path',
        server_pid: 1234,
        created_at: '2024-01-01T00:00:00.000Z',
        initial_prompt: 'test',
        title: 'Test',
        repository_id: null,
        worktree_id: null,
      };

      const session = toPersistedSession(dbSession, []);

      expect(session.type).toBe('quick');
      expect(session.initialPrompt).toBe('test');
    });

    it('should convert valid worktree session', () => {
      const dbSession: Session = {
        id: 'session-1',
        type: 'worktree',
        location_path: '/path/to/worktree',
        server_pid: 1234,
        created_at: '2024-01-01T00:00:00.000Z',
        initial_prompt: 'test prompt',
        title: 'Test Session',
        repository_id: 'repo-1',
        worktree_id: 'feature-branch',
      };

      const session = toPersistedSession(dbSession, []);

      expect(session.type).toBe('worktree');
      expect((session as PersistedWorktreeSession).repositoryId).toBe('repo-1');
      expect((session as PersistedWorktreeSession).worktreeId).toBe('feature-branch');
    });

    it('should include provided workers in session', () => {
      const dbSession: Session = {
        id: 'session-1',
        type: 'quick',
        location_path: '/path',
        server_pid: 1234,
        created_at: '2024-01-01T00:00:00.000Z',
        initial_prompt: null,
        title: null,
        repository_id: null,
        worktree_id: null,
      };

      const workers: PersistedAgentWorker[] = [
        {
          id: 'worker-1',
          type: 'agent',
          name: 'Claude',
          agentId: 'claude-code-builtin',
          pid: 1234,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ];

      const session = toPersistedSession(dbSession, workers);

      expect(session.workers).toHaveLength(1);
      expect(session.workers[0].id).toBe('worker-1');
    });

    it('should handle optional fields as undefined when null in database', () => {
      const dbSession: Session = {
        id: 'session-1',
        type: 'quick',
        location_path: '/path',
        server_pid: null,
        created_at: '2024-01-01T00:00:00.000Z',
        initial_prompt: null,
        title: null,
        repository_id: null,
        worktree_id: null,
      };

      const session = toPersistedSession(dbSession, []);

      expect(session.serverPid).toBeUndefined();
      expect(session.initialPrompt).toBeUndefined();
      expect(session.title).toBeUndefined();
    });
  });

  describe('DataIntegrityError', () => {
    it('should have correct error message format', () => {
      const error = new DataIntegrityError('worker', 'worker-123', 'agent_id (missing required field)');

      expect(error.message).toBe(
        "Data integrity error: worker 'worker-123' has invalid agent_id (missing required field)"
      );
      expect(error.entityType).toBe('worker');
      expect(error.entityId).toBe('worker-123');
      expect(error.issue).toBe('agent_id (missing required field)');
    });

    it('should be instanceof Error', () => {
      const error = new DataIntegrityError('session', 'session-1', 'repository_id (missing required field)');
      expect(error instanceof Error).toBe(true);
      expect(error instanceof DataIntegrityError).toBe(true);
    });

    it('should have correct name property', () => {
      const error = new DataIntegrityError('worker', 'worker-1', 'type (unexpected value: unknown)');
      expect(error.name).toBe('DataIntegrityError');
    });
  });

  describe('toPersistedWorker - type validation', () => {
    it('should throw DataIntegrityError for unknown worker type', () => {
      // Simulate database corruption where type column has an unexpected value
      const dbWorker = {
        id: 'worker-1',
        session_id: 'session-1',
        type: 'unknown-type',
        name: 'Unknown',
        created_at: new Date().toISOString(),
        pid: null,
        agent_id: null,
        base_commit: null,
      } as unknown as Worker;

      expect(() => toPersistedWorker(dbWorker)).toThrow(DataIntegrityError);
      expect(() => toPersistedWorker(dbWorker)).toThrow(/type \(unexpected value: unknown-type\)/);
    });
  });

  describe('toPersistedSession - type validation', () => {
    it('should throw DataIntegrityError for unknown session type', () => {
      // Simulate database corruption where type column has an unexpected value
      const dbSession = {
        id: 'session-1',
        type: 'invalid-type',
        location_path: '/path',
        server_pid: 1234,
        created_at: new Date().toISOString(),
        initial_prompt: null,
        title: null,
        repository_id: null,
        worktree_id: null,
      } as unknown as Session;

      expect(() => toPersistedSession(dbSession, [])).toThrow(DataIntegrityError);
      expect(() => toPersistedSession(dbSession, [])).toThrow(/type \(unexpected value: invalid-type\)/);
    });
  });

  describe('assertNever', () => {
    it('should throw error with message when called', () => {
      // This should never be called in normal code, but we test it for coverage
      expect(() => assertNever('invalid' as never, 'Unexpected value')).toThrow('Unexpected value');
    });

    it('should include the unexpected value in the error message', () => {
      expect(() => assertNever('test-value' as never, 'Unknown type')).toThrow(
        'Unknown type: Unexpected value: "test-value"'
      );
    });

    it('should work without a custom message', () => {
      expect(() => assertNever('some-value' as never)).toThrow('Unexpected value: "some-value"');
    });
  });

  describe('toRepositoryRow', () => {
    it('should convert Repository to database row', () => {
      const repository: PersistedRepository = {
        id: 'repo-1',
        name: 'my-project',
        path: '/home/user/projects/my-project',
        registeredAt: '2024-01-15T10:30:00.000Z',
      };

      const row = toRepositoryRow(repository);

      expect(row.id).toBe('repo-1');
      expect(row.name).toBe('my-project');
      expect(row.path).toBe('/home/user/projects/my-project');
      expect(row.registered_at).toBe('2024-01-15T10:30:00.000Z');
    });
  });

  describe('toRepository', () => {
    it('should convert database row to Repository', () => {
      const row: RepositoryRow = {
        id: 'repo-2',
        name: 'another-project',
        path: '/opt/repos/another-project',
        registered_at: '2024-02-20T14:00:00.000Z',
      };

      const repository = toRepository(row);

      expect(repository.id).toBe('repo-2');
      expect(repository.name).toBe('another-project');
      expect(repository.path).toBe('/opt/repos/another-project');
      expect(repository.registeredAt).toBe('2024-02-20T14:00:00.000Z');
    });

    it('should handle registered_at correctly', () => {
      const row: RepositoryRow = {
        id: 'repo-3',
        name: 'test-repo',
        path: '/tmp/test-repo',
        registered_at: '2024-12-01T00:00:00.000Z',
      };

      const repository = toRepository(row);

      // Verify registeredAt is correctly mapped from registered_at
      expect(repository.registeredAt).toBe('2024-12-01T00:00:00.000Z');
    });
  });

  describe('toAgentRow', () => {
    it('should convert AgentDefinition to database row', () => {
      const agent: AgentDefinition = {
        id: 'custom-agent-1',
        name: 'My Custom Agent',
        commandTemplate: 'my-agent --prompt {{prompt}} --dir {{cwd}}',
        continueTemplate: 'my-agent --continue --dir {{cwd}}',
        headlessTemplate: 'my-agent --headless --prompt {{prompt}} --dir {{cwd}}',
        description: 'A custom agent for testing',
        isBuiltIn: false,
        registeredAt: '2024-03-10T09:00:00.000Z',
        capabilities: {
          supportsContinue: true,
          supportsHeadlessMode: true,
          supportsActivityDetection: false,
        },
      };

      const row = toAgentRow(agent);

      expect(row.id).toBe('custom-agent-1');
      expect(row.name).toBe('My Custom Agent');
      expect(row.command_template).toBe('my-agent --prompt {{prompt}} --dir {{cwd}}');
      expect(row.continue_template).toBe('my-agent --continue --dir {{cwd}}');
      expect(row.headless_template).toBe('my-agent --headless --prompt {{prompt}} --dir {{cwd}}');
      expect(row.description).toBe('A custom agent for testing');
      expect(row.is_built_in).toBe(0);
      expect(row.registered_at).toBe('2024-03-10T09:00:00.000Z');
      expect(row.activity_patterns).toBeNull();
    });

    it('should serialize activityPatterns as JSON', () => {
      const agent: AgentDefinition = {
        id: 'agent-with-patterns',
        name: 'Agent With Patterns',
        commandTemplate: 'agent-cmd {{prompt}}',
        isBuiltIn: false,
        registeredAt: '2024-03-10T09:00:00.000Z',
        activityPatterns: {
          askingPatterns: ['^Question:', '^Input needed:'],
        },
        capabilities: {
          supportsContinue: false,
          supportsHeadlessMode: false,
          supportsActivityDetection: true,
        },
      };

      const row = toAgentRow(agent);

      expect(row.activity_patterns).not.toBeNull();
      const parsed = JSON.parse(row.activity_patterns!);
      expect(parsed.askingPatterns).toEqual(['^Question:', '^Input needed:']);
    });

    it('should handle null optional fields', () => {
      const agent: AgentDefinition = {
        id: 'minimal-agent',
        name: 'Minimal Agent',
        commandTemplate: 'minimal-cmd {{prompt}}',
        isBuiltIn: false,
        registeredAt: '2024-03-10T09:00:00.000Z',
        // No optional fields
        capabilities: {
          supportsContinue: false,
          supportsHeadlessMode: false,
          supportsActivityDetection: false,
        },
      };

      const row = toAgentRow(agent);

      expect(row.continue_template).toBeNull();
      expect(row.headless_template).toBeNull();
      expect(row.description).toBeNull();
      expect(row.activity_patterns).toBeNull();
    });
  });

  describe('toAgentDefinition', () => {
    it('should convert database row to AgentDefinition', () => {
      const row: AgentRow = {
        id: 'db-agent-1',
        name: 'DB Agent',
        command_template: 'db-agent --prompt {{prompt}}',
        continue_template: 'db-agent --continue',
        headless_template: 'db-agent --headless {{prompt}}',
        description: 'Agent from database',
        is_built_in: 0,
        registered_at: '2024-04-01T12:00:00.000Z',
        activity_patterns: null,
      };

      const agent = toAgentDefinition(row);

      expect(agent.id).toBe('db-agent-1');
      expect(agent.name).toBe('DB Agent');
      expect(agent.commandTemplate).toBe('db-agent --prompt {{prompt}}');
      expect(agent.continueTemplate).toBe('db-agent --continue');
      expect(agent.headlessTemplate).toBe('db-agent --headless {{prompt}}');
      expect(agent.description).toBe('Agent from database');
      expect(agent.isBuiltIn).toBe(false);
      expect(agent.registeredAt).toBe('2024-04-01T12:00:00.000Z');
      expect(agent.activityPatterns).toBeUndefined();
    });

    it('should parse activityPatterns JSON', () => {
      const row: AgentRow = {
        id: 'agent-patterns',
        name: 'Agent With Patterns',
        command_template: 'cmd {{prompt}}',
        continue_template: null,
        headless_template: null,
        description: null,
        is_built_in: 0,
        registered_at: '2024-04-01T12:00:00.000Z',
        activity_patterns: JSON.stringify({
          askingPatterns: ['^Ask:', '^Input:'],
        }),
      };

      const agent = toAgentDefinition(row);

      expect(agent.activityPatterns).toBeDefined();
      expect(agent.activityPatterns!.askingPatterns).toEqual(['^Ask:', '^Input:']);
    });

    it('should recompute capabilities from templates', () => {
      // Agent with continue and headless templates
      const rowWithBoth: AgentRow = {
        id: 'capable-agent',
        name: 'Capable Agent',
        command_template: 'cmd {{prompt}}',
        continue_template: 'cmd --continue',
        headless_template: 'cmd --headless {{prompt}}',
        description: null,
        is_built_in: 0,
        registered_at: '2024-04-01T12:00:00.000Z',
        activity_patterns: null,
      };

      const agentWithBoth = toAgentDefinition(rowWithBoth);
      expect(agentWithBoth.capabilities.supportsContinue).toBe(true);
      expect(agentWithBoth.capabilities.supportsHeadlessMode).toBe(true);

      // Agent without templates
      const rowWithout: AgentRow = {
        id: 'basic-agent',
        name: 'Basic Agent',
        command_template: 'basic {{prompt}}',
        continue_template: null,
        headless_template: null,
        description: null,
        is_built_in: 0,
        registered_at: '2024-04-01T12:00:00.000Z',
        activity_patterns: null,
      };

      const agentWithout = toAgentDefinition(rowWithout);
      expect(agentWithout.capabilities.supportsContinue).toBe(false);
      expect(agentWithout.capabilities.supportsHeadlessMode).toBe(false);
    });

    it('should handle null/undefined optional fields', () => {
      const row: AgentRow = {
        id: 'null-fields-agent',
        name: 'Agent With Nulls',
        command_template: 'cmd {{prompt}}',
        continue_template: null,
        headless_template: null,
        description: null,
        is_built_in: 0,
        registered_at: null, // This can be null in DB
        activity_patterns: null,
      };

      const agent = toAgentDefinition(row);

      expect(agent.continueTemplate).toBeUndefined();
      expect(agent.headlessTemplate).toBeUndefined();
      expect(agent.description).toBeUndefined();
      expect(agent.activityPatterns).toBeUndefined();
      // registeredAt should have a fallback when null
      expect(agent.registeredAt).toBeDefined();
    });
  });
});
