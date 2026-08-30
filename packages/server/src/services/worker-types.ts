/**
 * Internal worker types used by SessionManager and WorkerManager.
 * These types represent in-memory worker state with PTY and callbacks.
 *
 * Public API types (Worker, AgentWorker, etc.) are defined in @agent-console/shared.
 */

import type { Subprocess, FileSink } from 'bun';
import type { AgentActivityState, ExitReason } from '@agent-console/shared';
import type { PtyInstance } from '../lib/pty-provider.js';
import type { ActivityDetector } from './activity-detector.js';
// Type-only import back into embedded-agent-worker-service.ts, which itself
// type-only imports `InternalEmbeddedAgentWorker` FROM this file -- not a
// real circular dependency (type-only imports are erased at build time).
// Referenced rather than re-declared: a hand-written copy of `RestoreInfo`'s
// shape does not fail to compile when it gains a member, so the two would
// silently drift -- the same "referenced rather than re-declared" pattern
// `session-manager.ts`'s `getEmbeddedAgentRestoreInfo` already uses for this
// exact type.
import type { RestoreInfo } from './embedded-agent-worker-service.js';

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
  /** Transcript Restore (#1123 success / #1205 completion / #1449 failure) push -- see EmbeddedAgentWorkerService. Embedded-agent workers only. */
  // `sdkResumed` (R1) is optional and THREE-VALUED: absent means the engine
  // has no such concept, `false` means a resume did not take. Consumers must
  // test `=== false`, never `!sdkResumed`. Applies identically to both
  // members of `RestoreInfo` below (success and #1449 failure).
  onRestoreInfo?: (info: RestoreInfo) => void;
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
  loginShellSentinel?: string;
  pendingCommand?: string;
  /**
   * MCP token file delivered to this worker (multi-user mode only); null when
   * no token was minted (single-user, or session lacked createdBy). Used to
   * delete the file on exit/kill/delete alongside the in-memory token revoke.
   */
  mcpToken: { filePath: string; username: string } | null;
  /**
   * Prompt file delivered to this worker's shell via the sentinel-injected
   * `claude "$(cat '<path>')"` command -- avoids embedding a
   * long initialPrompt directly on the injected line, which truncates once
   * it exceeds the tty's canonical-mode input buffer. null when no prompt
   * file was written (no initialPrompt, template lacks {{prompt}}, or
   * restart/continue). Used to delete the file on exit/kill alongside the
   * pendingCommand cleanup.
   */
  promptFile: { filePath: string; username: string } | null;
  /**
   * Whether this worker is eligible to receive the session's `initialPrompt`
   * on activation or restart. The terminal-agent counterpart of
   * `InternalEmbeddedAgentWorker.deliverInitialPromptOnActivation` below.
   * Set true only for the session's initial agent worker (created with a
   * non-empty `initialPrompt`); workers added later via the generic
   * add-worker route, or created without a prompt, are never eligible.
   * Persisted via `PersistedAgentWorker.deliverInitialPromptOnActivation`
   * and survives server restart.
   */
  deliverInitialPromptOnActivation: boolean;
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
 * Internal embedded-agent worker. Owns an LLM-loop subprocess (not a PTY) and
 * streams NDJSON events. Deliberately does NOT extend InternalPtyWorkerBase (no
 * PTY, no ActivityDetector), but mirrors the stream fields (outputOffset,
 * epoch, connectionCallbacks, live-handle-or-null) so the WebSocket plumbing
 * can treat "PTY worker or embedded-agent worker" uniformly where it only needs
 * those fields.
 */
export interface InternalEmbeddedAgentWorker extends InternalWorkerBase {
  type: 'embedded-agent';
  embeddedAgentId: string;
  /** Live subprocess handle; null = not activated (mirrors InternalPtyWorkerBase.pty). */
  subprocess: Subprocess<'pipe', 'pipe', 'pipe'> | null;
  /** stdin sink for protocol commands; null when subprocess is null. */
  stdin: FileSink | null;
  activityState: AgentActivityState;
  /** File-absolute byte offset of the NDJSON event log (same semantics as InternalPtyWorkerBase.outputOffset). */
  outputOffset: number;
  /** Incarnation id, same semantics as InternalPtyWorkerBase.epoch. */
  epoch: number;
  connectionCallbacks: Map<string, WorkerCallbacks>;
  /**
   * Whether this worker is eligible to receive the session's `initialPrompt`.
   * One of two mechanisms for the same family: the session's initial
   * agent-kind worker (embedded OR terminal-agent) is eligible; workers
   * added later via the generic add-worker route, or created without a
   * prompt, are never eligible. For this (embedded-agent) worker kind,
   * delivery happens as this worker's first user message once its loop
   * reports `ready`. See `InternalAgentWorker.deliverInitialPromptOnActivation`
   * for the terminal-agent twin, which instead delivers via a
   * sentinel-injected command referencing a prompt file.
   * Persisted via `PersistedEmbeddedAgentWorker.deliverInitialPromptOnActivation`
   * and survives server restart -- unlike `subprocess`/`stdin`, which are
   * always null-on-restore. See `docs/design/embedded-agent-worker.md`
   * "Initial prompt delivery".
   */
  deliverInitialPromptOnActivation: boolean;
  /**
   * The worker's CURRENT Claude Agent SDK session id (SDK engine only; stays
   * `null` for `openai-api` engine workers). Set from the `sdk-session-id`
   * event, emitted on activation and on every SDK-session replacement (e.g.
   * a future re-session) -- last-write-wins, mirroring
   * `subprocess`/`stdin`'s null-when-not-applicable convention. Persisted via
   * `PersistedEmbeddedAgentWorker.sdkSessionId` and survives server restart.
   * See docs/design/embedded-agent-sdk-engine.md §4 "Process lifetime" row.
   */
  sdkSessionId: string | null;
  /**
   * Compaction's automatic-firing toggle for THIS worker (see
   * docs/design/embedded-agent-worker.md "Compaction"). Per-worker rather
   * than per-definition on purpose: the decision belongs to the conversation
   * in front of the user, so two workers from the same embedded agent may
   * differ. Defaults ON. Persisted via
   * `PersistedEmbeddedAgentWorker.autoCompaction` (`workers.auto_compaction`)
   * and survives server restart.
   */
  autoCompaction: boolean;
}

/**
 * Union type for PTY-based workers.
 */
export type InternalPtyWorker = InternalAgentWorker | InternalTerminalWorker;

/**
 * Union type for all internal workers.
 */
export type InternalWorker =
  | InternalAgentWorker
  | InternalTerminalWorker
  | InternalGitDiffWorker
  | InternalEmbeddedAgentWorker;

/**
 * PTY-backed internal workers (agent, terminal). Positive predicate so callers
 * of PTY-only operations narrow structurally instead of enumerating every
 * non-PTY worker type (git-diff, embedded-agent, ...).
 */
export function isInternalPtyWorker(w: InternalWorker): w is InternalPtyWorker {
  return w.type === 'agent' || w.type === 'terminal';
}

/**
 * Workers exposing the shared append-only stream shape (outputOffset, epoch,
 * connectionCallbacks): PTY workers and embedded-agent workers. Lets the
 * WebSocket layer serve history / fan out output uniformly.
 */
export function isStreamWorker(
  w: InternalWorker
): w is InternalPtyWorker | InternalEmbeddedAgentWorker {
  return w.type === 'agent' || w.type === 'terminal' || w.type === 'embedded-agent';
}
