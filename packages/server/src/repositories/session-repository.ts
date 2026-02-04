import type { PersistedSession } from '../services/persistence-service.js';

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
   * @param id - The session ID to update
   * @param updates - Partial session data to merge with existing session
   * @returns true if session was found and updated, false if not found
   */
  update(id: string, updates: Partial<PersistedSession>): Promise<boolean>;
}
