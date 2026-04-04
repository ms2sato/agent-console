/**
 * Domain record for a persisted timer.
 * Matches the fields stored in the timers table (camelCase).
 */
export interface TimerRecord {
  id: string;
  sessionId: string;
  workerId: string;
  intervalSeconds: number;
  action: string;
  createdAt: string;
}

/**
 * Repository interface for timer persistence.
 */
export interface TimerRepository {
  /**
   * Save a timer record.
   * @param record - The timer record to persist
   */
  save(record: TimerRecord): Promise<void>;

  /**
   * Delete a timer by its ID.
   * @param id - The timer ID to delete
   */
  delete(id: string): Promise<void>;

  /**
   * Delete all timers belonging to a session.
   * @param sessionId - The session ID whose timers should be deleted
   * @returns The number of deleted rows
   */
  deleteBySessionId(sessionId: string): Promise<number>;

  /**
   * Retrieve all persisted timer records.
   * @returns Array of all timer records
   */
  findAll(): Promise<TimerRecord[]>;
}
