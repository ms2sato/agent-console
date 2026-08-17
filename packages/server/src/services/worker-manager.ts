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
import type { StartupIntent } from './startup-intent.js';
import type { SessionDataPathResolver } from '../lib/session-data-path-resolver.js';
import type { UserMode, AgentConsoleContext } from './user-mode.js';
import { ActivityDetector } from './activity-detector.js';
import { CLAUDE_CODE_AGENT_ID } from './agent-manager.js';
import type { AgentManager } from './agent-manager.js';
import { expandTemplate } from '../lib/template.js';
import { computeDefaultBaseSpec } from './git-diff-service.js';
import { serverConfig } from '../lib/server-config.js';
import type { WorkerOutputFileManager } from '../lib/worker-output-file.js';
import { buildPtyNotificationText } from '../lib/pty-notification.js';
import { extractCommandToken } from '../lib/command-token.js';
import { buildDirectSentinelShellCommand, buildElevatedSentinelCommand } from './sentinel-spawn-command.js';
import { getUnsetEnvPrefix } from './env-filter.js';
import type { McpTokenRegistry } from '../mcp/mcp-auth.js';
import { writeUserOwnedSecretFile, rmRecursiveAsUser, shouldElevateForUser, type runAsUser } from './privilege-elevation.js';
import { lookupOsUser, type LookupOsUserFn } from './os-user-lookup.js';
import { listDescendantPids, signalPids } from '../lib/process-tree.js';
import { createLogger } from '../lib/logger.js';
import { getConfigDir } from '../lib/config.js';
import * as path from 'node:path';

const logger = createLogger('worker-manager');

/** Name of the env var carrying the MCP token FILE PATH (never the raw token). */
const MCP_TOKEN_FILE_ENV_VAR = 'AGENT_CONSOLE_MCP_TOKEN_FILE';

/** Maximum time to wait for a PTY process to exit after kill signal. */
const PTY_EXIT_TIMEOUT_MS = 5000;
// If an agent worker's login-shell sentinel is never detected,
// the pre-sentinel swallow gate keeps the worker's output log at 0 bytes
// forever with no other signal. This bounds that silence.
const SENTINEL_WATCHDOG_TIMEOUT_MS = 15000;

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
  /**
   * Whether this worker is the session's initial agent worker, created with
   * a non-empty `initialPrompt`. Gates whether `restartAgentWorker` re-injects
   * the session's `initialPrompt` on a restart that never actually delivered
   * it. `false`/omitted for workers added later via the generic add-worker
   * route.
   */
  deliverInitialPromptOnActivation?: boolean;
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
   * OS username to run git as during the initial
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
  /**
   * The already-resolved startup decision for this activation (see
   * `startup-intent.ts`). Callers resolve this once, before this PTY is
   * spawned; this method reads it directly and never re-derives it from
   * `initialPrompt` / worker or session state.
   */
  startupIntent: StartupIntent;
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
   * semantic the client's IndexedDB cache expects.
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
 * Callback fired when a terminal-agent worker's initial-prompt command is
 * injected into its PTY (the post-sentinel `pty.write` in
 * setupWorkerEventHandlers), gated on `worker.promptFile !== null`. Wired
 * by SessionManager to mark `session.initialPromptDelivered = true` and
 * persist it. "Delivered" here means injected, not received; the server
 * cannot observe actual agent receipt.
 */
export type OnInitialPromptInjectedCallback = (sessionId: string, workerId: string) => void;

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
  private onInitialPromptInjectedCallback?: OnInitialPromptInjectedCallback;

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
    /** Test seam for the process-tree walk in `killWorker`. Defaults to the real implementation. */
    private listDescendantPidsImpl: typeof listDescendantPids = listDescendantPids,
    /** Test seam for the process-tree signal step in `killWorker`. Defaults to the real implementation. */
    private signalPidsImpl: typeof signalPids = signalPids,
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

  /**
   * Set the callback fired when a terminal-agent worker's initial-prompt
   * command is injected into its PTY. See `OnInitialPromptInjectedCallback`.
   */
  setOnInitialPromptInjected(callback: OnInitialPromptInjectedCallback): void {
    this.onInitialPromptInjectedCallback = callback;
  }

  // ========== Worker Initialization ==========

  /**
   * Initialize an agent worker WITHOUT starting the PTY.
   * The PTY will be activated later via activateAgentWorkerPty.
   */
  initializeAgentWorker(params: AgentWorkerInitParams): InternalAgentWorker {
    const { id, name, createdAt, agentId } = params;
    const deliverInitialPromptOnActivation = params.deliverInitialPromptOnActivation ?? false;

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
      promptFile: null,
      deliverInitialPromptOnActivation,
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
      sdkSessionId: null,
    };

    return worker;
  }

  /**
   * Initialize a git-diff worker (async for base spec computation).
   *
   * The worker stores a base *spec* (intent), not a frozen commit hash. The
   * spec is re-resolved to a concrete hash on every diff computation, so the
   * diff base tracks the moving fork point as the branch absorbs upstream
   * commits.
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

    const { sessionId, locationPath, agentId, startupIntent, initialPrompt, repositoryEnvVars, repositoryId, context } = params;

    // Align outputOffset with file-absolute semantic on revived
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

    const template = startupIntent === 'continue' && agent.continueTemplate
      ? agent.continueTemplate
      : agent.commandTemplate;

    // NOTE: template selection above and the initialPrompt-injection gate
    // below are two INDEPENDENT conditions, not one gated decision. A
    // 'continue' startupIntent selects the continue template but does not
    // itself suppress prompt injection -- if that template contains
    // '{{prompt}}', a non-empty initialPrompt still gets written and
    // injected. Unreachable for the builtin agent (its continueTemplate has
    // no '{{prompt}}'), but reachable for a custom agent whose continue
    // template does. This is a known, deliberately deferred design gap, not
    // an oversight -- do not "fix" it inline without deciding what
    // 'continue' should mean for such an agent first.

    // Everything below can leave a partially-activated worker behind: the
    // prompt-file write and the MCP-token mint/write both attach state to
    // `worker` (promptFile / mcpToken) before `worker.pty` is assigned, and
    // `spawnPty` itself can throw synchronously (PTY allocation failure).
    // Neither `pty.onExit` nor `killWorker` ever runs for a worker whose
    // `pty` was never assigned -- and callers (createWorker/restartWorker)
    // discard the worker object entirely on a rejected activation, so
    // nothing else can reach it either. This try/catch is the ONLY closure
    // point for both artifacts; on any failure in this span, clean up
    // whatever was already written before rethrowing the original error
    // unchanged (activation must still fail loudly).
    try {
      // Persist initialPrompt to a file and inject a short `"$(cat '<path>')"`
      // substitution instead of embedding the raw prompt on the sentinel-
      // injected command line: the injected line is typed as PTY
      // typeahead while the tty is still in canonical mode, and canonical-mode
      // input buffers are bounded (~1KB macOS / 4096B Linux) -- a long prompt
      // silently truncates and the agent never starts. Deliberately NOT gated
      // on AUTH_MODE: the underlying truncation reproduces in single-user mode.
      let promptFilePath: string | undefined;
      if (initialPrompt?.trim() && template.includes('{{prompt}}')) {
        const elevate = shouldElevateForUser(params.username);
        let promptsDir: string;
        if (elevate) {
          const osUser = await this.lookupOsUserFn(params.username);
          if (!osUser) {
            logger.error(
              { workerId: worker.id, username: params.username },
              'Could not resolve OS user home directory for prompt file; aborting agent worker PTY activation',
            );
            throw new Error(`Failed to resolve OS user home directory for prompt file (worker ${worker.id})`);
          }
          promptsDir = path.join(osUser.homeDir, '.agent-console', 'prompts');
        } else {
          promptsDir = path.join(getConfigDir(), 'prompts');
        }
        const filePath = path.join(promptsDir, `${worker.id}.prompt`);
        // Set BEFORE the write (not after a successful write): if the write
        // is interrupted partway through (e.g. `cat >` receives a partial
        // stream), the catch block's cleanup below still reaches this path
        // -- `rmRecursiveAsUser`'s `rm -f` is idempotent on a missing or
        // partial file either way.
        worker.promptFile = { filePath, username: params.username };
        const writeResult = await writeUserOwnedSecretFile({
          username: params.username,
          filePath,
          content: initialPrompt,
          runAsUserImpl: this.runAsUserImpl,
        });
        if (writeResult.exitCode !== 0 || writeResult.timedOut) {
          logger.error(
            {
              workerId: worker.id,
              exitCode: writeResult.exitCode,
              timedOut: writeResult.timedOut,
              stderr: writeResult.stderr,
            },
            'Failed to write prompt file; aborting agent worker PTY activation',
          );
          throw new Error(`Failed to write prompt file for worker ${worker.id}`);
        }
        promptFilePath = filePath;
      }

      const { command, env: templateEnv } = expandTemplate({
        template,
        cwd: locationPath,
        templateVars: context?.templateVars,
        ...(promptFilePath !== undefined ? { promptFilePath } : { prompt: initialPrompt }),
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
          // The default AGENT_CONSOLE_MCP_AUTH mode is `warn`, so this
          // worker's tokenless MCP calls are merely logged, not rejected;
          // only an operator-opted-in `enforce` would reject them
          // (fail-closed). The worker itself still starts either way.
          logger.warn(
            { workerId: worker.id, sessionId, username: params.username },
            `Agent worker activated without session.createdBy; worker will spawn as server-process user '${params.username}' -- command resolution and file access use that identity, so per-user CLI installs will not resolve (skipping MCP token mint; MCP calls from this worker will be rejected if AGENT_CONSOLE_MCP_AUTH=enforce is set; see Issue #1107)`,
          );
        } else if (this.mcpTokenRegistry) {
          // lookupOsUserFn is an injectable seam (LookupOsUserFn); the built-in
          // implementation never rejects, but an injected implementation (test
          // stub, future variant) is not contractually guaranteed not to throw
          // -- see os-user-lookup.ts's LookupOsUserFn JSDoc. Fold a throw into
          // the same "skip mint, don't fail activation" path as a null result,
          // distinguished by `logger.error` (implementation misbehaved) vs the
          // `logger.warn` below (genuinely unresolved).
          const osUser = await this.lookupOsUserFn(params.username).catch((err: unknown) => {
            logger.error(
              { workerId: worker.id, username: params.username, err },
              'lookupOsUserFn threw unexpectedly during MCP token mint; skipping mint',
            );
            return null;
          });
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
            // Set BEFORE the write (not after a successful write):
            // writeUserOwnedSecretFile's command truncates the destination
            // (`cat >`) before streaming the new content, so a write that
            // fails partway through (the elevated process gets killed
            // mid-stream, or the shell fails after truncation but before the
            // full payload lands) can leave a truncated/partial file behind
            // -- and that file may contain a FRAGMENT OF THE SECRET TOKEN.
            // The outer catch block's cleanup must reach this path even when
            // the failure happens mid-write, not only on a clean exitCode
            // !== 0 result.
            worker.mcpToken = { filePath: tokenFilePath, username: params.username };
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
              // orphaned token from a failed activation" invariant. The
              // in-memory revoke here is a fast-path for THIS failure only;
              // the outer catch below also unconditionally calls
              // revokeAndDeleteMcpToken, which now (worker.mcpToken having
              // just been assigned above) also issues the file-level `rm`
              // for the possibly-truncated token file -- this fast-path call
              // only revokes the registry entry a moment sooner than the
              // catch would.
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

      this.setupWorkerEventHandlers(worker, sessionId, params.resolver, { command, username: params.username, sentinel });
    } catch (err) {
      // Both cleanup calls are null-safe (no-op when nothing was ever set)
      // and never throw (internal failures are logged as warnings) -- see
      // deletePromptFile / revokeAndDeleteMcpToken. Always rethrow the
      // ORIGINAL error unmodified; activation must still fail loudly.
      await this.deletePromptFile(worker);
      await this.revokeAndDeleteMcpToken(worker);
      throw err;
    }
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

    // Align outputOffset with file-absolute semantic on revived
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
  private setupWorkerEventHandlers(
    worker: InternalPtyWorker,
    sessionId: string,
    resolver: SessionDataPathResolver,
    agentSpawnInfo?: { command: string; username: string; sentinel: string },
  ): void {
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

    // Sentinel watchdog: the pre-sentinel swallow gate above
    // keeps the worker's output log at 0 bytes forever if the sentinel is
    // never observed, with no other signal to distinguish "stuck" from
    // "just slow". Arm a bounded timer at handler setup (below); on expiry,
    // log an ERROR carrying enough diagnostics (the PTY adapter's native
    // data-callback fire count, buffered/dropped byte counts from the
    // pre-attach buffer, and a sample of the pre-sentinel bytes actually
    // received) to distinguish "native never delivered a byte" from "bytes
    // arrived but never matched" from "the pre-attach cap was hit". Cleared
    // on sentinel detection, on worker exit, and (via `disposables`) on
    // managed kill -- it must never fire after any of those.
    let sentinelWatchdogTimer: ReturnType<typeof setTimeout> | undefined;
    let preSentinelSample = '';
    const PRE_SENTINEL_SAMPLE_MAX_LEN = 256;
    const clearSentinelWatchdog = (): void => {
      if (sentinelWatchdogTimer !== undefined) {
        clearTimeout(sentinelWatchdogTimer);
        sentinelWatchdogTimer = undefined;
      }
    };
    if (!sentinelDetected) {
      sentinelWatchdogTimer = setTimeout(() => {
        sentinelWatchdogTimer = undefined;
        const diagnostics = worker.pty?.getDataDiagnostics?.();
        logger.error(
          {
            sessionId,
            workerId: worker.id,
            fireCount: diagnostics?.fireCount,
            bufferedBytes: diagnostics?.bufferedBytes,
            droppedBytes: diagnostics?.droppedBytes,
            preSentinelSample: JSON.stringify(preSentinelSample),
          },
          'Login-shell sentinel not detected within timeout; agent worker PTY output may be stuck or lost',
        );
      }, SENTINEL_WATCHDOG_TIMEOUT_MS);
    }
    disposables.push({ dispose: clearSentinelWatchdog });

    const onDataDisposable = worker.pty.onData((rawData) => {
      let data = rawData;

      if (!sentinelDetected && worker.type === 'agent' && worker.loginShellSentinel) {
        const sentinel = worker.loginShellSentinel;
        if (preSentinelSample.length < PRE_SENTINEL_SAMPLE_MAX_LEN) {
          preSentinelSample = (preSentinelSample + data).slice(0, PRE_SENTINEL_SAMPLE_MAX_LEN);
        }
        const haystack = preSentinelCarry + data;
        const idx = haystack.indexOf(sentinel);
        if (idx === -1) {
          preSentinelCarry = haystack.slice(-(sentinel.length - 1));
          return;
        }
        sentinelDetected = true;
        clearSentinelWatchdog();
        preSentinelCarry = '';
        if (worker.pendingCommand && worker.pty) {
          worker.pty.write(worker.pendingCommand + '\r');
          worker.pendingCommand = undefined;
          // "Delivered" for a terminal-agent worker means this injection write
          // occurred while a prompt file was attached to the command. This is
          // delivered=injected, not delivered=received: if the agent binary
          // fails after this write (e.g. command not found), this callback
          // still fires and a future restart will NOT re-deliver. The server
          // cannot observe actual agent receipt; do not approximate it with
          // activity-pattern heuristics.
          if (worker.promptFile !== null) {
            this.onInitialPromptInjectedCallback?.(sessionId, worker.id);
          }
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
    const onExitDisposable = pty.onExit(async ({ exitCode, signal }) => {
      const signalStr = signal !== undefined ? String(signal) : null;
      logger.info({ workerId: worker.id, pid: pty.pid, exitCode, signal: signalStr }, 'Worker exited');

      // Sentinel watchdog: the worker exited (naturally, e.g.
      // the agent binary failed to start) before the sentinel was ever
      // detected -- no point logging a stuck-sentinel ERROR for a worker
      // that is already gone. No-op if the watchdog was never armed or
      // already cleared.
      clearSentinelWatchdog();

      // Exit 127 ("command not found") on an agent worker is usually the
      // spawn-shell chain itself failing to start, not the agent's own
      // command -- the agent command is TYPED into an already-alive
      // interactive shell (see sentinel-spawn-command.ts), and an
      // interactive shell survives its own "command not found" rather
      // than exiting. Surface this as a synthesized diagnostic message
      // naming both suspects, hedged (see appendSpawnFailureNotification).
      // Must be awaited BEFORE the rest of teardown: the delegate path
      // never has a WebSocket client attached to trigger a flush, so the
      // bytes must be forced to disk here or they are lost with the
      // pending buffer.
      if (worker.type === 'agent' && exitCode === 127 && agentSpawnInfo) {
        // This listener is a synchronous PTY event callback that nothing
        // awaits (same constraint documented on the revokeAndDeleteMcpToken
        // fire-and-forget call below) -- an unhandled rejection here would
        // propagate out of the async listener and skip every teardown step
        // after this block (detachPty, MCP token revoke, prompt file
        // delete, per-connection and global exit callbacks). Catch and log
        // instead of letting a failure (e.g. a connected client's onData
        // throwing during appendSyntheticOutput's fan-out) abort teardown.
        try {
          await this.appendSpawnFailureNotification(worker, sessionId, resolver, agentSpawnInfo, exitCode);
        } catch (err) {
          logger.error(
            { workerId: worker.id, sessionId, err },
            'Failed to synthesize exit-127 diagnostic message; continuing teardown',
          );
        }
      }

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
        void this.deletePromptFile(worker);
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

  /**
   * Append server-authored text directly to a PTY worker's output stream --
   * advances outputOffset, buffers it for file persistence, and fans out to
   * currently-attached connections. Mirrors the post-sentinel-gate tail of
   * the onData handler above, minus the sentinel-detection and
   * activity-detector steps (irrelevant for synthesized text). Does NOT
   * write into the PTY itself -- there is no live PTY left once a worker
   * has exited.
   */
  private appendSyntheticOutput(worker: InternalPtyWorker, sessionId: string, resolver: SessionDataPathResolver, text: string): void {
    worker.outputBuffer += text;
    const maxBufferSize = serverConfig.WORKER_OUTPUT_BUFFER_SIZE;
    if (worker.outputBuffer.length > maxBufferSize) {
      worker.outputBuffer = worker.outputBuffer.slice(-maxBufferSize);
    }
    worker.outputOffset += Buffer.byteLength(text, 'utf-8');
    this.workerOutputFileManager.bufferOutput(sessionId, worker.id, text, resolver, worker.epoch);
    const callbacksSnapshot = Array.from(worker.connectionCallbacks.values());
    for (const callbacks of callbacksSnapshot) {
      callbacks.onData(text, worker.outputOffset, worker.epoch);
    }
  }

  /**
   * Synthesize and deliver the exit-127 diagnostic message for an agent
   * worker. The command token comes from the EXPANDED
   * commandTemplate captured at activation time (`agentSpawnInfo.command`),
   * never from the final sentinel/env-wrapped shell string -- see
   * `extractCommandToken`'s doc for why. Forces the buffered bytes to disk
   * before returning: the delegate path (zero attached clients) has no
   * other trigger that would flush them, and the caller's teardown must not
   * proceed until this is durable (R-c / S2).
   */
  private async appendSpawnFailureNotification(
    worker: InternalAgentWorker,
    sessionId: string,
    resolver: SessionDataPathResolver,
    agentSpawnInfo: { command: string; username: string; sentinel: string },
    exitCode: number,
  ): Promise<void> {
    const commandToken = extractCommandToken(agentSpawnInfo.command);
    const { username } = agentSpawnInfo;

    // Display-only reuse of the SAME builders production spawns with
    // (sentinel-spawn-command.ts is the single source of truth both sides
    // import) -- lets a future investigator immediately tell "wrapper failed
    // pre-sentinel" from "something else failed post-sentinel" without
    // reproducing the investigation. This is a structured-log-only field;
    // the user-facing message built below is unaffected.
    const wrapperCommand = shouldElevateForUser(username)
      ? buildElevatedSentinelCommand(agentSpawnInfo.sentinel)
      : buildDirectSentinelShellCommand(agentSpawnInfo.sentinel, getUnsetEnvPrefix());

    logger.warn(
      { workerId: worker.id, sessionId, command: commandToken, username, exitCode, wrapperCommand },
      'Agent worker exited 127 (command not found); synthesizing diagnostic message on worker output stream',
    );

    const text = buildPtyNotificationText({
      kind: 'internal-agent-spawn-failed',
      tag: 'internal:agent-spawn-failed',
      fields: {
        command: commandToken,
        username,
        exitCode: String(exitCode),
        diagnosis: `usually means a required program is missing for user '${username}': the spawn shell itself, or the agent command '${commandToken}', is not installed or not on PATH`,
        remedy: `install and authenticate the agent CLI for user '${username}', or adjust this agent's command template -- check the server log's wrapperCommand field for this event to see which one was actually attempted`,
      },
      intent: 'triage',
    });

    this.appendSyntheticOutput(worker, sessionId, resolver, text);
    await this.workerOutputFileManager.forceFlush(sessionId, worker.id);
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
            promptFile: null,
            // Round-trips from PersistedAgentWorker.deliverInitialPromptOnActivation,
            // written at create time by toPersistedWorker, so eligibility
            // survives a server restart.
            deliverInitialPromptOnActivation: pw.deliverInitialPromptOnActivation,
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
            // survives a server restart.
            deliverInitialPromptOnActivation: pw.deliverInitialPromptOnActivation,
            // Round-trips from PersistedEmbeddedAgentWorker.sdkSessionId so a
            // restored SDK-engine worker retains its session id across a
            // server restart, even though `subprocess`/`stdin` restart null.
            sdkSessionId: pw.sdkSessionId,
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
        const persistedAgent: PersistedAgentWorker = {
          ...base,
          type: 'agent',
          agentId: worker.agentId,
          pid: worker.pty?.pid ?? null,
          deliverInitialPromptOnActivation: worker.deliverInitialPromptOnActivation,
        };
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
          sdkSessionId: worker.sdkSessionId,
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
   * Detach a PTY worker's PTY reference (set to null) and dispose the
   * underlying PTY resource. Used after killing the PTY to ensure persisted
   * worker PIDs are saved as null.
   *
   * `dispose()` is a backstop here, not the primary release path: for
   * `BunTerminalPtyAdapter`, `dispose()` already ran as part of the adapter's
   * own `subprocess.exited`-triggered `fireExit()` on the common paths (both
   * unexpected exit and managed kill followed by confirmed exit), so this
   * call is typically a no-op idempotent re-check. It matters for the
   * kill-timeout give-up path in `killWorker`, where the PTY did not confirm
   * exit before the timeout elapsed -- calling `dispose()` there forcibly
   * releases the Bun.Terminal master fd instead of leaking it.
   */
  detachPty(worker: InternalPtyWorker): void {
    worker.pty?.dispose?.();
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
   * Delete the prompt file written for an agent worker. Called
   * on every path a terminal-agent PTY can stop existing through:
   * unexpected exit (pty.onExit) and managed kill (killWorker). No-op when
   * the worker never had a prompt file. Never throws -- deletion failures
   * are logged as warnings so cleanup never blocks the exit/kill flow.
   */
  private async deletePromptFile(worker: InternalAgentWorker): Promise<void> {
    const promptFile = worker.promptFile;
    if (promptFile === null) {
      return;
    }
    worker.promptFile = null;
    try {
      await rmRecursiveAsUser(promptFile.filePath, promptFile.username, {
        runAsUserImpl: this.runAsUserImpl,
      });
    } catch (err) {
      logger.warn(
        { workerId: worker.id, filePath: promptFile.filePath, err },
        'Failed to delete prompt file',
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

        // Construct the exit/timeout race SYNCHRONOUSLY here (registering the
        // setTimeout immediately), before the async descendant-pid snapshot
        // below. The race is only *awaited* further down, after `pty.kill()`.
        // This ordering matters for the fake-timers test
        // ('should resolve with timeout when PTY does not exit'): that test
        // calls `jest.advanceTimersByTime(...)` synchronously right after
        // invoking `killWorker()`, and expects the timer to already be
        // registered at that point. Awaiting the real process-tree read
        // (`listDescendantPidsImpl`) BEFORE constructing this race would
        // defer the `setTimeout` registration past that synchronous call.
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const TIMEOUT_SENTINEL = Symbol('timeout');
        const exitOrTimeout = Promise.race([
          exitPromise.then(() => 'exited' as const),
          new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
            timeoutHandle = setTimeout(() => resolve(TIMEOUT_SENTINEL), PTY_EXIT_TIMEOUT_MS);
          }),
        ]);

        // Snapshot descendant pids BEFORE killing the PTY root. The PTY's
        // root pid is a login shell, not the agent process itself (see
        // sentinel-spawn-command.ts) -- the agent command is typed into
        // that shell like a human user, so job control gives it its OWN
        // process group, separate from the shell's. `pty.kill()` below
        // only reaches the shell's pid/pgid, never the agent's. Snapshotting
        // first (rather than after kill) avoids depending on how quickly a
        // killed shell's children get reparented to init, which would still
        // resolve via ppid=1 but adds a race against the read.
        let descendantPids: number[];
        try {
          descendantPids = await this.listDescendantPidsImpl(pty.pid);
        } catch (err) {
          // Must not abort the rest of killWorker (pty.kill() below) on a
          // process-tree read failure -- that would leak the PTY entirely.
          // Falling back to [] only affects this one kill cycle; any
          // descendant that leaks as a result is still caught by the next
          // kill cycle's own tree walk.
          logger.warn(
            { pid: pty.pid, err },
            'Failed to list descendant pids before kill, proceeding without descendant signaling',
          );
          descendantPids = [];
        }

        // Kill PTY process
        pty.kill();
        if (descendantPids.length > 0) {
          this.signalPidsImpl(descendantPids, 'SIGTERM');
        }

        // Await exit with timeout to ensure directory handles are released
        try {
          const result = await exitOrTimeout;
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

        // Escalate: any descendant that ignored/outlived SIGTERM (e.g. the
        // agent process still shutting down) gets SIGKILL. `signalPids`
        // swallows ESRCH, so already-exited descendants are a silent no-op.
        if (descendantPids.length > 0) {
          this.signalPidsImpl(descendantPids, 'SIGKILL');
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
        await this.deletePromptFile(worker);
      }
    }
    // git-diff workers have no PTY to kill
  }
}
