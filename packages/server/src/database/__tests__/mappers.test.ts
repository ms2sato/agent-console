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
  toEmbeddedAgentRow,
  toEmbeddedAgentDefinition,
  DataIntegrityError,
  assertNever,
} from '../mappers.js';
import type { Session, Worker, RepositoryRow, AgentRow, EmbeddedAgentRow } from '../schema.js';
import type { EmbeddedAgentDefinition } from '@agent-console/shared';
import type {
  PersistedAgentWorker,
  PersistedTerminalWorker,
  PersistedGitDiffWorker,
  PersistedEmbeddedAgentWorker,
  PersistedWorktreeSession,
} from '../../services/persistence-service.js';
import {
  buildPersistedWorktreeSession,
  buildPersistedQuickSession,
  buildPersistedAgentWorker,
  buildPersistedTerminalWorker,
  buildPersistedGitDiffWorker,
  buildPersistedEmbeddedAgentWorker,
  buildPersistedRepository,
  buildAgentDefinition,
} from '../../__tests__/utils/build-test-data.js';

describe('mappers', () => {
  describe('toSessionRow', () => {
    it('should convert worktree session with all fields', () => {
      const session = buildPersistedWorktreeSession({
        id: 'session-1',
        locationPath: '/path/to/worktree',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        serverPid: 1234,
        createdAt: '2024-01-01T00:00:00.000Z',
        initialPrompt: 'Test prompt',
        title: 'Test Session',
      });

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
      const session = buildPersistedWorktreeSession({
        id: 'session-1',
        locationPath: '/path/to/worktree',
        repositoryId: 'repo-1',
        worktreeId: 'feature-branch',
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const row = toSessionRow(session);

      expect(row.server_pid).toBeNull();
      expect(row.initial_prompt).toBeNull();
      expect(row.title).toBeNull();
    });

    it('should convert quick session with all fields', () => {
      const session = buildPersistedQuickSession({
        id: 'session-1',
        locationPath: '/path/to/project',
        serverPid: 5678,
        createdAt: '2024-01-01T00:00:00.000Z',
        initialPrompt: 'Quick prompt',
        title: 'Quick Session',
      });

      const row = toSessionRow(session);

      expect(row.id).toBe('session-1');
      expect(row.type).toBe('quick');
      expect(row.repository_id).toBeNull();
      expect(row.worktree_id).toBeNull();
    });

    it('should map pausedAt to paused_at', () => {
      const session = buildPersistedQuickSession({
        id: 'session-1',
        locationPath: '/path/to/project',
        createdAt: '2024-01-01T00:00:00.000Z',
        pausedAt: '2025-06-15T12:00:00.000Z',
      });

      const row = toSessionRow(session);

      expect(row.paused_at).toBe('2025-06-15T12:00:00.000Z');
    });

    it('should map undefined pausedAt to null paused_at', () => {
      const session = buildPersistedQuickSession({
        id: 'session-1',
        locationPath: '/path/to/project',
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const row = toSessionRow(session);

      expect(row.paused_at).toBeNull();
    });

    it('should map initialPromptDelivered true/false to 1/0', () => {
      const delivered = buildPersistedQuickSession({
        id: 'session-1',
        locationPath: '/path/to/project',
        createdAt: '2024-01-01T00:00:00.000Z',
        initialPromptDelivered: true,
      });
      const notDelivered = buildPersistedQuickSession({
        id: 'session-2',
        locationPath: '/path/to/project',
        createdAt: '2024-01-01T00:00:00.000Z',
        initialPromptDelivered: false,
      });

      expect(toSessionRow(delivered).initial_prompt_delivered).toBe(1);
      expect(toSessionRow(notDelivered).initial_prompt_delivered).toBe(0);
    });

    it('should map undefined initialPromptDelivered to null', () => {
      const session = buildPersistedQuickSession({
        id: 'session-1',
        locationPath: '/path/to/project',
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const row = toSessionRow(session);

      expect(row.initial_prompt_delivered).toBeNull();
    });
  });

  describe('toWorkerRow', () => {
    it('should convert agent worker with pid', () => {
      const worker = buildPersistedAgentWorker({
        id: 'worker-1',
        name: 'Claude',
        agentId: 'claude-code-builtin',
        pid: 9999,
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const row = toWorkerRow(worker, 'session-1');

      expect(row.id).toBe('worker-1');
      expect(row.session_id).toBe('session-1');
      expect(row.type).toBe('agent');
      expect(row.agent_id).toBe('claude-code-builtin');
      expect(row.pid).toBe(9999);
      expect(row.base_commit).toBeNull();
    });

    it('should convert terminal worker', () => {
      const worker = buildPersistedTerminalWorker({
        id: 'worker-1',
        name: 'Terminal',
        pid: 8888,
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const row = toWorkerRow(worker, 'session-1');

      expect(row.type).toBe('terminal');
      expect(row.agent_id).toBeNull();
      expect(row.base_commit).toBeNull();
    });

    it('should convert git-diff worker', () => {
      const worker = buildPersistedGitDiffWorker({
        id: 'worker-1',
        name: 'Git Diff',
        baseCommit: 'abc123',
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const row = toWorkerRow(worker, 'session-1');

      expect(row.type).toBe('git-diff');
      expect(row.pid).toBeNull();
      expect(row.agent_id).toBeNull();
      expect(row.base_commit).toBe('abc123');
      expect(row.embedded_agent_id).toBeNull();
    });

    it('sets embedded_agent_id null for agent workers', () => {
      const worker = buildPersistedAgentWorker({ id: 'worker-1' });
      const row = toWorkerRow(worker, 'session-1');
      expect(row.embedded_agent_id).toBeNull();
    });

    it('should convert embedded-agent worker', () => {
      const worker = buildPersistedEmbeddedAgentWorker({
        id: 'worker-1',
        name: 'Embedded Agent',
        embeddedAgentId: 'def-1',
        pid: 4321,
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const row = toWorkerRow(worker, 'session-1');

      expect(row.type).toBe('embedded-agent');
      expect(row.embedded_agent_id).toBe('def-1');
      expect(row.pid).toBe(4321);
      expect(row.agent_id).toBeNull();
      expect(row.base_commit).toBeNull();
    });

    it('writes deliver_initial_prompt_on_activation: 1 when the persisted worker is eligible', () => {
      const worker = buildPersistedEmbeddedAgentWorker({
        id: 'worker-1',
        embeddedAgentId: 'def-1',
        deliverInitialPromptOnActivation: true,
      });

      const row = toWorkerRow(worker, 'session-1');

      expect(row.deliver_initial_prompt_on_activation).toBe(1);
    });

    it('writes deliver_initial_prompt_on_activation: 0 when the persisted worker is not eligible', () => {
      const worker = buildPersistedEmbeddedAgentWorker({
        id: 'worker-1',
        embeddedAgentId: 'def-1',
        deliverInitialPromptOnActivation: false,
      });

      const row = toWorkerRow(worker, 'session-1');

      expect(row.deliver_initial_prompt_on_activation).toBe(0);
    });
  });

  describe('toSessionRow - scope+slug invariants', () => {
    it('should accept legacy session with no dataScope', () => {
      const session = buildPersistedQuickSession({
        id: 'legacy-session',
        // no dataScope, no dataScopeSlug
      });
      // Strip the scope-related fields to simulate legacy state
      const legacy = { ...session };
      delete (legacy as { dataScope?: unknown }).dataScope;
      delete (legacy as { dataScopeSlug?: unknown }).dataScopeSlug;

      const row = toSessionRow(legacy);
      expect(row.data_scope).toBeNull();
      expect(row.data_scope_slug).toBeNull();
    });

    it('should accept quick scope with null slug', () => {
      const session = buildPersistedQuickSession({
        id: 'quick-session',
        dataScope: 'quick',
        dataScopeSlug: null,
      });
      const row = toSessionRow(session);
      expect(row.data_scope).toBe('quick');
      expect(row.data_scope_slug).toBeNull();
    });

    it('should throw DataIntegrityError when quick scope has a non-null slug', () => {
      const session = buildPersistedQuickSession({
        id: 'bad-quick',
        dataScope: 'quick',
        dataScopeSlug: 'unexpected-slug',
      });
      expect(() => toSessionRow(session)).toThrow(DataIntegrityError);
      expect(() => toSessionRow(session)).toThrow(/dataScopeSlug must be null for quick scope/);
    });

    it('should accept repository scope with non-empty slug', () => {
      const session = buildPersistedWorktreeSession({
        id: 'repo-session',
        dataScope: 'repository',
        dataScopeSlug: 'owner/repo',
      });
      const row = toSessionRow(session);
      expect(row.data_scope).toBe('repository');
      expect(row.data_scope_slug).toBe('owner/repo');
    });

    it('should throw DataIntegrityError when repository scope has null slug', () => {
      const session = buildPersistedWorktreeSession({
        id: 'bad-repo',
        dataScope: 'repository',
        dataScopeSlug: null,
      });
      expect(() => toSessionRow(session)).toThrow(DataIntegrityError);
      expect(() => toSessionRow(session)).toThrow(/dataScopeSlug required for repository scope/);
    });

    it('should throw DataIntegrityError when repository scope has empty string slug', () => {
      const session = buildPersistedWorktreeSession({
        id: 'bad-repo-empty',
        dataScope: 'repository',
        dataScopeSlug: '',
      });
      expect(() => toSessionRow(session)).toThrow(DataIntegrityError);
      expect(() => toSessionRow(session)).toThrow(/dataScopeSlug required for repository scope/);
    });
  });

  describe('toPersistedSession - scope+slug invariants', () => {
    function makeSessionRow(overrides: Partial<Session>): Session {
      return {
        id: 'session-1',
        type: 'quick',
        location_path: '/path',
        server_pid: null,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
        initial_prompt: null,
        initial_prompt_delivered: null,
        title: null,
        repository_id: null,
        worktree_id: null,
        paused_at: null,
        parent_session_id: null,
        parent_worker_id: null,
        created_by: null,
        initiated_by: null,
        data_scope: null,
        data_scope_slug: null,
        recovery_state: 'healthy',
        orphaned_at: null,
        orphaned_reason: null,
        ...overrides,
      };
    }

    it('should accept null scope (legacy row) without throwing', () => {
      const row = makeSessionRow({ data_scope: null, data_scope_slug: null });
      const session = toPersistedSession(row, []);
      expect(session.dataScope).toBeUndefined();
    });

    it('should throw when scope=quick has a non-null slug in DB', () => {
      const row = makeSessionRow({ data_scope: 'quick', data_scope_slug: 'unexpected' });
      expect(() => toPersistedSession(row, [])).toThrow(DataIntegrityError);
      expect(() => toPersistedSession(row, [])).toThrow(/inconsistent scope\+slug combination/);
    });

    it('should throw when scope=repository has null slug in DB', () => {
      const row = makeSessionRow({
        type: 'worktree',
        repository_id: 'repo-1',
        worktree_id: 'wt-1',
        data_scope: 'repository',
        data_scope_slug: null,
      });
      expect(() => toPersistedSession(row, [])).toThrow(DataIntegrityError);
      expect(() => toPersistedSession(row, [])).toThrow(/inconsistent scope\+slug combination/);
    });

    it('should throw when scope=repository has empty string slug in DB', () => {
      const row = makeSessionRow({
        type: 'worktree',
        repository_id: 'repo-1',
        worktree_id: 'wt-1',
        data_scope: 'repository',
        data_scope_slug: '',
      });
      expect(() => toPersistedSession(row, [])).toThrow(DataIntegrityError);
      expect(() => toPersistedSession(row, [])).toThrow(/inconsistent scope\+slug combination/);
    });

    it('should throw when data_scope is an unknown value', () => {
      const row = makeSessionRow({
        // Simulate database corruption: column type is wider than the union
        data_scope: 'unknown' as unknown as 'quick' | 'repository' | null,
        data_scope_slug: null,
      });
      expect(() => toPersistedSession(row, [])).toThrow(DataIntegrityError);
      expect(() => toPersistedSession(row, [])).toThrow(/data_scope \(unexpected value: unknown\)/);
    });

    it('should accept valid quick scope (null slug) on read', () => {
      const row = makeSessionRow({ data_scope: 'quick', data_scope_slug: null });
      const session = toPersistedSession(row, []);
      expect(session.dataScope).toBe('quick');
      expect(session.dataScopeSlug).toBeNull();
    });

    it('should accept valid repository scope (non-empty slug) on read', () => {
      const row = makeSessionRow({
        type: 'worktree',
        repository_id: 'repo-1',
        worktree_id: 'wt-1',
        data_scope: 'repository',
        data_scope_slug: 'owner/repo',
      });
      const session = toPersistedSession(row, []);
      expect(session.dataScope).toBe('repository');
      expect(session.dataScopeSlug).toBe('owner/repo');
    });

    it('should throw when recovery_state is an unknown value', () => {
      const row = makeSessionRow({
        recovery_state: 'mystery' as unknown as 'healthy' | 'orphaned',
      });
      expect(() => toPersistedSession(row, [])).toThrow(DataIntegrityError);
      expect(() => toPersistedSession(row, [])).toThrow(/recovery_state \(unexpected value: mystery\)/);
    });

    it('should treat null recovery_state as healthy (legacy row)', () => {
      const row = makeSessionRow({
        recovery_state: null as unknown as 'healthy' | 'orphaned',
      });
      const session = toPersistedSession(row, []);
      expect(session.recoveryState).toBe('healthy');
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
        updated_at: new Date().toISOString(),
        pid: null,
        agent_id: null, // Missing required field
        base_commit: null,
        embedded_agent_id: null,
        deliver_initial_prompt_on_activation: null,
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
        updated_at: new Date().toISOString(),
        pid: null,
        agent_id: null,
        base_commit: null, // Missing required field
        embedded_agent_id: null,
        deliver_initial_prompt_on_activation: null,
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
        updated_at: '2024-01-01T00:00:00.000Z',
        pid: 1234,
        agent_id: 'claude-code-builtin',
        base_commit: null,
        embedded_agent_id: null,
        deliver_initial_prompt_on_activation: null,
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
        updated_at: '2024-01-01T00:00:00.000Z',
        pid: 5678,
        agent_id: null,
        base_commit: null,
        embedded_agent_id: null,
        deliver_initial_prompt_on_activation: null,
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
        updated_at: '2024-01-01T00:00:00.000Z',
        pid: null,
        agent_id: null,
        base_commit: 'abc123def456',
        embedded_agent_id: null,
        deliver_initial_prompt_on_activation: null,
      };

      const worker = toPersistedWorker(dbWorker);

      expect(worker.type).toBe('git-diff');
      expect((worker as PersistedGitDiffWorker).baseCommit).toBe('abc123def456');
    });

    it('should throw DataIntegrityError when embedded_agent_id is missing for embedded-agent worker', () => {
      const dbWorker: Worker = {
        id: 'worker-1',
        session_id: 'session-1',
        type: 'embedded-agent',
        name: 'Embedded Agent',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
        pid: null,
        agent_id: null,
        base_commit: null,
        embedded_agent_id: null, // Missing required field
        deliver_initial_prompt_on_activation: null,
      };

      expect(() => toPersistedWorker(dbWorker)).toThrow(DataIntegrityError);
      expect(() => toPersistedWorker(dbWorker)).toThrow(/embedded_agent_id/);
    });

    it('should convert valid embedded-agent worker', () => {
      const dbWorker: Worker = {
        id: 'worker-1',
        session_id: 'session-1',
        type: 'embedded-agent',
        name: 'Embedded Agent',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
        pid: 4321,
        agent_id: null,
        base_commit: null,
        embedded_agent_id: 'def-1',
        deliver_initial_prompt_on_activation: 1,
      };

      const worker = toPersistedWorker(dbWorker);

      expect(worker.type).toBe('embedded-agent');
      expect((worker as PersistedEmbeddedAgentWorker).embeddedAgentId).toBe('def-1');
      expect((worker as PersistedEmbeddedAgentWorker).pid).toBe(4321);
      expect((worker as PersistedEmbeddedAgentWorker).deliverInitialPromptOnActivation).toBe(true);
    });

    it('maps deliver_initial_prompt_on_activation: null to deliverInitialPromptOnActivation: false', () => {
      const dbWorker: Worker = {
        id: 'worker-1',
        session_id: 'session-1',
        type: 'embedded-agent',
        name: 'Embedded Agent',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
        pid: null,
        agent_id: null,
        base_commit: null,
        embedded_agent_id: 'def-1',
        deliver_initial_prompt_on_activation: null,
      };

      const worker = toPersistedWorker(dbWorker);

      expect((worker as PersistedEmbeddedAgentWorker).deliverInitialPromptOnActivation).toBe(false);
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
        updated_at: new Date().toISOString(),
        initial_prompt: null,
        initial_prompt_delivered: null,
        title: null,
        repository_id: null, // Missing required field
        worktree_id: 'branch',
        paused_at: null,
        parent_session_id: null,
        parent_worker_id: null,
        created_by: null,
        initiated_by: null,
        data_scope: null,
        data_scope_slug: null,
        recovery_state: 'healthy',
        orphaned_at: null,
        orphaned_reason: null,
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
        updated_at: new Date().toISOString(),
        initial_prompt: null,
        initial_prompt_delivered: null,
        title: null,
        repository_id: 'repo-1',
        worktree_id: null, // Missing required field
        paused_at: null,
        parent_session_id: null,
        parent_worker_id: null,
        created_by: null,
        initiated_by: null,
        data_scope: null,
        data_scope_slug: null,
        recovery_state: 'healthy',
        orphaned_at: null,
        orphaned_reason: null,
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
        updated_at: '2024-01-01T00:00:00.000Z',
        initial_prompt: 'test',
        initial_prompt_delivered: null,
        title: 'Test',
        repository_id: null,
        worktree_id: null,
        paused_at: null,
        parent_session_id: null,
        parent_worker_id: null,
        created_by: null,
        initiated_by: null,
        data_scope: null,
        data_scope_slug: null,
        recovery_state: 'healthy',
        orphaned_at: null,
        orphaned_reason: null,
      };

      const session = toPersistedSession(dbSession, []);

      expect(session.type).toBe('quick');
      expect(session.initialPrompt).toBe('test');
    });

    it('should map initial_prompt_delivered 1/0/null to true/false/undefined', () => {
      const base: Omit<Session, 'initial_prompt_delivered'> = {
        id: 'session-1',
        type: 'quick',
        location_path: '/path',
        server_pid: 1234,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
        initial_prompt: 'test',
        title: 'Test',
        repository_id: null,
        worktree_id: null,
        paused_at: null,
        parent_session_id: null,
        parent_worker_id: null,
        created_by: null,
        initiated_by: null,
        data_scope: null,
        data_scope_slug: null,
        recovery_state: 'healthy',
        orphaned_at: null,
        orphaned_reason: null,
      };

      expect(toPersistedSession({ ...base, initial_prompt_delivered: 1 }, []).initialPromptDelivered).toBe(true);
      expect(toPersistedSession({ ...base, initial_prompt_delivered: 0 }, []).initialPromptDelivered).toBe(false);
      expect(toPersistedSession({ ...base, initial_prompt_delivered: null }, []).initialPromptDelivered).toBeUndefined();
    });

    it('should convert valid worktree session', () => {
      const dbSession: Session = {
        id: 'session-1',
        type: 'worktree',
        location_path: '/path/to/worktree',
        server_pid: 1234,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
        initial_prompt: 'test prompt',
        initial_prompt_delivered: null,
        title: 'Test Session',
        repository_id: 'repo-1',
        worktree_id: 'feature-branch',
        paused_at: null,
        parent_session_id: null,
        parent_worker_id: null,
        created_by: null,
        initiated_by: null,
        data_scope: null,
        data_scope_slug: null,
        recovery_state: 'healthy',
        orphaned_at: null,
        orphaned_reason: null,
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
        updated_at: '2024-01-01T00:00:00.000Z',
        initial_prompt: null,
        initial_prompt_delivered: null,
        title: null,
        repository_id: null,
        worktree_id: null,
        paused_at: null,
        parent_session_id: null,
        parent_worker_id: null,
        created_by: null,
        initiated_by: null,
        data_scope: null,
        data_scope_slug: null,
        recovery_state: 'healthy',
        orphaned_at: null,
        orphaned_reason: null,
      };

      const workers = [
        buildPersistedAgentWorker({
          id: 'worker-1',
          name: 'Claude',
          agentId: 'claude-code-builtin',
          pid: 1234,
          createdAt: '2024-01-01T00:00:00.000Z',
        }),
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
        updated_at: '2024-01-01T00:00:00.000Z',
        initial_prompt: null,
        initial_prompt_delivered: null,
        title: null,
        repository_id: null,
        worktree_id: null,
        paused_at: null,
        parent_session_id: null,
        parent_worker_id: null,
        created_by: null,
        initiated_by: null,
        data_scope: null,
        data_scope_slug: null,
        recovery_state: 'healthy',
        orphaned_at: null,
        orphaned_reason: null,
      };

      const session = toPersistedSession(dbSession, []);

      expect(session.serverPid).toBeUndefined();
      expect(session.initialPrompt).toBeUndefined();
      expect(session.title).toBeUndefined();
      expect(session.pausedAt).toBeUndefined();
    });

    it('should map paused_at timestamp to pausedAt', () => {
      const dbSession: Session = {
        id: 'session-1',
        type: 'quick',
        location_path: '/path',
        server_pid: null,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
        initial_prompt: null,
        initial_prompt_delivered: null,
        title: null,
        repository_id: null,
        worktree_id: null,
        paused_at: '2025-06-15T12:00:00.000Z',
        parent_session_id: null,
        parent_worker_id: null,
        created_by: null,
        initiated_by: null,
        data_scope: null,
        data_scope_slug: null,
        recovery_state: 'healthy',
        orphaned_at: null,
        orphaned_reason: null,
      };

      const session = toPersistedSession(dbSession, []);

      expect(session.pausedAt).toBe('2025-06-15T12:00:00.000Z');
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
        initial_prompt_delivered: null,
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
      const repository = buildPersistedRepository({
        id: 'repo-1',
        name: 'my-project',
        path: '/home/user/projects/my-project',
        createdAt: '2024-01-15T10:30:00.000Z',
      });

      const row = toRepositoryRow(repository);

      expect(row.id).toBe('repo-1');
      expect(row.name).toBe('my-project');
      expect(row.path).toBe('/home/user/projects/my-project');
      expect(row.created_at).toBe('2024-01-15T10:30:00.000Z');
      expect(row.updated_at).toBeDefined();
      expect(row.setup_command).toBeNull();
      expect(row.cleanup_command).toBeNull();
      expect(row.default_agent_id).toBeNull();
    });

    it('should map defaultAgentId to default_agent_id', () => {
      const repository = buildPersistedRepository({
        id: 'repo-default-agent',
        name: 'default-agent-project',
        path: '/home/user/projects/default-agent-project',
        createdAt: '2024-01-15T10:30:00.000Z',
        defaultAgentId: 'custom-agent-1',
      });

      const row = toRepositoryRow(repository);

      expect(row.default_agent_id).toBe('custom-agent-1');
    });

    it('should map cleanupCommand to cleanup_command', () => {
      const repository = buildPersistedRepository({
        id: 'repo-cleanup',
        name: 'cleanup-project',
        path: '/home/user/projects/cleanup-project',
        createdAt: '2024-01-15T10:30:00.000Z',
        cleanupCommand: 'docker compose down',
      });

      const row = toRepositoryRow(repository);

      expect(row.cleanup_command).toBe('docker compose down');
    });
  });

  describe('toRepository', () => {
    it('should convert database row to Repository', () => {
      const row: RepositoryRow = {
        id: 'repo-2',
        name: 'another-project',
        path: '/opt/repos/another-project',
        created_at: '2024-02-20T14:00:00.000Z',
        updated_at: '2024-02-20T14:00:00.000Z',
        setup_command: null,
        cleanup_command: null,
        env_vars: null,
        description: null,
        default_agent_id: null,
      };

      const repository = toRepository(row);

      expect(repository.id).toBe('repo-2');
      expect(repository.name).toBe('another-project');
      expect(repository.path).toBe('/opt/repos/another-project');
      expect(repository.createdAt).toBe('2024-02-20T14:00:00.000Z');
      expect(repository.setupCommand).toBeNull();
      expect(repository.cleanupCommand).toBeNull();
      expect(repository.envVars).toBeNull();
      expect(repository.defaultAgentId).toBeNull();
    });

    it('should handle created_at correctly', () => {
      const row: RepositoryRow = {
        id: 'repo-3',
        name: 'test-repo',
        path: '/tmp/test-repo',
        created_at: '2024-12-01T00:00:00.000Z',
        updated_at: '2024-12-01T00:00:00.000Z',
        setup_command: null,
        cleanup_command: null,
        env_vars: null,
        description: null,
        default_agent_id: null,
      };

      const repository = toRepository(row);

      // Verify createdAt is correctly mapped from created_at
      expect(repository.createdAt).toBe('2024-12-01T00:00:00.000Z');
    });

    it('should map cleanup_command to cleanupCommand', () => {
      const row: RepositoryRow = {
        id: 'repo-cleanup',
        name: 'test-repo',
        path: '/tmp/test-repo',
        created_at: '2024-12-01T00:00:00.000Z',
        updated_at: '2024-12-01T00:00:00.000Z',
        setup_command: null,
        cleanup_command: 'docker compose down',
        env_vars: null,
        description: null,
        default_agent_id: null,
      };

      const repository = toRepository(row);

      expect(repository.cleanupCommand).toBe('docker compose down');
    });

    it('should map setup_command to setupCommand', () => {
      const row: RepositoryRow = {
        id: 'repo-4',
        name: 'test-repo',
        path: '/tmp/test-repo',
        created_at: '2024-12-01T00:00:00.000Z',
        updated_at: '2024-12-01T00:00:00.000Z',
        setup_command: 'npm install',
        cleanup_command: null,
        env_vars: null,
        description: null,
        default_agent_id: null,
      };

      const repository = toRepository(row);

      expect(repository.setupCommand).toBe('npm install');
    });

    it('should map env_vars to envVars', () => {
      const row: RepositoryRow = {
        id: 'repo-5',
        name: 'test-repo',
        path: '/tmp/test-repo',
        created_at: '2024-12-01T00:00:00.000Z',
        updated_at: '2024-12-01T00:00:00.000Z',
        setup_command: null,
        cleanup_command: null,
        env_vars: 'FOO=bar\nBAZ=qux',
        description: null,
        default_agent_id: null,
      };

      const repository = toRepository(row);

      expect(repository.envVars).toBe('FOO=bar\nBAZ=qux');
    });
  });

  describe('toAgentRow', () => {
    it('should convert AgentDefinition to database row', () => {
      const agent = buildAgentDefinition({
        id: 'custom-agent-1',
        name: 'My Custom Agent',
        commandTemplate: 'my-agent --prompt {{prompt}} --dir {{cwd}}',
        continueTemplate: 'my-agent --continue --dir {{cwd}}',
        headlessTemplate: 'my-agent --headless --prompt {{prompt}} --dir {{cwd}}',
        description: 'A custom agent for testing',
        isBuiltIn: false,
        createdAt: '2024-03-10T09:00:00.000Z',
        capabilities: {
          supportsContinue: true,
          supportsHeadlessMode: true,
          supportsActivityDetection: false,
        },
      });

      const row = toAgentRow(agent);

      expect(row.id).toBe('custom-agent-1');
      expect(row.name).toBe('My Custom Agent');
      expect(row.command_template).toBe('my-agent --prompt {{prompt}} --dir {{cwd}}');
      expect(row.continue_template).toBe('my-agent --continue --dir {{cwd}}');
      expect(row.headless_template).toBe('my-agent --headless --prompt {{prompt}} --dir {{cwd}}');
      expect(row.description).toBe('A custom agent for testing');
      expect(row.is_built_in).toBe(0);
      expect(row.created_at).toBe('2024-03-10T09:00:00.000Z');
      expect(row.updated_at).toBeDefined();
      expect(row.activity_patterns).toBeNull();
    });

    it('should serialize activityPatterns as JSON', () => {
      const agent = buildAgentDefinition({
        id: 'agent-with-patterns',
        name: 'Agent With Patterns',
        commandTemplate: 'agent-cmd {{prompt}}',
        isBuiltIn: false,
        createdAt: '2024-03-10T09:00:00.000Z',
        activityPatterns: {
          askingPatterns: ['^Question:', '^Input needed:'],
        },
        capabilities: {
          supportsContinue: false,
          supportsHeadlessMode: false,
          supportsActivityDetection: true,
        },
      });

      const row = toAgentRow(agent);

      expect(row.activity_patterns).not.toBeNull();
      const parsed = JSON.parse(row.activity_patterns!);
      expect(parsed.askingPatterns).toEqual(['^Question:', '^Input needed:']);
    });

    it('should handle null optional fields', () => {
      const agent = buildAgentDefinition({
        id: 'minimal-agent',
        name: 'Minimal Agent',
        commandTemplate: 'minimal-cmd {{prompt}}',
        isBuiltIn: false,
        createdAt: '2024-03-10T09:00:00.000Z',
        capabilities: {
          supportsContinue: false,
          supportsHeadlessMode: false,
          supportsActivityDetection: false,
        },
      });

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
        created_at: '2024-04-01T12:00:00.000Z',
        updated_at: '2024-04-01T12:00:00.000Z',
        activity_patterns: null,
        base_agent_id: null,
      };

      const agent = toAgentDefinition(row);

      expect(agent.id).toBe('db-agent-1');
      expect(agent.name).toBe('DB Agent');
      expect(agent.commandTemplate).toBe('db-agent --prompt {{prompt}}');
      expect(agent.continueTemplate).toBe('db-agent --continue');
      expect(agent.headlessTemplate).toBe('db-agent --headless {{prompt}}');
      expect(agent.description).toBe('Agent from database');
      expect(agent.isBuiltIn).toBe(false);
      expect(agent.createdAt).toBe('2024-04-01T12:00:00.000Z');
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
        created_at: '2024-04-01T12:00:00.000Z',
        updated_at: '2024-04-01T12:00:00.000Z',
        activity_patterns: JSON.stringify({
          askingPatterns: ['^Ask:', '^Input:'],
        }),
        base_agent_id: null,
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
        created_at: '2024-04-01T12:00:00.000Z',
        updated_at: '2024-04-01T12:00:00.000Z',
        activity_patterns: null,
        base_agent_id: null,
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
        created_at: '2024-04-01T12:00:00.000Z',
        updated_at: '2024-04-01T12:00:00.000Z',
        activity_patterns: null,
        base_agent_id: null,
      };

      const agentWithout = toAgentDefinition(rowWithout);
      expect(agentWithout.capabilities.supportsContinue).toBe(false);
      expect(agentWithout.capabilities.supportsHeadlessMode).toBe(false);
    });

    it('should handle null/undefined optional fields', () => {
      // Test fallback behavior if DB somehow contains null (defensive test)
      const row = {
        id: 'null-fields-agent',
        name: 'Agent With Nulls',
        command_template: 'cmd {{prompt}}',
        continue_template: null,
        headless_template: null,
        description: null,
        is_built_in: 0,
        created_at: null,
        updated_at: null,
        activity_patterns: null,
      } as unknown as AgentRow;

      const agent = toAgentDefinition(row);

      expect(agent.continueTemplate).toBeUndefined();
      expect(agent.headlessTemplate).toBeUndefined();
      expect(agent.description).toBeUndefined();
      expect(agent.activityPatterns).toBeUndefined();
      // createdAt should have a fallback when null
      expect(agent.createdAt).toBeDefined();
    });
  });

  describe('toEmbeddedAgentRow / toEmbeddedAgentDefinition', () => {
    const fullDefinition: EmbeddedAgentDefinition = {
      id: 'def-1',
      name: 'Ollama qwen3:32b',
      description: 'Local model',
      provider: {
        baseUrl: 'http://localhost:11434/v1',
        model: 'qwen3:32b',
        apiKeyRef: 'my-key',
      },
      systemPrompt: 'You are helpful.',
      maxToolIterations: 30,
      enabledTools: ['Read', 'Glob'],
      instructions: ['docs/local-note.md', 'CONTRIBUTING.md'],
      createdBy: 'user-uuid',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };

    it('flattens provider fields into provider_* columns', () => {
      const row = toEmbeddedAgentRow(fullDefinition);

      expect(row.id).toBe('def-1');
      expect(row.name).toBe('Ollama qwen3:32b');
      expect(row.description).toBe('Local model');
      expect(row.provider_base_url).toBe('http://localhost:11434/v1');
      expect(row.provider_model).toBe('qwen3:32b');
      expect(row.provider_api_key_ref).toBe('my-key');
      expect(row.system_prompt).toBe('You are helpful.');
      expect(row.max_tool_iterations).toBe(30);
      expect(row.enabled_tools).toBe('["Read","Glob"]');
      expect(row.instructions).toBe('["docs/local-note.md","CONTRIBUTING.md"]');
      expect(row.created_by).toBe('user-uuid');
    });

    it('maps absent optional fields to null columns', () => {
      const minimal: EmbeddedAgentDefinition = {
        id: 'def-2',
        name: 'Minimal',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
        createdBy: 'user-uuid',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };

      const row = toEmbeddedAgentRow(minimal);

      expect(row.description).toBeNull();
      expect(row.provider_api_key_ref).toBeNull();
      expect(row.system_prompt).toBeNull();
      expect(row.max_tool_iterations).toBeNull();
      expect(row.enabled_tools).toBeNull();
      expect(row.instructions).toBeNull();
    });

    it('maps an explicit empty enabledTools array to a serialized empty-array column', () => {
      const emptyTools: EmbeddedAgentDefinition = {
        id: 'def-4',
        name: 'AllToolsOff',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
        enabledTools: [],
        createdBy: 'user-uuid',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };

      const row = toEmbeddedAgentRow(emptyTools);

      expect(row.enabled_tools).toBe('[]');
    });

    it('maps an explicit empty instructions array to a serialized empty-array column', () => {
      const emptyInstructions: EmbeddedAgentDefinition = {
        id: 'def-6',
        name: 'NoInstructions',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
        instructions: [],
        createdBy: 'user-uuid',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };

      const row = toEmbeddedAgentRow(emptyInstructions);

      expect(row.instructions).toBe('[]');
    });

    it('round-trips a full definition through row and back', () => {
      const row = toEmbeddedAgentRow(fullDefinition);
      // Simulate a SELECT row: the Generated timestamp columns resolve to the
      // inserted strings, and nullable columns are concrete null (not undefined).
      const selectRow: EmbeddedAgentRow = {
        id: row.id,
        name: row.name,
        description: row.description ?? null,
        provider_base_url: row.provider_base_url,
        provider_model: row.provider_model,
        provider_api_key_ref: row.provider_api_key_ref ?? null,
        system_prompt: row.system_prompt ?? null,
        max_tool_iterations: row.max_tool_iterations ?? null,
        enabled_tools: row.enabled_tools ?? null,
        instructions: row.instructions ?? null,
        created_by: row.created_by,
        created_at: fullDefinition.createdAt,
        updated_at: fullDefinition.updatedAt,
      };

      const restored = toEmbeddedAgentDefinition(selectRow);

      expect(restored).toEqual(fullDefinition);
    });

    it('unflattens null columns to undefined optional fields', () => {
      const selectRow: EmbeddedAgentRow = {
        id: 'def-3',
        name: 'Nulls',
        description: null,
        provider_base_url: 'http://localhost:11434/v1',
        provider_model: 'llama3',
        provider_api_key_ref: null,
        system_prompt: null,
        max_tool_iterations: null,
        enabled_tools: null,
        instructions: null,
        created_by: 'user-uuid',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      };

      const restored = toEmbeddedAgentDefinition(selectRow);

      expect(restored.description).toBeUndefined();
      expect(restored.provider.apiKeyRef).toBeUndefined();
      expect(restored.systemPrompt).toBeUndefined();
      expect(restored.maxToolIterations).toBeUndefined();
      expect(restored.enabledTools).toBeUndefined();
      expect(restored.instructions).toBeUndefined();
    });

    it('unflattens a serialized empty-array column to an explicit empty array', () => {
      const selectRow: EmbeddedAgentRow = {
        id: 'def-5',
        name: 'EmptyTools',
        description: null,
        provider_base_url: 'http://localhost:11434/v1',
        provider_model: 'llama3',
        provider_api_key_ref: null,
        system_prompt: null,
        max_tool_iterations: null,
        enabled_tools: '[]',
        instructions: '[]',
        created_by: 'user-uuid',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      };

      const restored = toEmbeddedAgentDefinition(selectRow);

      expect(restored.enabledTools).toEqual([]);
      expect(restored.instructions).toEqual([]);
    });

    it('does not throw and falls back to undefined when enabled_tools contains malformed JSON', () => {
      const selectRow: EmbeddedAgentRow = {
        id: 'def-malformed',
        name: 'Malformed',
        description: null,
        provider_base_url: 'http://localhost:11434/v1',
        provider_model: 'llama3',
        provider_api_key_ref: null,
        system_prompt: null,
        max_tool_iterations: null,
        enabled_tools: '["Read"',
        instructions: null,
        created_by: 'user-uuid',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      };

      let restored: EmbeddedAgentDefinition | undefined;
      expect(() => {
        restored = toEmbeddedAgentDefinition(selectRow);
      }).not.toThrow();

      expect(restored?.enabledTools).toBeUndefined();
    });

    it('does not throw and falls back to undefined when instructions contains malformed JSON', () => {
      const selectRow: EmbeddedAgentRow = {
        id: 'def-malformed-instructions',
        name: 'Malformed',
        description: null,
        provider_base_url: 'http://localhost:11434/v1',
        provider_model: 'llama3',
        provider_api_key_ref: null,
        system_prompt: null,
        max_tool_iterations: null,
        enabled_tools: null,
        instructions: '["docs/note.md"',
        created_by: 'user-uuid',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      };

      let restored: EmbeddedAgentDefinition | undefined;
      expect(() => {
        restored = toEmbeddedAgentDefinition(selectRow);
      }).not.toThrow();

      expect(restored?.instructions).toBeUndefined();
    });

    it('does not throw and falls back to undefined when enabled_tools parses to a non-array value', () => {
      const selectRow: EmbeddedAgentRow = {
        id: 'def-non-array-tools',
        name: 'NonArray',
        description: null,
        provider_base_url: 'http://localhost:11434/v1',
        provider_model: 'llama3',
        provider_api_key_ref: null,
        system_prompt: null,
        max_tool_iterations: null,
        enabled_tools: '{}',
        instructions: null,
        created_by: 'user-uuid',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      };

      let restored: EmbeddedAgentDefinition | undefined;
      expect(() => {
        restored = toEmbeddedAgentDefinition(selectRow);
      }).not.toThrow();

      expect(restored?.enabledTools).toBeUndefined();
    });

    it('does not throw and falls back to undefined when instructions parses to a non-array value', () => {
      const selectRow: EmbeddedAgentRow = {
        id: 'def-non-array-instructions',
        name: 'NonArray',
        description: null,
        provider_base_url: 'http://localhost:11434/v1',
        provider_model: 'llama3',
        provider_api_key_ref: null,
        system_prompt: null,
        max_tool_iterations: null,
        enabled_tools: null,
        instructions: '"foo"',
        created_by: 'user-uuid',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      };

      let restored: EmbeddedAgentDefinition | undefined;
      expect(() => {
        restored = toEmbeddedAgentDefinition(selectRow);
      }).not.toThrow();

      expect(restored?.instructions).toBeUndefined();
    });
  });
});
