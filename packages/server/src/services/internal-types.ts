/**
 * Internal session types shared between SessionManager and WorkerLifecycleManager.
 *
 * These types represent the in-memory session state and are NOT exported from the package.
 * Public API types (Session, WorktreeSession, etc.) are defined in @agent-console/shared.
 */

import type { InternalWorker } from './worker-types.js';

export interface InternalSessionBase {
  id: string;
  locationPath: string;
  status: 'active' | 'inactive';
  createdAt: string;
  workers: Map<string, InternalWorker>;
  initialPrompt?: string;
  title?: string;
  /** Parent session ID that delegated this session */
  parentSessionId?: string;
  /** Parent worker ID that delegated this session */
  parentWorkerId?: string;
  /** User UUID (from users table) of the user who created this session */
  createdBy?: string;
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
