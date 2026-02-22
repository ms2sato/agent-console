/**
 * WorkerLifecycleManager - Session-aware worker lifecycle operations.
 *
 * Responsibilities:
 * - Worker creation (initialize + activate PTY + persist)
 * - Worker deletion (kill + cleanup + remove)
 * - Worker restart (kill old, create new with same ID)
 * - Worker restoration (activate PTY after server restart)
 * - Worker I/O delegation (attach/detach callbacks, write input, resize)
 * - Worker output history (file-based output with incremental sync)
 *
 * This class sits between SessionManager and WorkerManager:
 * - SessionManager handles session lifecycle and delegates worker ops here
 * - WorkerLifecycleManager handles session-aware worker lifecycle
 * - WorkerManager handles low-level PTY operations (session-agnostic)
 *
 * Dependencies are injected via WorkerLifecycleDeps to avoid circular imports.
 * SessionManager creates this with closures that capture its own state.
 */

import type {
  Session,
  Worker,
  AgentActivityState,
  CreateWorkerParams,
  WorkerErrorCode,
} from '@agent-console/shared';
import type {
  InternalWorker,
  InternalPtyWorker,
  WorkerCallbacks,
} from './worker-types.js';
import type { InternalSession } from './internal-types.js';
import type { WorkerManager } from './worker-manager.js';
import type { JobQueue } from '../jobs/index.js';
import { JOB_TYPES } from '../jobs/index.js';
import { getAgentManager, CLAUDE_CODE_AGENT_ID } from './agent-manager.js';
import { stopWatching } from './git-diff-service.js';
import { getNotificationManager } from './notifications/index.js';
import {
  getCurrentBranch as gitGetCurrentBranch,
  renameBranch as gitRenameBranch,
} from '../lib/git.js';
import { workerOutputFileManager, type HistoryReadResult } from '../lib/worker-output-file.js';
import { createLogger } from '../lib/logger.js';

import type { SessionLifecycleCallbacks } from './session-manager.js';

const logger = createLogger('worker-lifecycle-manager');

/**
 * Dependencies injected by SessionManager.
 * Uses closures to capture late-bound state (jobQueue, sessionLifecycleCallbacks, etc.)
 * so values are always current at call time.
 */
export interface WorkerLifecycleDeps {
  workerManager: WorkerManager;
  pathExists: (path: string) => Promise<boolean>;
  getSession: (sessionId: string) => InternalSession | undefined;
  persistSession: (session: InternalSession) => Promise<void>;
  getRepositoryEnvVars: (sessionId: string) => Record<string, string>;
  toPublicSession: (session: InternalSession) => Session;
  getJobQueue: () => JobQueue | null;
  getSessionLifecycleCallbacks: () => SessionLifecycleCallbacks | undefined;
}

/**
 * Result type for restoreWorker operation.
 * Provides detailed error information for specific failure cases.
 * Note: worker type is narrowed to 'agent' | 'terminal' since git-diff workers
 * don't support PTY restoration.
 *
 * @property wasRestored - true if PTY was activated (was hibernated), false if already active.
 *   Used to notify clients about server restart so they can invalidate cached state.
 */
export type RestoreWorkerResult =
  | { success: true; worker: { type: 'agent' | 'terminal' }; wasRestored: boolean }
  | { success: false; errorCode: WorkerErrorCode; message: string };

export class WorkerLifecycleManager {
  constructor(private deps: WorkerLifecycleDeps) {}

  // ========== Worker Lifecycle ==========

  async createWorker(
    sessionId: string,
    request: CreateWorkerParams,
    continueConversation: boolean = false,
    initialPrompt?: string
  ): Promise<Worker | null> {
    const session = this.deps.getSession(sessionId);
    if (!session) return null;

    const workerId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const agentIdForName = request.type === 'agent' ? request.agentId : undefined;
    const workerName = request.name ?? await this.generateWorkerName(session, request.type, agentIdForName);

    let worker: InternalWorker;
    const repositoryEnvVars = this.deps.getRepositoryEnvVars(sessionId);
    const repositoryId = session.type === 'worktree' ? session.repositoryId : undefined;

    if (request.type === 'agent') {
      const agentWorker = await this.deps.workerManager.initializeAgentWorker({
        id: workerId,
        name: workerName,
        createdAt,
        agentId: request.agentId,
      });
      await this.deps.workerManager.activateAgentWorkerPty(agentWorker, {
        sessionId,
        locationPath: session.locationPath,
        repositoryEnvVars,
        agentId: agentWorker.agentId,
        continueConversation,
        initialPrompt,
        repositoryId,
      });
      worker = agentWorker;
    } else if (request.type === 'terminal') {
      const terminalWorker = this.deps.workerManager.initializeTerminalWorker({
        id: workerId,
        name: workerName,
        createdAt,
      });
      this.deps.workerManager.activateTerminalWorkerPty(terminalWorker, {
        sessionId,
        locationPath: session.locationPath,
        repositoryEnvVars,
      });
      worker = terminalWorker;
    } else {
      // git-diff worker (async initialization for base commit calculation)
      worker = await this.deps.workerManager.initializeGitDiffWorker({
        id: workerId,
        name: workerName,
        createdAt,
        locationPath: session.locationPath,
        baseCommit: request.baseCommit,
      });
    }

    session.workers.set(workerId, worker);

    // Initialize output file immediately for PTY workers (agent/terminal)
    // This prevents race conditions where WebSocket connects before any output is buffered
    if (request.type === 'agent' || request.type === 'terminal') {
      await workerOutputFileManager.initializeWorkerOutput(sessionId, workerId);
    }

    await this.deps.persistSession(session);

    logger.info({ workerId, workerType: request.type, sessionId }, 'Worker created');

    return this.deps.workerManager.toPublicWorker(worker);
  }

  getWorker(sessionId: string, workerId: string): InternalWorker | undefined {
    const session = this.deps.getSession(sessionId);
    return session?.workers.get(workerId);
  }

  /**
   * Get a worker that is ready for PTY operations.
   * If the worker exists but PTY is not activated (after server restart),
   * this method will activate the PTY before returning the worker.
   * Returns null if worker doesn't exist or activation fails.
   */
  async getAvailableWorker(sessionId: string, workerId: string): Promise<InternalPtyWorker | null> {
    const session = this.deps.getSession(sessionId);
    if (!session) return null;

    const worker = session.workers.get(workerId);
    if (!worker) return null;

    // git-diff workers don't have PTY
    if (worker.type === 'git-diff') return null;

    // If PTY is already active, return the worker
    if (worker.pty) {
      return worker;
    }

    // PTY is not active - need to activate it
    // SECURITY: Verify session's locationPath still exists before activating
    const pathExistsResult = await this.deps.pathExists(session.locationPath);
    if (!pathExistsResult) {
      logger.warn({ sessionId, workerId, locationPath: session.locationPath }, 'Cannot activate worker: session path no longer exists');
      return null;
    }

    const repositoryEnvVars = this.deps.getRepositoryEnvVars(sessionId);
    const repositoryId = session.type === 'worktree' ? session.repositoryId : undefined;

    // Activate PTY based on worker type
    if (worker.type === 'agent') {
      const effectiveAgentId = await this.resolveEffectiveAgentId(worker.agentId, { sessionId, workerId });
      await this.deps.workerManager.activateAgentWorkerPty(worker, {
        sessionId,
        locationPath: session.locationPath,
        repositoryEnvVars,
        agentId: effectiveAgentId,
        continueConversation: true,
        repositoryId,
      });
    } else {
      this.deps.workerManager.activateTerminalWorkerPty(worker, {
        sessionId,
        locationPath: session.locationPath,
        repositoryEnvVars,
      });
    }

    await this.deps.persistSession(session);
    logger.info({ workerId, sessionId, workerType: worker.type }, 'Worker PTY activated');

    return worker;
  }

  async deleteWorker(sessionId: string, workerId: string): Promise<boolean> {
    const session = this.deps.getSession(sessionId);
    if (!session) return false;

    const worker = session.workers.get(workerId);
    if (!worker) return false;

    // Clean up based on worker type
    if (worker.type === 'agent' || worker.type === 'terminal') {
      this.deps.workerManager.killWorker(worker);
      await this.cleanupWorkerOutput(sessionId, workerId);
    } else {
      // git-diff worker: stop file watcher (synchronous operation)
      stopWatching(session.locationPath);
    }

    // Clean up notification state (debounce timers, previous state)
    try {
      const notificationManager = getNotificationManager();
      notificationManager.cleanupWorker(sessionId, workerId);
    } catch {
      // NotificationManager not initialized yet, skip
    }

    session.workers.delete(workerId);
    await this.deps.persistSession(session);

    logger.info({ workerId, sessionId }, 'Worker deleted');
    return true;
  }

  async restartAgentWorker(
    sessionId: string,
    workerId: string,
    continueConversation: boolean,
    agentId?: string,
    branch?: string
  ): Promise<Worker | null> {
    const session = this.deps.getSession(sessionId);
    if (!session) return null;

    const existingWorker = session.workers.get(workerId);
    if (!existingWorker || existingWorker.type !== 'agent') return null;

    // Resolve agent ID: use provided agentId or fall back to existing
    const workerAgentId = agentId ?? existingWorker.agentId;

    // Validate that the agent exists if a new agentId was provided
    if (agentId) {
      const agentManager = await getAgentManager();
      const agent = agentManager.getAgent(agentId);
      if (!agent) {
        logger.warn({ workerId, sessionId, agentId }, 'Cannot restart worker: agent not found');
        return null;
      }
    }

    // Handle branch rename if requested (must happen before restart)
    if (branch && session.type === 'worktree') {
      try {
        const currentBranch = await gitGetCurrentBranch(session.locationPath);
        if (currentBranch !== branch) {
          await gitRenameBranch(currentBranch, branch, session.locationPath);
        }
        session.worktreeId = branch;
      } catch (err) {
        logger.error(
          { sessionId, workerId, branch, locationPath: session.locationPath, err },
          'Failed to rename branch during worker restart'
        );
        throw err;
      }
    }

    const isAgentChanged = workerAgentId !== existingWorker.agentId;

    // Capture worker metadata before killing (needed for new worker creation)
    const workerName = isAgentChanged
      ? await this.generateWorkerName(session, 'agent', workerAgentId)
      : existingWorker.name;
    const workerCreatedAt = existingWorker.createdAt;
    const locationPath = session.locationPath;

    // Kill existing worker
    this.deps.workerManager.killWorker(existingWorker);

    // Reset the output file to prevent offset mismatch with client cache.
    await workerOutputFileManager.resetWorkerOutput(sessionId, workerId);

    // Create new worker with same ID, preserving original createdAt for tab order
    const repositoryEnvVars = this.deps.getRepositoryEnvVars(sessionId);
    const repositoryId = session.type === 'worktree' ? session.repositoryId : undefined;
    const newWorker = await this.deps.workerManager.initializeAgentWorker({
      id: workerId,
      name: workerName,
      createdAt: workerCreatedAt,
      agentId: workerAgentId,
    });
    await this.deps.workerManager.activateAgentWorkerPty(newWorker, {
      sessionId,
      locationPath,
      repositoryEnvVars,
      agentId: workerAgentId,
      continueConversation,
      repositoryId,
    });

    // Re-check session still exists after async gap
    // Session may have been deleted during async operations above
    const currentSession = this.deps.getSession(sessionId);
    if (!currentSession) {
      logger.warn({ sessionId, workerId }, 'Session deleted during worker restart, killing new worker');
      this.deps.workerManager.killWorker(newWorker);
      return null;
    }

    currentSession.workers.set(workerId, newWorker);
    await this.deps.persistSession(currentSession);

    // Broadcast session update so all clients learn about agent/name/branch changes
    const hasBranchChange = branch !== undefined && session.type === 'worktree';
    if (isAgentChanged || hasBranchChange) {
      this.deps.getSessionLifecycleCallbacks()?.onSessionUpdated?.(this.deps.toPublicSession(currentSession));
    }

    let restartReason = 'Agent worker restarted';
    if (isAgentChanged) {
      restartReason = 'Agent worker switched to different agent';
    } else if (hasBranchChange) {
      restartReason = 'Agent worker restarted with branch rename';
    }

    logger.info(
      { workerId, sessionId, continueConversation, agentId: workerAgentId, previousAgentId: existingWorker.agentId, branch },
      restartReason
    );

    return this.deps.workerManager.toPublicWorker(newWorker);
  }

  /**
   * Restore a PTY worker and ensure its PTY is active.
   * Called when WebSocket connection is established to ensure the worker is ready for I/O.
   *
   * - If worker exists with active PTY, return it as-is
   * - If worker exists without PTY (loaded from persistence), activate its PTY
   * - Returns error for git-diff workers (they don't need PTY restoration)
   * - Returns error with specific code if worker cannot be restored
   */
  async restoreWorker(sessionId: string, workerId: string): Promise<RestoreWorkerResult> {
    const session = this.deps.getSession(sessionId);
    if (!session) {
      return {
        success: false,
        errorCode: 'WORKER_NOT_FOUND',
        message: 'Session not found',
      };
    }

    const existingWorker = session.workers.get(workerId);
    if (!existingWorker) {
      return {
        success: false,
        errorCode: 'WORKER_NOT_FOUND',
        message: 'Worker not found in session',
      };
    }

    // Git-diff workers don't need PTY restoration
    if (existingWorker.type === 'git-diff') {
      return {
        success: false,
        errorCode: 'WORKER_NOT_FOUND',
        message: 'Git-diff workers do not support PTY restoration',
      };
    }

    // If PTY is already active, return as-is (normal browser reload case)
    if (existingWorker.pty) {
      return { success: true, worker: existingWorker, wasRestored: false };
    }

    // SECURITY: Verify session's locationPath still exists before activating PTY
    const pathExistsResult = await this.deps.pathExists(session.locationPath);
    if (!pathExistsResult) {
      logger.warn({ sessionId, workerId, locationPath: session.locationPath }, 'Cannot restore worker: session path no longer exists');
      return {
        success: false,
        errorCode: 'PATH_NOT_FOUND',
        message: 'Session directory was deleted or is inaccessible',
      };
    }

    // Activate PTY for the worker
    try {
      const repositoryEnvVars = this.deps.getRepositoryEnvVars(sessionId);
      const repositoryId = session.type === 'worktree' ? session.repositoryId : undefined;

      if (existingWorker.type === 'agent') {
        const effectiveAgentId = await this.resolveEffectiveAgentId(existingWorker.agentId, { sessionId, workerId });
        await this.deps.workerManager.activateAgentWorkerPty(existingWorker, {
          sessionId,
          locationPath: session.locationPath,
          repositoryEnvVars,
          agentId: effectiveAgentId,
          continueConversation: true,
          repositoryId,
        });
      } else {
        this.deps.workerManager.activateTerminalWorkerPty(existingWorker, {
          sessionId,
          locationPath: session.locationPath,
          repositoryEnvVars,
        });
      }
    } catch (err) {
      logger.error({ sessionId, workerId, err }, 'Failed to activate PTY for worker');
      return {
        success: false,
        errorCode: 'ACTIVATION_FAILED',
        message: 'Failed to start process. Check permissions and system resources.',
      };
    }

    await this.deps.persistSession(session);

    logger.info({ workerId, sessionId, workerType: existingWorker.type }, 'Worker PTY activated');

    // Notify listeners that the worker was activated (broadcasts to app clients)
    this.deps.getSessionLifecycleCallbacks()?.onWorkerActivated?.(sessionId, workerId);

    return { success: true, worker: existingWorker, wasRestored: true };
  }

  // ========== Worker I/O Delegation ==========

  /**
   * Attach callbacks for a WebSocket connection to a worker.
   * Supports multiple concurrent connections (e.g., multiple browser tabs).
   * @returns Connection ID for later detachment, or null if worker not found
   */
  attachWorkerCallbacks(sessionId: string, workerId: string, callbacks: WorkerCallbacks): string | null {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return null;

    return this.deps.workerManager.attachCallbacks(worker, callbacks);
  }

  /**
   * Detach callbacks for a specific WebSocket connection.
   * @param connectionId The connection ID returned by attachWorkerCallbacks
   */
  detachWorkerCallbacks(sessionId: string, workerId: string, connectionId: string): boolean {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return false;

    return this.deps.workerManager.detachCallbacks(worker, connectionId);
  }

  writeWorkerInput(sessionId: string, workerId: string, data: string): boolean {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return false;

    return this.deps.workerManager.writeInput(worker, data);
  }

  resizeWorker(sessionId: string, workerId: string, cols: number, rows: number): boolean {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return false;

    return this.deps.workerManager.resize(worker, cols, rows);
  }

  getWorkerOutputBuffer(sessionId: string, workerId: string): string {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return '';
    return this.deps.workerManager.getOutputBuffer(worker);
  }

  getWorkerActivityState(sessionId: string, workerId: string): AgentActivityState | undefined {
    const worker = this.getWorker(sessionId, workerId);
    if (worker?.type === 'agent') {
      return this.deps.workerManager.getActivityState(worker);
    }
    return undefined;
  }

  /**
   * Get worker output history from file with optional offset for incremental sync.
   * @param sessionId Session ID
   * @param workerId Worker ID
   * @param fromOffset If specified, return only data after this offset
   * @param maxLines If specified and fromOffset is 0 or undefined, limit to last N lines
   * @returns History data and current offset, or null if not available
   */
  async getWorkerOutputHistory(
    sessionId: string,
    workerId: string,
    fromOffset?: number,
    maxLines?: number
  ): Promise<HistoryReadResult | null> {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return null;

    // Use line-limited read for initial connection (fromOffset is 0 or undefined)
    if (maxLines !== undefined && (fromOffset === undefined || fromOffset === 0)) {
      return workerOutputFileManager.readLastNLines(sessionId, workerId, maxLines);
    }

    return workerOutputFileManager.readHistoryWithOffset(sessionId, workerId, fromOffset);
  }

  /**
   * Get current output offset for a worker.
   * Used to mark the boundary before registering callbacks.
   * @returns Current file offset (0 if file doesn't exist)
   */
  async getCurrentOutputOffset(sessionId: string, workerId: string): Promise<number> {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return 0;

    return workerOutputFileManager.getCurrentOffset(sessionId, workerId);
  }

  // ========== Private Helpers ==========

  /**
   * Resolve effective agent ID, falling back to default if the original agent is no longer registered.
   */
  private async resolveEffectiveAgentId(agentId: string, context: { sessionId: string; workerId: string }): Promise<string> {
    const agentManager = await getAgentManager();
    const agent = agentManager.getAgent(agentId);
    if (agent) return agentId;

    logger.warn({ ...context, originalAgentId: agentId, fallbackAgentId: CLAUDE_CODE_AGENT_ID }, 'Agent no longer valid, falling back to default');
    return CLAUDE_CODE_AGENT_ID;
  }

  private async generateWorkerName(session: InternalSession, type: 'agent' | 'terminal' | 'git-diff', agentId?: string): Promise<string> {
    if (type === 'agent') {
      const agentManager = await getAgentManager();
      const agent = agentId ? agentManager.getAgent(agentId) : undefined;
      return agent?.name ?? 'AI';
    }

    if (type === 'git-diff') {
      return 'Git Diff';
    }

    const terminalCount = Array.from(session.workers.values())
      .filter((w) => w.type === 'terminal').length;
    return `Terminal ${terminalCount + 1}`;
  }

  /**
   * Clean up worker output file via job queue.
   * If jobQueue is not available, logs a warning and skips cleanup gracefully.
   */
  private async cleanupWorkerOutput(sessionId: string, workerId: string): Promise<void> {
    const jobQueue = this.deps.getJobQueue();
    if (!jobQueue) {
      logger.warn({ sessionId, workerId }, 'JobQueue not available, skipping async output cleanup');
      return;
    }
    await jobQueue.enqueue(JOB_TYPES.CLEANUP_WORKER_OUTPUT, { sessionId, workerId });
  }
}
