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

export type { InboundEventJobPayload } from '@agent-console/shared';
