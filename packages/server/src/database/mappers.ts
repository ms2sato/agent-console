import type { AgentDefinition, Repository, AgentActivityPatterns, MessageTemplate, EmbeddedAgentDefinition, EmbeddedAgentToolName, Artifact, Bookmark } from '@agent-console/shared';
import type { ArtifactRecord } from '../repositories/artifact-repository.js';
import type { BookmarkRecord } from '../repositories/bookmark-repository.js';
import { computeCapabilities } from '@agent-console/shared';
import type { NewSession, NewWorker, Session, Worker, NewRepository, RepositoryRow, NewAgent, AgentRow, MessageTemplateRow, NewEmbeddedAgent, EmbeddedAgentRow, ArtifactRow, BookmarkRow } from './schema.js';
import type {
  PersistedSession,
  PersistedWorker,
  PersistedAgentWorker,
  PersistedTerminalWorker,
  PersistedGitDiffWorker,
  PersistedEmbeddedAgentWorker,
  PersistedWorktreeSession,
  PersistedQuickSession,
  PersistedRepository,
} from '../services/persistence-service.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('database-mappers');

/**
 * Helper function for exhaustive type checking in discriminated unions.
 * Calling this function in a switch/if-else default case ensures that all
 * possible types have been handled at compile time.
 *
 * @param x - The value that should be of type `never` if all cases are handled
 * @param message - Optional context for the error message
 * @throws Error if called at runtime, indicating an unhandled case
 */
export function assertNever(x: never, message?: string): never {
  const context = message ? `${message}: ` : '';
  throw new Error(`${context}Unexpected value: ${JSON.stringify(x)}`);
}

/**
 * Error thrown when database data is corrupted or missing required fields.
 * Provides context about which field is missing and on which entity.
 */
export class DataIntegrityError extends Error {
  constructor(
    public readonly entityType: 'session' | 'worker' | 'embedded-agent',
    public readonly entityId: string,
    public readonly issue: string
  ) {
    super(
      `Data integrity error: ${entityType} '${entityId}' has invalid ${issue}`
    );
    this.name = 'DataIntegrityError';
  }
}

/**
 * Convert a persisted session to a database row for insertion.
 *
 * @param session - The session to convert
 * @returns Database row ready for insertion
 */
export function toSessionRow(session: PersistedSession): NewSession {
  // Validate (scope, slug) combination at the boundary. Legacy rows
  // (dataScope undefined) are accepted as-is; orphan detection runs
  // separately at startup.
  if (session.dataScope === 'quick') {
    if (session.dataScopeSlug !== null && session.dataScopeSlug !== undefined) {
      throw new DataIntegrityError(
        'session',
        session.id,
        'dataScopeSlug must be null for quick scope'
      );
    }
  } else if (session.dataScope === 'repository') {
    if (
      session.dataScopeSlug === null ||
      session.dataScopeSlug === undefined ||
      session.dataScopeSlug === ''
    ) {
      throw new DataIntegrityError(
        'session',
        session.id,
        'dataScopeSlug required for repository scope'
      );
    }
  }

  const now = new Date().toISOString();
  const base = {
    id: session.id,
    type: session.type,
    location_path: session.locationPath,
    server_pid: session.serverPid ?? null,
    created_at: session.createdAt,
    updated_at: now,
    initial_prompt: session.initialPrompt ?? null,
    initial_prompt_delivered: session.initialPromptDelivered === undefined ? null : (session.initialPromptDelivered ? 1 : 0),
    title: session.title ?? null,
    paused_at: session.pausedAt ?? null,
    parent_session_id: session.parentSessionId ?? null,
    parent_worker_id: session.parentWorkerId ?? null,
    created_by: session.createdBy ?? null,
    initiated_by: session.initiatedBy ?? null,
    data_scope: session.dataScope ?? null,
    data_scope_slug: session.dataScopeSlug ?? null,
    // recovery_state has a DB-level DEFAULT 'healthy' but we write it
    // explicitly so round-tripping a PersistedSession is lossless.
    recovery_state: session.recoveryState ?? 'healthy',
    orphaned_at: session.orphanedAt ?? null,
    orphaned_reason: session.orphanedReason ?? null,
  };

  if (session.type === 'worktree') {
    return {
      ...base,
      repository_id: session.repositoryId,
      worktree_id: session.worktreeId,
    };
  } else if (session.type === 'quick') {
    return {
      ...base,
      repository_id: null,
      worktree_id: null,
    };
  } else {
    return assertNever(session, `Unknown session type for session ${base.id}`);
  }
}

/**
 * Convert a persisted worker to a database row for insertion.
 *
 * @param worker - The worker to convert
 * @param sessionId - The session ID this worker belongs to
 * @returns Database row ready for insertion
 */
export function toWorkerRow(worker: PersistedWorker, sessionId: string): NewWorker {
  const now = new Date().toISOString();
  const base = {
    id: worker.id,
    session_id: sessionId,
    type: worker.type,
    name: worker.name,
    created_at: worker.createdAt,
    updated_at: now,
  };

  if (worker.type === 'agent') {
    return {
      ...base,
      pid: worker.pid ?? null,
      agent_id: worker.agentId,
      base_commit: null,
      embedded_agent_id: null,
      deliver_initial_prompt_on_activation: worker.deliverInitialPromptOnActivation ? 1 : 0,
    };
  } else if (worker.type === 'terminal') {
    return {
      ...base,
      pid: worker.pid ?? null,
      agent_id: null,
      base_commit: null,
      embedded_agent_id: null,
      deliver_initial_prompt_on_activation: null,
    };
  } else if (worker.type === 'git-diff') {
    return {
      ...base,
      pid: null,
      agent_id: null,
      base_commit: worker.baseCommit,
      embedded_agent_id: null,
      deliver_initial_prompt_on_activation: null,
    };
  } else if (worker.type === 'embedded-agent') {
    return {
      ...base,
      pid: worker.pid ?? null,
      agent_id: null,
      base_commit: null,
      embedded_agent_id: worker.embeddedAgentId,
      deliver_initial_prompt_on_activation: worker.deliverInitialPromptOnActivation ? 1 : 0,
      sdk_session_id: worker.sdkSessionId,
    };
  } else {
    return assertNever(worker, `Unknown worker type for worker ${base.id}`);
  }
}

/**
 * Valid worker types. Used for runtime validation of database values.
 */
const VALID_WORKER_TYPES = ['agent', 'terminal', 'git-diff', 'embedded-agent'] as const;

/**
 * Convert a database worker row to a persisted worker.
 * Validates that required fields are present based on worker type.
 *
 * @param worker - The database worker row
 * @returns The persisted worker
 * @throws DataIntegrityError if required fields are missing or type is invalid
 */
export function toPersistedWorker(worker: Worker): PersistedWorker {
  // Validate type at runtime before the switch
  // Database 'type' column is text, so corruption could result in unexpected values
  if (!VALID_WORKER_TYPES.includes(worker.type as (typeof VALID_WORKER_TYPES)[number])) {
    throw new DataIntegrityError('worker', worker.id, `type (unexpected value: ${worker.type})`);
  }

  if (worker.type === 'agent') {
    if (worker.agent_id === null || worker.agent_id === undefined) {
      throw new DataIntegrityError('worker', worker.id, 'agent_id (missing required field)');
    }
    return {
      id: worker.id,
      type: 'agent',
      name: worker.name,
      createdAt: worker.created_at,
      pid: worker.pid ?? null,
      agentId: worker.agent_id,
      deliverInitialPromptOnActivation: worker.deliver_initial_prompt_on_activation === 1,
    } as PersistedAgentWorker;
  } else if (worker.type === 'terminal') {
    return {
      id: worker.id,
      type: 'terminal',
      name: worker.name,
      createdAt: worker.created_at,
      pid: worker.pid ?? null,
    } as PersistedTerminalWorker;
  } else if (worker.type === 'git-diff') {
    if (worker.base_commit === null || worker.base_commit === undefined) {
      throw new DataIntegrityError('worker', worker.id, 'base_commit (missing required field)');
    }
    return {
      id: worker.id,
      type: 'git-diff',
      name: worker.name,
      createdAt: worker.created_at,
      baseCommit: worker.base_commit,
    } as PersistedGitDiffWorker;
  } else if (worker.type === 'embedded-agent') {
    if (worker.embedded_agent_id === null || worker.embedded_agent_id === undefined) {
      throw new DataIntegrityError('worker', worker.id, 'embedded_agent_id (missing required field)');
    }
    return {
      id: worker.id,
      type: 'embedded-agent',
      name: worker.name,
      createdAt: worker.created_at,
      pid: worker.pid ?? null,
      embeddedAgentId: worker.embedded_agent_id,
      deliverInitialPromptOnActivation: worker.deliver_initial_prompt_on_activation === 1,
      sdkSessionId: worker.sdk_session_id ?? null,
    } as PersistedEmbeddedAgentWorker;
  } else {
    // This should never be reached due to the validation above,
    // but TypeScript needs this for exhaustive checking
    return assertNever(worker.type as never, `Unknown worker type for worker ${worker.id}`);
  }
}

/**
 * Valid session types. Used for runtime validation of database values.
 */
const VALID_SESSION_TYPES = ['worktree', 'quick'] as const;

/**
 * Convert a database session row and workers to a persisted session.
 * Validates that required fields are present based on session type.
 *
 * @param session - The database session row
 * @param workers - The persisted workers belonging to this session
 * @returns The persisted session
 * @throws DataIntegrityError if required fields are missing or type is invalid
 */
export function toPersistedSession(
  session: Session,
  workers: PersistedWorker[]
): PersistedSession {
  // Validate type at runtime before the switch
  // Database 'type' column is text, so corruption could result in unexpected values
  if (!VALID_SESSION_TYPES.includes(session.type as (typeof VALID_SESSION_TYPES)[number])) {
    throw new DataIntegrityError('session', session.id, `type (unexpected value: ${session.type})`);
  }

  // Validate scope+slug combination at the boundary. Null scope is accepted
  // (legacy row, pre-backfill). Other invalid combinations indicate corruption
  // and must throw rather than silently fall back.
  // Slug grammar (path-traversal etc.) is intentionally NOT checked here —
  // that is runtime's job (orphan detector).
  let dataScope: 'quick' | 'repository' | undefined;
  if (session.data_scope === null || session.data_scope === undefined) {
    dataScope = undefined;
  } else if (session.data_scope === 'quick' || session.data_scope === 'repository') {
    dataScope = session.data_scope;
  } else {
    throw new DataIntegrityError(
      'session',
      session.id,
      `data_scope (unexpected value: ${session.data_scope})`
    );
  }

  if (dataScope === 'quick' && session.data_scope_slug !== null) {
    throw new DataIntegrityError(
      'session',
      session.id,
      'inconsistent scope+slug combination (quick scope must have null slug)'
    );
  }
  if (
    dataScope === 'repository' &&
    (session.data_scope_slug === null || session.data_scope_slug === '')
  ) {
    throw new DataIntegrityError(
      'session',
      session.id,
      'inconsistent scope+slug combination (repository scope requires non-empty slug)'
    );
  }

  const dataScopeSlug: string | null | undefined =
    session.data_scope_slug === null ? null : session.data_scope_slug ?? undefined;

  // Validate recovery_state. Null treated as 'healthy' (legacy row).
  let recoveryState: 'healthy' | 'orphaned';
  if (
    session.recovery_state === null ||
    session.recovery_state === undefined ||
    session.recovery_state === 'healthy'
  ) {
    recoveryState = 'healthy';
  } else if (session.recovery_state === 'orphaned') {
    recoveryState = 'orphaned';
  } else {
    throw new DataIntegrityError(
      'session',
      session.id,
      `recovery_state (unexpected value: ${session.recovery_state})`
    );
  }

  const orphanedAt = session.orphaned_at ?? null;
  const orphanedReason = session.orphaned_reason ?? null;

  if (session.type === 'worktree') {
    if (session.repository_id === null || session.repository_id === undefined) {
      throw new DataIntegrityError('session', session.id, 'repository_id (missing required field)');
    }
    if (session.worktree_id === null || session.worktree_id === undefined) {
      throw new DataIntegrityError('session', session.id, 'worktree_id (missing required field)');
    }
    return {
      id: session.id,
      type: 'worktree',
      locationPath: session.location_path,
      repositoryId: session.repository_id,
      worktreeId: session.worktree_id,
      serverPid: session.server_pid ?? undefined,
      createdAt: session.created_at,
      workers,
      initialPrompt: session.initial_prompt ?? undefined,
      initialPromptDelivered: session.initial_prompt_delivered === null ? undefined : session.initial_prompt_delivered === 1,
      title: session.title ?? undefined,
      pausedAt: session.paused_at ?? undefined,
      parentSessionId: session.parent_session_id ?? undefined,
      parentWorkerId: session.parent_worker_id ?? undefined,
      createdBy: session.created_by ?? undefined,
      initiatedBy: session.initiated_by ?? undefined,
      dataScope,
      dataScopeSlug,
      recoveryState,
      orphanedAt,
      orphanedReason,
    } as PersistedWorktreeSession;
  } else if (session.type === 'quick') {
    return {
      id: session.id,
      type: 'quick',
      locationPath: session.location_path,
      serverPid: session.server_pid ?? undefined,
      createdAt: session.created_at,
      workers,
      initialPrompt: session.initial_prompt ?? undefined,
      initialPromptDelivered: session.initial_prompt_delivered === null ? undefined : session.initial_prompt_delivered === 1,
      title: session.title ?? undefined,
      pausedAt: session.paused_at ?? undefined,
      parentSessionId: session.parent_session_id ?? undefined,
      parentWorkerId: session.parent_worker_id ?? undefined,
      createdBy: session.created_by ?? undefined,
      initiatedBy: session.initiated_by ?? undefined,
      dataScope,
      dataScopeSlug,
      recoveryState,
      orphanedAt,
      orphanedReason,
    } as PersistedQuickSession;
  } else {
    // This should never be reached due to the validation above,
    // but TypeScript needs this for exhaustive checking
    return assertNever(session.type as never, `Unknown session type for session ${session.id}`);
  }
}

// ========== Repository Mappers ==========

/**
 * Convert a persisted repository to a database row for insertion.
 *
 * @param repository - The repository to convert
 * @returns Database row ready for insertion
 */
export function toRepositoryRow(repository: PersistedRepository): NewRepository {
  const now = new Date().toISOString();
  return {
    id: repository.id,
    name: repository.name,
    path: repository.path,
    created_at: repository.createdAt,
    updated_at: now,
    setup_command: repository.setupCommand ?? null,
    cleanup_command: repository.cleanupCommand ?? null,
    env_vars: repository.envVars ?? null,
    description: repository.description ?? null,
    default_agent_id: repository.defaultAgentId ?? null,
  };
}

/**
 * Convert a database repository row to a Repository domain object.
 *
 * @param row - The database repository row
 * @returns The Repository object
 */
export function toRepository(row: RepositoryRow): Repository {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
    setupCommand: row.setup_command ?? null,
    cleanupCommand: row.cleanup_command ?? null,
    envVars: row.env_vars ?? null,
    description: row.description ?? null,
    defaultAgentId: row.default_agent_id ?? null,
    // `clonedSourceRepoPath` is a derived field (not persisted). The serving
    // path (REST / WS) enriches the value via `withRepositoryRemote`; this
    // mapper sets the safe default so the type contract is satisfied at the
    // edges of the persistence layer.
    clonedSourceRepoPath: null,
  };
}

// ========== Agent Mappers ==========

/**
 * Convert an AgentDefinition to a database row for insertion.
 *
 * @param agent - The agent to convert
 * @returns Database row ready for insertion
 */
export function toAgentRow(agent: AgentDefinition): NewAgent {
  const now = new Date().toISOString();
  return {
    id: agent.id,
    name: agent.name,
    command_template: agent.commandTemplate,
    continue_template: agent.continueTemplate ?? null,
    headless_template: agent.headlessTemplate ?? null,
    description: agent.description ?? null,
    is_built_in: agent.isBuiltIn ? 1 : 0,
    created_at: agent.createdAt,
    updated_at: now,
    activity_patterns: agent.activityPatterns ? JSON.stringify(agent.activityPatterns) : null,
    base_agent_id: agent.baseAgentId ?? null,
  };
}

/**
 * Convert a database agent row to an AgentDefinition.
 * Recomputes capabilities from the templates.
 *
 * @param row - The database agent row
 * @returns The AgentDefinition object
 */
export function toAgentDefinition(row: AgentRow): AgentDefinition {
  let activityPatterns: AgentActivityPatterns | undefined;
  if (row.activity_patterns) {
    try {
      activityPatterns = JSON.parse(row.activity_patterns) as AgentActivityPatterns;
    } catch {
      logger.warn({ agentId: row.id }, 'Failed to parse activity_patterns, ignoring');
      activityPatterns = undefined;
    }
  }

  const agentBase = {
    id: row.id,
    name: row.name,
    commandTemplate: row.command_template,
    continueTemplate: row.continue_template ?? undefined,
    headlessTemplate: row.headless_template ?? undefined,
    description: row.description ?? undefined,
    isBuiltIn: row.is_built_in === 1,
    createdAt: row.created_at ?? new Date().toISOString(),
    activityPatterns,
    baseAgentId: row.base_agent_id ?? undefined,
  };

  return {
    ...agentBase,
    capabilities: computeCapabilities(agentBase),
  };
}

// ========== Embedded Agent Mappers ==========

/**
 * Convert an EmbeddedAgentDefinition to a database row for insertion.
 * Flattens the nested `provider` object into `provider_*` columns.
 *
 * @param def - The embedded agent definition to convert
 * @returns Database row ready for insertion
 */
export function toEmbeddedAgentRow(def: EmbeddedAgentDefinition): NewEmbeddedAgent {
  return {
    id: def.id,
    name: def.name,
    description: def.description ?? null,
    engine: def.engine,
    // openai-api writes its real baseUrl; claude-sdk writes null -- no
    // provider secret crosses the server for that engine (SDK Engine Phase
    // 1, docs/design/embedded-agent-sdk-engine.md §3.2). Both engines write
    // provider_model (every engine carries a model).
    provider_base_url: def.engine === 'openai-api' ? def.provider.baseUrl : null,
    provider_model: def.provider.model,
    provider_api_key_ref: def.engine === 'openai-api' ? (def.provider.apiKeyRef ?? null) : null,
    system_prompt: def.systemPrompt ?? null,
    max_tool_iterations: def.maxToolIterations ?? null,
    enabled_tools: def.enabledTools !== undefined ? JSON.stringify(def.enabledTools) : null,
    instructions: def.instructions !== undefined ? JSON.stringify(def.instructions) : null,
    context_window_tokens: def.contextWindowTokens ?? null,
    handoff_soft_ratio: def.handoff?.softRatio ?? null,
    handoff_hard_ratio: def.handoff?.hardRatio ?? null,
    handoff_auto: def.handoff?.auto !== undefined ? (def.handoff.auto ? 1 : 0) : null,
    is_built_in: def.isBuiltIn ? 1 : 0,
    created_by: def.createdBy,
    created_at: def.createdAt,
    updated_at: def.updatedAt,
  };
}

/**
 * Parse a nullable JSON-array-string embedded-agent column (`enabled_tools`,
 * `instructions`) into a typed array. This is the only boundary where DB
 * content becomes a typed policy value, so both failure modes are guarded
 * and treated the same as a NULL column (warn + fall back to `undefined`):
 * the string not being valid JSON at all, and the JSON parsing successfully
 * to a non-array value (e.g. `'"foo"'` or `'{}'`) that would otherwise
 * silently misbehave when a caller iterates it as an array.
 */
function parseEmbeddedAgentJsonArrayColumn<T>(
  value: string | null,
  embeddedAgentId: string,
  fieldName: 'enabled_tools' | 'instructions'
): T[] | undefined {
  if (value === null) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      logger.warn({ embeddedAgentId }, `Failed to parse ${fieldName}, ignoring`);
      return undefined;
    }
    return parsed as T[];
  } catch {
    logger.warn({ embeddedAgentId }, `Failed to parse ${fieldName}, ignoring`);
    return undefined;
  }
}

/**
 * Convert a database embedded agent row to an EmbeddedAgentDefinition.
 * Unflattens the `provider_*` columns into the nested `provider` object.
 *
 * @param row - The database embedded agent row
 * @returns The EmbeddedAgentDefinition object
 */
export function toEmbeddedAgentDefinition(row: EmbeddedAgentRow): EmbeddedAgentDefinition {
  // enabledTools / instructions: NULL in DB is the "follow the default" (or
  // "no instructions") signal. Once a definition is edited via the Add/Edit
  // form, it is written as an explicit array (per the Q1 design decision) —
  // this pins the enabled set to the values shown at edit time. Future
  // default changes do NOT propagate to edited definitions.
  const enabledTools = parseEmbeddedAgentJsonArrayColumn<EmbeddedAgentToolName>(
    row.enabled_tools,
    row.id,
    'enabled_tools'
  );
  const instructions = parseEmbeddedAgentJsonArrayColumn<string>(row.instructions, row.id, 'instructions');

  // `handoff` is reconstructed conditionally: unlike `provider` (required,
  // always rebuilt), an all-null triple must yield `undefined`, not `{}`, so
  // an unconfigured definition round-trips to "no handoff config" exactly as
  // it was written.
  const handoff =
    row.handoff_soft_ratio !== null || row.handoff_hard_ratio !== null || row.handoff_auto !== null
      ? {
          softRatio: row.handoff_soft_ratio ?? undefined,
          hardRatio: row.handoff_hard_ratio ?? undefined,
          auto: row.handoff_auto !== null ? row.handoff_auto === 1 : undefined,
        }
      : undefined;

  const base = {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    systemPrompt: row.system_prompt ?? undefined,
    maxToolIterations: row.max_tool_iterations ?? undefined,
    enabledTools,
    instructions,
    contextWindowTokens: row.context_window_tokens ?? undefined,
    handoff,
    isBuiltIn: row.is_built_in === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  // Engine/provider-shape consistency guard (SDK Engine Phase 1, consulted
  // with the Architect 2026-08-17): `engine` and `provider_base_url` must
  // agree, mirroring the `dataScope`/`dataScopeSlug` consistency checks
  // above (`toSessionRow`/`toPersistedSession`). A row failing this check is
  // corrupted data, not a recoverable shape -- throw rather than silently
  // picking an arm.
  if (row.engine === 'openai-api') {
    if (row.provider_base_url === null) {
      throw new DataIntegrityError(
        'embedded-agent',
        row.id,
        'provider_base_url (missing required field for openai-api engine)'
      );
    }
    return {
      ...base,
      engine: 'openai-api',
      provider: {
        baseUrl: row.provider_base_url,
        model: row.provider_model,
        apiKeyRef: row.provider_api_key_ref ?? undefined,
      },
    };
  } else if (row.engine === 'claude-sdk') {
    if (row.provider_base_url !== null) {
      throw new DataIntegrityError(
        'embedded-agent',
        row.id,
        'provider_base_url (unexpected value for claude-sdk engine, must be null)'
      );
    }
    return {
      ...base,
      engine: 'claude-sdk',
      provider: { model: row.provider_model },
    };
  } else {
    throw new DataIntegrityError('embedded-agent', row.id, `engine (unexpected value: ${row.engine})`);
  }
}

// ========== Message Template Mappers ==========

/**
 * Convert a database message template row to a MessageTemplate domain object.
 *
 * @param row - The database message template row
 * @returns The MessageTemplate object
 */
export function toMessageTemplate(row: MessageTemplateRow): MessageTemplate {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ========== Artifact Mappers ==========

/**
 * Convert a database artifact row to the shared `Artifact` wire summary
 * (id, title, createdAt, sizeBytes). Deliberately excludes `user_id` and
 * `source_session_id` -- neither belongs in the wire type (see
 * `packages/shared/src/types/artifact.ts`); content never lives in this row
 * at all (see `lib/artifact-storage.ts`).
 *
 * @param row - The database artifact row
 * @returns The Artifact object
 */
export function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    sizeBytes: row.size_bytes,
  };
}

/**
 * Convert a database artifact row to the server-internal `ArtifactRecord`
 * (the wire `Artifact` summary plus `userId`). Used by route handlers that
 * need the owning user's id -- e.g. to locate the on-disk file
 * (`lib/artifact-storage.ts`) or to enforce owner-only deletion -- but MUST
 * NEVER forward `userId` into a client-visible response.
 *
 * @param row - The database artifact row
 * @returns The ArtifactRecord object
 */
export function toArtifactRecord(row: ArtifactRow): ArtifactRecord {
  return {
    ...toArtifact(row),
    userId: row.user_id,
  };
}

// ========== Bookmark Mappers ==========

/**
 * Convert a database bookmark row to the shared `Bookmark` wire summary
 * (id, url, title, createdAt). Deliberately excludes `user_id` and
 * `source_session_id` -- neither belongs in the wire type (see
 * `packages/shared/src/types/bookmark.ts`).
 *
 * @param row - The database bookmark row
 * @returns The Bookmark object
 */
export function toBookmark(row: BookmarkRow): Bookmark {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    createdAt: row.created_at,
  };
}

/**
 * Convert a database bookmark row to the server-internal `BookmarkRecord`
 * (the wire `Bookmark` summary plus `userId`). Used by route handlers that
 * need the owning user's id -- e.g. to enforce owner-only deletion -- but
 * MUST NEVER forward `userId` into a client-visible response.
 *
 * @param row - The database bookmark row
 * @returns The BookmarkRecord object
 */
export function toBookmarkRecord(row: BookmarkRow): BookmarkRecord {
  return {
    ...toBookmark(row),
    userId: row.user_id,
  };
}
