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
import { getAgentParameterCapabilities, EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES } from '@agent-console/shared';
import type { EmbeddedAgentEngineParameterCapabilities } from '@agent-console/shared';
import type {
  InternalWorker,
  InternalPtyWorker,
  WorkerCallbacks,
} from './worker-types.js';
import { isInternalPtyWorker, isStreamWorker } from './worker-types.js';
import type { InternalSession } from './internal-types.js';
import type { WorkerManager } from './worker-manager.js';
import type { JobQueue } from '../jobs/index.js';
import { JOB_TYPES } from '../jobs/index.js';
import { CLAUDE_CODE_AGENT_ID } from './agent-manager.js';
import type { AgentManager } from './agent-manager.js';
import type { EmbeddedAgentManager } from './embedded-agent-manager.js';
import { ValidationError } from '../lib/errors.js';
import { resolveStartupIntent, type StartupIntentPreference } from './startup-intent.js';
import type { NotificationManager } from './notifications/notification-manager.js';
import type { InterSessionMessageService } from './inter-session-message-service.js';
import type { AnnotationService } from './annotation-service.js';
import { stopWatching } from './git-diff-service.js';
import {
  getCurrentBranch as gitGetCurrentBranch,
  renameBranch as gitRenameBranch,
} from '../lib/git.js';
import { type WorkerOutputFileManager, type HistoryReadResult, type HistoryRangeResult } from '../lib/worker-output-file.js';
import { SessionDataPathResolver } from '../lib/session-data-path-resolver.js';
import { createLogger } from '../lib/logger.js';

import type { SessionLifecycleCallbacks } from './session-lifecycle-types.js';

const logger = createLogger('worker-lifecycle-manager');

/**
 * Dependencies injected by SessionManager.
 * Uses closures to capture late-bound state (jobQueue, sessionLifecycleCallbacks, etc.)
 * so values are always current at call time.
 */
export interface WorkerLifecycleDeps {
  workerManager: WorkerManager;
  agentManager: AgentManager;
  /**
   * Test seam for `getAgentParameterCapabilities` (agent-surface.md Ruling 1).
   * Defaults to the real shared accessor. Lets a test prove `createWorker`'s
   * model/reasoningEffort validation follows the accessor's return value
   * rather than an independent re-scan of `agent.commandTemplate`, without
   * `mock.module()` on `@agent-console/shared` (prohibited by
   * `.claude/rules/testing.md` Anti-Pattern #2 -- the shared package is
   * imported by virtually every other test file in this process).
   */
  getAgentParameterCapabilitiesImpl?: typeof getAgentParameterCapabilities;
  /**
   * Test seam for `EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES` (agent-surface.md
   * Ruling 1, embedded-agent side). Defaults to a lookup against the real
   * shared table. Lets a test prove `createWorker`'s embedded model/
   * reasoningEffort validation follows the injected accessor's return value
   * -- including an INCAPABLE row, which the production table does not
   * contain today -- rather than the production table's hardcoded shape.
   */
  getEmbeddedAgentParameterCapabilitiesImpl?: (
    engine: 'openai-api' | 'claude-sdk',
  ) => EmbeddedAgentEngineParameterCapabilities;
  /**
   * Embedded-agent definition registry. Only `getEmbeddedAgent` is needed here
   * (interface-segregated): createWorker resolves the definition to validate the
   * referenced id at creation time and to derive the worker's default name.
   */
  embeddedAgentManager: Pick<EmbeddedAgentManager, 'getEmbeddedAgent'>;
  /**
   * Deactivate an embedded-agent worker's subprocess (graceful shutdown ->
   * SIGTERM -> SIGKILL, token revocation). Called from deleteWorker before
   * output cleanup so the subprocess is torn down and its MCP token revoked.
   * A no-op for a worker that was never activated.
   */
  deactivateEmbeddedAgentWorker: (sessionId: string, workerId: string) => Promise<void>;
  /**
   * Activate an embedded-agent worker's subprocess (spawn + init handshake).
   * Called from restartAgentWorkerAsEmbedded after the worker is initialized,
   * persisted, and every restart broadcast has fired -- the converted worker
   * is activated immediately rather than left dormant. Throws on failure; the
   * caller does not catch it (the worker stays a dormant, persisted
   * embedded-agent worker on activation failure -- see that method's
   * doc comment).
   */
  activateEmbeddedAgentWorker: (sessionId: string, workerId: string) => Promise<void>;
  notificationManager: NotificationManager | null;
  pathExists: (path: string) => Promise<boolean>;
  getSession: (sessionId: string) => InternalSession | undefined;
  persistSession: (session: InternalSession) => Promise<void>;
  getRepositoryEnvVars: (sessionId: string) => Promise<Record<string, string>>;
  toPublicSession: (session: InternalSession) => Session;
  getJobQueue: () => JobQueue | null;
  getSessionLifecycleCallbacks: () => SessionLifecycleCallbacks | undefined;
  /**
   * Resolve the OS username for PTY spawning from a session's createdBy field.
   * If createdBy is null (pre-multi-user sessions), returns the server process username.
   */
  resolveSpawnUsername: (createdBy?: string) => Promise<string>;
  /**
   * Resolve the session data path resolver for a session.
   * Throws if the session's scope cannot be resolved (orphaned session).
   */
  getPathResolver: (session: InternalSession) => SessionDataPathResolver;
  /**
   * Look up the (scope, slug) pair for a session for cleanup-job enqueue.
   * Returns null for orphaned sessions — callers must log and skip.
   */
  getSessionScope: (session: InternalSession) => { scope: 'quick' | 'repository'; slug: string | null } | null;
  /**
   * Resolve the data-path resolver for a session that is no longer in memory
   * (e.g. after a browser reconnect hit the "session not found" branch).
   * Returns null when the DB has no matching row or the persisted scope is
   * invalid — callers must not fall back to `_quick/`.
   */
  getPathResolverByPersistedSessionId: (sessionId: string) => Promise<SessionDataPathResolver | null>;
  /** In-memory review annotation store */
  annotationService: AnnotationService;
  /** Worker output file management (buffering, history, cleanup) */
  workerOutputFileManager: WorkerOutputFileManager;
  /** Inter-session message file management */
  interSessionMessageService: InterSessionMessageService;
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
    startupPreference: StartupIntentPreference = 'fresh',
    initialPrompt?: string,
    templateVars?: Record<string, string>,
  ): Promise<Worker | null> {
    const session = this.deps.getSession(sessionId);
    if (!session) return null;

    const workerId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    // Resolve (and validate) the embedded-agent definition up front so a
    // dangling embeddedAgentId is rejected before anything is persisted, and
    // the resolved definition can name the worker without a second lookup.
    const embeddedAgentDefinition =
      request.type === 'embedded-agent'
        ? this.deps.embeddedAgentManager.getEmbeddedAgent(request.embeddedAgentId)
        : undefined;
    if (request.type === 'embedded-agent' && !embeddedAgentDefinition) {
      throw new ValidationError(
        `Embedded agent definition not found: ${request.embeddedAgentId}`,
      );
    }

    const agentIdForName = request.type === 'agent' ? request.agentId : undefined;
    const workerName =
      request.name ??
      this.generateWorkerName(session, request.type, agentIdForName, embeddedAgentDefinition?.name);

    let worker: InternalWorker;
    const repositoryId = session.type === 'worktree' ? session.repositoryId : undefined;
    const resolver = this.deps.getPathResolver(session);

    if (request.type === 'agent') {
      // Validate model/reasoningEffort against the resolved agent's ACTUAL
      // capability (agent-surface.md Ruling 1) before anything is
      // initialized/persisted. This is the ONE validation choke point for
      // these params -- it covers session-creation's initial worker, the
      // add-worker route, and (transitively, via createWorktreeWithSession
      // -> sessionManager.createSession) both the REST worktree-creation
      // route and MCP delegate_to_worktree. Do not duplicate this
      // validation at the route/MCP layer.
      //
      // Scoped to fire ONLY when a model/reasoningEffort param is actually
      // present: an unknown/omitted agentId with neither param set must
      // keep its pre-existing behavior (silent fallback to the default
      // agent inside initializeAgentWorker) unchanged -- that fallback is
      // relied on by callers upstream of this method that do not
      // pre-validate agentId existence (e.g. POST /api/sessions), and
      // fixing it is out of scope for this Issue.
      if (request.model !== undefined || request.reasoningEffort !== undefined) {
        const resolvedAgentId = request.agentId ?? CLAUDE_CODE_AGENT_ID;
        const resolvedAgent = this.deps.agentManager.getAgent(resolvedAgentId);
        if (!resolvedAgent) {
          throw new ValidationError(`Agent not found: ${resolvedAgentId}`);
        }
        const getCapabilities = this.deps.getAgentParameterCapabilitiesImpl ?? getAgentParameterCapabilities;
        const capabilities = getCapabilities(resolvedAgent);
        // Empty-string model/reasoningEffort is intentionally NOT rejected here
        // (unlike the embedded-agent branch): the command template's
        // optional-argument model/effort placeholders (template.ts's POSIX
        // ${var:+word}-style semantics) expand an empty override to nothing,
        // same as an absent one -- no wrong behavior results. Terminal agents
        // also always reject contextWindowTokens (kind-level, below), so
        // there is no companion invariant here for an empty model to silently
        // satisfy. The embedded branch rejects empty specifically to protect
        // that invariant (agent-surface.md Ruling 4 / R4d).
        // The placeholder's literal spelling is deliberately not quoted here
        // -- the static sweep keeps that string in its single writer module
        // (agent-parameter-capabilities.ts); do not "helpfully" restore it.
        if (request.model !== undefined && !capabilities.model) {
          throw new ValidationError(
            `Agent "${resolvedAgent.name}" (${resolvedAgent.id}) does not support the "model" parameter -- its command template has no model template placeholder (e.g. {{ model...}}).`,
          );
        }
        if (request.reasoningEffort !== undefined && !capabilities.reasoningEffort) {
          throw new ValidationError(
            `Agent "${resolvedAgent.name}" (${resolvedAgent.id}) does not support the "reasoningEffort" parameter -- its command template has no effort template placeholder (e.g. {{ effort...}}).`,
          );
        }
      }

      // contextWindowTokens is an embedded-agent-only concept
      // (agent-surface.md Ruling 4) -- terminal agents have no repository-side
      // context-window notion at all. This is a kind-level rejection (any
      // presence is invalid), not a per-agent capability-table row, so it is
      // gated independently of the model/reasoningEffort block above.
      if (request.contextWindowTokens !== undefined) {
        throw new ValidationError(
          'Agent workers do not support the "contextWindowTokens" parameter -- it is embedded-agent-only (agent-surface.md Ruling 4).',
        );
      }

      const repositoryEnvVars = await this.deps.getRepositoryEnvVars(sessionId);
      const username = await this.deps.resolveSpawnUsername(session.createdBy);
      // Only the session's initial agent worker (created with a non-empty
      // initialPrompt) is eligible for restart re-delivery.
      const deliverInitialPromptOnActivation = !!initialPrompt?.trim();
      const agentWorker = this.deps.workerManager.initializeAgentWorker({
        id: workerId,
        name: workerName,
        createdAt,
        agentId: request.agentId,
        deliverInitialPromptOnActivation,
        model: request.model,
        reasoningEffort: request.reasoningEffort,
      });
      // Resolved once, before activation; the value below is threaded
      // straight into activateAgentWorkerPty (which never re-derives it).
      const startupIntent = resolveStartupIntent(startupPreference, {
        deliverInitialPromptOnActivation,
        initialPrompt,
        initialPromptDelivered: session.initialPromptDelivered,
      });
      await this.deps.workerManager.activateAgentWorkerPty(agentWorker, {
        sessionId,
        locationPath: session.locationPath,
        repositoryEnvVars,
        username,
        resolver,
        agentId: agentWorker.agentId,
        startupIntent,
        initialPrompt,
        repositoryId,
        context: {
          parentSessionId: session.parentSessionId,
          parentWorkerId: session.parentWorkerId,
          templateVars,
          // Forward the delegated session's 1Password socket fallback into
          // PTY activation. Undefined for non-delegated paths.
          sshAuthSockFallback: session.sshAuthSockFallback,
        },
        revived: false,
        createdByUserId: session.createdBy,
      });
      worker = agentWorker;
    } else if (request.type === 'terminal') {
      const repositoryEnvVars = await this.deps.getRepositoryEnvVars(sessionId);
      const username = await this.deps.resolveSpawnUsername(session.createdBy);
      const terminalWorker = this.deps.workerManager.initializeTerminalWorker({
        id: workerId,
        name: workerName,
        createdAt,
      });
      await this.deps.workerManager.activateTerminalWorkerPty(terminalWorker, {
        sessionId,
        locationPath: session.locationPath,
        repositoryEnvVars,
        username,
        resolver,
        revived: false,
      });
      worker = terminalWorker;
    } else if (request.type === 'embedded-agent') {
      // Validate model/reasoningEffort/contextWindowTokens against the
      // resolved definition's ACTUAL per-engine capability (agent-surface.md
      // Ruling 1/4) before anything is initialized/persisted. Mirrors the
      // terminal-agent branch's validation above -- this is the SAME single
      // choke point, just for the embedded-agent kind. embeddedAgentDefinition
      // was already resolved and validated to exist above (before the branch
      // dispatch), so no second lookup is needed here.
      //
      // Scoped to fire ONLY when a model/reasoningEffort/contextWindowTokens
      // param is actually present, mirroring the terminal branch's scoping.
      if (
        request.model !== undefined ||
        request.reasoningEffort !== undefined ||
        request.contextWindowTokens !== undefined
      ) {
        // embeddedAgentDefinition is guaranteed defined here: the branch
        // dispatch above (request.type === 'embedded-agent' with a
        // resolvable definition) is the only way this code path is reached.
        //
        // Reads EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES directly by
        // engine rather than going through agent-surface.ts's
        // getAgentParameterCapabilitiesFor(AgentDirectoryEntry): this branch
        // already knows the kind statically (it IS the embedded-agent
        // branch), so there is no kind to dispatch on, and the dispatch
        // entry's boolean-only AgentParameterCapabilitiesByKind is
        // insufficient here anyway -- validation below needs the full row
        // (acceptedValues domain check, reason strings for the error
        // messages), not just capable/incapable booleans.
        const definition = embeddedAgentDefinition!;
        const getEmbeddedCapabilities =
          this.deps.getEmbeddedAgentParameterCapabilitiesImpl ??
          ((engine: 'openai-api' | 'claude-sdk') => EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES[engine]);
        const capabilities = getEmbeddedCapabilities(definition.engine);

        if (request.model !== undefined) {
          // Mirror the valibot wire schemas' v.trim() + v.minLength(1, 'model
          // must not be empty') contract (packages/shared/src/schemas/worker.ts).
          // Unlike the REST/WS routes, MCP's delegate_to_worktree validates
          // `model` via a looser Zod schema (z.string().optional(), no
          // .min(1)/trim), so an empty/whitespace-only value would otherwise
          // reach this choke point unrejected -- and would also satisfy the
          // contextWindowTokens-requires-model check below despite being
          // semantically absent (agent-surface.md Ruling 4 / 4d).
          if (request.model.trim().length === 0) {
            throw new ValidationError('model must not be empty');
          }
          if (!capabilities.model.capable) {
            throw new ValidationError(
              `Embedded agent "${definition.name}" (engine: ${definition.engine}) does not support the "model" parameter -- ${capabilities.model.reason}`,
            );
          }
        }
        if (request.reasoningEffort !== undefined) {
          // Same empty/whitespace gap as `model` above, for the same reason
          // (MCP's looser Zod schema).
          if (request.reasoningEffort.trim().length === 0) {
            throw new ValidationError('reasoningEffort must not be empty');
          }
          if (!capabilities.reasoningEffort.capable) {
            throw new ValidationError(
              `Embedded agent "${definition.name}" (engine: ${definition.engine}) does not support the "reasoningEffort" parameter -- ${capabilities.reasoningEffort.reason}`,
            );
          }
          if (
            capabilities.reasoningEffort.acceptedValues !== null &&
            !capabilities.reasoningEffort.acceptedValues.includes(request.reasoningEffort)
          ) {
            throw new ValidationError(
              `Embedded agent "${definition.name}" (engine: ${definition.engine}) does not accept "${request.reasoningEffort}" for "reasoningEffort" -- accepted values: ${capabilities.reasoningEffort.acceptedValues.join(', ')}`,
            );
          }
        }
        if (request.contextWindowTokens !== undefined && request.model === undefined) {
          throw new ValidationError(
            'contextWindowTokens requires an accompanying model override -- agent-surface.md Ruling 4: a declared window without a model change would silently apply to a model it wasn\'t declared for.',
          );
        }
      }

      // Embedded-agent worker. The referenced definition was already resolved
      // and validated above. In Phase 1 the subprocess is not spawned and no
      // output file is initialized; the worker persists as deactivated
      // (activation + output land in Phase 2).
      worker = this.deps.workerManager.initializeEmbeddedAgentWorker({
        id: workerId,
        name: workerName,
        createdAt,
        embeddedAgentId: request.embeddedAgentId,
        // Only the session's initial embedded-agent worker (created with a
        // non-empty initialPrompt) is eligible for delivery.
        deliverInitialPromptOnActivation: !!initialPrompt?.trim(),
        model: request.model,
        reasoningEffort: request.reasoningEffort,
        contextWindowTokens: request.contextWindowTokens,
      });
    } else {
      // git-diff worker (async initialization for base commit calculation).
      // Resolve the worktree-owning OS username so the initial
      // `computeDefaultBaseSpec` git invocation runs as that user in
      // multi-user mode (avoiding "dubious ownership in repository").
      const username = await this.deps.resolveSpawnUsername(session.createdBy);
      worker = await this.deps.workerManager.initializeGitDiffWorker({
        id: workerId,
        name: workerName,
        createdAt,
        locationPath: session.locationPath,
        baseCommit: request.baseCommit,
        requestUser: username,
      });
    }

    session.workers.set(workerId, worker);

    // Initialize output file immediately for PTY workers (agent/terminal)
    // This prevents race conditions where WebSocket connects before any output is buffered.
    // Record the worker's already-minted epoch in the manifest so history reads
    // and live output messages carry the same generation identifier (§3.4).
    if (worker.type === 'agent' || worker.type === 'terminal') {
      worker.epoch = await this.deps.workerOutputFileManager.initializeWorkerOutput(
        sessionId,
        workerId,
        resolver,
        worker.epoch,
      );
    }

    await this.deps.persistSession(session);

    // Broadcast session update so all clients learn about the new worker
    // (mirrors deleteWorker's broadcast after its own persistSession call).
    this.deps.getSessionLifecycleCallbacks()?.onSessionUpdated?.(this.deps.toPublicSession(session));

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

    // Non-PTY workers (git-diff, embedded-agent) have no PTY to activate here.
    if (worker.type === 'git-diff' || worker.type === 'embedded-agent') return null;

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

    const repositoryEnvVars = await this.deps.getRepositoryEnvVars(sessionId);
    const repositoryId = session.type === 'worktree' ? session.repositoryId : undefined;
    const resolver = this.deps.getPathResolver(session);
    const username = await this.deps.resolveSpawnUsername(session.createdBy);

    // Activate PTY based on worker type
    if (worker.type === 'agent') {
      const effectiveAgentId = this.resolveEffectiveAgentId(worker.agentId, { sessionId, workerId });
      // Reviving an already-existing worker (not a fresh start): the
      // conversation always continues, same as restoreWorker / resume.
      const startupIntent = resolveStartupIntent('continue', {
        deliverInitialPromptOnActivation: worker.deliverInitialPromptOnActivation,
        initialPrompt: session.initialPrompt,
        initialPromptDelivered: session.initialPromptDelivered,
      });
      await this.deps.workerManager.activateAgentWorkerPty(worker, {
        sessionId,
        locationPath: session.locationPath,
        repositoryEnvVars,
        username,
        resolver,
        agentId: effectiveAgentId,
        startupIntent,
        repositoryId,
        context: {
          parentSessionId: session.parentSessionId,
          parentWorkerId: session.parentWorkerId,
          templateVars: session.templateVars,
          // Re-emit the SSH_AUTH_SOCK fallback on lazy activation.
          sshAuthSockFallback: session.sshAuthSockFallback,
        },
        revived: true,
        createdByUserId: session.createdBy,
      });
    } else {
      await this.deps.workerManager.activateTerminalWorkerPty(worker, {
        sessionId,
        locationPath: session.locationPath,
        repositoryEnvVars,
        username,
        resolver,
        revived: true,
      });
    }

    await this.deps.persistSession(session);
    logger.info({ workerId, sessionId, workerType: worker.type }, 'Worker PTY activated');

    // Broadcast session-updated since activationState may have changed
    this.deps.getSessionLifecycleCallbacks()?.onSessionUpdated?.(this.deps.toPublicSession(session));

    return worker;
  }

  async deleteWorker(sessionId: string, workerId: string): Promise<boolean> {
    const session = this.deps.getSession(sessionId);
    if (!session) return false;

    const worker = session.workers.get(workerId);
    if (!worker) return false;

    const resolver = this.deps.getPathResolver(session);

    // Clean up based on worker type
    if (worker.type === 'agent' || worker.type === 'terminal') {
      await this.deps.workerManager.killWorker(worker, sessionId);
      await this.cleanupWorkerOutput(sessionId, workerId, session);
    } else if (worker.type === 'git-diff') {
      // git-diff worker: stop file watcher (synchronous operation)
      stopWatching(session.locationPath);
    } else {
      // embedded-agent worker: gracefully tear down the loop subprocess (and
      // revoke its MCP token) BEFORE cleaning the output stream. Cleanup must
      // not throw — a deactivation failure is logged and does not abort delete.
      try {
        await this.deps.deactivateEmbeddedAgentWorker(sessionId, workerId);
      } catch (err) {
        logger.warn(
          { sessionId, workerId, err },
          'Failed to deactivate embedded-agent worker during delete',
        );
      }
      await this.cleanupWorkerOutput(sessionId, workerId, session);
    }

    // Clean up notification state (debounce timers, previous state)
    this.deps.notificationManager?.cleanupWorker(sessionId, workerId);

    // Clean up review annotations for this worker
    this.deps.annotationService.clearAnnotations(workerId);

    // Clean up inter-session message files for this worker
    try {
      await this.deps.interSessionMessageService.deleteWorkerMessages(sessionId, workerId, resolver);
    } catch (err) {
      logger.warn(
        { sessionId, workerId, err },
        'Failed to clean inter-session message files for worker',
      );
    }

    session.workers.delete(workerId);
    await this.deps.persistSession(session);

    // Broadcast session update so all clients learn the worker was removed
    this.deps.getSessionLifecycleCallbacks()?.onSessionUpdated?.(this.deps.toPublicSession(session));

    logger.info({ workerId, sessionId }, 'Worker deleted');
    return true;
  }

  async restartAgentWorker(
    sessionId: string,
    workerId: string,
    startupPreference: StartupIntentPreference,
    agentId?: string,
    branch?: string
  ): Promise<Worker | null> {
    const session = this.deps.getSession(sessionId);
    if (!session) return null;

    const existingWorker = session.workers.get(workerId);
    if (!existingWorker) return null;

    // R2: the wire schema's terminal member (TerminalRestartSchema) has no
    // dedicated "existing worker is embedded-agent" member of its own -- the
    // discriminant (which KIND of worker is being restarted) lives in the
    // URL/session lookup above, not in the request body, so this ONE check
    // cannot be expressed structurally the way the rest of #1171/#1592's
    // cross-type restart contract is (see RestartWorkerRequestSchema's own
    // doc comment). `continueConversation: true` has nothing to continue --
    // the conversation belongs to the embedded worker being replaced, not to
    // a terminal that never existed -- and a missing `agentId` has no
    // "current terminal agent" to fall back to (unlike the agent->agent case
    // below, which defaults to the existing worker's own agentId).
    if (existingWorker.type === 'embedded-agent') {
      if (startupPreference === 'continue') {
        throw new ValidationError(
          'nothing to continue: the conversation belongs to the embedded worker, not to a terminal that never existed',
        );
      }
      if (!agentId) {
        throw new ValidationError('agentId is required to restart an embedded-agent worker as a terminal agent');
      }
      return this.restartEmbeddedWorkerAsAgent(sessionId, workerId, agentId, branch);
    }

    if (existingWorker.type !== 'agent') return null;

    // Resolve the startup intent once, from the still-live
    // existingWorker/session state, BEFORE the worker is killed/recreated
    // below (preserving the pre-refactor shouldRedeliverInitialPrompt gate's
    // TOCTOU position). The resolved value is threaded to every downstream
    // consumer of this restart flow; nothing re-derives it.
    const startupIntent = resolveStartupIntent(startupPreference, {
      deliverInitialPromptOnActivation: existingWorker.deliverInitialPromptOnActivation,
      initialPrompt: session.initialPrompt,
      initialPromptDelivered: session.initialPromptDelivered,
    });

    // Resolve agent ID: use provided agentId or fall back to existing
    const workerAgentId = agentId ?? existingWorker.agentId;

    // Validate that the agent exists if a new agentId was provided
    if (agentId) {
      const agentManager = this.deps.agentManager;
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

      // Update git-diff workers' base commit after successful branch rename.
      // This is a secondary concern - failure should not abort the agent restart.
      try {
        await this.updateGitDiffWorkersAfterBranchRename(sessionId);
      } catch (err) {
        logger.error(
          { sessionId, err },
          'Failed to update git-diff workers after branch rename'
        );
      }
    }

    const isAgentChanged = workerAgentId !== existingWorker.agentId;

    // Capture worker metadata before killing (needed for new worker creation)
    const workerName = isAgentChanged
      ? this.generateWorkerName(session, 'agent', workerAgentId)
      : existingWorker.name;
    const workerCreatedAt = existingWorker.createdAt;
    const locationPath = session.locationPath;

    // Resolve the path resolver before killing anything -- getPathResolver
    // can throw for an orphaned session (its own JSDoc), so this fallible
    // prerequisite must be resolved before the destructive kill below.
    const resolver = this.deps.getPathResolver(session);

    // Kill existing worker
    await this.deps.workerManager.killWorker(existingWorker, sessionId);

    // Reset the output file to prevent offset mismatch with client cache. This
    // mints a NEW generation epoch (the stream restarts at 0 under a new
    // generation); the new worker object must carry it so `output` messages and
    // `history` responses agree (§3.4 / §4.5).
    const newEpoch = await this.deps.workerOutputFileManager.resetWorkerOutput(sessionId, workerId, resolver);

    // Create new worker with same ID, preserving original createdAt for tab order
    const repositoryEnvVars = await this.deps.getRepositoryEnvVars(sessionId);
    const repositoryId = session.type === 'worktree' ? session.repositoryId : undefined;
    const username = await this.deps.resolveSpawnUsername(session.createdBy);
    const newWorker = this.deps.workerManager.initializeAgentWorker({
      id: workerId,
      name: workerName,
      createdAt: workerCreatedAt,
      agentId: workerAgentId,
      // Eligibility carries over unchanged across restart -- it is a
      // property of "is this the session's initial agent worker", which
      // restart does not change. NOT recomputed from the resolved
      // startupIntent above.
      deliverInitialPromptOnActivation: existingWorker.deliverInitialPromptOnActivation,
      // model/reasoningEffort (agent-surface.md Ruling 3): a same-agent restart
      // preserves the worker's override verbatim -- this is the restart-
      // persistence pin. An agent CHANGE starts fresh with no override: the
      // new agent is a different definition, possibly incapable of the old
      // override, so carrying it over risks resurrecting a now-invalid
      // value. A future phase can add explicit restart-time model/effort
      // params if wanted; out of scope here.
      model: isAgentChanged ? null : existingWorker.model,
      reasoningEffort: isAgentChanged ? null : existingWorker.reasoningEffort,
    });
    // Adopt the epoch minted by resetWorkerOutput so the manifest and the
    // in-memory worker agree from the first live chunk (activation is
    // revived:false, so it does not reload the epoch).
    newWorker.epoch = newEpoch;
    await this.deps.workerManager.activateAgentWorkerPty(newWorker, {
      sessionId,
      locationPath,
      repositoryEnvVars,
      username,
      resolver,
      agentId: workerAgentId,
      startupIntent,
      // Only carries a value when the resolved intent calls for delivery;
      // otherwise the activation machinery behaves exactly as before this
      // issue.
      initialPrompt: startupIntent === 'deliver-initial-prompt' ? session.initialPrompt : undefined,
      repositoryId,
      context: {
        parentSessionId: session.parentSessionId,
        parentWorkerId: session.parentWorkerId,
        templateVars: session.templateVars,
        // Preserve the SSH_AUTH_SOCK fallback across restart.
        sshAuthSockFallback: session.sshAuthSockFallback,
      },
      // File was just truncated by resetWorkerOutput above, so the
      // file-absolute offset is 0 — equivalent to fresh creation.
      revived: false,
      createdByUserId: session.createdBy,
    });

    // Re-check session still exists after async gap
    // Session may have been deleted during async operations above
    const currentSession = this.deps.getSession(sessionId);
    if (!currentSession) {
      logger.warn({ sessionId, workerId }, 'Session deleted during worker restart, killing new worker');
      await this.deps.workerManager.killWorker(newWorker, sessionId);
      return null;
    }

    currentSession.workers.set(workerId, newWorker);
    await this.deps.persistSession(currentSession);

    // Broadcast session update so all clients learn about agent/name/branch changes
    const hasBranchChange = branch !== undefined && session.type === 'worktree';
    if (isAgentChanged || hasBranchChange) {
      this.deps.getSessionLifecycleCallbacks()?.onSessionUpdated?.(this.deps.toPublicSession(currentSession));
    }

    // Always notify that worker was restarted, regardless of agent/branch changes
    const activityState = this.getWorkerActivityState(sessionId, workerId) ?? 'unknown';
    this.deps.getSessionLifecycleCallbacks()?.onWorkerRestarted?.(sessionId, workerId, activityState);

    let restartReason = 'Agent worker restarted';
    if (isAgentChanged) {
      restartReason = 'Agent worker switched to different agent';
    } else if (hasBranchChange) {
      restartReason = 'Agent worker restarted with branch rename';
    }

    logger.info(
      { workerId, sessionId, startupPreference, startupIntent, agentId: workerAgentId, previousAgentId: existingWorker.agentId, branch },
      restartReason
    );

    return this.deps.workerManager.toPublicWorker(newWorker);
  }

  /**
   * Restart a PTY `agent` worker AS an embedded-agent worker: same worker
   * slot/tab, same `workerId`, but the underlying mechanism flips from PTY
   * subprocess to embedded-agent subprocess. This is a conversion, not a
   * same-kind restart -- see `restartAgentWorker` for the PTY->PTY case,
   * whose body this method does not modify or call into.
   *
   * Call order is load-bearing (mirrors, and diverges from, restartAgentWorker
   * where noted):
   *   1. Resolve + validate the embedded-agent definition FIRST, before
   *      touching the existing PTY worker at all -- an unknown embeddedAgentId
   *      must leave the PTY worker completely untouched.
   *   2. Branch rename (identical block to restartAgentWorker's).
   *   3. Resolve the path resolver -- getPathResolver can throw for an
   *      orphaned session (its own JSDoc). Resolving it here, alongside the
   *      worker-metadata capture and before the kill in step 4, means this
   *      second fallible prerequisite is settled before the destructive PTY
   *      kill happens, same discipline as step 1's definition validation.
   *   4. Kill the existing PTY worker -- this also revokes its MCP token and
   *      deletes its prompt file (killWorker's own contract for
   *      worker.type === 'agent'). Steps 1-3 are the only fallible
   *      prerequisites; nothing after this point can leave the PTY worker
   *      un-killed.
   *   5. DELETE the output file (content AND manifest) rather than merely
   *      resetting it -- the embedded worker's NDJSON log and the PTY
   *      worker's raw terminal bytes share the same on-disk path, so any
   *      leftover content or manifest before the embedded worker's first
   *      activation is wrong for it. A plain reset is not enough: it re-mints
   *      the manifest in place, and `EmbeddedAgentWorkerService.activate`'s
   *      `hasEverBeenActivated` check is keyed on manifest EXISTENCE, not
   *      content -- a re-minted-but-present manifest from the PTY worker's
   *      own original creation (every PTY worker's `initializeWorkerOutput`
   *      writes one at creation time, long before any conversion) makes the
   *      embedded engine take its "attempt restore" branch on an empty
   *      stream, which throws a spurious read-failure and reports
   *      `getEmbeddedAgentRestoreInfo` as `failed: true` on what is actually
   *      a first-ever activation. Deleting the manifest outright (the same
   *      operation `deleteWorkerOutput` already performs for worker
   *      deletion) makes `hasEverBeenActivated` correctly read false, so
   *      `activate()` takes its OWN "first-ever activation, nothing to
   *      restore" branch and mints the fresh epoch + manifest itself.
   *      NON-FATAL: the PTY worker is already dead (step 4), so aborting here
   *      would strand the worker mid-conversion with no PTY and no embedded
   *      worker either. A failure is logged and the method continues -- at
   *      worst a stale manifest surfaces later as a declared restore-failure
   *      marker (visible and recoverable), never silent corruption.
   *   6. Clear NotificationManager's per-worker state for this identity
   *      (previousState, pending debounce timer) before the embedded worker
   *      exists. The identity (sessionId:workerId) is reused across the type
   *      flip, but NotificationManager keys its state on identity alone, so
   *      without this a pending PTY-side debounce timer could fire after
   *      conversion, or stale retained state could suppress the embedded
   *      worker's first notification. restartAgentWorker (PTY->PTY) does not
   *      do this -- it keeps the same worker kind throughout, so there is no
   *      state to invalidate. Unconditional: runs whether or not step 5
   *      succeeded.
   *   7. Initialize the embedded-agent worker (identity fields per R2: same
   *      workerId/createdAt, regenerated name, carried-over
   *      deliverInitialPromptOnActivation, no model/reasoningEffort/
   *      contextWindowTokens override -- always a different kind of
   *      definition). No epoch to adopt here (see step 5) -- the worker
   *      keeps whatever placeholder `initializeEmbeddedAgentWorker` assigns;
   *      `activate()`'s first-activation branch overwrites it before any
   *      client-visible output flows, and `epoch` is never part of the
   *      public worker shape, so the transient value is not observable. This
   *      is synchronous construction and cannot fail, so it stays after the
   *      kill.
   *   8. Re-check the session still exists (async-gap TOCTOU guard). Unlike
   *      restartAgentWorker's PTY->PTY path, there is nothing to kill here on
   *      the deleted-session branch: the new embedded worker was never
   *      activated (no subprocess, no MCP token minted yet).
   *   9. Persist. If this throws, no special handling is added: the in-memory
   *      map already holds the new embedded worker (set immediately before
   *      this call, same as restartAgentWorker's identical window at its own
   *      persistSession call), onSessionUpdated has not fired yet, and the
   *      error propagates to the caller as-is -- the DB catches up at the
   *      next persist.
   *   10. onSessionUpdated -- fired UNCONDITIONALLY (unlike restartAgentWorker's
   *       isAgentChanged/hasBranchChange-gated call): the worker's TYPE
   *       changed, every client must re-render the tab regardless of whether
   *       branch also changed.
   *   11. onWorkerRestarted (closes the old worker's PTY sockets client-side).
   *   12. Activate the new embedded-agent worker immediately. If this throws,
   *       it propagates to the caller as-is -- the worker stays a dormant,
   *       persisted embedded-agent worker (already flipped to type
   *       'embedded-agent' in step 9); this method does NOT attempt to
   *       resurrect the killed PTY worker.
   *
   * Returns null when the session doesn't exist, the target worker doesn't
   * exist or isn't a PTY `agent` worker (e.g. it's already 'terminal' or
   * already 'embedded-agent' -- reverse/repeat conversion is out of scope),
   * or the session was deleted during the async gap.
   */
  async restartAgentWorkerAsEmbedded(
    sessionId: string,
    workerId: string,
    embeddedAgentId: string,
    branch?: string,
  ): Promise<Worker | null> {
    const session = this.deps.getSession(sessionId);
    if (!session) return null;

    const existingWorker = session.workers.get(workerId);
    if (!existingWorker) return null;

    // Dispatch on the EXISTING worker's kind before this method's own
    // PTY->embedded body runs. An embedded existing worker means this is
    // either (c) a same-definition restart (no conversion -- see R1(c) /
    // restartEmbeddedWorkerSameDefinition) or (b) a definition switch (see
    // restartEmbeddedWorkerAsDifferentEmbedded). Neither reuses this
    // method's own body below, which assumes a PTY source.
    if (existingWorker.type === 'embedded-agent') {
      if (existingWorker.embeddedAgentId === embeddedAgentId) {
        return this.restartEmbeddedWorkerSameDefinition(sessionId, workerId, branch);
      }
      return this.restartEmbeddedWorkerAsDifferentEmbedded(sessionId, workerId, embeddedAgentId, branch);
    }

    if (existingWorker.type !== 'agent') return null;

    // Resolve and validate the embedded-agent definition FIRST, before
    // touching anything -- mirrors createWorker's embedded branch (validate
    // before any initialize/persist).
    const embeddedAgentDefinition = this.deps.embeddedAgentManager.getEmbeddedAgent(embeddedAgentId);
    if (!embeddedAgentDefinition) {
      throw new ValidationError(`Embedded agent definition not found: ${embeddedAgentId}`);
    }

    // Handle branch rename if requested (must happen before restart) --
    // identical block to restartAgentWorker's.
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

      // Update git-diff workers' base commit after successful branch rename.
      // This is a secondary concern - failure should not abort the restart.
      try {
        await this.updateGitDiffWorkersAfterBranchRename(sessionId);
      } catch (err) {
        logger.error(
          { sessionId, err },
          'Failed to update git-diff workers after branch rename'
        );
      }
    }

    // Capture worker metadata before killing (needed for new worker creation).
    const workerName = this.generateWorkerName(session, 'embedded-agent', undefined, embeddedAgentDefinition.name);
    const workerCreatedAt = existingWorker.createdAt;

    // Resolve the path resolver before killing anything -- getPathResolver
    // can throw for an orphaned session (its own JSDoc), so this fallible
    // prerequisite must be resolved before the destructive kill below.
    const resolver = this.deps.getPathResolver(session);

    // Kill existing PTY worker. This also revokes its MCP token and deletes
    // its prompt file (killWorker's contract for worker.type === 'agent').
    await this.deps.workerManager.killWorker(existingWorker, sessionId);

    // Delete the output file (content AND manifest) entirely -- see the
    // method doc comment's step 5 for why a plain resetWorkerOutput is not
    // enough. This is the SAME operation deleteWorkerOutput already performs
    // for worker deletion; here it clears the way for the embedded engine's
    // own "first-ever activation" bootstrap to run cleanly.
    //
    // NON-FATAL: the PTY worker is already dead at this point, so a failure
    // here must not abort the conversion -- there would be nothing left to
    // recover to. Log and continue; a stale manifest surfaces later (if at
    // all) as a declared restore-failure marker, not silent corruption.
    try {
      await this.deps.workerOutputFileManager.deleteWorkerOutput(sessionId, workerId, resolver);
    } catch (err) {
      logger.warn(
        { sessionId, workerId, err },
        'Failed to delete PTY worker output before embedded-agent conversion; continuing',
      );
    }

    // Clear any per-worker notification state left over from the PTY side of
    // this identity (previousState, pending debounce timer) before the
    // embedded-agent replacement is created. The identity (sessionId:workerId)
    // is reused across the type flip, but NotificationManager's state is
    // keyed on identity only, so without this a pending PTY-side debounce
    // timer could fire post-conversion, or stale retained state could
    // suppress the embedded worker's first notification. restartAgentWorker
    // (PTY->PTY) does not call this -- it keeps the same worker kind
    // throughout, so there is no state to invalidate.
    this.deps.notificationManager?.cleanupWorker(sessionId, workerId);

    // Create the new embedded-agent worker with the same id, preserving
    // original createdAt for tab order.
    const newWorker = this.deps.workerManager.initializeEmbeddedAgentWorker({
      id: workerId,
      name: workerName,
      createdAt: workerCreatedAt,
      embeddedAgentId,
      // Eligibility carries over unchanged across conversion -- it is a
      // property of "is this the session's initial worker", which
      // conversion does not change. NOT recomputed.
      deliverInitialPromptOnActivation: existingWorker.deliverInitialPromptOnActivation,
      // No model/reasoningEffort/contextWindowTokens carry-over: this is
      // always a conversion to a different kind of definition, so there is
      // no valid override to preserve (agent-surface.md Ruling 3 precedent).
    });

    // Re-check session still exists after the async gap above. Unlike
    // restartAgentWorker's PTY->PTY path, there is nothing to kill here on
    // the deleted-session branch: the new embedded worker was never
    // activated (no subprocess spawned, no MCP token minted).
    const currentSession = this.deps.getSession(sessionId);
    if (!currentSession) {
      logger.warn(
        { sessionId, workerId },
        'Session deleted during worker restart, discarding new embedded-agent worker'
      );
      return null;
    }

    currentSession.workers.set(workerId, newWorker);
    await this.deps.persistSession(currentSession);

    // Unlike restartAgentWorker's conditional broadcast, this ALWAYS
    // notifies: the worker's TYPE changed, so every client must re-render
    // the tab regardless of whether branch also changed.
    this.deps.getSessionLifecycleCallbacks()?.onSessionUpdated?.(this.deps.toPublicSession(currentSession));

    // Always notify that worker was restarted (closes old PTY sockets client-side).
    const activityState = this.getWorkerActivityState(sessionId, workerId) ?? 'unknown';
    this.deps.getSessionLifecycleCallbacks()?.onWorkerRestarted?.(sessionId, workerId, activityState);

    logger.info(
      { workerId, sessionId, embeddedAgentId, previousAgentId: existingWorker.agentId, branch },
      'Agent worker converted to embedded-agent worker via restart'
    );

    // Activate immediately -- don't leave the converted worker dormant. If
    // this throws, it propagates to the caller: the worker stays persisted
    // as a dormant embedded-agent worker (already flipped above), never
    // reverted to PTY.
    await this.deps.activateEmbeddedAgentWorker(sessionId, workerId);

    return this.deps.workerManager.toPublicWorker(newWorker);
  }

  /**
   * Restart an embedded-agent worker AS a PTY `agent` worker: same worker
   * slot/tab, same `workerId`, but the underlying mechanism flips from
   * embedded-agent subprocess to PTY subprocess. This is the reverse
   * direction of restartAgentWorkerAsEmbedded -- a conversion, not a
   * same-kind restart -- and does not modify or call into that method's
   * body, nor restartAgentWorker's PTY->PTY body. Reached only from
   * restartAgentWorker's dispatch, after that method has already validated
   * `agentId` is present and `continueConversation` was not requested (R2).
   *
   * Call order (R4) mirrors, and diverges from, restartAgentWorkerAsEmbedded
   * in one key way: activation is LAST here (step 13), whereas
   * restartAgentWorker's own PTY->PTY body activates BEFORE persisting.
   * Deferring activation to the end keeps this method's failure contract
   * identical to restartAgentWorkerAsEmbedded's (persisted-but-dormant on
   * activation failure) rather than restartAgentWorker's (kill-the-new-worker
   * on a post-activation session-deletion race):
   *   1. Resolve + validate the target `agentId` FIRST, before touching the
   *      existing embedded worker at all -- an unknown agentId must leave
   *      the embedded worker completely untouched.
   *   2. Branch rename (identical block to the sibling methods').
   *   3. Resolve the path resolver -- getPathResolver can throw for an
   *      orphaned session (its own JSDoc). Resolved before the destructive
   *      teardown in step 4, same discipline as restartAgentWorkerAsEmbedded's
   *      step 3.
   *   4. Gracefully deactivate the existing embedded-agent worker
   *      (deactivateEmbeddedAgentWorker: shutdown -> SIGTERM -> SIGKILL,
   *      token revocation) -- NOT killWorker, which is a PTY-only operation.
   *   5. Delete the output file (content AND manifest) -- see
   *      restartAgentWorkerAsEmbedded's step 5 doc for why a plain reset is
   *      not enough: the embedded worker's NDJSON log and a PTY worker's raw
   *      terminal bytes share the same on-disk path, and a stale manifest
   *      would misdirect the new PTY worker's own output-file semantics.
   *      NON-FATAL: the embedded worker is already torn down, so a failure
   *      here must not abort the conversion -- there is nothing left to
   *      recover to.
   *   6. Clear NotificationManager's per-worker state for this identity
   *      (previousState, pending debounce timer) before the PTY replacement
   *      exists -- same reasoning as restartAgentWorkerAsEmbedded's step 6:
   *      the identity (sessionId:workerId) is reused across the type flip,
   *      but NotificationManager keys its state on identity alone.
   *   7. Initialize the new PTY agent worker (identity fields: same
   *      workerId, original createdAt, regenerated name, carried-over
   *      deliverInitialPromptOnActivation, no model/reasoningEffort
   *      carry-over -- always a different kind of definition, same
   *      agent-surface.md Ruling 3 precedent as restartAgentWorkerAsEmbedded).
   *   8. Mint the output file's epoch + manifest via initializeWorkerOutput
   *      BEFORE the PTY's first byte -- mirrors createWorker's agent branch.
   *      Unlike the embedded-target sibling (whose own activate() mints its
   *      epoch/manifest lazily on first activation), activateAgentWorkerPty
   *      does not initialize the output file itself -- this must happen here.
   *   9. Re-check the session still exists (async-gap TOCTOU guard). Nothing
   *      to kill on the deleted-session branch: the new PTY worker was never
   *      activated (no pty spawned yet) -- mirrors
   *      restartAgentWorkerAsEmbedded's identical branch, NOT
   *      restartAgentWorker's kill-the-new-worker branch (that method
   *      activates the PTY before this check; this method activates last).
   *   10. Persist.
   *   11. onSessionUpdated -- fired UNCONDITIONALLY: the worker's TYPE
   *       changed, every client must re-render the tab regardless of
   *       whether branch also changed.
   *   12. onWorkerRestarted (closes the old embedded worker's connections
   *       client-side).
   *   13. Activate the new PTY LAST. If this throws (including a failure in
   *       resolving repositoryEnvVars/username, which this method resolves
   *       just before this call), it propagates to the caller as-is: the
   *       worker stays persisted as type 'agent' with no PTY started --
   *       this method does NOT attempt to resurrect the deactivated
   *       embedded worker.
   *
   * Returns null when the session doesn't exist, the target worker doesn't
   * exist or isn't an embedded-agent worker (defensive -- restartAgentWorker
   * already checked this before dispatching here), or the session was
   * deleted during the async gap.
   */
  private async restartEmbeddedWorkerAsAgent(
    sessionId: string,
    workerId: string,
    agentId: string,
    branch?: string,
  ): Promise<Worker | null> {
    const session = this.deps.getSession(sessionId);
    if (!session) return null;

    const existingWorker = session.workers.get(workerId);
    if (!existingWorker || existingWorker.type !== 'embedded-agent') return null;

    // Resolve and validate the target agent FIRST, before touching anything
    // -- mirrors restartAgentWorkerAsEmbedded's definition-validation-first
    // discipline.
    const agent = this.deps.agentManager.getAgent(agentId);
    if (!agent) {
      throw new ValidationError(`Agent not found: ${agentId}`);
    }

    // Handle branch rename if requested (must happen before restart) --
    // identical block to the sibling methods'.
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

      // Update git-diff workers' base commit after successful branch rename.
      // This is a secondary concern - failure should not abort the restart.
      try {
        await this.updateGitDiffWorkersAfterBranchRename(sessionId);
      } catch (err) {
        logger.error(
          { sessionId, err },
          'Failed to update git-diff workers after branch rename'
        );
      }
    }

    // Capture worker metadata before tearing down (needed for new worker creation).
    const workerName = this.generateWorkerName(session, 'agent', agentId);
    const workerCreatedAt = existingWorker.createdAt;

    // Resolve the path resolver before tearing down anything -- getPathResolver
    // can throw for an orphaned session (its own JSDoc), so this fallible
    // prerequisite must be resolved before the destructive deactivate below.
    const resolver = this.deps.getPathResolver(session);

    // Gracefully deactivate the existing embedded-agent worker (shutdown ->
    // SIGTERM -> SIGKILL, token revocation) -- NOT killWorker, which is a
    // PTY-only operation.
    await this.deps.deactivateEmbeddedAgentWorker(sessionId, workerId);

    // Delete the output file (content AND manifest) rather than merely
    // resetting it -- see restartAgentWorkerAsEmbedded's doc comment step 5
    // for why a plain reset is not enough (shared on-disk path, manifest
    // existence gates the reader's "has this worker ever activated" branch).
    // NON-FATAL: the embedded worker is already torn down, so aborting here
    // would strand the worker mid-conversion with nothing to recover to.
    try {
      await this.deps.workerOutputFileManager.deleteWorkerOutput(sessionId, workerId, resolver);
    } catch (err) {
      logger.warn(
        { sessionId, workerId, err },
        'Failed to delete embedded-agent worker output before PTY conversion; continuing',
      );
    }

    // Clear any per-worker notification state left over from the embedded
    // side of this identity, before the PTY replacement is created. See
    // restartAgentWorkerAsEmbedded's identical call for the full rationale.
    this.deps.notificationManager?.cleanupWorker(sessionId, workerId);

    // Create the new PTY agent worker with the same id, preserving original
    // createdAt for tab order.
    const newWorker = this.deps.workerManager.initializeAgentWorker({
      id: workerId,
      name: workerName,
      createdAt: workerCreatedAt,
      agentId,
      // Eligibility carries over unchanged across conversion -- it is a
      // property of "is this the session's initial worker", which
      // conversion does not change. NOT recomputed.
      deliverInitialPromptOnActivation: existingWorker.deliverInitialPromptOnActivation,
      // No model/reasoningEffort carry-over: this is always a conversion to
      // a different kind of definition (agent-surface.md Ruling 3
      // precedent, same as restartAgentWorkerAsEmbedded).
    });

    // Mint the output file's epoch + manifest BEFORE the PTY's first byte --
    // mirrors createWorker's agent branch. Unlike the embedded-target
    // sibling (whose activate() mints its own epoch/manifest lazily on
    // first activation), activateAgentWorkerPty does not initialize the
    // output file itself.
    newWorker.epoch = await this.deps.workerOutputFileManager.initializeWorkerOutput(
      sessionId,
      workerId,
      resolver,
      newWorker.epoch,
    );

    // Re-check session still exists after the async gap above. Nothing to
    // kill here on the deleted-session branch: the new PTY worker was never
    // activated (no pty spawned yet) -- mirrors restartAgentWorkerAsEmbedded's
    // identical branch, NOT restartAgentWorker's kill-the-new-worker branch
    // (which activates the PTY before this check; this method activates
    // last, see step 13).
    const currentSession = this.deps.getSession(sessionId);
    if (!currentSession) {
      logger.warn(
        { sessionId, workerId },
        'Session deleted during worker restart, discarding new agent worker'
      );
      return null;
    }

    currentSession.workers.set(workerId, newWorker);
    await this.deps.persistSession(currentSession);

    // Unlike restartAgentWorker's conditional broadcast, this ALWAYS
    // notifies: the worker's TYPE changed, so every client must re-render
    // the tab regardless of whether branch also changed.
    this.deps.getSessionLifecycleCallbacks()?.onSessionUpdated?.(this.deps.toPublicSession(currentSession));

    // Always notify that worker was restarted (closes old embedded
    // connections client-side).
    const activityState = this.getWorkerActivityState(sessionId, workerId) ?? 'unknown';
    this.deps.getSessionLifecycleCallbacks()?.onWorkerRestarted?.(sessionId, workerId, activityState);

    logger.info(
      { workerId, sessionId, agentId, previousEmbeddedAgentId: existingWorker.embeddedAgentId, branch },
      'Embedded-agent worker converted to PTY agent worker via restart'
    );

    // Resolve dependencies for PTY activation, mirroring createWorker's
    // agent branch. Deliberately resolved AFTER persist/broadcast (step 13
    // is the last step) -- a failure here still leaves the worker persisted
    // as type 'agent' with no PTY, per this method's own failure contract.
    const repositoryEnvVars = await this.deps.getRepositoryEnvVars(sessionId);
    const repositoryId = currentSession.type === 'worktree' ? currentSession.repositoryId : undefined;
    const username = await this.deps.resolveSpawnUsername(currentSession.createdBy);

    // Startup intent is always a fresh start -- there is no prior PTY
    // conversation to continue. R2 already rejected `continueConversation:
    // true` against an embedded existing worker upstream, in
    // restartAgentWorker, before this method was ever reached; a pending
    // initial prompt can still be owed and is delivered below exactly as a
    // fresh 'agent' worker creation would.
    const startupIntent = resolveStartupIntent('fresh', {
      deliverInitialPromptOnActivation: newWorker.deliverInitialPromptOnActivation,
      initialPrompt: currentSession.initialPrompt,
      initialPromptDelivered: currentSession.initialPromptDelivered,
    });

    // Activate the new PTY LAST. If this throws, it propagates to the
    // caller as-is: the worker stays persisted as type 'agent' with no PTY
    // started -- this method does NOT attempt to resurrect the deactivated
    // embedded worker.
    await this.deps.workerManager.activateAgentWorkerPty(newWorker, {
      sessionId,
      locationPath: currentSession.locationPath,
      repositoryEnvVars,
      username,
      resolver,
      agentId,
      startupIntent,
      initialPrompt: startupIntent === 'deliver-initial-prompt' ? currentSession.initialPrompt : undefined,
      repositoryId,
      context: {
        parentSessionId: currentSession.parentSessionId,
        parentWorkerId: currentSession.parentWorkerId,
        templateVars: currentSession.templateVars,
        // Preserve the SSH_AUTH_SOCK fallback across conversion.
        sshAuthSockFallback: currentSession.sshAuthSockFallback,
      },
      // Output file was just (re-)initialized by step 8 above, so the
      // file-absolute offset is 0 -- equivalent to fresh creation.
      revived: false,
      createdByUserId: currentSession.createdBy,
    });

    return this.deps.workerManager.toPublicWorker(newWorker);
  }

  /**
   * Restart an embedded-agent worker against the SAME definition it is
   * already running: this is an ordinary restart, not a conversion --
   * `deactivate` then `activate` on the same worker, identical to
   * `restartAllAgentWorkers`'s own embedded-agent arm. Nothing is deleted
   * (no output-file reset, no notification-state clear): the worker's
   * identity, definition, and on-disk conversation are all untouched, and
   * Transcript Restore is what carries the conversation across the
   * deactivate/activate boundary -- exactly as it does for a bulk restart.
   *
   * Reached only from restartAgentWorkerAsEmbedded's dispatch, when the
   * requested `embeddedAgentId` matches the existing worker's own.
   *
   * A branch rename (step 2, before either call) is persisted explicitly and
   * immediately, right after the rename mutates `session.worktreeId` -- it
   * cannot rely on `deactivateEmbeddedAgentWorker` / `activateEmbeddedAgentWorker`
   * to carry it along. `deactivate` is a no-op (no persist) when the worker
   * is not currently activated (`worker.subprocess === null` --
   * `EmbeddedAgentWorkerService.deactivate`'s own guard), and `activate`
   * (via `runActivation`) only persists on its success path -- nothing is
   * persisted if it throws. A dormant worker restarted with a rename would
   * otherwise leave the branch renamed on disk (the git operation already
   * ran, unconditionally, above) while the DB row still held the old name.
   * Beyond the rename, no explicit `persistSession` call is needed here:
   * both `deactivateEmbeddedAgentWorker` (via its exit observer,
   * `handleExit`) and `activateEmbeddedAgentWorker` (via `runActivation`'s
   * success path) already call `persistSession` internally for their own
   * state, on their own completion paths -- see
   * `EmbeddedAgentWorkerService.handleExit` / `.runActivation`.
   */
  private async restartEmbeddedWorkerSameDefinition(
    sessionId: string,
    workerId: string,
    branch?: string,
  ): Promise<Worker | null> {
    const session = this.deps.getSession(sessionId);
    if (!session) return null;

    const existingWorker = session.workers.get(workerId);
    if (!existingWorker || existingWorker.type !== 'embedded-agent') return null;

    // Handle branch rename if requested (must happen before restart) --
    // identical block to the sibling methods'.
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

      // Update git-diff workers' base commit after successful branch rename.
      // This is a secondary concern - failure should not abort the restart.
      try {
        await this.updateGitDiffWorkersAfterBranchRename(sessionId);
      } catch (err) {
        logger.error(
          { sessionId, err },
          'Failed to update git-diff workers after branch rename'
        );
      }

      // Persist the rename explicitly, before deactivate/activate: a
      // dormant worker's deactivate() is a no-op (nothing to persist) and
      // activate() only persists on its own success path, so neither call
      // can be relied on to carry this mutation -- see the method doc
      // comment above for the full reasoning. The rename must be durable
      // even if activation below throws.
      await this.deps.persistSession(session);
    }

    await this.deps.deactivateEmbeddedAgentWorker(sessionId, workerId);
    await this.deps.activateEmbeddedAgentWorker(sessionId, workerId);

    // Re-fetch defensively: deactivate/activate are async and could in
    // principle span a session deletion. Both no-op gracefully on a missing
    // session/worker (nothing new was created here to clean up), so a
    // missing session/worker at this point is treated the same way as every
    // other "vanished mid-flight" branch in this file: return null.
    const currentSession = this.deps.getSession(sessionId);
    const currentWorker = currentSession?.workers.get(workerId);
    if (!currentSession || !currentWorker || currentWorker.type !== 'embedded-agent') {
      logger.warn(
        { sessionId, workerId },
        'Session or worker vanished during same-definition embedded-agent restart'
      );
      return null;
    }

    // Unlike a definition switch (embeddedAgentId did not change here),
    // there is no type/identity change to force a broadcast for -- only
    // fire onSessionUpdated when the branch actually changed, mirroring
    // restartAgentWorker's own hasBranchChange gate.
    const hasBranchChange = branch !== undefined && session.type === 'worktree';
    if (hasBranchChange) {
      this.deps.getSessionLifecycleCallbacks()?.onSessionUpdated?.(this.deps.toPublicSession(currentSession));
    }

    // Always notify that worker was restarted, regardless of branch change
    // -- the client needs this to reset its chat state / reconnect even
    // though the type/id/definition did not change.
    const activityState = this.getWorkerActivityState(sessionId, workerId) ?? 'unknown';
    this.deps.getSessionLifecycleCallbacks()?.onWorkerRestarted?.(sessionId, workerId, activityState);

    logger.info(
      { workerId, sessionId, embeddedAgentId: currentWorker.embeddedAgentId, branch },
      'Embedded-agent worker restarted (same definition)'
    );

    return this.deps.workerManager.toPublicWorker(currentWorker);
  }

  /**
   * Restart an embedded-agent worker AS a DIFFERENT embedded-agent
   * definition: same worker slot/tab, same `workerId`, but the definition
   * (and therefore engine/provider) it runs against changes. This IS a
   * conversion (unlike restartEmbeddedWorkerSameDefinition): the old
   * definition's conversation must not leak into the new one, mirroring
   * restartAgentWorkerAsEmbedded's PTY->embedded conversion discipline, just
   * with an embedded source instead of a PTY one.
   *
   * Reached only from restartAgentWorkerAsEmbedded's dispatch, when the
   * requested `embeddedAgentId` differs from the existing worker's own.
   *
   * Call order:
   *   1. Resolve + validate the NEW definition FIRST, before touching
   *      anything -- an unknown embeddedAgentId must leave the existing
   *      worker completely untouched.
   *   2. Branch rename (identical block to the sibling methods').
   *   3. Capture `existingWorker.autoCompaction` and
   *      `existingWorker.deliverInitialPromptOnActivation` BEFORE teardown --
   *      needed after the new worker object is constructed. autoCompaction
   *      (R3) is the ONE field that DOES carry over across a definition
   *      switch: it is the worker's own toggle, a user preference, not a
   *      property of the definition -- unlike model/reasoningEffort/
   *      contextWindowTokens, which never carry over (always a different
   *      definition, agent-surface.md Ruling 3 precedent).
   *   4. Resolve the path resolver before the destructive teardown --
   *      getPathResolver can throw for an orphaned session.
   *   5. Gracefully deactivate the existing embedded-agent worker (shutdown
   *      -> SIGTERM -> SIGKILL, token revocation) -- NOT killWorker.
   *   6. Delete the output file (content AND manifest): the OLD definition's
   *      NDJSON log must not leak into the new definition's "first-ever
   *      activation" check -- an `openai-api` reconstruction would seed the
   *      new definition with the old definition's conversation and tool
   *      schema, and a `claude-sdk` one has no session to resume anyway
   *      (R3). NON-FATAL, same reasoning as the sibling methods.
   *   7. Clear NotificationManager's per-worker state for this identity.
   *   8. Initialize the new embedded-agent worker for the NEW definition
   *      (identity fields: same workerId, original createdAt, regenerated
   *      name, carried-over deliverInitialPromptOnActivation, no
   *      model/reasoningEffort/contextWindowTokens override -- always a
   *      different definition). `initializeEmbeddedAgentWorker` hardcodes
   *      `autoCompaction: true` for every new worker; immediately overwrite
   *      it with the captured pre-teardown value (step 3) -- the ONE
   *      post-construction override this method needs. `sdkSessionId` stays
   *      `null` (already the default from `initializeEmbeddedAgentWorker`,
   *      no action needed -- there is no session to resume across a
   *      definition switch).
   *   9. Re-check the session still exists (async-gap TOCTOU guard). Nothing
   *      to kill on the deleted-session branch: the new embedded worker was
   *      never activated (no subprocess spawned, no MCP token minted).
   *   10. Persist.
   *   11. onSessionUpdated -- fired UNCONDITIONALLY: the definition changed,
   *       which is a user-visible identity change, regardless of whether
   *       branch also changed (same reasoning as restartAgentWorkerAsEmbedded).
   *   12. onWorkerRestarted.
   *   13. Activate the new embedded-agent worker immediately (unlike
   *       restartEmbeddedWorkerAsAgent, which activates a PTY worker --
   *       this activates via the SAME dep restartAgentWorkerAsEmbedded uses
   *       for its own PTY->embedded conversion). If this throws, it
   *       propagates to the caller as-is: the worker stays persisted as a
   *       dormant embedded-agent worker under the NEW definition, never
   *       reverted to the old one.
   */
  private async restartEmbeddedWorkerAsDifferentEmbedded(
    sessionId: string,
    workerId: string,
    embeddedAgentId: string,
    branch?: string,
  ): Promise<Worker | null> {
    const session = this.deps.getSession(sessionId);
    if (!session) return null;

    const existingWorker = session.workers.get(workerId);
    if (!existingWorker || existingWorker.type !== 'embedded-agent') return null;

    // Resolve and validate the NEW embedded-agent definition FIRST, before
    // touching anything.
    const embeddedAgentDefinition = this.deps.embeddedAgentManager.getEmbeddedAgent(embeddedAgentId);
    if (!embeddedAgentDefinition) {
      throw new ValidationError(`Embedded agent definition not found: ${embeddedAgentId}`);
    }

    // Handle branch rename if requested (must happen before restart) --
    // identical block to the sibling methods'.
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

      // Update git-diff workers' base commit after successful branch rename.
      // This is a secondary concern - failure should not abort the restart.
      try {
        await this.updateGitDiffWorkersAfterBranchRename(sessionId);
      } catch (err) {
        logger.error(
          { sessionId, err },
          'Failed to update git-diff workers after branch rename'
        );
      }
    }

    // Capture worker metadata before tearing down.
    const workerName = this.generateWorkerName(session, 'embedded-agent', undefined, embeddedAgentDefinition.name);
    const workerCreatedAt = existingWorker.createdAt;
    // R3: autoCompaction is the worker's own toggle (a user preference), not
    // a property of the definition -- it survives a definition switch, unlike
    // every other override field below. Captured before teardown; re-applied
    // after initializeEmbeddedAgentWorker's own hardcoded default (see step 8).
    const autoCompaction = existingWorker.autoCompaction;
    const deliverInitialPromptOnActivation = existingWorker.deliverInitialPromptOnActivation;

    // Resolve the path resolver before tearing down anything.
    const resolver = this.deps.getPathResolver(session);

    // Gracefully deactivate the existing embedded-agent worker (shutdown ->
    // SIGTERM -> SIGKILL, token revocation) -- NOT killWorker.
    await this.deps.deactivateEmbeddedAgentWorker(sessionId, workerId);

    // Delete the output file (content AND manifest): the OLD definition's
    // NDJSON log must not leak into the new definition's "first-ever
    // activation" check (R3) -- an openai-api reconstruction would seed the
    // new definition with the old definition's conversation and tool schema,
    // and a claude-sdk one has no session to resume across a definition
    // switch anyway. NON-FATAL: the worker is already torn down, so a
    // failure here must not abort the conversion.
    try {
      await this.deps.workerOutputFileManager.deleteWorkerOutput(sessionId, workerId, resolver);
    } catch (err) {
      logger.warn(
        { sessionId, workerId, err },
        'Failed to delete embedded-agent worker output before definition-switch conversion; continuing',
      );
    }

    // Clear any per-worker notification state left over from the old
    // definition's side of this identity, before the replacement is created.
    this.deps.notificationManager?.cleanupWorker(sessionId, workerId);

    // Create the new embedded-agent worker with the same id, preserving
    // original createdAt for tab order.
    const newWorker = this.deps.workerManager.initializeEmbeddedAgentWorker({
      id: workerId,
      name: workerName,
      createdAt: workerCreatedAt,
      embeddedAgentId,
      // Eligibility carries over unchanged across conversion -- it is a
      // property of "is this the session's initial worker", which
      // conversion does not change. NOT recomputed.
      deliverInitialPromptOnActivation,
      // No model/reasoningEffort/contextWindowTokens carry-over: always a
      // conversion to a different definition (agent-surface.md Ruling 3).
    });
    // initializeEmbeddedAgentWorker hardcodes autoCompaction: true for every
    // new worker; R3 requires it be PRESERVED across a definition switch
    // (the worker's own toggle, not a definition property) -- overwrite the
    // default with the value captured before teardown.
    newWorker.autoCompaction = autoCompaction;
    // sdkSessionId stays null (already initializeEmbeddedAgentWorker's
    // default) -- there is no session to resume across a definition switch,
    // so no explicit reset is needed here.

    // Re-check session still exists after the async gap above. Nothing to
    // kill here on the deleted-session branch: the new embedded worker was
    // never activated (no subprocess spawned, no MCP token minted).
    const currentSession = this.deps.getSession(sessionId);
    if (!currentSession) {
      logger.warn(
        { sessionId, workerId },
        'Session deleted during worker restart, discarding new embedded-agent worker'
      );
      return null;
    }

    currentSession.workers.set(workerId, newWorker);
    await this.deps.persistSession(currentSession);

    // Unlike a same-definition restart, the definition changed -- a
    // user-visible identity change -- so this ALWAYS notifies, regardless of
    // whether branch also changed.
    this.deps.getSessionLifecycleCallbacks()?.onSessionUpdated?.(this.deps.toPublicSession(currentSession));

    // Always notify that worker was restarted (closes old connections
    // client-side).
    const activityState = this.getWorkerActivityState(sessionId, workerId) ?? 'unknown';
    this.deps.getSessionLifecycleCallbacks()?.onWorkerRestarted?.(sessionId, workerId, activityState);

    logger.info(
      { workerId, sessionId, embeddedAgentId, previousEmbeddedAgentId: existingWorker.embeddedAgentId, branch },
      'Embedded-agent worker converted to a different embedded-agent definition via restart'
    );

    // Activate immediately -- don't leave the converted worker dormant. If
    // this throws, it propagates to the caller: the worker stays persisted
    // as a dormant embedded-agent worker under the NEW definition (already
    // flipped above), never reverted to the old one.
    await this.deps.activateEmbeddedAgentWorker(sessionId, workerId);

    return this.deps.workerManager.toPublicWorker(newWorker);
  }

  /**
   * Re-push git-diff workers' diff after a branch rename.
   *
   * In the spec-based model the persisted base *spec* is
   * branch-agnostic and re-resolves to the moving fork point on every diff, so
   * a branch rename does NOT require freezing a new base hash. We keep each
   * worker's `baseCommit` spec unchanged and fire `onDiffBaseCommitChanged`
   * (passing the spec) so connected clients receive a freshly re-resolved diff.
   *
   * Does NOT persist the session - callers are responsible for persistence.
   */
  async updateGitDiffWorkersAfterBranchRename(sessionId: string): Promise<void> {
    const session = this.deps.getSession(sessionId);
    if (!session) return;

    for (const worker of session.workers.values()) {
      if (worker.type !== 'git-diff') continue;

      // Spec stays unchanged; re-push so the diff re-resolves against the new branch.
      this.deps.getSessionLifecycleCallbacks()?.onDiffBaseCommitChanged?.(
        sessionId, worker.id, worker.baseCommit
      );
    }
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
        errorCode: 'SESSION_DELETED',
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

    // Non-PTY workers (git-diff, embedded-agent) don't need PTY restoration
    if (!isInternalPtyWorker(existingWorker)) {
      return {
        success: false,
        errorCode: 'WORKER_NOT_FOUND',
        message: 'This worker type does not support PTY restoration',
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
      const repositoryEnvVars = await this.deps.getRepositoryEnvVars(sessionId);
      const repositoryId = session.type === 'worktree' ? session.repositoryId : undefined;
      const resolver = this.deps.getPathResolver(session);
      const username = await this.deps.resolveSpawnUsername(session.createdBy);

      if (existingWorker.type === 'agent') {
        const effectiveAgentId = this.resolveEffectiveAgentId(existingWorker.agentId, { sessionId, workerId });
        // Reviving an already-existing worker (not a fresh start): the
        // conversation always continues, same as getAvailableWorker / resume.
        const startupIntent = resolveStartupIntent('continue', {
          deliverInitialPromptOnActivation: existingWorker.deliverInitialPromptOnActivation,
          initialPrompt: session.initialPrompt,
          initialPromptDelivered: session.initialPromptDelivered,
        });
        await this.deps.workerManager.activateAgentWorkerPty(existingWorker, {
          sessionId,
          locationPath: session.locationPath,
          repositoryEnvVars,
          username,
          resolver,
          agentId: effectiveAgentId,
          startupIntent,
          repositoryId,
          context: {
            parentSessionId: session.parentSessionId,
            parentWorkerId: session.parentWorkerId,
            templateVars: session.templateVars,
            // Re-emit the SSH_AUTH_SOCK fallback on restore.
            sshAuthSockFallback: session.sshAuthSockFallback,
          },
          revived: true,
          createdByUserId: session.createdBy,
        });
      } else {
        await this.deps.workerManager.activateTerminalWorkerPty(existingWorker, {
          sessionId,
          locationPath: session.locationPath,
          repositoryEnvVars,
          username,
          resolver,
          revived: true,
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

    // Broadcast session-updated so clients learn the activationState changed (e.g., hibernated -> running)
    this.deps.getSessionLifecycleCallbacks()?.onSessionUpdated?.(this.deps.toPublicSession(session));

    return { success: true, worker: existingWorker, wasRestored: true };
  }

  // ========== Worker I/O Delegation ==========

  /**
   * Attach callbacks for a WebSocket connection to a worker.
   * Supports multiple concurrent connections (e.g., multiple browser tabs).
   * Accepts any stream worker (PTY or embedded-agent); git-diff workers are
   * excluded since they don't expose the shared stream shape.
   * @returns Connection ID for later detachment, or null if worker not found
   */
  attachWorkerCallbacks(sessionId: string, workerId: string, callbacks: WorkerCallbacks): string | null {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || !isStreamWorker(worker)) return null;

    return this.deps.workerManager.attachCallbacks(worker, callbacks);
  }

  /**
   * Detach callbacks for a specific WebSocket connection.
   * @param connectionId The connection ID returned by attachWorkerCallbacks
   */
  detachWorkerCallbacks(sessionId: string, workerId: string, connectionId: string): boolean {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || !isStreamWorker(worker)) return false;

    return this.deps.workerManager.detachCallbacks(worker, connectionId);
  }

  writeWorkerInput(sessionId: string, workerId: string, data: string): boolean {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || !isInternalPtyWorker(worker)) return false;

    return this.deps.workerManager.writeInput(worker, data);
  }

  resizeWorker(sessionId: string, workerId: string, cols: number, rows: number): boolean {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || !isInternalPtyWorker(worker)) return false;

    return this.deps.workerManager.resize(worker, cols, rows);
  }

  getWorkerOutputBuffer(sessionId: string, workerId: string): string {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || !isInternalPtyWorker(worker)) return '';
    return this.deps.workerManager.getOutputBuffer(worker);
  }

  getWorkerActivityState(sessionId: string, workerId: string): AgentActivityState | undefined {
    const worker = this.getWorker(sessionId, workerId);
    if (worker?.type === 'agent') {
      return this.deps.workerManager.getActivityState(worker);
    }
    // Embedded-agent workers carry activityState directly (loop-emitted, not
    // ActivityDetector-derived) — see worker-types.ts InternalEmbeddedAgentWorker.
    if (worker?.type === 'embedded-agent') {
      return worker.activityState;
    }
    return undefined;
  }

  /**
   * Get worker output history from file with optional offset for incremental sync.
   * @param sessionId Session ID
   * @param workerId Worker ID
   * @param fromOffset If specified, return only data after this absolute offset
   * @param maxLines Recent-window line cap: the initial-load limit when fromOffset
   *   is 0/undefined, and the fallback cap for the archived-out / stale branches
   *   of an incremental read (§3.1)
   * @returns History data and absolute offsets, or null if not available
   */
  async getWorkerOutputHistory(
    sessionId: string,
    workerId: string,
    fromOffset?: number,
    maxLines?: number
  ): Promise<HistoryReadResult | null> {
    const session = this.deps.getSession(sessionId);
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return null;

    const resolver = await this.resolveOutputResolver(sessionId, session);
    if (!resolver) {
      // No valid scope available — treat as no history.
      // Never silently fall back to _quick/ (see design §2).
      return null;
    }

    // embedded-agent has no client-side history-range paging in v1
    // (embedded-agent-store.ts:639-641) -- the initial window IS the whole
    // story for that client, so it must be archive-aware. PTY/terminal
    // workers page backward themselves via requestOlderHistory() ->
    // readHistoryRange, so their live-only initial window is sufficient (see
    // terminal-store.ts's sendRangeRequest / request-history-range). This
    // branch should be revisited (become capability-based rather than
    // type-based) if/when R4's paging-parity follow-up lands for
    // embedded-agent (#1506).
    if (worker.type === 'embedded-agent' && maxLines !== undefined) {
      return this.deps.workerOutputFileManager.readHistoryForDisplay(sessionId, workerId, resolver, maxLines, fromOffset);
    }

    // Use line-limited read for initial connection (fromOffset is 0 or undefined)
    if (maxLines !== undefined && (fromOffset === undefined || fromOffset === 0)) {
      return this.deps.workerOutputFileManager.readLastNLines(sessionId, workerId, maxLines, resolver);
    }

    return this.deps.workerOutputFileManager.readHistoryWithOffset(sessionId, workerId, resolver, fromOffset, maxLines);
  }

  /**
   * Serve a backwards history range (§5.1). Returns the bytes ending strictly
   * before `beforeOffset`, clamped to one storage unit and the server cap.
   * Returns null for missing / git-diff workers or when no output scope is
   * available (treated as no history by the caller).
   */
  async getWorkerHistoryRange(
    sessionId: string,
    workerId: string,
    beforeOffset: number,
    maxBytes?: number,
  ): Promise<HistoryRangeResult | null> {
    const session = this.deps.getSession(sessionId);
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return null;

    const resolver = await this.resolveOutputResolver(sessionId, session);
    if (!resolver) return null;

    return this.deps.workerOutputFileManager.readHistoryRange(sessionId, workerId, resolver, beforeOffset, maxBytes);
  }

  /**
   * Get the current generation epoch for a worker (in-memory incarnation tag).
   * Used to stamp history responses assembled from the in-memory buffer or the
   * empty/timeout fallbacks, which do not read the manifest. Returns null for
   * missing or git-diff workers.
   */
  getWorkerEpoch(sessionId: string, workerId: string): number | null {
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return null;
    return worker.epoch;
  }

  /**
   * Get current output offset for a worker.
   * Used to mark the boundary before registering callbacks.
   * @returns Current file offset (0 if file doesn't exist or scope is missing)
   */
  async getCurrentOutputOffset(sessionId: string, workerId: string): Promise<number> {
    const session = this.deps.getSession(sessionId);
    const worker = this.getWorker(sessionId, workerId);
    if (!worker || worker.type === 'git-diff') return 0;

    const resolver = await this.resolveOutputResolver(sessionId, session);
    if (!resolver) {
      // Scope missing — do not fall back to _quick/. Return 0 and log.
      logger.warn({ sessionId, workerId }, 'No valid scope to resolve output offset; returning 0');
      return 0;
    }
    return this.deps.workerOutputFileManager.getCurrentOffset(sessionId, workerId, resolver);
  }

  /**
   * Resolve a SessionDataPathResolver for an output read operation.
   * Prefers the in-memory session; falls back to DB lookup when the session
   * is not in memory. Returns null when scope cannot be resolved — callers
   * must treat this as "no history" and never default to `_quick/`.
   */
  private async resolveOutputResolver(
    sessionId: string,
    session: InternalSession | undefined,
  ): Promise<SessionDataPathResolver | null> {
    if (session) {
      try {
        return this.deps.getPathResolver(session);
      } catch (err) {
        logger.warn({ sessionId, err }, 'Failed to resolve path for in-memory session');
        return null;
      }
    }
    return this.deps.getPathResolverByPersistedSessionId(sessionId);
  }

  // ========== Private Helpers ==========

  /**
   * Resolve effective agent ID, falling back to default if the original agent is no longer registered.
   */
  private resolveEffectiveAgentId(agentId: string, context: { sessionId: string; workerId: string }): string {
    const agentManager = this.deps.agentManager;
    const agent = agentManager.getAgent(agentId);
    if (agent) return agentId;

    logger.warn({ ...context, originalAgentId: agentId, fallbackAgentId: CLAUDE_CODE_AGENT_ID }, 'Agent no longer valid, falling back to default');
    return CLAUDE_CODE_AGENT_ID;
  }

  private generateWorkerName(
    session: InternalSession,
    type: 'agent' | 'terminal' | 'git-diff' | 'embedded-agent',
    agentId?: string,
    embeddedAgentName?: string,
  ): string {
    if (type === 'agent') {
      const agentManager = this.deps.agentManager;
      const agent = agentId ? agentManager.getAgent(agentId) : undefined;
      return agent?.name ?? 'AI';
    }

    if (type === 'git-diff') {
      return 'Git Diff';
    }

    if (type === 'embedded-agent') {
      // Default to the resolved definition's name (parallel to agent workers),
      // falling back only if the definition is somehow unnamed.
      return embeddedAgentName || 'Embedded Agent';
    }

    const terminalCount = Array.from(session.workers.values())
      .filter((w) => w.type === 'terminal').length;
    return `Terminal ${terminalCount + 1}`;
  }

  /**
   * Clean up worker output file via job queue.
   * Uses the session's persisted `(scope, slug)` pair for the payload.
   * If jobQueue is not available, or scope cannot be resolved, logs a warning
   * and skips cleanup — never falls back to `_quick/`.
   */
  private async cleanupWorkerOutput(sessionId: string, workerId: string, session: InternalSession): Promise<void> {
    const jobQueue = this.deps.getJobQueue();
    if (!jobQueue) {
      logger.warn({ sessionId, workerId }, 'JobQueue not available, skipping async output cleanup');
      return;
    }
    const scopeInfo = this.deps.getSessionScope(session);
    if (!scopeInfo) {
      logger.warn({ sessionId, workerId }, 'Session has no valid scope; skipping worker-output cleanup enqueue');
      return;
    }
    await jobQueue.enqueue(JOB_TYPES.CLEANUP_WORKER_OUTPUT, {
      sessionId,
      workerId,
      scope: scopeInfo.scope,
      slug: scopeInfo.slug,
    });
  }
}
