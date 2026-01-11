/**
 * Job type constants and payload definitions.
 *
 * All job types used in the system are defined here for consistency
 * and to provide a single reference for available background jobs.
 */

/**
 * Available job types in the system.
 */
export const JOB_TYPES = {
  /**
   * Delete all output files for a session.
   * Payload: CleanupSessionOutputsPayload
   */
  CLEANUP_SESSION_OUTPUTS: 'cleanup:session-outputs',

  /**
   * Delete output file for a single worker.
   * Payload: CleanupWorkerOutputPayload
   */
  CLEANUP_WORKER_OUTPUT: 'cleanup:worker-output',

  /**
   * Remove repository data directory (worktrees and templates).
   * Payload: CleanupRepositoryPayload
   */
  CLEANUP_REPOSITORY: 'cleanup:repository',

  /**
   * Process an inbound integration webhook event.
   * Payload: InboundEventJobPayload
   */
  INBOUND_EVENT_PROCESS: 'inbound-event:process',
} as const;

/**
 * Type representing all available job type values.
 */
export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

/**
 * Payload for cleanup:session-outputs job.
 */
export interface CleanupSessionOutputsPayload {
  sessionId: string;
}

/**
 * Payload for cleanup:worker-output job.
 */
export interface CleanupWorkerOutputPayload {
  sessionId: string;
  workerId: string;
}

/**
 * Payload for cleanup:repository job.
 */
export interface CleanupRepositoryPayload {
  repoDir: string;
}

/**
 * Payload for inbound-event:process job.
 */
export interface InboundEventJobPayload {
  /** Same value as jobs.id (for cross-reference) */
  jobId: string;
  /** Webhook service identifier (e.g., 'github') */
  service: string;
  /** Raw JSON payload */
  rawPayload: string;
  /** Request headers as a serializable record */
  headers: Record<string, string>;
  /** ISO timestamp when received */
  receivedAt: string;
}
