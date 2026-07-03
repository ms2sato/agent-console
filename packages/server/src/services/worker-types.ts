/**
 * Internal worker types used by SessionManager and WorkerManager.
 * These types represent in-memory worker state with PTY and callbacks.
 *
 * Public API types (Worker, AgentWorker, etc.) are defined in @agent-console/shared.
 */

import type { AgentActivityState, ExitReason } from '@agent-console/shared';
import type { PtyInstance } from '../lib/pty-provider.js';
import type { ActivityDetector } from './activity-detector.js';

/**
 * Callbacks for worker lifecycle events (data, exit, activity changes).
 * Used when attaching WebSocket connections to workers.
 * Multiple connections can be attached to a single worker (e.g., multiple browser tabs).
 */
export interface WorkerCallbacks {
  /**
   * Live output chunk. `offset` is the absolute end position in the cumulative
   * stream; `epoch` is the incarnation generation identifier, snapshotted with
   * the chunk so a response never pairs one incarnation's bytes with another's
   * epoch (terminal-history-paging.md §3.4).
   */
  onData: (data: string, offset: number, epoch: number) => void;
  onExit: (exitCode: number, signal: string | null, reason?: ExitReason) => void;
  onActivityChange?: (state: AgentActivityState) => void;
}

/**
 * Base interface for all internal workers.
 */
export interface InternalWorkerBase {
  id: string;
  name: string;
  createdAt: string;
}

/**
 * Disposable interface for cleaning up PTY event handlers.
 */
export interface Disposable {
  dispose: () => void;
}

/**
 * Base interface for PTY-based workers (agent, terminal).
 * Uses Map to support multiple concurrent WebSocket connections (e.g., multiple browser tabs).
 * After server restart, pty may be null until the worker is activated via WebSocket connection.
 */
export interface InternalPtyWorkerBase extends InternalWorkerBase {
  pty: PtyInstance | null;  // null = not yet activated after server restart
  outputBuffer: string;
  outputOffset: number;  // Current absolute output offset in bytes (cumulative stream position)
  // Generation identifier of the current incarnation (ms timestamp). Loaded
  // from the manifest at activation; a new value is minted on worker restart.
  // Tags every `output` message so the client can detect a restart (§3.4).
  epoch: number;
  // Map of connection ID to callbacks - supports multiple simultaneous connections
  connectionCallbacks: Map<string, WorkerCallbacks>;
  // Disposables for PTY event handlers - cleaned up when worker is killed
  disposables?: Disposable[];
}

/**
 * Internal agent worker with PTY, activity detection, and agent-specific state.
 */
export interface InternalAgentWorker extends InternalPtyWorkerBase {
  type: 'agent';
  agentId: string;
  activityState: AgentActivityState;
  activityDetector: ActivityDetector | null;  // null when pty is null
}

/**
 * Internal terminal worker with PTY for shell access.
 */
export interface InternalTerminalWorker extends InternalPtyWorkerBase {
  type: 'terminal';
}

/**
 * Internal git-diff worker. Does not use PTY - runs in server process.
 */
export interface InternalGitDiffWorker extends InternalWorkerBase {
  type: 'git-diff';
  baseCommit: string;
  // File watcher and callbacks managed by git-diff-handler.ts
}

/**
 * Union type for PTY-based workers.
 */
export type InternalPtyWorker = InternalAgentWorker | InternalTerminalWorker;

/**
 * Union type for all internal workers.
 */
export type InternalWorker = InternalAgentWorker | InternalTerminalWorker | InternalGitDiffWorker;
