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
 * Get the singleton JobQueue instance.
 * Creates the instance on first call using the database path from getConfigDir().
 * @returns The JobQueue instance
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
 * Reset the singleton JobQueue instance.
 * Used for testing to ensure test isolation.
 * Stops the queue and closes the database connection before resetting.
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
 * Check if JobQueue has been initialized.
 * Useful for conditional operations that depend on job queue availability.
 */
export function isJobQueueInitialized(): boolean {
  return jobQueueInstance !== null;
}
