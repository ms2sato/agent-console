/**
 * Job type constants and payload definitions.
 *
 * Re-exports from @agent-console/shared for convenience.
 * All job types used in the system are defined in the shared package
 * to provide a single reference for available background jobs.
 */
export {
  JOB_TYPES,
  type JobType,
  type CleanupSessionOutputsPayload,
  type CleanupWorkerOutputPayload,
  type CleanupRepositoryPayload,
  type InboundEventJobPayload,
} from '@agent-console/shared';
