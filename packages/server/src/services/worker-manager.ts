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
  EmbeddedAgentWorker,
  AgentActivityState,
  ExitReason,
} from '@agent-console/shared';
import type {
  PersistedWorker,
  PersistedAgentWorker,
  PersistedTerminalWorker,
  PersistedGitDiffWorker,
  PersistedEmbeddedAgentWorker,
} from './persistence-service.js';
import type {
  InternalWorker,
  InternalPtyWorker,
  InternalAgentWorker,
  InternalTerminalWorker,
  InternalGitDiffWorker,
  InternalEmbeddedAgentWorker,
  WorkerCallbacks,
  Disposable,
} from './worker-types.js';
import type { SessionCreationContext } from './internal-types.js';
import type { SessionDataPathResolver } from '../lib/session-data-path-resolver.js';
import type { UserMode, AgentConsoleContext } from './user-mode.js';
import { ActivityDetector } from './activity-detector.js';
import { CLAUDE_CODE_AGENT_ID } from './agent-manager.js';
import type { AgentManager } from './agent-manager.js';
import { expandTemplate } from '../lib/template.js';
import { computeDefaultBaseSpec } from './git-diff-service.js';
import { serverConfig } from '../lib/server-config.js';
import type { WorkerOutputFileManager } from '../lib/worker-output-file.js';
import type { McpTokenRegistry } from '../mcp/mcp-auth.js';
import { writeUserOwnedSecretFile, rmRecursiveAsUser, type runAsUser } from './privilege-elevation.js';
import { lookupOsUser, type LookupOsUserFn } from './os-user-lookup.js';
import { createLogger } from '../lib/logger.js';
import * as path from 'node:path';

const logger = createLogger('worker-manager');

/** Name of the env var carrying the MCP token FILE PATH (never the raw token). */
const MCP_TOKEN_FILE_ENV_VAR = 'AGENT_CONSOLE_MCP_TOKEN_FILE';

/** Maximum time to wait for a PTY process to exit after kill signal. */
const PTY_EXIT_TIMEOUT_MS = 5000;

/**
 * Context passed from SessionManager for worker operations.
 * WorkerManager doesn't know about sessions directly.
 */
export interface WorkerContext {
  sessionId: string;
  locationPath: string;
  repositoryEnvVars: Record<string, string>;
  /** OS username for PTY process ownership. Used by MultiUserMode for sudo -u. */
  username: string;
  /** Path resolver for session data directories (messages, memos, outputs). */
  resolver: SessionDataPathResolver;
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
 * Parameters for initializing an embedded-agent worker.
 */
export interface EmbeddedAgentWorkerInitParams {
  id: string;
  name: string;
  createdAt: string;
  embeddedAgentId: string;
  /**
   * Whether this worker is the session's initial embedded-agent worker,
   * created with a non-empty `initialPrompt`. Gates whether
   * `EmbeddedAgentWorkerService` delivers the session's `initialPrompt` as
   * this worker's first user message once the loop reports `ready`.
   * `false`/omitted for workers added later via the generic add-worker route.
   * See `docs/design/embedded-agent-worker.md` "Initial prompt delivery".
   */
  deliverInitialPromptOnActivation?: boolean;
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
  /**
   * Issue #869: OS username to run git as during the initial
   * `computeDefaultBaseSpec` call. In multi-user mode this is the
   * worktree-owning user (resolved from the session's `createdBy`), so git
   * does not refuse with "dubious ownership in repository". Pass `null` in
   * single-user mode or when elevation is not required.
   */
  requestUser: string | null;
}

/**
 * Parameters for activating an agent worker's PTY.
 */
export interface AgentActivationParams extends WorkerContext {
  agentId: string;
  continueConversation: boolean;
  initialPrompt?: string;
  /** Repository ID for worktree sessions. Omit for quick sessions. */
  repositoryId?: string;
  /** Session creation context holding delegation and template information */
  context?: SessionCreationContext;
  /**
   * Whether this activation is reviving a worker whose PTY had previously died
   * (server restart, hibernation, pause/resume) while the persisted output
   * file remained on disk. When true, `outputOffset` is seeded from the
   * current file size so subsequent `output` events keep the file-absolute
   * semantic the client's IndexedDB cache expects (Issue #769).
   * Set false for fresh worker creation and for `restartWorker` (which
   * truncates the file to zero before activation).
   */
  revived: boolean;
  /**
   * The session owner's `users.id` UUID (`InternalSession.createdBy`). Used
   * (multi-user mode only) to mint an MCP bearer token identity comparable to
   * session ownership, mirroring `EmbeddedAgentWorkerServiceDeps`'s use of
   * `session.createdBy`. When absent (legacy / ownerless session), token
   * minting is skipped -- see the non-fatal skip in `activateAgentWorkerPty`.
   */
  createdByUserId?: string;
}

/**
 * Parameters for activating a terminal worker's PTY.
 */
export interface TerminalActivationParams extends WorkerContext {
  /**
   * Whether this activation is reviving a worker whose PTY had previously died
   * (server restart, hibernation, pause/resume) while the persisted output
   * file remained on disk. See `AgentActivationParams.revived` for details.
   */
  revived: boolean;
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
  workerId: string,
  reason: ExitReason
) => void;

/**
 * Callback type for global worker exit events.
 */
export type GlobalWorkerExitCallback = (
  sessionId: string,
  workerId: string,
  exitCode: number,
  reason: ExitReason
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
  private userMode: UserMode;
  private agentManager: AgentManager;
  private globalActivityCallback?: GlobalActivityCallback;
  private globalPtyExitCallback?: PtyExitCallback;
  private globalWorkerExitCallback?: GlobalWorkerExitCallback;

  constructor(
    userMode: UserMode,
    agentManager: AgentManager,
    private workerOutputFileManager: WorkerOutputFileManager,
    private mcpTokenRegistry?: Pick<McpTokenRegistry, 'mint' | 'revokeByWorker'>,
    /** Test seam for OS user lookup (MCP token file destination). Defaults to the real implementation. */
    private lookupOsUserFn: LookupOsUserFn = lookupOsUser,
    /**
     * Test seam threaded into `writeUserOwnedSecretFile` / `rmRecursiveAsUser`
     * for the MCP token file write/delete calls, mirroring the
     * `runAsUserImpl` DI pattern documented in elevation-helpers.md. Defaults
     * to `undefined` so production leaves both helpers on their own default
     * (`runAsUser`).
     */
    private runAsUserImpl?: typeof runAsUser,
  ) {
    this.userMode = userMode;
    this.agentManager = agentManager;
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

  /**
   * Set a global callback for all worker exit events (for notifications).
   */
  setGlobalWorkerExitCallback(callback: GlobalWorkerExitCallback): void {
    this.globalWorkerExitCallback = callback;
  }

  // ========== Worker Initialization ==========

  /**
   * Initialize an agent worker WITHOUT starting the PTY.
   * The PTY will be activated later via activateAgentWorkerPty.
   */
  initializeAgentWorker(params: AgentWorkerInitParams): InternalAgentWorker {
    const { id, name, createdAt, agentId } = params;

    const resolvedAgentId = agentId ?? CLAUDE_CODE_AGENT_ID;
    const agentManager = this.agentManager;
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
      epoch: Date.now(),
      activityState: 'unknown',
      activityDetector: null,
      connectionCallbacks: new Map(),
      mcpToken: null,
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
      epoch: Date.now(),
      connectionCallbacks: new Map(),
    };

    return worker;
  }

  /**
   * Initialize an embedded-agent worker WITHOUT spawning the subprocess.
   * The subprocess is activated later (Phase 2); a Phase-1 worker persists as
   * deactivated (subprocess/stdin null).
   */
  initializeEmbeddedAgentWorker(params: EmbeddedAgentWorkerInitParams): InternalEmbeddedAgentWorker {
    const { id, name, createdAt, embeddedAgentId } = params;

    const worker: InternalEmbeddedAgentWorker = {
      id,
      type: 'embedded-agent',
      name,
      createdAt,
      embeddedAgentId,
      subprocess: null,
      stdin: null,
      activityState: 'unknown',
      outputOffset: 0,
      epoch: Date.now(),
      connectionCallbacks: new Map(),
      deliverInitialPromptOnActivation: params.deliverInitialPromptOnActivation ?? false,
    };

    return worker;
  }

  /**
   * Initialize a git-diff worker (async for base spec computation).
   *
   * The worker stores a base *spec* (intent), not a frozen commit hash. The
   * spec is re-resolved to a concrete hash on every diff computation, so the
   * diff base tracks the moving fork point as the branch absorbs upstream
   * commits (Issue #800).
   */
  async initializeGitDiffWorker(params: GitDiffWorkerInitParams): Promise<InternalGitDiffWorker> {
    const { id, name, createdAt, locationPath, baseCommit, requestUser } = params;

    // An explicitly-provided baseCommit is treated as a verbatim spec (caller
    // intent — e.g. a branch name or commit hash), not pre-resolved. Otherwise
    // compute the default base spec for this repository.
    const baseSpec = baseCommit ?? (await computeDefaultBaseSpec(locationPath, requestUser));

    const worker: InternalGitDiffWorker = {
      id,
      type: 'git-diff',
      name,
      createdAt,
      baseCommit: baseSpec,
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

    const { sessionId, locationPath, agentId, continueConversation, initialPrompt, repositoryEnvVars, repositoryId, context } = params;

    // Issue #769: align outputOffset with file-absolute semantic on revived
    // activation. Must run BEFORE PTY spawn so the very first onData chunk
    // advances from the seeded value, not from 0.
    if (params.revived) {
      worker.outputOffset = await this.workerOutputFileManager.getCurrentOffset(
        sessionId,
        worker.id,
        params.resolver,
      );
      // On revival the stream continues under the persisted generation, so load
      // the epoch from the manifest (overriding the placeholder minted at
      // restore time). Fresh / restarted workers already carry the correct
      // epoch on the worker object and write it into the manifest, so this load
      // is skipped for them — keeping the create path free of extra I/O before
      // the worker is registered (§3.4).
      worker.epoch = await this.workerOutputFileManager.getEpoch(
        sessionId,
        worker.id,
        params.resolver,
        worker.epoch,
      );
    }

    const agentManager = this.agentManager;
    const requestedAgent = agentManager.getAgent(agentId);
    const agent = requestedAgent ?? agentManager.getDefaultAgent();
    if (!requestedAgent) {
      logger.debug(
        { workerId: worker.id, requestedAgentId: agentId, fallbackAgentId: agent.id },
        'Requested agent not found, falling back to default agent'
      );
    }

    const template = continueConversation && agent.continueTemplate
      ? agent.continueTemplate
      : agent.commandTemplate;

    const { command, env: templateEnv } = expandTemplate({
      template,
      prompt: initialPrompt,
      cwd: locationPath,
      templateVars: context?.templateVars,
    });

    // Build AgentConsole context so the agent knows its own identity.
    // These enable self-delegation (e.g., MCP tools) and agent self-awareness.
    const agentConsoleContext: AgentConsoleContext = {
      baseUrl: `http://localhost:${serverConfig.PORT}`,
      sessionId,
      workerId: worker.id,
      repositoryId,
      parentSessionId: context?.parentSessionId,
      parentWorkerId: context?.parentWorkerId,
    };

    // additionalEnvVars: repository + template env vars
    // Base env (getCleanChildProcessEnv) and AGENT_CONSOLE_* conversion
    // are handled internally by UserMode.spawnPty()
    const additionalEnvVars: Record<string, string> = {
      ...repositoryEnvVars,
      ...templateEnv,
    };

    // Multi-user mode: mint an MCP bearer token for this worker, write it to
    // a user-owned 0600 file, and inject only the FILE PATH via env. The raw
    // token must NEVER travel through argv or an env var embedded into the
    // elevation's inner shell command string (visible via
    // /proc/<pid>/cmdline of the inner `sh -c` process, see
    // privilege-elevation.ts:buildInnerCommand) -- a file path is not a
    // secret and is safe to pass this way.
    // (docs/design/embedded-agent-worker.md § "MCP caller identity")
    if (process.env.AUTH_MODE === 'multi-user') {
      if (!params.createdByUserId) {
        // Non-fatal skip (unlike EmbeddedAgentWorkerService's hard-fail):
        // terminal-agent PTY activation is a long-established
        // availability-critical path (create / revive / restart / restore).
        // Under AGENT_CONSOLE_MCP_AUTH=enforce this worker's MCP calls are
        // rejected (fail-closed); the worker itself still starts.
        logger.warn(
          { workerId: worker.id, sessionId },
          'Agent worker activated without session.createdBy; skipping MCP token mint (MCP calls from this worker will be rejected under AGENT_CONSOLE_MCP_AUTH=enforce)',
        );
      } else if (this.mcpTokenRegistry) {
        const osUser = await this.lookupOsUserFn(params.username);
        if (!osUser) {
          logger.warn(
            { workerId: worker.id, username: params.username },
            'Could not resolve OS user home directory for MCP token file; skipping MCP token mint',
          );
        } else {
          const token = this.mcpTokenRegistry.mint({
            sessionId,
            workerId: worker.id,
            userId: params.createdByUserId,
          });
          const tokenFilePath = path.join(
            osUser.homeDir,
            '.agent-console',
            'mcp-tokens',
            `${worker.id}.token`,
          );
          const writeResult = await writeUserOwnedSecretFile({
            username: params.username,
            filePath: tokenFilePath,
            content: token,
            runAsUserImpl: this.runAsUserImpl,
          });
          if (writeResult.exitCode !== 0 || writeResult.timedOut) {
            // Unlike the missing-createdBy case above (a deliberate skip),
            // a write FAILURE after a successful mint is an unexpected error
            // state -- fail loud, mirroring EmbeddedAgentWorkerService's "no
            // orphaned token from a failed activation" invariant.
            this.mcpTokenRegistry.revokeByWorker(worker.id);
            logger.error(
              {
                workerId: worker.id,
                exitCode: writeResult.exitCode,
                timedOut: writeResult.timedOut,
                stderr: writeResult.stderr,
              },
              'Failed to write MCP token file; aborting agent worker PTY activation',
            );
            throw new Error(`Failed to write MCP token file for worker ${worker.id}`);
          }
          worker.mcpToken = { filePath: tokenFilePath, username: params.username };
          additionalEnvVars[MCP_TOKEN_FILE_ENV_VAR] = tokenFilePath;
        }
      }
    }

    const sentinel = `__AGENT_CONSOLE_READY_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

    const ptyProcess = this.userMode.spawnPty({
      type: 'agent',
      username: params.username,
      cwd: locationPath,
      additionalEnvVars,
      cols: 120,
      rows: 30,
      command,
      agentConsoleContext,
      sentinel,
      // Forward the optional SSH_AUTH_SOCK fallback from the session
      // creation context. Populated only by the MCP delegate path;
      // undefined for every other path so existing behavior is preserved.
      sshAuthSockFallback: context?.sshAuthSockFallback,
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
    worker.agentId = agent.id;
    worker.loginShellSentinel = sentinel;
    worker.pendingCommand = command;

    // Set initial activity state to match ActivityDetector's initial state ('idle').
    // The onStateChange callback only fires on state *changes*, not on initialization,
    // so we must explicitly set the initial state here.
    worker.activityState = 'idle';
    this.globalActivityCallback?.(sessionId, worker.id, 'idle');

    this.setupWorkerEventHandlers(worker, sessionId, params.resolver);
  }

  /**
   * Activate PTY for a terminal worker.
   * Mutates the worker object to add pty.
   */
  async activateTerminalWorkerPty(
    worker: InternalTerminalWorker,
    params: TerminalActivationParams
  ): Promise<void> {
    // Idempotent: If PTY already active, skip
    if (worker.pty !== null) {
      logger.debug(
        { workerId: worker.id, existingPid: worker.pty.pid },
        'Terminal worker PTY already active, skipping activation'
      );
      return;
    }

    const { sessionId, locationPath, repositoryEnvVars } = params;

    // Issue #769: align outputOffset with file-absolute semantic on revived
    // activation. See activateAgentWorkerPty for the full rationale.
    if (params.revived) {
      worker.outputOffset = await this.workerOutputFileManager.getCurrentOffset(
        sessionId,
        worker.id,
        params.resolver,
      );
      // Load the persisted epoch on revival (see activateAgentWorkerPty).
      worker.epoch = await this.workerOutputFileManager.getEpoch(
        sessionId,
        worker.id,
        params.resolver,
        worker.epoch,
      );
    }

    // additionalEnvVars: repository env vars only
    // Base env (getCleanChildProcessEnv), shell detection, and unset prefix
    // are handled internally by UserMode.spawnPty()
    const ptyProcess = this.userMode.spawnPty({
      type: 'terminal',
      username: params.username,
      cwd: locationPath,
      additionalEnvVars: repositoryEnvVars,
      cols: 120,
      rows: 30,
    });

    worker.pty = ptyProcess;

    this.setupWorkerEventHandlers(worker, sessionId, params.resolver);
  }

  /**
   * Setup event handlers for a PTY worker.
   * Stores disposables on the worker for cleanup when worker is killed.
   */
  private setupWorkerEventHandlers(worker: InternalPtyWorker, sessionId: string, resolver: SessionDataPathResolver): void {
    if (!sessionId || sessionId.trim() === '') {
      throw new Error(
        `Cannot setup event handlers: sessionId is required (got: ${sessionId === '' ? 'empty string' : String(sessionId)})`
      );
    }

    if (!worker.pty) {
      throw new Error('Cannot setup event handlers: worker.pty is null');
    }

    const disposables: Disposable[] = [];

    let sentinelDetected = worker.type !== 'agent' || !worker.loginShellSentinel;
    // Carries the tail of the pre-sentinel stream across PTY read boundaries so a
    // sentinel split between two chunks is still detected. Bounded to
    // sentinel.length - 1 characters (the largest partial match possible).
    let preSentinelCarry = '';

    const onDataDisposable = worker.pty.onData((rawData) => {
      let data = rawData;

      if (!sentinelDetected && worker.type === 'agent' && worker.loginShellSentinel) {
        const sentinel = worker.loginShellSentinel;
        const haystack = preSentinelCarry + data;
        const idx = haystack.indexOf(sentinel);
        if (idx === -1) {
          preSentinelCarry = haystack.slice(-(sentinel.length - 1));
          return;
        }
        sentinelDetected = true;
        preSentinelCarry = '';
        if (worker.pendingCommand && worker.pty) {
          worker.pty.write(worker.pendingCommand + '\r');
          worker.pendingCommand = undefined;
        }
        const afterSentinel = haystack.slice(idx + sentinel.length).replace(/^[\r\n]+/, '');
        worker.loginShellSentinel = undefined;
        if (afterSentinel.length === 0) return;
        data = afterSentinel;
      }

      worker.outputBuffer += data;
      const maxBufferSize = serverConfig.WORKER_OUTPUT_BUFFER_SIZE;
      if (worker.outputBuffer.length > maxBufferSize) {
        worker.outputBuffer = worker.outputBuffer.slice(-maxBufferSize);
      }

      worker.outputOffset += Buffer.byteLength(data, 'utf-8');

      this.workerOutputFileManager.bufferOutput(sessionId, worker.id, data, resolver, worker.epoch);

      if (worker.type === 'agent' && worker.activityDetector) {
        worker.activityDetector.processOutput(data);
      }

      const callbacksSnapshot = Array.from(worker.connectionCallbacks.values());
      for (const callbacks of callbacksSnapshot) {
        callbacks.onData(data, worker.outputOffset, worker.epoch);
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
      this.detachPty(worker);

      if (worker.type === 'agent' && worker.activityDetector) {
        worker.activityDetector.dispose();
        worker.activityDetector = null;
      }

      if (worker.type === 'agent') {
        worker.loginShellSentinel = undefined;
        worker.pendingCommand = undefined;
        // Fire-and-forget: this callback is a synchronous PTY event listener
        // and cannot be awaited by its caller. Failures are logged inside
        // revokeAndDeleteMcpToken itself.
        void this.revokeAndDeleteMcpToken(worker);
      }

      const callbacksSnapshot = Array.from(worker.connectionCallbacks.values());
      for (const callbacks of callbacksSnapshot) {
        callbacks.onExit(exitCode, signalStr, 'unexpected');
      }

      // Notify listeners about worker exit
      this.globalWorkerExitCallback?.(sessionId, worker.id, exitCode, 'unexpected');
      this.globalPtyExitCallback?.(sessionId, worker.id, 'unexpected');
    });
    if (onExitDisposable) {
      disposables.push({ dispose: () => onExitDisposable.dispose() });
    }

    // Store disposables on worker for cleanup
    worker.disposables = disposables;
  }

  // ========== Worker I/O ==========

  /**
   * Attach callbacks for a WebSocket connection to a worker.
   * Accepts any stream worker (PTY or embedded-agent) since both expose the
   * same `connectionCallbacks` map shape.
   * @returns Connection ID for later detachment, or null if worker is invalid
   */
  attachCallbacks(worker: InternalPtyWorker | InternalEmbeddedAgentWorker, callbacks: WorkerCallbacks): string {
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
  detachCallbacks(worker: InternalPtyWorker | InternalEmbeddedAgentWorker, connectionId: string): boolean {
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
      // Placeholder; the authoritative epoch is loaded from the manifest at
      // activation (getEpoch). Never reaches the wire before activation because
      // `output` only flows after the PTY is active and `history` reads the
      // manifest epoch directly.
      epoch: Date.now(),
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
            mcpToken: null,
          };
          break;
        case 'terminal':
          worker = { ...base, ...ptyWorkerBase, connectionCallbacks: new Map(), type: 'terminal' };
          break;
        case 'git-diff':
          worker = { ...base, type: 'git-diff', baseCommit: pw.baseCommit };
          break;
        case 'embedded-agent':
          worker = {
            ...base,
            type: 'embedded-agent',
            embeddedAgentId: pw.embeddedAgentId,
            subprocess: null,
            stdin: null,
            activityState: 'unknown',
            outputOffset: 0,
            // Placeholder epoch; the authoritative epoch is loaded from the
            // manifest at activation (mirrors the PTY-worker restore path).
            epoch: Date.now(),
            connectionCallbacks: new Map(), // Must be unique per worker
            // Round-trips from PersistedEmbeddedAgentWorker.deliverInitialPromptOnActivation,
            // written at create time by toPersistedWorker, so eligibility
            // survives a server restart (Issue #1074).
            deliverInitialPromptOnActivation: pw.deliverInitialPromptOnActivation,
          };
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
      case 'agent': {
        const agentWorker: AgentWorker = { ...base, type: 'agent', agentId: worker.agentId, activated: worker.pty !== null };
        return agentWorker;
      }
      case 'terminal': {
        const terminalWorker: TerminalWorker = { ...base, type: 'terminal', activated: worker.pty !== null };
        return terminalWorker;
      }
      case 'git-diff': {
        const gitDiffWorker: GitDiffWorker = { ...base, type: 'git-diff', baseCommit: worker.baseCommit };
        return gitDiffWorker;
      }
      case 'embedded-agent': {
        const embeddedAgentWorker: EmbeddedAgentWorker = {
          ...base,
          type: 'embedded-agent',
          embeddedAgentId: worker.embeddedAgentId,
          activated: worker.subprocess !== null,
        };
        return embeddedAgentWorker;
      }
    }
  }

  /**
   * Convert an internal worker to persisted format.
   */
  toPersistedWorker(worker: InternalWorker): PersistedWorker {
    const base = { id: worker.id, name: worker.name, createdAt: worker.createdAt };

    switch (worker.type) {
      case 'agent': {
        const persistedAgent: PersistedAgentWorker = { ...base, type: 'agent', agentId: worker.agentId, pid: worker.pty?.pid ?? null };
        return persistedAgent;
      }
      case 'terminal': {
        const persistedTerminal: PersistedTerminalWorker = { ...base, type: 'terminal', pid: worker.pty?.pid ?? null };
        return persistedTerminal;
      }
      case 'git-diff': {
        const persistedGitDiff: PersistedGitDiffWorker = { ...base, type: 'git-diff', baseCommit: worker.baseCommit };
        return persistedGitDiff;
      }
      case 'embedded-agent': {
        const persistedEmbeddedAgent: PersistedEmbeddedAgentWorker = {
          ...base,
          type: 'embedded-agent',
          embeddedAgentId: worker.embeddedAgentId,
          pid: worker.subprocess?.pid ?? null,
          deliverInitialPromptOnActivation: worker.deliverInitialPromptOnActivation,
        };
        return persistedEmbeddedAgent;
      }
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
   * Detach a PTY worker's PTY reference (set to null).
   * Used after killing the PTY to ensure persisted worker PIDs are saved as null.
   */
  detachPty(worker: InternalPtyWorker): void {
    worker.pty = null;
  }

  /**
   * Revoke the in-memory MCP token and delete its backing file for an agent
   * worker. Called on every path a terminal-agent PTY can stop existing
   * through: unexpected exit (pty.onExit) and managed kill (killWorker).
   * No-op when the worker never had a token (single-user mode, or the
   * session lacked createdBy at activation). Never throws -- deletion
   * failures are logged as warnings so cleanup never blocks the exit/kill
   * flow (see backend.md "Resource Cleanup").
   */
  private async revokeAndDeleteMcpToken(worker: InternalAgentWorker): Promise<void> {
    const token = worker.mcpToken;
    if (token === null) {
      return;
    }
    worker.mcpToken = null;
    this.mcpTokenRegistry?.revokeByWorker(worker.id);
    try {
      await rmRecursiveAsUser(token.filePath, token.username, {
        runAsUserImpl: this.runAsUserImpl,
      });
    } catch (err) {
      logger.warn(
        { workerId: worker.id, filePath: token.filePath, err },
        'Failed to delete MCP token file',
      );
    }
  }

  /**
   * Kill a worker's PTY process and clean up resources.
   * Awaits PTY process exit to ensure directory handles are released
   * before callers proceed (e.g., git worktree remove).
   */
  async killWorker(worker: InternalWorker, sessionId: string): Promise<void> {
    if (worker.type === 'agent' || worker.type === 'terminal') {
      const pty = worker.pty;

      if (pty) {
        // Dispose old PTY event handlers first
        if (worker.disposables) {
          for (const disposable of worker.disposables) {
            disposable.dispose();
          }
          worker.disposables = undefined;
        }

        // Register exit promise AFTER disposing old listeners
        // to avoid any interference from old disposables
        const exitPromise = new Promise<void>((resolve) => {
          pty.onExit(() => resolve());
        });

        // Kill PTY process
        pty.kill();

        // Await exit with timeout to ensure directory handles are released
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
          const TIMEOUT_SENTINEL = Symbol('timeout');
          const result = await Promise.race([
            exitPromise.then(() => 'exited' as const),
            new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
              timeoutHandle = setTimeout(() => resolve(TIMEOUT_SENTINEL), PTY_EXIT_TIMEOUT_MS);
            }),
          ]);
          if (result === TIMEOUT_SENTINEL) {
            logger.warn(
              { pid: pty.pid },
              `PTY process did not exit within ${PTY_EXIT_TIMEOUT_MS}ms after kill, proceeding anyway`,
            );
          }
        } finally {
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
          }
        }

        // Fire exit notifications for managed kill.
        // The onExit handler in setupWorkerEventHandlers was disposed above,
        // so we must explicitly notify WebSocket connections and global listeners.
        const exitCode = 0; // Managed kills are intentional
        const signal: string | null = null;

        const callbacksSnapshot = Array.from(worker.connectionCallbacks.values());
        for (const callbacks of callbacksSnapshot) {
          callbacks.onExit(exitCode, signal, 'managed');
        }

        this.globalWorkerExitCallback?.(sessionId, worker.id, exitCode, 'managed');
        this.globalPtyExitCallback?.(sessionId, worker.id, 'managed');

        this.detachPty(worker);
      } else {
        // No PTY, just clean up disposables
        if (worker.disposables) {
          for (const disposable of worker.disposables) {
            disposable.dispose();
          }
          worker.disposables = undefined;
        }
      }

      // Dispose activity detector for agent workers
      if (worker.type === 'agent' && worker.activityDetector) {
        worker.activityDetector.dispose();
      }

      // MCP token cleanup runs LAST (and only for agent workers). Deliberately
      // placed after the PTY-kill race above rather than at the top of this
      // method: an early `await` here would defer the `setTimeout(...,
      // PTY_EXIT_TIMEOUT_MS)` registration above past the point where a
      // fake-timers test calls `jest.advanceTimersByTime(...)`, since that
      // call is made synchronously right after invoking `killWorker()` and
      // expects the timer to already be registered.
      if (worker.type === 'agent') {
        await this.revokeAndDeleteMcpToken(worker);
      }
    }
    // git-diff workers have no PTY to kill
  }
}
