/**
 * JobQueue singleton instance management.
 *
 * Provides explicit initialization and cleanup functions for the global job queue.
 * The job queue uses the same SQLite database as the rest of the application.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../database/schema.js';
import { JobQueue } from './job-queue.js';
import { getDatabase } from '../database/connection.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('job-queue-instance');

let jobQueueInstance: JobQueue | null = null;

/**
 * Initialize the JobQueue singleton.
 * Must be called once at application startup after database initialization.
 * @param options - Optional configuration
 * @returns The initialized JobQueue instance
 */
export function initializeJobQueue(options?: {
  concurrency?: number;
  db?: Kysely<Database>;
}): JobQueue {
  if (jobQueueInstance) {
    throw new Error('JobQueue already initialized');
  }
  const db = options?.db ?? getDatabase();
  jobQueueInstance = new JobQueue(db, { concurrency: options?.concurrency ?? 4 });
  logger.info('JobQueue instance created');
  return jobQueueInstance;
}

/**
 * Get the JobQueue singleton instance.
 * @throws Error if initializeJobQueue() has not been called
 */
export function getJobQueue(): JobQueue {
  if (!jobQueueInstance) {
    throw new Error('JobQueue not initialized. Call initializeJobQueue() first.');
  }
  return jobQueueInstance;
}

/**
 * Reset the singleton JobQueue instance.
 * @internal For testing only.
 * Stops the queue before resetting.
 */
export async function resetJobQueue(): Promise<void> {
  if (jobQueueInstance) {
    await jobQueueInstance.stop();
    jobQueueInstance = null;
    logger.debug('JobQueue instance reset');
  }
}

/**
 * Check if JobQueue has been initialized.
 */
export function isJobQueueInitialized(): boolean {
  return jobQueueInstance !== null;
}
