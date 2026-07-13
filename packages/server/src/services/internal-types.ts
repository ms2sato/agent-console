/**
 * Internal session types shared between SessionManager and WorkerLifecycleManager.
 *
 * These types represent the in-memory session state and are NOT exported from the package.
 * Public API types (Session, WorktreeSession, etc.) are defined in @agent-console/shared.
 */

import type { InternalWorker } from './worker-types.js';

/**
 * Context object for session/worker creation chain.
 * Constructed at entry points (REST/MCP handlers) and passed through:
 *   worktree-creation-service → session-manager → worker-lifecycle-manager → worker-manager
 */
export interface SessionCreationContext {
  /** User UUID (from users table) of the user who created this session */
  createdBy?: string;
  /**
   * User UUID of the authenticated user who actually created this session.
   * For shared sessions this differs from createdBy; for personal sessions
   * it is omitted (left undefined).
   */
  initiatedBy?: string;
  /** Parent session ID that delegated this session */
  parentSessionId?: string;
  /** Parent worker ID that delegated this session */
  parentWorkerId?: string;
  /** Custom template variable overrides for agent command templates */
  templateVars?: Record<string, string>;
  /**
   * Optional SSH_AUTH_SOCK fallback path for delegated worktree sessions.
   * Populated by the MCP delegate path from the parent user's `homeDir`
   * (`${homeDir}/.1password/agent.sock`, Linux 1Password convention) so
   * that PTY workers in multi-user mode can fall back to the 1Password
   * socket when the elevated login shell init does not set SSH_AUTH_SOCK.
   * Undefined for every other code path; in-memory only (not persisted).
   */
  sshAuthSockFallback?: string;
}

export interface InternalSessionBase {
  id: string;
  locationPath: string;
  status: 'active' | 'inactive';
  createdAt: string;
  workers: Map<string, InternalWorker>;
  initialPrompt?: string;
  /**
   * Whether `initialPrompt` has already been delivered as the session's
   * initial embedded-agent worker's first user message. See
   * `packages/shared/src/types/session.ts` `Session.initialPromptDelivered`
   * for the full contract (never re-fires once true, including across
   * restart).
   */
  initialPromptDelivered?: boolean;
  title?: string;
  /** Parent session ID that delegated this session */
  parentSessionId?: string;
  /** Parent worker ID that delegated this session */
  parentWorkerId?: string;
  /** User UUID (from users table) of the user who created this session */
  createdBy?: string;
  /**
   * User UUID of the authenticated user who actually created this session.
   * For shared sessions this differs from createdBy; for personal sessions
   * it is omitted.
   */
  initiatedBy?: string;
  /** Custom template variable overrides for agent command templates */
  templateVars?: Record<string, string>;
  /** Scope-based persistence for session data path. See docs/design/session-data-path.md. */
  dataScope?: 'quick' | 'repository';
  /** Slug for 'repository' scope; null for 'quick'. */
  dataScopeSlug?: string | null;
  /** 'healthy' or 'orphaned'. Undefined defaults to 'healthy'. */
  recoveryState?: 'healthy' | 'orphaned';
  /** Unix epoch ms when marked orphaned. */
  orphanedAt?: number | null;
  /** Machine-readable reason code for orphan. */
  orphanedReason?: string | null;
  /**
   * Optional SSH_AUTH_SOCK fallback path. Carries the value from
   * {@link SessionCreationContext.sshAuthSockFallback} through the
   * in-memory session lifetime so worker activation / revive can re-emit
   * it into the elevated PTY's inner shell command. In-memory only; not
   * persisted, so after a server restart a revived delegated session
   * loses this value (acceptable degradation -- manual `export
   * SSH_AUTH_SOCK=...` works as before).
   */
  sshAuthSockFallback?: string;
}

export interface InternalWorktreeSession extends InternalSessionBase {
  type: 'worktree';
  repositoryId: string;
  worktreeId: string;
}

export interface InternalQuickSession extends InternalSessionBase {
  type: 'quick';
}

export type InternalSession = InternalWorktreeSession | InternalQuickSession;
