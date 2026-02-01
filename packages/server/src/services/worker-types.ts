/**
 * Internal worker types used by SessionManager and WorkerManager.
 * These types represent in-memory worker state with PTY and callbacks.
 *
 * Public API types (Worker, AgentWorker, etc.) are defined in @agent-console/shared.
 */

import type { AgentActivityState, SDKMessage } from '@agent-console/shared';
import type { PtyInstance } from '../lib/pty-provider.js';
import type { ActivityDetector } from './activity-detector.js';

/**
 * Callbacks for worker lifecycle events (data, exit, activity changes).
 * Used when attaching WebSocket connections to workers.
 * Multiple connections can be attached to a single worker (e.g., multiple browser tabs).
 */
export interface WorkerCallbacks {
  onData: (data: string, offset: number) => void;
  onExit: (exitCode: number, signal: string | null) => void;
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
  outputOffset: number;  // Current output offset in bytes (for incremental sync)
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
 * Callbacks for SDK worker events.
 * Similar to WorkerCallbacks but with structured messages instead of raw output.
 */
export interface SdkWorkerCallbacks {
  onMessage: (message: SDKMessage) => void;
  onActivityChange: (state: AgentActivityState) => void;
  onExit: (exitCode: number, signal: string | null) => void;
}

/**
 * Internal SDK worker. Does not use PTY - uses Claude Code SDK query().
 */
export interface InternalSdkWorker extends InternalWorkerBase {
  type: 'sdk';
  agentId: string;
  activityState: AgentActivityState;
  /** SDK session ID for resume capability */
  sdkSessionId: string | null;
  /** AbortController for cancelling current query() */
  abortController: AbortController | null;
  /** Whether a query() is currently running */
  isRunning: boolean;
  /** In-memory message history */
  messages: SDKMessage[];
  /** Callbacks for connected WebSocket clients */
  connectionCallbacks: Map<string, SdkWorkerCallbacks>;
}

/**
 * Union type for PTY-based workers.
 */
export type InternalPtyWorker = InternalAgentWorker | InternalTerminalWorker;

/**
 * Union type for all internal workers.
 */
export type InternalWorker = InternalAgentWorker | InternalTerminalWorker | InternalGitDiffWorker | InternalSdkWorker;
