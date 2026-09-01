import type { Generated, Insertable, Selectable, Updateable } from 'kysely';
import type { JobStatus, JobType } from '@agent-console/shared';

/**
 * Database table definitions for Kysely.
 * Represents the SQLite database schema.
 */
export interface Database {
  sessions: SessionsTable;
  workers: WorkersTable;
  repositories: RepositoriesTable;
  agents: AgentsTable;
  embedded_agents: EmbeddedAgentsTable;
  jobs: JobsTable;
  repository_slack_integrations: RepositorySlackIntegrationsTable;
  worktrees: WorktreesTable;
  inbound_event_notifications: InboundEventNotificationsTable;
  users: UsersTable;
  timers: TimersTable;
  message_templates: MessageTemplatesTable;
  artifacts: ArtifactsTable;
  user_notification_cursor: UserNotificationCursorTable;
  bookmarks: BookmarksTable;
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
  /**
   * Whether `initial_prompt` has already been delivered as the session's
   * initial embedded-agent worker's first user message. SQLite
   * stores booleans as INTEGER 0/1; null for legacy rows predating v24.
   */
  initial_prompt_delivered: number | null;
  /** Human-readable title for the session */
  title: string | null;
  /** Repository ID for worktree sessions (null for quick sessions) */
  repository_id: string | null;
  /** Worktree identifier for worktree sessions (null for quick sessions) */
  worktree_id: string | null;
  /** ISO 8601 timestamp when session was paused (null = not paused) */
  paused_at: string | null;
  /** Parent session ID that delegated this session (null for non-delegated sessions) */
  parent_session_id: string | null;
  /** Parent worker ID that delegated this session (null for non-delegated sessions) */
  parent_worker_id: string | null;
  /** User UUID (from users table) of the user who created this session (null for pre-multi-user sessions) */
  created_by: string | null;
  /**
   * User UUID (from users table) of the authenticated user who actually
   * created this session. For shared sessions this differs from created_by
   * (which is the shared account); for personal sessions it is left null
   * since it would equal created_by.
   * See docs/design/shared-orchestrator-session.md §"Schema Notes".
   */
  initiated_by: string | null;
  /** Data-location scope ('quick' | 'repository'); null for legacy rows and orphaned sessions. */
  data_scope: 'quick' | 'repository' | null;
  /** Slug for 'repository' scope; null for 'quick' scope and orphaned sessions. */
  data_scope_slug: string | null;
  /** Recovery state ('healthy' | 'orphaned'); has DEFAULT 'healthy'. */
  recovery_state: Generated<'healthy' | 'orphaned'>;
  /** Unix epoch ms when marked orphaned (null if healthy). */
  orphaned_at: number | null;
  /** Machine-readable orphan reason code (null if healthy). */
  orphaned_reason: string | null;
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
  /** Worker type: 'agent', 'terminal', 'git-diff', or 'embedded-agent' */
  type: 'agent' | 'terminal' | 'git-diff' | 'embedded-agent';
  /** Display name for the worker */
  name: string;
  /** Creation timestamp as ISO 8601 string (has DEFAULT) */
  created_at: Generated<string>;
  /** Last update timestamp as ISO 8601 string (has DEFAULT) */
  updated_at: Generated<string>;
  /**
   * Process ID: the PTY process for agent/terminal workers, or the agent
   * subprocess for embedded-agent workers. Null for git-diff workers and for
   * inactive PTY / not-yet-activated embedded-agent workers.
   */
  pid: number | null;
  /** Agent ID for agent workers (null for other worker types) */
  agent_id: string | null;
  /** Base commit hash for git-diff workers (null for other worker types) */
  base_commit: string | null;
  /** Embedded agent definition ID for embedded-agent workers (null for other worker types) */
  embedded_agent_id: string | null;
  /** Eligibility marker for initial-prompt delivery (embedded-agent workers only; null for other types and legacy rows). See docs/glossary.md "Initial Prompt (Session)". */
  deliver_initial_prompt_on_activation: number | null;
  /** The worker's current Claude Agent SDK session id (embedded-agent workers with the `claude-sdk` engine only; null for other types and openai-api engine workers). See docs/design/embedded-agent-sdk-engine.md §4 "Process lifetime" row. */
  sdk_session_id: string | null;
  /**
   * Compaction's per-worker auto toggle (embedded-agent workers only; the
   * value is written but meaningless for other types). NOT NULL DEFAULT 1 --
   * ON is what the owner's 2026-08-28 decision means, and rows predating
   * migration v35 fall to ON for the same reason. See
   * docs/design/embedded-agent-worker.md "Compaction".
   */
  auto_compaction: Generated<number>;
  /**
   * Worker-persisted model override (agent workers only; null for other
   * types). Beats the agent definition's own template default; survives
   * server restart (agent-surface.md Ruling 3). NULL, never an empty string --
   * the wire schema rejects empty/whitespace input, so the storage layer
   * never sees a third state between "a real value" and "absent".
   */
  model: string | null;
  /**
   * Worker-persisted reasoning-effort override (agent workers only; null for
   * other types). Same persistence contract as `model`. See
   * docs/design/agent-surface.md "Model & Reasoning-Effort Parameters".
   */
  reasoning_effort: string | null;
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
  /** Shell command to run before deleting worktrees (added in v9) */
  cleanup_command: string | null;
  /** Environment variables in .env format to apply to workers (added in v5) */
  env_vars: string | null;
  /** Brief description of the repository (added in v7) */
  description: string | null;
  /** Default agent ID for worktree creation (added in v10) */
  default_agent_id: string | null;
}

/** Repository row as returned from SELECT queries */
export type RepositoryRow = Selectable<RepositoriesTable>;
/** Repository data for INSERT queries */
export type NewRepository = Insertable<RepositoriesTable>;
/** Repository data for UPDATE queries */
export type RepositoryUpdate = Updateable<RepositoriesTable>;

/**
 * Agents table schema.
 * Stores agent definitions (both built-in and custom).
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
  /** Whether this is a built-in agent (1 for built-in, 0 for custom) */
  is_built_in: number;
  /** Creation timestamp as ISO 8601 string (has DEFAULT) */
  created_at: Generated<string>;
  /** Last update timestamp as ISO 8601 string (has DEFAULT) */
  updated_at: Generated<string>;
  /** JSON-serialized activity patterns (optional) */
  activity_patterns: string | null;
  /** Base agent ID for preset agents (optional, references agents.id) */
  base_agent_id: string | null;
}

/** Agent row as returned from SELECT queries */
export type AgentRow = Selectable<AgentsTable>;
/** Agent data for INSERT queries */
export type NewAgent = Insertable<AgentsTable>;
/** Agent data for UPDATE queries */
export type AgentUpdate = Updateable<AgentsTable>;

/**
 * Embedded agents table schema.
 * Stores embedded-agent definitions (OpenAI-compatible provider + model),
 * a separate registry from `agents` (which describes terminal programs).
 */
export interface EmbeddedAgentsTable {
  /** Primary key - UUID */
  id: string;
  /** Display name (e.g. "Ollama qwen3:32b") */
  name: string;
  /** Human-readable description (optional) */
  description: string | null;
  /** Execution engine discriminant (SDK Engine Phase 1): 'openai-api' (existing OpenAI-compatible custom loop) or 'claude-sdk' (Claude Agent SDK subprocess). See docs/design/embedded-agent-sdk-engine.md §3.1. */
  engine: 'openai-api' | 'claude-sdk';
  /** OpenAI-compatible provider root URL. NULL for 'claude-sdk' engine rows (no provider secret crosses the server for that engine, §3.2); NOT NULL for 'openai-api' rows. */
  provider_base_url: string | null;
  /** Model id passed in the chat.completions request (openai-api) or to the SDK session (claude-sdk) -- both engines have a model */
  provider_model: string;
  /** Name of a key in the server-side key store (null = no auth, e.g. local LLMs) */
  provider_api_key_ref: string | null;
  /** System prompt prepended to every conversation (optional) */
  system_prompt: string | null;
  /** Max tool iterations per user turn (null = use default) */
  max_tool_iterations: number | null;
  /** JSON-serialized array of enabled builtin tool names (null = default read-only set applies downstream) */
  enabled_tools: string | null;
  /** JSON-serialized array of opt-in instruction-file paths (null = none configured) */
  instructions: string | null;
  /** Operator-declared model context window in tokens (Compaction); null = no denominator, so the ratio UI is disabled AND openai-api auto compaction can never fire */
  context_window_tokens: number | null;
  /** Auto-compaction threshold ratio 0..1 exclusive of 0 (Compaction, migration v36, replacing the three handoff_* columns); null = use DEFAULT_COMPACTION_THRESHOLD downstream */
  compaction_threshold: number | null;
  /** Builtin-definition marker (SDK Engine Phase 1), mirroring agents.is_built_in: 1 for the claude-sdk builtin, 0 for user-created definitions. Builtin definitions cannot be modified or deleted. */
  is_built_in: number;
  /** User UUID (from users table) of the creator */
  created_by: string;
  /** Creation timestamp as ISO 8601 string (has DEFAULT) */
  created_at: Generated<string>;
  /** Last update timestamp as ISO 8601 string (has DEFAULT) */
  updated_at: Generated<string>;
}

/** Embedded agent row as returned from SELECT queries */
export type EmbeddedAgentRow = Selectable<EmbeddedAgentsTable>;
/** Embedded agent data for INSERT queries */
export type NewEmbeddedAgent = Insertable<EmbeddedAgentsTable>;
/** Embedded agent data for UPDATE queries */
export type EmbeddedAgentUpdate = Updateable<EmbeddedAgentsTable>;

/**
 * Jobs table schema.
 * Stores background job queue entries for async task processing.
 */
export interface JobsTable {
  /** Primary key - UUID */
  id: string;
  /** Job type identifier (e.g., 'cleanup:session-outputs') */
  type: JobType;
  /** JSON-serialized job payload */
  payload: string;
  /** Job status: pending, processing, completed, stalled */
  status: JobStatus;
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

/**
 * Worktrees table schema.
 * Stores worktree index data, replacing the JSON-based worktree-indexes.json.
 */
export interface WorktreesTable {
  /** Primary key - UUID */
  id: string;
  /** Foreign key reference to repositories.id */
  repository_id: string;
  /** Absolute path to the worktree directory (unique) */
  path: string;
  /** Index number for worktree naming (e.g., wt-001-xxxx) */
  index_number: number;
  /** Creation timestamp as ISO 8601 string (has DEFAULT) */
  created_at: Generated<string>;
}

/** Worktree row as returned from SELECT queries */
export type WorktreeRow = Selectable<WorktreesTable>;
/** Worktree data for INSERT queries */
export type NewWorktree = Insertable<WorktreesTable>;
/** Worktree data for UPDATE queries */
export type WorktreeUpdate = Updateable<WorktreesTable>;

/**
 * Inbound Event Notifications table schema.
 * Tracks delivery of inbound events to session/worker targets for idempotency.
 */
export interface InboundEventNotificationsTable {
  /** Primary key - UUID */
  id: string;
  /** Job ID that triggered this notification */
  job_id: string;
  /** Target session ID */
  session_id: string;
  /** Target worker ID */
  worker_id: string;
  /** Handler that processed this notification */
  handler_id: string;
  /** Event type (e.g., 'ci:completed') */
  event_type: string;
  /** Human-readable event summary */
  event_summary: string;
  /** Notification status ('pending' or 'delivered') */
  status: 'pending' | 'delivered';
  /** Creation timestamp as ISO 8601 string */
  created_at: string;
  /** Timestamp when notification was delivered (null if pending) */
  notified_at: string | null;
}

/** Inbound event notification row as returned from SELECT queries */
export type InboundEventNotification = Selectable<InboundEventNotificationsTable>;
/** Inbound event notification data for INSERT queries */
export type NewInboundEventNotification = Insertable<InboundEventNotificationsTable>;

/**
 * Users table schema.
 * Stores user identity with UUID primary key for stable cross-reference.
 */
export interface UsersTable {
  /** Primary key - UUID (app's stable identifier) */
  id: string;
  /** OS numeric user ID (nullable for future non-OS auth) */
  os_uid: number | null;
  /** Current OS username */
  username: string;
  /** Home directory path */
  home_dir: string;
  /** Creation timestamp as ISO 8601 string */
  created_at: string;
  /** Last update timestamp as ISO 8601 string */
  updated_at: string;
}

/** User row as returned from SELECT queries */
export type UserRow = Selectable<UsersTable>;
/** User data for INSERT queries */
export type NewUser = Insertable<UsersTable>;
/** User data for UPDATE queries */
export type UserUpdate = Updateable<UsersTable>;

/**
 * Timers table schema.
 * Stores cron timer definitions for periodic worker actions.
 * No foreign key on session_id — timers must survive restarts when sessions may not yet exist.
 */
export interface TimersTable {
  /** Primary key - UUID */
  id: string;
  /** Session ID this timer belongs to */
  session_id: string;
  /** Worker ID this timer targets */
  worker_id: string;
  /** Interval in seconds between executions */
  interval_seconds: number;
  /** Action to perform on each tick */
  action: string;
  /** Creation timestamp as ISO 8601 string */
  created_at: string;
}

/** Timer row as returned from SELECT queries */
export type TimerRow = Selectable<TimersTable>;
/** Timer data for INSERT queries */
export type NewTimer = Insertable<TimersTable>;

/**
 * Message Templates table schema.
 * Stores saved message templates for quick insertion into the message input.
 */
export interface MessageTemplatesTable {
  /** Primary key - UUID */
  id: string;
  /** Display title for the template */
  title: string;
  /** Template content text */
  content: string;
  /** Sort order for display (lower = first) */
  sort_order: number;
  /** Creation timestamp as ISO 8601 string (has DEFAULT) */
  created_at: Generated<string>;
  /** Last update timestamp as ISO 8601 string (has DEFAULT) */
  updated_at: Generated<string>;
}

/** Message template row as returned from SELECT queries */
export type MessageTemplateRow = Selectable<MessageTemplatesTable>;
/** Message template data for INSERT queries */
export type NewMessageTemplate = Insertable<MessageTemplatesTable>;
/** Message template data for UPDATE queries */
export type MessageTemplateUpdate = Updateable<MessageTemplatesTable>;

/**
 * Artifacts table schema (HTML Artifacts phase 1).
 * Stores metadata for user-uploaded HTML artifacts; the HTML bytes
 * themselves live on disk at `<AGENT_CONSOLE_HOME>/artifacts/<user_id>/<id>.html`
 * (see `lib/artifact-storage.ts`), not in this table.
 * See docs/design/html-artifacts.md §5.1.
 */
export interface ArtifactsTable {
  /** Primary key - UUID */
  id: string;
  /** Foreign key reference to users.id (owner) */
  user_id: string;
  /** Display title, resolved per docs/design/html-artifacts.md §5.3 */
  title: string;
  /** Creation timestamp as ISO 8601 string */
  created_at: string;
  /** Size of the stored HTML file in bytes */
  size_bytes: number;
  /**
   * Provenance only -- the session that created this artifact. Nullable,
   * and NEVER used for lookup: an artifact outlives its source session.
   */
  source_session_id: string | null;
}

/** Artifact row as returned from SELECT queries */
export type ArtifactRow = Selectable<ArtifactsTable>;
/** Artifact data for INSERT queries */
export type NewArtifact = Insertable<ArtifactsTable>;

/**
 * User notification cursor table (Notification Center, docs/design/notification-center.md §5).
 * One row per user; `last_seen_at` is a high-water mark, not per-item state (N2).
 */
export interface UserNotificationCursorTable {
  /** Primary key — foreign key reference to users.id (owner) */
  user_id: string;
  /** ISO 8601 timestamp of the newest notification the user has seen */
  last_seen_at: string;
}

/** User notification cursor row as returned from SELECT queries */
export type UserNotificationCursorRow = Selectable<UserNotificationCursorTable>;
/** User notification cursor data for INSERT queries */
export type NewUserNotificationCursor = Insertable<UserNotificationCursorTable>;

/**
 * Bookmarks table schema.
 * Stores user-registered bookmarks: an arbitrary URL plus optional title,
 * scoped by owner. Unlike `artifacts`, bookmarks have no file-storage
 * component -- everything lives in this table.
 */
export interface BookmarksTable {
  /** Primary key - UUID */
  id: string;
  /** Foreign key reference to users.id (owner) */
  user_id: string;
  /**
   * Provenance only -- the session that created this bookmark. Nullable,
   * and NEVER used for authorization: a bookmark outlives its source
   * session (no cascade delete on session removal).
   */
  source_session_id: string | null;
  /** The bookmarked URL. Scheme-allowlisted (http:/https: only) at write time. */
  url: string;
  /** Optional display title; null displays the URL client-side. */
  title: string | null;
  /** Creation timestamp as ISO 8601 string */
  created_at: string;
  /**
   * Provenance: `'user'` (registered through the sidebar form) or `'agent'`
   * (registered via an MCP tool call). NOT NULL DEFAULT 'user' (migration
   * v34) -- every pre-migration row was, definitionally, human-registered.
   * Provenance only, not an authorization scope (see
   * `docs/design/session-bookmarks.md` §4.1). `Generated<>` (not a plain
   * union, mirroring `recovery_state` above) since the SQL DEFAULT makes
   * this column insert-optional; the underlying storage is still plain
   * TEXT, so `mappers.ts`'s `toBookmark` still validates at runtime.
   */
  origin: Generated<'user' | 'agent'>;
}

/** Bookmark row as returned from SELECT queries */
export type BookmarkRow = Selectable<BookmarksTable>;
/** Bookmark data for INSERT queries */
export type NewBookmark = Insertable<BookmarksTable>;
