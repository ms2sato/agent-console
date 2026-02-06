import type { Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * Database table definitions for Kysely.
 * Represents the SQLite database schema.
 */
export interface Database {
  sessions: SessionsTable;
  workers: WorkersTable;
  repositories: RepositoriesTable;
  agents: AgentsTable;
  jobs: JobsTable;
  repository_slack_integrations: RepositorySlackIntegrationsTable;
}

/**
 * Sessions table schema.
 * Stores session metadata with both worktree and quick session types.
 */
export interface SessionsTable {
  /** Primary key - UUID */
  id: string;
  /** Session type: 'worktree' or 'quick' */
  type: 'worktree' | 'quick';
  /** Working directory path */
  location_path: string;
  /** Server process ID that owns this session (null for orphaned sessions) */
  server_pid: number | null;
  /** Creation timestamp as ISO 8601 string (has DEFAULT) */
  created_at: Generated<string>;
  /** Last update timestamp as ISO 8601 string (has DEFAULT) */
  updated_at: Generated<string>;
  /** Initial prompt used to start the session */
  initial_prompt: string | null;
  /** Human-readable title for the session */
  title: string | null;
  /** Repository ID for worktree sessions (null for quick sessions) */
  repository_id: string | null;
  /** Worktree identifier for worktree sessions (null for quick sessions) */
  worktree_id: string | null;
}

/**
 * Workers table schema.
 * Stores worker metadata with foreign key reference to sessions.
 */
export interface WorkersTable {
  /** Primary key - UUID */
  id: string;
  /** Foreign key reference to sessions.id */
  session_id: string;
  /** Worker type: 'agent', 'terminal', 'git-diff', or 'sdk' */
  type: 'agent' | 'terminal' | 'git-diff' | 'sdk';
  /** Display name for the worker */
  name: string;
  /** Creation timestamp as ISO 8601 string (has DEFAULT) */
  created_at: Generated<string>;
  /** Last update timestamp as ISO 8601 string (has DEFAULT) */
  updated_at: Generated<string>;
  /** PTY process ID (null for git-diff workers or inactive PTY workers) */
  pid: number | null;
  /** Agent ID for agent workers (null for other worker types) */
  agent_id: string | null;
  /** Base commit hash for git-diff workers (null for other worker types) */
  base_commit: string | null;
  /** SDK session ID for SDK workers (null for other worker types) */
  sdk_session_id: string | null;
}

// Helper types for queries

/** Session row as returned from SELECT queries */
export type Session = Selectable<SessionsTable>;
/** Session data for INSERT queries */
export type NewSession = Insertable<SessionsTable>;
/** Session data for UPDATE queries */
export type SessionUpdate = Updateable<SessionsTable>;

/** Worker row as returned from SELECT queries */
export type Worker = Selectable<WorkersTable>;
/** Worker data for INSERT queries */
export type NewWorker = Insertable<WorkersTable>;
/** Worker data for UPDATE queries */
export type WorkerUpdate = Updateable<WorkersTable>;

/**
 * Repositories table schema.
 * Stores registered git repository metadata.
 */
export interface RepositoriesTable {
  /** Primary key - UUID */
  id: string;
  /** Display name (usually directory name) */
  name: string;
  /** Absolute path to the repository */
  path: string;
  /** Creation timestamp as ISO 8601 string (has DEFAULT) */
  created_at: Generated<string>;
  /** Last update timestamp as ISO 8601 string (has DEFAULT) */
  updated_at: Generated<string>;
  /** Shell command to run after creating worktrees (added in v4) */
  setup_command: string | null;
  /** Environment variables in .env format to apply to workers (added in v5) */
  env_vars: string | null;
}

/** Repository row as returned from SELECT queries */
export type RepositoryRow = Selectable<RepositoriesTable>;
/** Repository data for INSERT queries */
export type NewRepository = Insertable<RepositoriesTable>;
/** Repository data for UPDATE queries */
export type RepositoryUpdate = Updateable<RepositoriesTable>;

/**
 * Agents table schema.
 * Stores custom agent definitions (built-in agents are NOT persisted).
 */
export interface AgentsTable {
  /** Primary key - UUID */
  id: string;
  /** Display name */
  name: string;
  /** Command template for starting with initial prompt (required) */
  command_template: string;
  /** Command template for continuing conversation (optional) */
  continue_template: string | null;
  /** Command template for headless execution (optional) */
  headless_template: string | null;
  /** Human-readable description (optional) */
  description: string | null;
  /** Whether this is a built-in agent (always 0 for persisted agents) */
  is_built_in: number;
  /** Creation timestamp as ISO 8601 string (has DEFAULT) */
  created_at: Generated<string>;
  /** Last update timestamp as ISO 8601 string (has DEFAULT) */
  updated_at: Generated<string>;
  /** JSON-serialized activity patterns (optional) */
  activity_patterns: string | null;
  /** Agent type identifier (e.g., 'claude-code', 'gemini', 'codex', 'unknown') (added in v8) */
  agent_type: string;
}

/** Agent row as returned from SELECT queries */
export type AgentRow = Selectable<AgentsTable>;
/** Agent data for INSERT queries */
export type NewAgent = Insertable<AgentsTable>;
/** Agent data for UPDATE queries */
export type AgentUpdate = Updateable<AgentsTable>;

/**
 * Jobs table schema.
 * Stores background job queue entries for async task processing.
 */
export interface JobsTable {
  /** Primary key - UUID */
  id: string;
  /** Job type identifier (e.g., 'cleanup:session-outputs') */
  type: string;
  /** JSON-serialized job payload */
  payload: string;
  /** Job status: pending, processing, completed, stalled */
  status: string;
  /** Priority (higher = processed first). Default: 0 */
  priority: number;
  /** Number of processing attempts. Default: 0 */
  attempts: number;
  /** Maximum retry attempts before marking as stalled. Default: 5 */
  max_attempts: number;
  /** Unix timestamp (ms) when the job can next be processed */
  next_retry_at: number;
  /** Last error message if job failed */
  last_error: string | null;
  /** Unix timestamp (ms) when job was created */
  created_at: number;
  /** Unix timestamp (ms) when job started processing */
  started_at: number | null;
  /** Unix timestamp (ms) when job completed */
  completed_at: number | null;
}

/** Job row as returned from SELECT queries */
export type JobRow = Selectable<JobsTable>;
/** Job data for INSERT queries */
export type NewJob = Insertable<JobsTable>;
/** Job data for UPDATE queries */
export type JobUpdate = Updateable<JobsTable>;

/**
 * Repository Slack Integrations table schema.
 * Stores per-repository Slack integration settings for outbound notifications.
 */
export interface RepositorySlackIntegrationsTable {
  /** Primary key - UUID */
  id: string;
  /** Foreign key reference to repositories.id */
  repository_id: string;
  /** Slack webhook URL */
  webhook_url: string;
  /** Whether integration is enabled (0 = disabled, 1 = enabled) */
  enabled: number;
  /** Creation timestamp as ISO 8601 string */
  created_at: Generated<string>;
  /** Last update timestamp as ISO 8601 string */
  updated_at: Generated<string>;
}

/** Repository Slack integration row as returned from SELECT queries */
export type RepositorySlackIntegrationRow = Selectable<RepositorySlackIntegrationsTable>;
/** Repository Slack integration data for INSERT queries */
export type NewRepositorySlackIntegration = Insertable<RepositorySlackIntegrationsTable>;
/** Repository Slack integration data for UPDATE queries */
export type RepositorySlackIntegrationUpdate = Updateable<RepositorySlackIntegrationsTable>;
