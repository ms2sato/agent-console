/**
 * Service responsible for converting between internal, persisted, and public session formats.
 * Extracted from SessionManager to separate data mapping from session lifecycle management.
 */

import type {
  Session,
  WorktreeSession,
  QuickSession,
  Worker,
  SessionActivationState,
} from '@agent-console/shared';
import type {
  PersistedSession,
  PersistedWorker,
} from './persistence-service.js';
import type {
  InternalWorker,
  InternalAgentWorker,
  InternalTerminalWorker,
} from './worker-types.js';
import type { InternalSession } from './internal-types.js';

/**
 * Minimum repository view needed by the converter to attach
 * `repositoryName` and `isMainWorktree` to public session objects.
 */
export interface RepositoryDisplayLookup {
  getRepositoryDisplayInfo(repositoryId: string): { name: string; path: string } | undefined;
}

/**
 * Dependencies injected into SessionConverterService.
 */
export interface SessionConverterDeps {
  repositoryDisplayLookup: RepositoryDisplayLookup;
  toPublicWorker: (worker: InternalWorker) => Worker;
  toPersistedWorker: (worker: InternalWorker) => PersistedWorker;
  getServerPid: () => number | null;
}

/** Re-export so tests can reference the same type the service expects. */
export type { RepositoryDisplayLookup as SessionConverterRepositoryLookup };

export class SessionConverterService {
  private readonly deps: SessionConverterDeps;

  constructor(deps: SessionConverterDeps) {
    this.deps = deps;
  }

  /**
   * Compute the activation state of a session based on its workers' PTY state.
   * A session is 'running' if at least one PTY worker has an active PTY.
   * A session is 'hibernated' if all PTY workers have no PTY (after server restart).
   * Sessions with no PTY workers (only git-diff) are considered 'running'.
   */
  computeActivationState(session: InternalSession): SessionActivationState {
    const ptyWorkers = Array.from(session.workers.values()).filter(
      (w): w is InternalAgentWorker | InternalTerminalWorker =>
        w.type === 'agent' || w.type === 'terminal'
    );
    if (ptyWorkers.length === 0) return 'running';
    const hasActivePty = ptyWorkers.some((w) => w.pty !== null);
    return hasActivePty ? 'running' : 'hibernated';
  }

  /**
   * Convert an internal session to persisted format using the current server PID.
   */
  toPersistedSession(session: InternalSession): PersistedSession {
    return this.toPersistedSessionWithServerPid(session, this.deps.getServerPid());
  }

  /**
   * Convert an internal session to persisted format with a specific serverPid.
   * Used by pauseSession to save with serverPid = null.
   */
  toPersistedSessionWithServerPid(session: InternalSession, serverPid: number | null): PersistedSession {
    // session.workers is the source of truth (all workers loaded on init)
    const workers: PersistedWorker[] = Array.from(session.workers.values()).map(w =>
      this.deps.toPersistedWorker(w)
    );

    const base = {
      id: session.id,
      locationPath: session.locationPath,
      serverPid,
      createdAt: session.createdAt,
      workers,
      initialPrompt: session.initialPrompt,
      title: session.title,
      parentSessionId: session.parentSessionId,
      parentWorkerId: session.parentWorkerId,
      createdBy: session.createdBy,
      initiatedBy: session.initiatedBy,
      templateVars: session.templateVars,
      dataScope: session.dataScope,
      dataScopeSlug: session.dataScopeSlug,
      recoveryState: session.recoveryState,
      orphanedAt: session.orphanedAt,
      orphanedReason: session.orphanedReason,
    };

    return session.type === 'worktree'
      ? { ...base, type: 'worktree', repositoryId: session.repositoryId, worktreeId: session.worktreeId }
      : { ...base, type: 'quick' };
  }

  /**
   * Convert an internal session to public Session format for API responses.
   */
  toPublicSession(session: InternalSession): Session {
    // session.workers is the source of truth (all workers loaded on init)
    const workers = Array.from(session.workers.values())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(w => this.deps.toPublicWorker(w));

    const base = {
      id: session.id,
      locationPath: session.locationPath,
      status: session.status,
      activationState: this.computeActivationState(session),
      createdAt: session.createdAt,
      workers,
      initialPrompt: session.initialPrompt,
      title: session.title,
      parentSessionId: session.parentSessionId,
      parentWorkerId: session.parentWorkerId,
      createdBy: session.createdBy,
      initiatedBy: session.initiatedBy,
      recoveryState: session.recoveryState ?? 'healthy',
    };

    if (session.type === 'worktree') {
      const repository = this.deps.repositoryDisplayLookup.getRepositoryDisplayInfo(session.repositoryId);

      const worktreeSession: WorktreeSession = {
        ...base,
        type: 'worktree',
        repositoryId: session.repositoryId,
        repositoryName: repository?.name ?? 'Unknown',
        worktreeId: session.worktreeId,
        isMainWorktree: repository?.path === session.locationPath,
      };
      return worktreeSession;
    }

    const quickSession: QuickSession = { ...base, type: 'quick' };
    return quickSession;
  }

  /**
   * Convert a persisted session to public Session format.
   * Used for paused sessions that aren't in memory.
   */
  persistedToPublicSession(p: PersistedSession): Session {
    const workers: Worker[] = p.workers.map((w) => {
      if (w.type === 'agent') {
        return {
          id: w.id,
          type: 'agent' as const,
          name: w.name,
          agentId: w.agentId,
          createdAt: w.createdAt,
          activated: false, // Paused sessions have no active PTY
        };
      } else if (w.type === 'terminal') {
        return {
          id: w.id,
          type: 'terminal' as const,
          name: w.name,
          createdAt: w.createdAt,
          activated: false, // Paused sessions have no active PTY
        };
      } else if (w.type === 'git-diff') {
        return {
          id: w.id,
          type: 'git-diff' as const,
          name: w.name,
          createdAt: w.createdAt,
          baseCommit: w.baseCommit,
        };
      } else {
        const _exhaustive: never = w;
        throw new Error(`Unknown worker type: ${(_exhaustive as PersistedWorker).type}`);
      }
    });

    const base = {
      id: p.id,
      locationPath: p.locationPath,
      status: 'active' as const, // Session exists, it's just paused
      activationState: 'hibernated' as const, // Paused sessions are always hibernated
      createdAt: p.createdAt,
      workers,
      initialPrompt: p.initialPrompt,
      title: p.title,
      pausedAt: p.pausedAt,
      parentSessionId: p.parentSessionId,
      parentWorkerId: p.parentWorkerId,
      createdBy: p.createdBy,
      initiatedBy: p.initiatedBy,
      recoveryState: p.recoveryState ?? 'healthy',
    };

    if (p.type === 'worktree') {
      const repository = this.deps.repositoryDisplayLookup.getRepositoryDisplayInfo(p.repositoryId);

      const worktreeSession: WorktreeSession = {
        ...base,
        type: 'worktree',
        repositoryId: p.repositoryId,
        repositoryName: repository?.name ?? 'Unknown',
        worktreeId: p.worktreeId,
        isMainWorktree: repository?.path === p.locationPath,
      };
      return worktreeSession;
    }

    const quickSession: QuickSession = { ...base, type: 'quick' };
    return quickSession;
  }
}
