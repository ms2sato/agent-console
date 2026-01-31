/**
 * Job Queue Type Definitions
 *
 * Types for the local job queue system that manages background tasks
 * such as cleanup operations for sessions, workers, and repositories.
 */

/**
 * Job status constants.
 * Use these instead of raw strings (e.g., JOB_STATUS.PENDING instead of 'pending').
 */
export const JOB_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  STALLED: 'stalled',
} as const;

/**
 * Job status in the lifecycle.
 */
export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

/**
 * Array of all valid job statuses (for validation).
 */
export const JOB_STATUSES = Object.values(JOB_STATUS);

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
  jobId: string;
  service: string;
  rawPayload: string;
  headers: Record<string, string>;
  receivedAt: string;
}

/**
 * Unified job payload type (union of all payload types).
 */
export type JobPayload =
  | CleanupSessionOutputsPayload
  | CleanupWorkerOutputPayload
  | CleanupRepositoryPayload
  | InboundEventJobPayload;

/**
 * Error fallback when job payload JSON parsing fails (corrupted data).
 */
export interface JobPayloadParseError {
  _parseError: true;
  raw: string;
}

/**
 * A job record as stored and returned from the API.
 * Represents a background task in the job queue.
 */
export interface Job {
  id: string;
  type: JobType;
  payload: JobPayload | JobPayloadParseError;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: number;
  lastError: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

/**
 * Response containing a list of jobs with pagination info.
 */
export interface JobsResponse {
  jobs: Job[];
  total: number;
}

/**
 * Job statistics showing counts by status.
 */
export interface JobStats {
  pending: number;
  processing: number;
  completed: number;
  stalled: number;
}
