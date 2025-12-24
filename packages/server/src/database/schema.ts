import type { Insertable, Selectable, Updateable } from 'kysely';

/**
 * Database table definitions for Kysely.
 * Represents the SQLite database schema.
 */
export interface Database {
  sessions: SessionsTable;
  workers: WorkersTable;
  repositories: RepositoriesTable;
  agents: AgentsTable;
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
  /** Creation timestamp as ISO 8601 string */
  created_at: string;
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
  /** Worker type: 'agent', 'terminal', or 'git-diff' */
  type: 'agent' | 'terminal' | 'git-diff';
  /** Display name for the worker */
  name: string;
  /** Creation timestamp as ISO 8601 string */
  created_at: string;
  /** PTY process ID (null for git-diff workers or inactive PTY workers) */
  pid: number | null;
  /** Agent ID for agent workers (null for other worker types) */
  agent_id: string | null;
  /** Base commit hash for git-diff workers (null for other worker types) */
  base_commit: string | null;
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
  /** Registration timestamp as ISO 8601 string */
  registered_at: string;
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
  /** Registration timestamp as ISO 8601 string (optional for built-in) */
  registered_at: string | null;
  /** JSON-serialized activity patterns (optional) */
  activity_patterns: string | null;
}

/** Agent row as returned from SELECT queries */
export type AgentRow = Selectable<AgentsTable>;
/** Agent data for INSERT queries */
export type NewAgent = Insertable<AgentsTable>;
/** Agent data for UPDATE queries */
export type AgentUpdate = Updateable<AgentsTable>;
