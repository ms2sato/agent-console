import type { PersistedSession } from '../services/persistence-service.js';

/**
 * Supported fields for partial session updates.
 * This is stricter than Partial<PersistedSession> to prevent silent field ignoring.
 * Only these fields are supported by the update() method:
 * - serverPid: Update server ownership (null = paused, number = owned by server)
 * - title: Update session title
 * - initialPrompt: Update initial prompt
 * - locationPath: Update session location path
 * - worktreeId: Update worktree ID (only valid for worktree sessions)
 */
export interface SessionUpdateFields {
  serverPid?: number | null;
  title?: string | null;
  initialPrompt?: string | null;
  locationPath?: string;
  worktreeId?: string;
}

/**
 * Repository interface for persisting sessions.
 * Provides an abstraction layer for session storage operations.
 */
export interface SessionRepository {
  /**
   * Retrieve all persisted sessions.
   */
  findAll(): Promise<PersistedSession[]>;

  /**
   * Find a session by its ID.
   * @param id - The session ID to search for
   * @returns The session if found, null otherwise
   */
  findById(id: string): Promise<PersistedSession | null>;

  /**
   * Find all sessions created by a specific server process.
   * Used for cleanup when a server restarts.
   * @param pid - The server process ID
   * @returns Array of sessions belonging to the specified server
   */
  findByServerPid(pid: number): Promise<PersistedSession[]>;

  /**
   * Save a single session.
   * Creates a new session or updates an existing one with the same ID.
   * @param session - The session to save
   */
  save(session: PersistedSession): Promise<void>;

  /**
   * Save multiple sessions at once.
   * Replaces all existing sessions with the provided array.
   * @param sessions - The sessions to save
   */
  saveAll(sessions: PersistedSession[]): Promise<void>;

  /**
   * Delete a session by its ID.
   * @param id - The session ID to delete
   */
  delete(id: string): Promise<void>;

  /**
   * Update specific fields of a session without replacing the entire session.
   * Only supports fields defined in SessionUpdateFields:
   * - serverPid, title, initialPrompt, locationPath, worktreeId
   * @param id - The session ID to update
   * @param updates - Fields to update (must be from SessionUpdateFields)
   * @returns true if session was found and updated, false if not found
   */
  update(id: string, updates: SessionUpdateFields): Promise<boolean>;

  /**
   * Find all paused sessions (those with serverPid = null).
   * Paused sessions are not actively managed by any server instance.
   * @returns Array of paused sessions
   */
  findPaused(): Promise<PersistedSession[]>;
}
