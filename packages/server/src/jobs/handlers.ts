/**
 * Job handlers for the local job queue.
 *
 * Registers handlers for background cleanup operations.
 * See job-types.ts for available job types and their payloads.
 */
import * as fs from 'fs/promises';
import type { JobQueue } from './job-queue.js';
import {
  JOB_TYPES,
  type CleanupSessionOutputsPayload,
  type CleanupWorkerOutputPayload,
  type CleanupRepositoryPayload,
} from './job-types.js';
import { workerOutputFileManager } from '../lib/worker-output-file.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('job-handlers');

/**
 * Register all job handlers with the job queue.
 * @param jobQueue The JobQueue instance to register handlers with
 */
export function registerJobHandlers(jobQueue: JobQueue): void {
  // Handler for deleting all output files for a session
  jobQueue.registerHandler<CleanupSessionOutputsPayload>(
    JOB_TYPES.CLEANUP_SESSION_OUTPUTS,
    async ({ sessionId }) => {
      logger.debug({ sessionId }, 'Executing cleanup:session-outputs job');
      await workerOutputFileManager.deleteSessionOutputs(sessionId);
      logger.info({ sessionId }, 'Session outputs cleanup completed');
    }
  );

  // Handler for deleting output file for a single worker
  jobQueue.registerHandler<CleanupWorkerOutputPayload>(
    JOB_TYPES.CLEANUP_WORKER_OUTPUT,
    async ({ sessionId, workerId }) => {
      logger.debug({ sessionId, workerId }, 'Executing cleanup:worker-output job');
      await workerOutputFileManager.deleteWorkerOutput(sessionId, workerId);
      logger.info({ sessionId, workerId }, 'Worker output cleanup completed');
    }
  );

  // Handler for removing repository data directory
  jobQueue.registerHandler<CleanupRepositoryPayload>(
    JOB_TYPES.CLEANUP_REPOSITORY,
    async ({ repoDir }) => {
      logger.debug({ repoDir }, 'Executing cleanup:repository job');
      try {
        await fs.rm(repoDir, { recursive: true });
        logger.info({ repoDir }, 'Repository data cleanup completed');
      } catch (error) {
        // Handle ENOENT (file not found) gracefully - directory already gone
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          logger.debug({ repoDir }, 'Repository directory does not exist, skipping cleanup');
          return;
        }
        // Let other errors propagate to trigger job retry
        throw error;
      }
    }
  );

  logger.info('Job handlers registered');
}
