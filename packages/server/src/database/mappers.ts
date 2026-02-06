import type { AgentDefinition, Repository, AgentActivityPatterns, AgentType } from '@agent-console/shared';
import { computeCapabilities, DEFAULT_AGENT_TYPE } from '@agent-console/shared';
import type { NewSession, NewWorker, Session, Worker, NewRepository, RepositoryRow, NewAgent, AgentRow } from './schema.js';
import type {
  PersistedSession,
  PersistedWorker,
  PersistedAgentWorker,
  PersistedTerminalWorker,
  PersistedGitDiffWorker,
  PersistedSdkWorker,
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
    public readonly entityType: 'session' | 'worker',
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
  const now = new Date().toISOString();
  const base = {
    id: session.id,
    type: session.type,
    location_path: session.locationPath,
    server_pid: session.serverPid ?? null,
    created_at: session.createdAt,
    updated_at: now,
    initial_prompt: session.initialPrompt ?? null,
    title: session.title ?? null,
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
      sdk_session_id: null,
    };
  } else if (worker.type === 'terminal') {
    return {
      ...base,
      pid: worker.pid ?? null,
      agent_id: null,
      base_commit: null,
      sdk_session_id: null,
    };
  } else if (worker.type === 'git-diff') {
    return {
      ...base,
      pid: null,
      agent_id: null,
      base_commit: worker.baseCommit,
      sdk_session_id: null,
    };
  } else if (worker.type === 'sdk') {
    return {
      ...base,
      pid: null,
      agent_id: worker.agentId,
      base_commit: null,
      sdk_session_id: worker.sdkSessionId ?? null,
    };
  } else {
    return assertNever(worker, `Unknown worker type for worker ${base.id}`);
  }
}

/**
 * Valid worker types. Used for runtime validation of database values.
 */
const VALID_WORKER_TYPES = ['agent', 'terminal', 'git-diff', 'sdk'] as const;

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
  } else if (worker.type === 'sdk') {
    if (worker.agent_id === null || worker.agent_id === undefined) {
      throw new DataIntegrityError('worker', worker.id, 'agent_id (missing required field)');
    }
    return {
      id: worker.id,
      type: 'sdk',
      name: worker.name,
      createdAt: worker.created_at,
      agentId: worker.agent_id,
      sdkSessionId: worker.sdk_session_id ?? null,
    } as PersistedSdkWorker;
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
      title: session.title ?? undefined,
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
      title: session.title ?? undefined,
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
    env_vars: repository.envVars ?? null,
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
    envVars: row.env_vars ?? null,
  };
}

// ========== Agent Mappers ==========

/**
 * Convert an AgentDefinition to a database row for insertion.
 * Note: Built-in agents should never be persisted.
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
    agent_type: agent.agentType ?? DEFAULT_AGENT_TYPE,
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
    agentType: row.agent_type as AgentType,
  };

  return {
    ...agentBase,
    capabilities: computeCapabilities(agentBase),
  };
}
