import { describe, it, expect, beforeEach } from 'bun:test';
import type { Worker } from '@agent-console/shared';
import type { PersistedWorker } from '../persistence-service.js';
import type { InternalWorker, InternalAgentWorker } from '../worker-types.js';
import { SessionConverterService, type SessionConverterDeps, type RepositoryDisplayLookup } from '../session-converter-service.js';
import {
  buildInternalAgentWorker,
  buildInternalTerminalWorker,
  buildInternalGitDiffWorker,
  buildInternalWorktreeSession,
  buildInternalQuickSession,
  buildPersistedWorktreeSession,
  buildPersistedQuickSession,
  buildPersistedAgentWorker,
  buildPersistedTerminalWorker,
  buildPersistedGitDiffWorker,
} from '../../__tests__/utils/build-test-data.js';

// --- Test suite ---

describe('SessionConverterService', () => {
  let service: SessionConverterService;
  let mockLookup: RepositoryDisplayLookup;
  let toPublicWorkerResults: Map<string, Worker>;
  let toPersistedWorkerResults: Map<string, PersistedWorker>;

  beforeEach(() => {
    mockLookup = {
      getRepositoryDisplayInfo: (id: string) => {
        if (id === 'repo-1') return { name: 'my-repo', path: '/repos/my-repo' };
        return undefined;
      },
    };

    toPublicWorkerResults = new Map();
    toPersistedWorkerResults = new Map();

    const deps: SessionConverterDeps = {
      repositoryDisplayLookup: mockLookup,
      toPublicWorker: (w: InternalWorker): Worker => {
        const existing = toPublicWorkerResults.get(w.id);
        if (existing) return existing;
        if (w.type === 'agent') {
          return { id: w.id, type: 'agent', name: w.name, agentId: w.agentId, createdAt: w.createdAt, activated: w.pty !== null };
        } else if (w.type === 'terminal') {
          return { id: w.id, type: 'terminal', name: w.name, createdAt: w.createdAt, activated: w.pty !== null };
        } else {
          return { id: w.id, type: 'git-diff', name: w.name, createdAt: w.createdAt, baseCommit: w.baseCommit };
        }
      },
      toPersistedWorker: (w: InternalWorker): PersistedWorker => {
        const existing = toPersistedWorkerResults.get(w.id);
        if (existing) return existing;
        if (w.type === 'agent') {
          return { id: w.id, type: 'agent', name: w.name, agentId: w.agentId, createdAt: w.createdAt, pid: w.pty?.pid ?? null };
        } else if (w.type === 'terminal') {
          return { id: w.id, type: 'terminal', name: w.name, createdAt: w.createdAt, pid: w.pty?.pid ?? null };
        } else {
          return { id: w.id, type: 'git-diff', name: w.name, createdAt: w.createdAt, baseCommit: w.baseCommit };
        }
      },
      getServerPid: () => 12345,
    };

    service = new SessionConverterService(deps);
  });

  // --- computeActivationState ---

  describe('computeActivationState', () => {
    it('returns running when at least one PTY worker has an active PTY', () => {
      const session = buildInternalWorktreeSession([
        buildInternalAgentWorker({ pty: { pid: 100 } as InternalAgentWorker['pty'] }),
        buildInternalTerminalWorker({ pty: null }),
      ]);
      expect(service.computeActivationState(session)).toBe('running');
    });

    it('returns hibernated when all PTY workers have null PTY', () => {
      const session = buildInternalWorktreeSession([
        buildInternalAgentWorker({ pty: null }),
        buildInternalTerminalWorker({ pty: null }),
      ]);
      expect(service.computeActivationState(session)).toBe('hibernated');
    });

    it('returns running when there are no PTY workers (only git-diff)', () => {
      const session = buildInternalWorktreeSession([buildInternalGitDiffWorker()]);
      expect(service.computeActivationState(session)).toBe('running');
    });

    it('returns running when there are no workers at all', () => {
      const session = buildInternalWorktreeSession([]);
      expect(service.computeActivationState(session)).toBe('running');
    });

    it('returns running when mix of PTY and non-PTY workers with at least one active PTY', () => {
      const session = buildInternalWorktreeSession([
        buildInternalAgentWorker({ pty: { pid: 100 } as InternalAgentWorker['pty'] }),
        buildInternalGitDiffWorker(),
      ]);
      expect(service.computeActivationState(session)).toBe('running');
    });
  });

  // --- toPublicSession ---

  describe('toPublicSession', () => {
    it('converts a worktree session with correct fields', () => {
      const agent = buildInternalAgentWorker({ agentId: 'agent-def-1', pty: { pid: 100 } as InternalAgentWorker['pty'] });
      const session = buildInternalWorktreeSession([agent], {
        locationPath: '/repos/my-repo/wt-001',
        worktreeId: 'wt-1',
        initialPrompt: 'do something',
        title: 'My Session',
        parentSessionId: 'parent-1',
        parentWorkerId: 'parent-w-1',
        createdBy: 'user-1',
      });

      const result = service.toPublicSession(session);

      expect(result.type).toBe('worktree');
      expect(result.id).toBe('session-1');
      expect(result.locationPath).toBe('/repos/my-repo/wt-001');
      expect(result.status).toBe('active');
      expect(result.activationState).toBe('running');
      expect(result.initialPrompt).toBe('do something');
      expect(result.title).toBe('My Session');
      expect(result.parentSessionId).toBe('parent-1');
      expect(result.parentWorkerId).toBe('parent-w-1');
      expect(result.createdBy).toBe('user-1');
      expect(result.workers).toHaveLength(1);
      if (result.type === 'worktree') {
        expect(result.repositoryId).toBe('repo-1');
        expect(result.repositoryName).toBe('my-repo');
        expect(result.worktreeId).toBe('wt-1');
        expect(result.isMainWorktree).toBe(false);
      }
    });

    it('sets isMainWorktree to true when locationPath matches repository path', () => {
      const session = buildInternalWorktreeSession([], {
        locationPath: '/repos/my-repo', // matches the mock repository path
      });

      const result = service.toPublicSession(session);
      if (result.type === 'worktree') {
        expect(result.isMainWorktree).toBe(true);
      }
    });

    it('converts a quick session correctly', () => {
      const terminal = buildInternalTerminalWorker();
      const session = buildInternalQuickSession([terminal]);

      const result = service.toPublicSession(session);

      expect(result.type).toBe('quick');
      expect(result.id).toBe('session-2');
      expect(result.workers).toHaveLength(1);
    });

    it('sorts workers by createdAt', () => {
      const later = buildInternalAgentWorker({ id: 'w-later', createdAt: '2026-01-01T00:10:00Z' });
      const earlier = buildInternalTerminalWorker({ id: 'w-earlier', createdAt: '2026-01-01T00:01:00Z' });
      // Insert in reverse order
      const session = buildInternalQuickSession([later, earlier]);

      const result = service.toPublicSession(session);

      expect(result.workers[0].id).toBe('w-earlier');
      expect(result.workers[1].id).toBe('w-later');
    });

    it('falls back to Unknown repository name when repository is not found', () => {
      mockLookup = {
        getRepositoryDisplayInfo: () => undefined,
      };
      // Recreate service with empty lookup.
      const deps: SessionConverterDeps = {
        repositoryDisplayLookup: mockLookup,
        toPublicWorker: (w) => ({ id: w.id, type: w.type, name: w.name, createdAt: w.createdAt } as unknown as Worker),
        toPersistedWorker: (w) => ({ id: w.id, type: w.type, name: w.name, createdAt: w.createdAt } as unknown as PersistedWorker),
        getServerPid: () => 12345,
      };
      service = new SessionConverterService(deps);

      const session = buildInternalWorktreeSession([]);
      const result = service.toPublicSession(session);
      if (result.type === 'worktree') {
        expect(result.repositoryName).toBe('Unknown');
      }
    });
  });

  // --- persistedToPublicSession ---

  describe('persistedToPublicSession', () => {
    it('converts a persisted worktree session with agent worker', () => {
      const persisted = buildPersistedWorktreeSession({
        id: 'ps-1',
        locationPath: '/repos/my-repo/wt-001',
        worktreeId: 'wt-1',
        serverPid: null,
        createdAt: '2026-01-01T00:00:00Z',
        workers: [
          buildPersistedAgentWorker({ id: 'pw-1', agentId: 'agent-1', createdAt: '2026-01-01T00:00:00Z' }),
        ],
        initialPrompt: 'hello',
        title: 'Persisted Session',
        pausedAt: '2026-01-02T00:00:00Z',
      });

      const result = service.persistedToPublicSession(persisted);

      expect(result.type).toBe('worktree');
      expect(result.id).toBe('ps-1');
      expect(result.status).toBe('active');
      expect(result.activationState).toBe('hibernated');
      expect(result.pausedAt).toBe('2026-01-02T00:00:00Z');
      expect(result.workers).toHaveLength(1);
      expect(result.workers[0].type).toBe('agent');
      if (result.workers[0].type === 'agent') {
        expect(result.workers[0].activated).toBe(false);
      }
      if (result.type === 'worktree') {
        expect(result.repositoryName).toBe('my-repo');
      }
    });

    it('converts a persisted quick session with terminal worker', () => {
      const persisted = buildPersistedQuickSession({
        id: 'ps-2',
        locationPath: '/tmp/quick',
        serverPid: null,
        createdAt: '2026-01-01T00:00:00Z',
        workers: [
          buildPersistedTerminalWorker({ id: 'pw-2', createdAt: '2026-01-01T00:00:00Z' }),
        ],
      });

      const result = service.persistedToPublicSession(persisted);

      expect(result.type).toBe('quick');
      expect(result.workers[0].type).toBe('terminal');
      if (result.workers[0].type === 'terminal') {
        expect(result.workers[0].activated).toBe(false);
      }
    });

    it('converts a persisted session with git-diff worker', () => {
      const persisted = buildPersistedQuickSession({
        id: 'ps-3',
        locationPath: '/tmp/quick',
        serverPid: null,
        createdAt: '2026-01-01T00:00:00Z',
        workers: [
          buildPersistedGitDiffWorker({ id: 'pw-3', name: 'Diff', baseCommit: 'abc123', createdAt: '2026-01-01T00:00:00Z' }),
        ],
      });

      const result = service.persistedToPublicSession(persisted);

      expect(result.workers[0].type).toBe('git-diff');
      if (result.workers[0].type === 'git-diff') {
        expect(result.workers[0].baseCommit).toBe('abc123');
      }
    });

    it('includes parentSessionId and parentWorkerId from persisted data', () => {
      const persisted = buildPersistedQuickSession({
        id: 'ps-4',
        locationPath: '/tmp/quick',
        serverPid: null,
        createdAt: '2026-01-01T00:00:00Z',
        parentSessionId: 'parent-s',
        parentWorkerId: 'parent-w',
        createdBy: 'user-42',
      });

      const result = service.persistedToPublicSession(persisted);

      expect(result.parentSessionId).toBe('parent-s');
      expect(result.parentWorkerId).toBe('parent-w');
      expect(result.createdBy).toBe('user-42');
    });
  });

  // --- toPersistedSession / toPersistedSessionWithServerPid ---

  describe('toPersistedSession', () => {
    it('converts an internal worktree session to persisted format with current server PID', () => {
      const agent = buildInternalAgentWorker({ agentId: 'agent-def-1' });
      const session = buildInternalWorktreeSession([agent], {
        locationPath: '/repos/my-repo/wt-001',
        worktreeId: 'wt-1',
        initialPrompt: 'prompt',
        title: 'title',
        parentSessionId: 'ps',
        parentWorkerId: 'pw',
        createdBy: 'user-1',
        templateVars: { key: 'value' },
      });

      const result = service.toPersistedSession(session);

      expect(result.id).toBe('session-1');
      expect(result.type).toBe('worktree');
      expect(result.serverPid).toBe(12345);
      expect(result.locationPath).toBe('/repos/my-repo/wt-001');
      expect(result.initialPrompt).toBe('prompt');
      expect(result.title).toBe('title');
      expect(result.parentSessionId).toBe('ps');
      expect(result.parentWorkerId).toBe('pw');
      expect(result.createdBy).toBe('user-1');
      expect(result.templateVars).toEqual({ key: 'value' });
      expect(result.workers).toHaveLength(1);
      if (result.type === 'worktree') {
        expect(result.repositoryId).toBe('repo-1');
        expect(result.worktreeId).toBe('wt-1');
      }
    });

    it('converts an internal quick session to persisted format', () => {
      const session = buildInternalQuickSession([buildInternalTerminalWorker()]);

      const result = service.toPersistedSession(session);

      expect(result.type).toBe('quick');
      expect(result.serverPid).toBe(12345);
    });
  });

  describe('toPersistedSessionWithServerPid', () => {
    it('uses the provided serverPid instead of the current one', () => {
      const session = buildInternalWorktreeSession([]);

      const result = service.toPersistedSessionWithServerPid(session, null);

      expect(result.serverPid).toBeNull();
    });

    it('maps all workers through toPersistedWorker', () => {
      const agent = buildInternalAgentWorker();
      const terminal = buildInternalTerminalWorker();
      const gitDiff = buildInternalGitDiffWorker();
      const session = buildInternalQuickSession([agent, terminal, gitDiff]);

      const result = service.toPersistedSessionWithServerPid(session, 999);

      expect(result.workers).toHaveLength(3);
      expect(result.serverPid).toBe(999);
      const types = result.workers.map(w => w.type).sort();
      expect(types).toEqual(['agent', 'git-diff', 'terminal']);
    });
  });
});
