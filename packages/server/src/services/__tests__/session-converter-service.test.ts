import { describe, it, expect, beforeEach } from 'bun:test';
import type { Worker } from '@agent-console/shared';
import type { PersistedSession, PersistedWorker } from '../persistence-service.js';
import type { InternalWorktreeSession, InternalQuickSession } from '../internal-types.js';
import type { InternalWorker, InternalAgentWorker, InternalTerminalWorker, InternalGitDiffWorker } from '../worker-types.js';
import type { SessionRepositoryCallbacks } from '../session-manager.js';
import { SessionConverterService, type SessionConverterDeps } from '../session-converter-service.js';

// --- Helpers to build test fixtures ---

function makeAgentWorker(overrides: Partial<InternalAgentWorker> = {}): InternalAgentWorker {
  return {
    id: 'w-agent-1',
    type: 'agent',
    name: 'Agent',
    agentId: 'agent-def-1',
    createdAt: '2026-01-01T00:00:00Z',
    pty: { pid: 100 } as InternalAgentWorker['pty'],
    outputBuffer: '',
    outputOffset: 0,
    connectionCallbacks: new Map(),
    activityState: 'idle',
    activityDetector: null,
    ...overrides,
  };
}

function makeTerminalWorker(overrides: Partial<InternalTerminalWorker> = {}): InternalTerminalWorker {
  return {
    id: 'w-term-1',
    type: 'terminal',
    name: 'Terminal',
    createdAt: '2026-01-01T00:01:00Z',
    pty: { pid: 200 } as InternalTerminalWorker['pty'],
    outputBuffer: '',
    outputOffset: 0,
    connectionCallbacks: new Map(),
    ...overrides,
  };
}

function makeGitDiffWorker(overrides: Partial<InternalGitDiffWorker> = {}): InternalGitDiffWorker {
  return {
    id: 'w-gitdiff-1',
    type: 'git-diff',
    name: 'Git Diff',
    createdAt: '2026-01-01T00:02:00Z',
    baseCommit: 'abc123',
    ...overrides,
  };
}

function makeWorktreeSession(workers: InternalWorker[], overrides: Partial<InternalWorktreeSession> = {}): InternalWorktreeSession {
  const workerMap = new Map<string, InternalWorker>();
  for (const w of workers) workerMap.set(w.id, w);
  return {
    id: 'session-1',
    type: 'worktree',
    locationPath: '/repos/my-repo/wt-001',
    repositoryId: 'repo-1',
    worktreeId: 'wt-1',
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    workers: workerMap,
    ...overrides,
  };
}

function makeQuickSession(workers: InternalWorker[], overrides: Partial<InternalQuickSession> = {}): InternalQuickSession {
  const workerMap = new Map<string, InternalWorker>();
  for (const w of workers) workerMap.set(w.id, w);
  return {
    id: 'session-2',
    type: 'quick',
    locationPath: '/tmp/quick',
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    workers: workerMap,
    ...overrides,
  };
}

// --- Test suite ---

describe('SessionConverterService', () => {
  let service: SessionConverterService;
  let mockRepoCallbacks: SessionRepositoryCallbacks;
  let toPublicWorkerResults: Map<string, Worker>;
  let toPersistedWorkerResults: Map<string, PersistedWorker>;

  beforeEach(() => {
    mockRepoCallbacks = {
      getRepository: (id: string) => {
        if (id === 'repo-1') return { name: 'my-repo', path: '/repos/my-repo' };
        return undefined;
      },
      isInitialized: () => true,
      getWorktreeIndexNumber: async () => 1,
    };

    toPublicWorkerResults = new Map();
    toPersistedWorkerResults = new Map();

    const deps: SessionConverterDeps = {
      getRepositoryCallbacks: () => mockRepoCallbacks,
      toPublicWorker: (w: InternalWorker): Worker => {
        const existing = toPublicWorkerResults.get(w.id);
        if (existing) return existing;
        // Default conversion for tests
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
      const session = makeWorktreeSession([
        makeAgentWorker({ pty: { pid: 100 } as InternalAgentWorker['pty'] }),
        makeTerminalWorker({ pty: null }),
      ]);
      expect(service.computeActivationState(session)).toBe('running');
    });

    it('returns hibernated when all PTY workers have null PTY', () => {
      const session = makeWorktreeSession([
        makeAgentWorker({ pty: null }),
        makeTerminalWorker({ pty: null }),
      ]);
      expect(service.computeActivationState(session)).toBe('hibernated');
    });

    it('returns running when there are no PTY workers (only git-diff)', () => {
      const session = makeWorktreeSession([makeGitDiffWorker()]);
      expect(service.computeActivationState(session)).toBe('running');
    });

    it('returns running when there are no workers at all', () => {
      const session = makeWorktreeSession([]);
      expect(service.computeActivationState(session)).toBe('running');
    });

    it('returns running when mix of PTY and non-PTY workers with at least one active PTY', () => {
      const session = makeWorktreeSession([
        makeAgentWorker({ pty: { pid: 100 } as InternalAgentWorker['pty'] }),
        makeGitDiffWorker(),
      ]);
      expect(service.computeActivationState(session)).toBe('running');
    });
  });

  // --- toPublicSession ---

  describe('toPublicSession', () => {
    it('converts a worktree session with correct fields', () => {
      const agent = makeAgentWorker();
      const session = makeWorktreeSession([agent], {
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
      const session = makeWorktreeSession([], {
        locationPath: '/repos/my-repo', // matches the mock repository path
      });

      const result = service.toPublicSession(session);
      if (result.type === 'worktree') {
        expect(result.isMainWorktree).toBe(true);
      }
    });

    it('converts a quick session correctly', () => {
      const terminal = makeTerminalWorker();
      const session = makeQuickSession([terminal]);

      const result = service.toPublicSession(session);

      expect(result.type).toBe('quick');
      expect(result.id).toBe('session-2');
      expect(result.workers).toHaveLength(1);
    });

    it('sorts workers by createdAt', () => {
      const later = makeAgentWorker({ id: 'w-later', createdAt: '2026-01-01T00:10:00Z' });
      const earlier = makeTerminalWorker({ id: 'w-earlier', createdAt: '2026-01-01T00:01:00Z' });
      // Insert in reverse order
      const session = makeQuickSession([later, earlier]);

      const result = service.toPublicSession(session);

      expect(result.workers[0].id).toBe('w-earlier');
      expect(result.workers[1].id).toBe('w-later');
    });

    it('falls back to Unknown repository name when repository callbacks not initialized', () => {
      mockRepoCallbacks = {
        ...mockRepoCallbacks,
        isInitialized: () => false,
      };

      const session = makeWorktreeSession([]);
      const result = service.toPublicSession(session);
      if (result.type === 'worktree') {
        expect(result.repositoryName).toBe('Unknown');
      }
    });
  });

  // --- persistedToPublicSession ---

  describe('persistedToPublicSession', () => {
    it('converts a persisted worktree session with agent worker', () => {
      const persisted: PersistedSession = {
        id: 'ps-1',
        type: 'worktree',
        locationPath: '/repos/my-repo/wt-001',
        repositoryId: 'repo-1',
        worktreeId: 'wt-1',
        serverPid: null,
        createdAt: '2026-01-01T00:00:00Z',
        workers: [
          { id: 'pw-1', type: 'agent', name: 'Agent', agentId: 'agent-1', createdAt: '2026-01-01T00:00:00Z', pid: null },
        ],
        initialPrompt: 'hello',
        title: 'Persisted Session',
        pausedAt: '2026-01-02T00:00:00Z',
      };

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
      const persisted: PersistedSession = {
        id: 'ps-2',
        type: 'quick',
        locationPath: '/tmp/quick',
        serverPid: null,
        createdAt: '2026-01-01T00:00:00Z',
        workers: [
          { id: 'pw-2', type: 'terminal', name: 'Terminal', createdAt: '2026-01-01T00:00:00Z', pid: null },
        ],
      };

      const result = service.persistedToPublicSession(persisted);

      expect(result.type).toBe('quick');
      expect(result.workers[0].type).toBe('terminal');
      if (result.workers[0].type === 'terminal') {
        expect(result.workers[0].activated).toBe(false);
      }
    });

    it('converts a persisted session with git-diff worker', () => {
      const persisted: PersistedSession = {
        id: 'ps-3',
        type: 'quick',
        locationPath: '/tmp/quick',
        serverPid: null,
        createdAt: '2026-01-01T00:00:00Z',
        workers: [
          { id: 'pw-3', type: 'git-diff', name: 'Diff', createdAt: '2026-01-01T00:00:00Z', baseCommit: 'abc123' },
        ],
      };

      const result = service.persistedToPublicSession(persisted);

      expect(result.workers[0].type).toBe('git-diff');
      if (result.workers[0].type === 'git-diff') {
        expect(result.workers[0].baseCommit).toBe('abc123');
      }
    });

    it('includes parentSessionId and parentWorkerId from persisted data', () => {
      const persisted: PersistedSession = {
        id: 'ps-4',
        type: 'quick',
        locationPath: '/tmp/quick',
        serverPid: null,
        createdAt: '2026-01-01T00:00:00Z',
        workers: [],
        parentSessionId: 'parent-s',
        parentWorkerId: 'parent-w',
        createdBy: 'user-42',
      };

      const result = service.persistedToPublicSession(persisted);

      expect(result.parentSessionId).toBe('parent-s');
      expect(result.parentWorkerId).toBe('parent-w');
      expect(result.createdBy).toBe('user-42');
    });
  });

  // --- toPersistedSession / toPersistedSessionWithServerPid ---

  describe('toPersistedSession', () => {
    it('converts an internal worktree session to persisted format with current server PID', () => {
      const agent = makeAgentWorker();
      const session = makeWorktreeSession([agent], {
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
      const session = makeQuickSession([makeTerminalWorker()]);

      const result = service.toPersistedSession(session);

      expect(result.type).toBe('quick');
      expect(result.serverPid).toBe(12345);
    });
  });

  describe('toPersistedSessionWithServerPid', () => {
    it('uses the provided serverPid instead of the current one', () => {
      const session = makeWorktreeSession([]);

      const result = service.toPersistedSessionWithServerPid(session, null);

      expect(result.serverPid).toBeNull();
    });

    it('maps all workers through toPersistedWorker', () => {
      const agent = makeAgentWorker();
      const terminal = makeTerminalWorker();
      const gitDiff = makeGitDiffWorker();
      const session = makeQuickSession([agent, terminal, gitDiff]);

      const result = service.toPersistedSessionWithServerPid(session, 999);

      expect(result.workers).toHaveLength(3);
      expect(result.serverPid).toBe(999);
      const types = result.workers.map(w => w.type).sort();
      expect(types).toEqual(['agent', 'git-diff', 'terminal']);
    });
  });
});
