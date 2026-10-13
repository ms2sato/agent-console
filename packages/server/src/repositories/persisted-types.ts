/**
 * Persisted record shapes for repositories, workers and sessions: the
 * canonical shapes the SQLite repositories, mappers and session services
 * exchange. Types only; no runtime value belongs in this file.
 */

export interface PersistedRepository {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  setupCommand?: string | null;
  cleanupCommand?: string | null;
  envVars?: string | null;
  description?: string | null;
  defaultAgentId?: string | null;
  /**
   * The repository's designated-Orchestrator session set (see docs/design/shared-orchestrator-session.md, "Designation in multi-user").
   * NOT persisted in this legacy JSON shape -- designations live in the
   * `repository_orchestrator_sessions` table (migration v41), populated
   * only through `RepositoryRepository.addOrchestratorSession` /
   * `removeOrchestratorSession`, never through the JSON migration path.
   * Declared here (always `[]`) purely so `PersistedRepository` remains
   * structurally compatible with `Repository`'s now-required field, same
   * rationale as `clonedSourceRepoPath` below.
   */
  orchestratorSessionIds: string[];
  /**
   * Derived field surfaced at serving time. Carries `null` in the persisted
   * JSON record; `withRepositoryRemote` recomputes the value against
   * `getSourceReposDir()` on every read. Kept in the persisted shape
   * (matching `Repository`) so `PersistedRepository` remains structurally
   * compatible with `Repository` for callers that consume the value
   * post-load without explicit enrichment.
   */
  clonedSourceRepoPath: string | null;
}

// Base for all persisted workers
interface PersistedWorkerBase {
  id: string;
  name: string;
  createdAt: string;
}

export interface PersistedAgentWorker extends PersistedWorkerBase {
  type: 'agent';
  agentId: string;
  pid: number | null;  // PTY process ID (null when not yet activated after server restart)
  /** See `InternalAgentWorker.deliverInitialPromptOnActivation`. */
  deliverInitialPromptOnActivation: boolean;
  /** See `InternalAgentWorker.model`. */
  model: string | null;
  /** See `InternalAgentWorker.reasoningEffort`. */
  reasoningEffort: string | null;
  /** See `InternalAgentWorker.sdkSessionId`. */
  sdkSessionId: string | null;
}

export interface PersistedTerminalWorker extends PersistedWorkerBase {
  type: 'terminal';
  pid: number | null;  // PTY process ID (null when not yet activated after server restart)
}

export interface PersistedGitDiffWorker extends PersistedWorkerBase {
  type: 'git-diff';
  baseCommit: string;  // No pid - runs in server process
}

export interface PersistedEmbeddedAgentWorker extends PersistedWorkerBase {
  type: 'embedded-agent';
  embeddedAgentId: string;
  pid: number | null;  // agent subprocess PID (null when not activated)
  /** See `InternalEmbeddedAgentWorker.deliverInitialPromptOnActivation`. */
  deliverInitialPromptOnActivation: boolean;
  /**
   * See `InternalEmbeddedAgentWorker.sdkSessionId`. This field's MEANING is
   * wider than its name suggests: provider-side conversation
   * id, SDK-assigned (read-only) for this (embedded-agent) worker kind, but
   * console-minted (we assign it) for terminal `agent` workers -- see
   * `PersistedAgentWorker.sdkSessionId`, the sibling field for that kind.
   */
  sdkSessionId: string | null;
  /** See `InternalEmbeddedAgentWorker.autoCompaction`. */
  autoCompaction: boolean;
  /** See `InternalEmbeddedAgentWorker.model`. */
  model: string | null;
  /** See `InternalEmbeddedAgentWorker.reasoningEffort`. */
  reasoningEffort: string | null;
  /** See `InternalEmbeddedAgentWorker.contextWindowTokens`. */
  contextWindowTokens: number | null;
}

export type PersistedWorker =
  | PersistedAgentWorker
  | PersistedTerminalWorker
  | PersistedGitDiffWorker
  | PersistedEmbeddedAgentWorker;

interface PersistedSessionBase {
  id: string;
  locationPath: string;
  /**
   * Server process ID that owns this session.
   * - undefined: no update (when used in Partial<PersistedSession>)
   * - null: explicitly cleared (paused session, not owned by any server)
   * - number: owned by the server with this PID
   */
  serverPid?: number | null;
  createdAt: string;
  workers: PersistedWorker[];
  initialPrompt?: string;
  /** See `InternalSessionBase.initialPromptDelivered`. */
  initialPromptDelivered?: boolean;
  title?: string;
  /** ISO 8601 timestamp when session was paused (undefined = not paused) */
  pausedAt?: string;
  /** Parent session ID that delegated this session */
  parentSessionId?: string;
  /** Parent worker ID that delegated this session */
  parentWorkerId?: string;
  /** User UUID (from users table) of the user who created this session */
  createdBy?: string;
  /**
   * User UUID (from users table) of the authenticated user who actually
   * created this session. For shared sessions this differs from createdBy
   * (which is the shared account). For personal sessions it is left
   * undefined (it would equal createdBy).
   */
  initiatedBy?: string;
  /** Scope-based persistence for session data path. Undefined on legacy rows before backfill. */
  dataScope?: 'quick' | 'repository';
  /** Slug for 'repository' scope; null for 'quick'. Undefined before backfill. */
  dataScopeSlug?: string | null;
  /** 'healthy' or 'orphaned'. Undefined defaults to 'healthy' for legacy rows. */
  recoveryState?: 'healthy' | 'orphaned';
  /** Unix epoch ms when marked orphaned. */
  orphanedAt?: number | null;
  /** Machine-readable reason code for orphan. */
  orphanedReason?: string | null;
}

export interface PersistedWorktreeSession extends PersistedSessionBase {
  type: 'worktree';
  repositoryId: string;
  worktreeId: string;
}

export interface PersistedQuickSession extends PersistedSessionBase {
  type: 'quick';
}

export type PersistedSession = PersistedWorktreeSession | PersistedQuickSession;
