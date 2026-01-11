/**
 * WorkerManager - Manages worker lifecycle and PTY operations.
 *
 * Responsibilities:
 * - Worker initialization (create worker objects)
 * - PTY activation (spawn PTY processes)
 * - Worker I/O (attach/detach callbacks, write input, resize)
 * - Worker recovery (restore workers after server restart)
 * - Conversion between internal and public worker types
 *
 * Note: This class does NOT know about sessions. SessionManager is responsible
 * for session-level concerns and calls WorkerManager with appropriate context.
 */

import type {
  Worker,
  AgentWorker,
  TerminalWorker,
  GitDiffWorker,
  AgentActivityState,
} from '@agent-console/shared';
import type {
  PersistedWorker,
  PersistedAgentWorker,
  PersistedTerminalWorker,
  PersistedGitDiffWorker,
} from './persistence-service.js';
import type { PtyProvider } from '../lib/pty-provider.js';
import type {
  InternalWorker,
  InternalPtyWorker,
  InternalAgentWorker,
  InternalTerminalWorker,
  InternalGitDiffWorker,
  WorkerCallbacks,
  Disposable,
} from './worker-types.js';
import { ActivityDetector } from './activity-detector.js';
import { getAgentManager, CLAUDE_CODE_AGENT_ID } from './agent-manager.js';
import { getChildProcessEnv, getUnsetEnvPrefix } from './env-filter.js';
import { expandTemplate } from '../lib/template.js';
import { calculateBaseCommit, resolveRef } from './git-diff-service.js';
import { serverConfig } from '../lib/server-config.js';
import { workerOutputFileManager } from '../lib/worker-output-file.js';
import { getNotificationManager } from './notifications/index.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('worker-manager');

/**
 * Context passed from SessionManager for worker operations.
 * WorkerManager doesn't know about sessions directly.
 */
export interface WorkerContext {
  sessionId: string;
  locationPath: string;
  repositoryEnvVars: Record<string, string>;
}

/**
 * Parameters for initializing an agent worker.
 */
export interface AgentWorkerInitParams {
  id: string;
  name: string;
  createdAt: string;
  agentId: string;
}

/**
 * Parameters for initializing a terminal worker.
 */
export interface TerminalWorkerInitParams {
  id: string;
  name: string;
  createdAt: string;
}

/**
 * Parameters for initializing a git-diff worker.
 */
export interface GitDiffWorkerInitParams {
  id: string;
  name: string;
  createdAt: string;
  locationPath: string;
  baseCommit?: string;
}

/**
 * Parameters for activating an agent worker's PTY.
 */
export interface AgentActivationParams extends WorkerContext {
  agentId: string;
  continueConversation: boolean;
  initialPrompt?: string;
}

/**
 * Parameters for activating a terminal worker's PTY.
 */
export interface TerminalActivationParams extends WorkerContext {
  // No additional parameters needed
}

/**
 * Callback type for global activity state changes.
 */
export type GlobalActivityCallback = (
  sessionId: string,
  workerId: string,
  state: AgentActivityState
) => void;

/**
 * Callback type for PTY exit events.
 * Used to notify SessionManager when a worker's PTY exits so it can update
 * the session's activation state.
 */
export type PtyExitCallback = (
  sessionId: string,
  workerId: string
) => void;

/**
 * Session info for notification events.
 * Minimal interface to avoid circular dependency with InternalSession.
 */
export interface SessionInfoForNotification {
  id: string;
  title?: string;
  worktreeId: string | null;
  repositoryId: string | null;
}

export class WorkerManager {
  private ptyProvider: PtyProvider;
  private globalActivityCallback?: GlobalActivityCallback;
  private globalPtyExitCallback?: PtyExitCallback;

  constructor(ptyProvider: PtyProvider) {
    this.ptyProvider = ptyProvider;
  }

  /**
   * Set a global callback for all activity state changes (for dashboard broadcast).
   */
  setGlobalActivityCallback(callback: GlobalActivityCallback): void {
    this.globalActivityCallback = callback;
  }

  /**
   * Set a global callback for PTY exit events.
   * Used by SessionManager to update session activation state when workers exit.
   */
  setGlobalPtyExitCallback(callback: PtyExitCallback): void {
    this.globalPtyExitCallback = callback;
  }

  // ========== Worker Initialization ==========

  /**
   * Initialize an agent worker WITHOUT starting the PTY.
   * The PTY will be activated later via activateAgentWorkerPty.
   */
  async initializeAgentWorker(params: AgentWorkerInitParams): Promise<InternalAgentWorker> {
    const { id, name, createdAt, agentId } = params;

    const resolvedAgentId = agentId ?? CLAUDE_CODE_AGENT_ID;
    const agentManager = await getAgentManager();
    const agent = agentManager.getAgent(resolvedAgentId) ?? agentManager.getDefaultAgent();

    const worker: InternalAgentWorker = {
      id,
      type: 'agent',
      name,
      createdAt,
      agentId: agent.id,
      pty: null,
      outputBuffer: '',
      outputOffset: 0,
      activityState: 'unknown',
      activityDetector: null,
      connectionCallbacks: new Map(),
    };

    return worker;
  }

  /**
   * Initialize a terminal worker WITHOUT starting the PTY.
   * The PTY will be activated later via activateTerminalWorkerPty.
   */
  initializeTerminalWorker(params: TerminalWorkerInitParams): InternalTerminalWorker {
    const { id, name, createdAt } = params;

    const worker: InternalTerminalWorker = {
      id,
      type: 'terminal',
      name,
      createdAt,
      pty: null,
      outputBuffer: '',
      outputOffset: 0,
      connectionCallbacks: new Map(),
    };

    return worker;
  }

  /**
   * Initialize a git-diff worker (async for base commit calculation).
   */
  async initializeGitDiffWorker(params: GitDiffWorkerInitParams): Promise<InternalGitDiffWorker> {
    const { id, name, createdAt, locationPath, baseCommit } = params;

    let resolvedBaseCommit: string;

    if (baseCommit) {
      const resolved = await resolveRef(baseCommit, locationPath);
      resolvedBaseCommit = resolved ?? 'HEAD';
    } else {
      const mergeBase = await calculateBaseCommit(locationPath);
      resolvedBaseCommit = mergeBase ?? 'HEAD';
    }

    const worker: InternalGitDiffWorker = {
      id,
      type: 'git-diff',
      name,
      createdAt,
      baseCommit: resolvedBaseCommit,
    };

    return worker;
  }

  // ========== PTY Activation ==========

  /**
   * Activate PTY for an agent worker.
   * Mutates the worker object to add pty and activityDetector.
   */
  async activateAgentWorkerPty(
    worker: InternalAgentWorker,
    params: AgentActivationParams
  ): Promise<void> {
    // Idempotent: If PTY already active, skip
    if (worker.pty !== null) {
      logger.debug(
        { workerId: worker.id, existingPid: worker.pty.pid },
        'Agent worker PTY already active, skipping activation'
      );
      return;
    }

    const { sessionId, locationPath, agentId, continueConversation, initialPrompt, repositoryEnvVars } = params;

    const agentManager = await getAgentManager();
    const agent = agentManager.getAgent(agentId) ?? agentManager.getDefaultAgent();

    const template = continueConversation && agent.continueTemplate
      ? agent.continueTemplate
      : agent.commandTemplate;

    const { command, env: templateEnv } = expandTemplate({
      template,
      prompt: initialPrompt,
      cwd: locationPath,
    });

    const processEnv = {
      ...getChildProcessEnv(),
      ...repositoryEnvVars,
      ...templateEnv,
    };

    const unsetPrefix = getUnsetEnvPrefix();
    const ptyProcess = this.ptyProvider.spawn('sh', ['-c', unsetPrefix + command], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: locationPath,
      env: processEnv,
    });

    const activityDetector = new ActivityDetector({
      onStateChange: (state) => {
        worker.activityState = state;
        const callbacksSnapshot = Array.from(worker.connectionCallbacks.values());
        for (const callbacks of callbacksSnapshot) {
          callbacks.onActivityChange?.(state);
        }
        this.globalActivityCallback?.(sessionId, worker.id, state);
      },
      activityPatterns: agent.activityPatterns,
    });

    worker.pty = ptyProcess;
    worker.activityDetector = activityDetector;
    worker.agentId = agentId;

    this.setupWorkerEventHandlers(worker, sessionId);
  }

  /**
   * Activate PTY for a terminal worker.
   * Mutates the worker object to add pty.
   */
  activateTerminalWorkerPty(
    worker: InternalTerminalWorker,
    params: TerminalActivationParams
  ): void {
    // Idempotent: If PTY already active, skip
    if (worker.pty !== null) {
      logger.debug(
        { workerId: worker.id, existingPid: worker.pty.pid },
        'Terminal worker PTY already active, skipping activation'
      );
      return;
    }

    const { sessionId, locationPath, repositoryEnvVars } = params;

    const processEnv = {
      ...getChildProcessEnv(),
      ...repositoryEnvVars,
    };

    const unsetPrefix = getUnsetEnvPrefix();
    const shell = process.env.SHELL || '/bin/bash';
    const ptyProcess = this.ptyProvider.spawn('sh', ['-c', `${unsetPrefix}exec ${shell} -l`], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: locationPath,
      env: processEnv,
    });

    worker.pty = ptyProcess;

    this.setupWorkerEventHandlers(worker, sessionId);
  }

  /**
   * Setup event handlers for a PTY worker.
   * Stores disposables on the worker for cleanup when worker is killed.
   */
  private setupWorkerEventHandlers(worker: InternalPtyWorker, sessionId: string): void {
    if (!sessionId || sessionId.trim() === '') {
      throw new Error(
        `Cannot setup event handlers: sessionId is required (got: ${sessionId === '' ? 'empty string' : String(sessionId)})`
      );
    }

    if (!worker.pty) {
      throw new Error('Cannot setup event handlers: worker.pty is null');
    }

    const disposables: Disposable[] = [];

    const onDataDisposable = worker.pty.onData((data) => {
      worker.outputBuffer += data;
      const maxBufferSize = serverConfig.WORKER_OUTPUT_BUFFER_SIZE;
      if (worker.outputBuffer.length > maxBufferSize) {
        worker.outputBuffer = worker.outputBuffer.slice(-maxBufferSize);
      }

      worker.outputOffset += Buffer.byteLength(data, 'utf-8');

      workerOutputFileManager.bufferOutput(sessionId, worker.id, data);

      if (worker.type === 'agent' && worker.activityDetector) {
        worker.activityDetector.processOutput(data);
      }

      const callbacksSnapshot = Array.from(worker.connectionCallbacks.values());
      for (const callbacks of callbacksSnapshot) {
        callbacks.onData(data, worker.outputOffset);
      }
    });
    if (onDataDisposable) {
      disposables.push({ dispose: () => onDataDisposable.dispose() });
    }

    const pty = worker.pty;
    const onExitDisposable = pty.onExit(({ exitCode, signal }) => {
      const signalStr = signal !== undefined ? String(signal) : null;
      logger.info({ workerId: worker.id, pid: pty.pid, exitCode, signal: signalStr }, 'Worker exited');

      // Mark worker as deactivated (PTY no longer running)
      worker.pty = null;

      if (worker.type === 'agent' && worker.activityDetector) {
        worker.activityDetector.dispose();
        worker.activityDetector = null;
      }

      const callbacksSnapshot = Array.from(worker.connectionCallbacks.values());
      for (const callbacks of callbacksSnapshot) {
        callbacks.onExit(exitCode, signalStr);
      }

      // Send notification for worker exit
      this.notifyWorkerExit(sessionId, worker, exitCode);

      // Notify SessionManager that PTY exited so it can update session activation state
      this.globalPtyExitCallback?.(sessionId, worker.id);
    });
    if (onExitDisposable) {
      disposables.push({ dispose: () => onExitDisposable.dispose() });
    }

    // Store disposables on worker for cleanup
    worker.disposables = disposables;
  }

  /**
   * Notify about worker exit. Called by setupWorkerEventHandlers.
   * Session info is fetched via callback to avoid coupling.
   */
  private notifyWorkerExit(sessionId: string, worker: InternalPtyWorker, exitCode: number): void {
    try {
      const notificationManager = getNotificationManager();
      // Get session info via the onGetSessionInfo callback if provided
      // For now, use minimal info since we don't have session context
      notificationManager.onWorkerExit(
        {
          id: sessionId,
          title: undefined,
          worktreeId: null,
          repositoryId: null,
        },
        { id: worker.id },
        exitCode
      );
    } catch {
      // NotificationManager not initialized yet, skip
    }
  }

  // ========== Worker I/O ==========

  /**
   * Attach callbacks for a WebSocket connection to a worker.
   * @returns Connection ID for later detachment, or null if worker is invalid
   */
  attachCallbacks(worker: InternalPtyWorker, callbacks: WorkerCallbacks): string {
    const connectionId = crypto.randomUUID();
    worker.connectionCallbacks.set(connectionId, {
      onData: callbacks.onData,
      onExit: callbacks.onExit,
      onActivityChange: callbacks.onActivityChange,
    });
    return connectionId;
  }

  /**
   * Detach callbacks for a specific WebSocket connection.
   */
  detachCallbacks(worker: InternalPtyWorker, connectionId: string): boolean {
    return worker.connectionCallbacks.delete(connectionId);
  }

  /**
   * Write input data to a worker's PTY.
   */
  writeInput(worker: InternalPtyWorker, data: string): boolean {
    if (!worker.pty) {
      logger.warn({ workerId: worker.id }, 'Cannot write input: worker PTY is not active');
      return false;
    }

    // Handle activity detection for agent workers
    if (worker.type === 'agent' && worker.activityDetector) {
      if (data.includes('\r')) {
        worker.activityDetector.clearUserTyping(false);
      } else if (data === '\x1b') {
        worker.activityDetector.clearUserTyping(true);
      } else if (data === '\x1b[I' || data === '\x1b[O') {
        // Ignore focus events
      } else {
        worker.activityDetector.setUserTyping();
      }
    }

    worker.pty.write(data);
    return true;
  }

  /**
   * Resize a worker's PTY.
   */
  resize(worker: InternalPtyWorker, cols: number, rows: number): boolean {
    if (!worker.pty) {
      logger.warn({ workerId: worker.id }, 'Cannot resize: worker PTY is not active');
      return false;
    }

    worker.pty.resize(cols, rows);
    return true;
  }

  // ========== Worker Recovery ==========

  /**
   * Restore workers from persisted data into InternalWorker format.
   * PTY workers are created with pty: null (will be activated on WebSocket connection).
   * Git-diff workers are fully restored (no PTY needed).
   */
  restoreWorkersFromPersistence(persistedWorkers: PersistedWorker[]): Map<string, InternalWorker> {
    const workers = new Map<string, InternalWorker>();

    // Shared base properties (excluding connectionCallbacks which must be unique per worker)
    const ptyWorkerBase = {
      pty: null,
      outputBuffer: '',
      outputOffset: 0,
    };

    for (const pw of persistedWorkers) {
      const base = { id: pw.id, name: pw.name, createdAt: pw.createdAt };
      let worker: InternalWorker;

      switch (pw.type) {
        case 'agent':
          worker = {
            ...base,
            ...ptyWorkerBase,
            connectionCallbacks: new Map(), // Must be unique per worker
            type: 'agent',
            agentId: pw.agentId,
            activityState: 'unknown',
            activityDetector: null,
          };
          break;
        case 'terminal':
          worker = { ...base, ...ptyWorkerBase, connectionCallbacks: new Map(), type: 'terminal' };
          break;
        case 'git-diff':
          worker = { ...base, type: 'git-diff', baseCommit: pw.baseCommit };
          break;
        default: {
          // Exhaustive check: compile error if new worker type is added
          const _exhaustive: never = pw;
          throw new Error(`Unknown worker type in persistence: ${(_exhaustive as PersistedWorker).type}`);
        }
      }

      workers.set(pw.id, worker);
    }

    return workers;
  }

  // ========== Conversion Utilities ==========

  /**
   * Convert an internal worker to public API format.
   */
  toPublicWorker(worker: InternalWorker): Worker {
    const base = { id: worker.id, name: worker.name, createdAt: worker.createdAt };

    switch (worker.type) {
      case 'agent':
        return { ...base, type: 'agent', agentId: worker.agentId, activated: worker.pty !== null } as AgentWorker;
      case 'terminal':
        return { ...base, type: 'terminal', activated: worker.pty !== null } as TerminalWorker;
      case 'git-diff':
        return { ...base, type: 'git-diff', baseCommit: worker.baseCommit } as GitDiffWorker;
    }
  }

  /**
   * Convert an internal worker to persisted format.
   */
  toPersistedWorker(worker: InternalWorker): PersistedWorker {
    const base = { id: worker.id, name: worker.name, createdAt: worker.createdAt };

    switch (worker.type) {
      case 'agent':
        return { ...base, type: 'agent', agentId: worker.agentId, pid: worker.pty?.pid ?? null } as PersistedAgentWorker;
      case 'terminal':
        return { ...base, type: 'terminal', pid: worker.pty?.pid ?? null } as PersistedTerminalWorker;
      case 'git-diff':
        return { ...base, type: 'git-diff', baseCommit: worker.baseCommit } as PersistedGitDiffWorker;
    }
  }

  /**
   * Get the output buffer for a PTY worker.
   */
  getOutputBuffer(worker: InternalPtyWorker): string {
    return worker.outputBuffer;
  }

  /**
   * Get the activity state for an agent worker.
   */
  getActivityState(worker: InternalAgentWorker): AgentActivityState {
    return worker.activityState;
  }

  /**
   * Kill a worker's PTY process and clean up resources.
   * Disposes PTY event handlers before killing to prevent memory leaks.
   */
  killWorker(worker: InternalWorker): void {
    if (worker.type === 'agent' || worker.type === 'terminal') {
      // Dispose PTY event handlers first to prevent memory leaks
      if (worker.disposables) {
        for (const disposable of worker.disposables) {
          disposable.dispose();
        }
        worker.disposables = undefined;
      }

      // Kill PTY process
      if (worker.pty) worker.pty.kill();

      // Dispose activity detector for agent workers
      if (worker.type === 'agent' && worker.activityDetector) {
        worker.activityDetector.dispose();
      }
    }
    // git-diff workers have no PTY to kill
  }
}
