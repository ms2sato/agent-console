/**
 * Shared test data builders for domain objects.
 *
 * Each builder follows the override-spread factory pattern:
 * - Returns a fully-typed object (no `as` casts needed by callers)
 * - Accepts optional Partial<T> overrides
 * - Uses sensible defaults for all required fields
 *
 * Naming: `build` prefix + full type name, one function per discriminated union variant.
 */

import type { AgentDefinition, WorktreeSession, QuickSession } from '@agent-console/shared';
import type {
  PersistedWorktreeSession,
  PersistedQuickSession,
  PersistedAgentWorker,
  PersistedTerminalWorker,
  PersistedGitDiffWorker,
  PersistedRepository,
} from '../../services/persistence-service.js';
import type {
  InternalWorktreeSession,
  InternalQuickSession,
} from '../../services/internal-types.js';
import type {
  InternalAgentWorker,
  InternalTerminalWorker,
  InternalGitDiffWorker,
  InternalWorker,
} from '../../services/worker-types.js';

// ── Persisted Workers ──

export function buildPersistedAgentWorker(
  overrides?: Partial<PersistedAgentWorker>
): PersistedAgentWorker {
  return {
    id: 'test-agent-worker-id',
    type: 'agent',
    name: 'Test Agent',
    agentId: 'claude-code-builtin',
    pid: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function buildPersistedTerminalWorker(
  overrides?: Partial<PersistedTerminalWorker>
): PersistedTerminalWorker {
  return {
    id: 'test-terminal-worker-id',
    type: 'terminal',
    name: 'Test Terminal',
    pid: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function buildPersistedGitDiffWorker(
  overrides?: Partial<PersistedGitDiffWorker>
): PersistedGitDiffWorker {
  return {
    id: 'test-git-diff-worker-id',
    type: 'git-diff',
    name: 'Git Diff',
    baseCommit: 'abc123def456',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── Persisted Sessions ──

export function buildPersistedWorktreeSession(
  overrides?: Partial<PersistedWorktreeSession>
): PersistedWorktreeSession {
  return {
    id: 'test-worktree-session-id',
    type: 'worktree',
    locationPath: '/test/worktree',
    repositoryId: 'repo-1',
    worktreeId: 'main',
    createdAt: '2026-01-01T00:00:00.000Z',
    workers: [],
    ...overrides,
  };
}

export function buildPersistedQuickSession(
  overrides?: Partial<PersistedQuickSession>
): PersistedQuickSession {
  return {
    id: 'test-quick-session-id',
    type: 'quick',
    locationPath: '/test/quick',
    createdAt: '2026-01-01T00:00:00.000Z',
    workers: [],
    ...overrides,
  };
}

// ── Persisted Repository ──

export function buildPersistedRepository(
  overrides?: Partial<PersistedRepository>
): PersistedRepository {
  return {
    id: 'test-repo-id',
    name: 'test-repo',
    path: '/test/repo',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── Internal Workers ──

export function buildInternalAgentWorker(
  overrides?: Partial<InternalAgentWorker>
): InternalAgentWorker {
  return {
    id: 'w-agent-1',
    type: 'agent',
    name: 'Agent',
    agentId: 'claude-code-builtin',
    createdAt: '2026-01-01T00:00:00.000Z',
    pty: null,
    outputBuffer: '',
    outputOffset: 0,
    connectionCallbacks: new Map(),
    activityState: 'unknown',
    activityDetector: null,
    ...overrides,
  };
}

export function buildInternalTerminalWorker(
  overrides?: Partial<InternalTerminalWorker>
): InternalTerminalWorker {
  return {
    id: 'w-term-1',
    type: 'terminal',
    name: 'Terminal',
    createdAt: '2026-01-01T00:00:00.000Z',
    pty: null,
    outputBuffer: '',
    outputOffset: 0,
    connectionCallbacks: new Map(),
    ...overrides,
  };
}

export function buildInternalGitDiffWorker(
  overrides?: Partial<InternalGitDiffWorker>
): InternalGitDiffWorker {
  return {
    id: 'w-gitdiff-1',
    type: 'git-diff',
    name: 'Git Diff',
    createdAt: '2026-01-01T00:00:00.000Z',
    baseCommit: 'abc123',
    ...overrides,
  };
}

// ── Internal Sessions ──

/**
 * Build an InternalWorktreeSession. Workers can be passed as an array
 * (converted to Map keyed by worker.id) or as a Map directly via overrides.
 */
export function buildInternalWorktreeSession(
  workers: InternalWorker[] = [],
  overrides?: Partial<InternalWorktreeSession>
): InternalWorktreeSession {
  const workerMap = new Map<string, InternalWorker>();
  for (const w of workers) workerMap.set(w.id, w);
  return {
    id: 'session-1',
    type: 'worktree',
    locationPath: '/test/worktree',
    repositoryId: 'repo-1',
    worktreeId: 'main',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    workers: workerMap,
    ...overrides,
  };
}

export function buildInternalQuickSession(
  workers: InternalWorker[] = [],
  overrides?: Partial<InternalQuickSession>
): InternalQuickSession {
  const workerMap = new Map<string, InternalWorker>();
  for (const w of workers) workerMap.set(w.id, w);
  return {
    id: 'session-2',
    type: 'quick',
    locationPath: '/test/quick',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    workers: workerMap,
    ...overrides,
  };
}

// ── Public API Sessions ──
// Note: Public Worker types (AgentWorker, TerminalWorker, GitDiffWorker) do NOT get builders
// because they are always produced by production code.

export function buildWorktreeSession(
  overrides?: Partial<WorktreeSession>
): WorktreeSession {
  return {
    id: 'session-1',
    type: 'worktree',
    locationPath: '/test/worktree',
    repositoryId: 'repo-1',
    repositoryName: 'test-repo',
    worktreeId: 'main',
    isMainWorktree: false,
    status: 'active',
    activationState: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    workers: [],
    recoveryState: 'healthy',
    ...overrides,
  };
}

export function buildQuickSession(
  overrides?: Partial<QuickSession>
): QuickSession {
  return {
    id: 'session-1',
    type: 'quick',
    locationPath: '/test/quick',
    status: 'active',
    activationState: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    workers: [],
    recoveryState: 'healthy',
    ...overrides,
  };
}

// ── Agent Definition ──

export function buildAgentDefinition(
  overrides?: Partial<AgentDefinition>
): AgentDefinition {
  return {
    id: 'test-agent-id',
    name: 'Test Agent',
    commandTemplate: 'agent start --prompt={{prompt}}',
    isBuiltIn: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    capabilities: {
      supportsContinue: false,
      supportsHeadlessMode: false,
      supportsActivityDetection: false,
    },
    ...overrides,
  };
}
