/**
 * Job handlers for the local job queue.
 *
 * Registers handlers for background cleanup operations:
 * - cleanup:session-outputs - Delete all output files for a session
 * - cleanup:worker-output - Delete output file for a single worker
 * - cleanup:repository - Remove repository data directory
 */
import * as fs from 'fs/promises';
import type { JobQueue } from './job-queue.js';
import { workerOutputFileManager } from '../lib/worker-output-file.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('job-handlers');

/**
 * Payload for cleanup:session-outputs job.
 */
interface CleanupSessionOutputsPayload {
  sessionId: string;
}

/**
 * Payload for cleanup:worker-output job.
 */
interface CleanupWorkerOutputPayload {
  sessionId: string;
  workerId: string;
}

/**
 * Payload for cleanup:repository job.
 */
interface CleanupRepositoryPayload {
  repoDir: string;
}

/**
 * Register all job handlers with the job queue.
 * @param jobQueue The JobQueue instance to register handlers with
 */
export function registerJobHandlers(jobQueue: JobQueue): void {
  // Handler for deleting all output files for a session
  jobQueue.registerHandler<CleanupSessionOutputsPayload>(
    'cleanup:session-outputs',
    async ({ sessionId }) => {
      logger.debug({ sessionId }, 'Executing cleanup:session-outputs job');
      await workerOutputFileManager.deleteSessionOutputs(sessionId);
      logger.info({ sessionId }, 'Session outputs cleanup completed');
    }
  );

  // Handler for deleting output file for a single worker
  jobQueue.registerHandler<CleanupWorkerOutputPayload>(
    'cleanup:worker-output',
    async ({ sessionId, workerId }) => {
      logger.debug({ sessionId, workerId }, 'Executing cleanup:worker-output job');
      await workerOutputFileManager.deleteWorkerOutput(sessionId, workerId);
      logger.info({ sessionId, workerId }, 'Worker output cleanup completed');
    }
  );

  // Handler for removing repository data directory
  jobQueue.registerHandler<CleanupRepositoryPayload>(
    'cleanup:repository',
    async ({ repoDir }) => {
      logger.debug({ repoDir }, 'Executing cleanup:repository job');
      try {
        await fs.access(repoDir);
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
