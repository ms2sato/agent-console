/**
 * JobQueue singleton instance management.
 *
 * Provides lazy initialization and cleanup functions for the global job queue.
 * The job queue uses the same SQLite database as the rest of the application.
 */
import * as path from 'path';
import { JobQueue } from './job-queue.js';
import { getConfigDir } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('job-queue-instance');

let jobQueueInstance: JobQueue | null = null;

/**
 * Return the singleton JobQueue, creating it on first access.
 *
 * The instance is initialized using the application's config directory database file (`data.db`) with a concurrency of 4.
 *
 * @returns The singleton JobQueue instance
 */
export function getJobQueue(): JobQueue {
  if (!jobQueueInstance) {
    const dbPath = path.join(getConfigDir(), 'data.db');
    jobQueueInstance = new JobQueue(dbPath, { concurrency: 4 });
    logger.info({ dbPath }, 'JobQueue instance created');
  }
  return jobQueueInstance;
}

/**
 * Reset the module-level JobQueue singleton.
 *
 * Stops the queue, closes its database connection, and clears the singleton reference; no-op if the queue was not initialized.
 */
export async function resetJobQueue(): Promise<void> {
  if (jobQueueInstance) {
    await jobQueueInstance.stop();
    jobQueueInstance.close();
    jobQueueInstance = null;
    logger.debug('JobQueue instance reset');
  }
}

/**
 * Determines whether the JobQueue singleton has been initialized.
 *
 * @returns `true` if the JobQueue instance exists, `false` otherwise.
 */
export function isJobQueueInitialized(): boolean {
  return jobQueueInstance !== null;
}