import type { JobPayload, JobStatus as SharedJobStatus, JobType } from '@agent-console/shared';
import { Hono } from 'hono';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { getJobQueue, JOB_STATUSES, type JobRecord, type JobStatus } from '../jobs/index.js';

const logger = createLogger('api:jobs');

/**
 * Transform a JobRecord from database format (snake_case) to API response format (camelCase).
 * Also parses the payload JSON string.
 */
interface JobResponse {
  id: string;
  type: JobType;
  payload: JobPayload;
  status: SharedJobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: number;
  lastError: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

function toJobResponse(job: JobRecord): JobResponse {
  let parsedPayload: JobPayload;
  try {
    parsedPayload = JSON.parse(job.payload) as JobPayload;
  } catch (error) {
    // Log warning and include parse error indicator for debugging
    logger.warn({ jobId: job.id, err: error }, 'Failed to parse job payload');
    parsedPayload = { _parseError: true, raw: job.payload } as unknown as JobPayload;
  }

  return {
    id: job.id,
    type: job.type as JobType,
    payload: parsedPayload,
    status: job.status,
    priority: job.priority,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    nextRetryAt: job.next_retry_at,
    lastError: job.last_error,
    createdAt: job.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
  };
}

const jobs = new Hono()
  // Get jobs with optional filtering and pagination
  .get('/', async (c) => {
    const statusParam = c.req.query('status');
    const type = c.req.query('type');
    const limitParam = c.req.query('limit');
    const offsetParam = c.req.query('offset');

    // Validate status parameter
    let status: JobStatus | undefined;
    if (statusParam) {
      if (!JOB_STATUSES.includes(statusParam as JobStatus)) {
        throw new ValidationError(`status must be one of: ${JOB_STATUSES.join(', ')}`);
      }
      status = statusParam as JobStatus;
    }

    const limit = limitParam ? parseInt(limitParam, 10) : 50;
    const offset = offsetParam ? parseInt(offsetParam, 10) : 0;

    // Validate limit and offset
    if (isNaN(limit) || limit < 1 || limit > 1000) {
      throw new ValidationError('limit must be a number between 1 and 1000');
    }
    if (isNaN(offset) || offset < 0) {
      throw new ValidationError('offset must be a non-negative number');
    }

    const jobQueue = getJobQueue();
    const jobList = await jobQueue.getJobs({ status, type, limit, offset });
    const total = await jobQueue.countJobs({ status, type });

    return c.json({
      jobs: jobList.map(toJobResponse),
      total,
    });
  })
  // Get job statistics
  .get('/stats', async (c) => {
    const jobQueue = getJobQueue();
    const stats = await jobQueue.getStats();
    return c.json(stats);
  })
  // Get a single job by ID
  .get('/:id', async (c) => {
    const jobId = c.req.param('id');
    const jobQueue = getJobQueue();
    const job = await jobQueue.getJob(jobId);

    if (!job) {
      throw new NotFoundError('Job');
    }

    return c.json(toJobResponse(job));
  })
  // Retry a stalled job
  .post('/:id/retry', async (c) => {
    const jobId = c.req.param('id');
    const jobQueue = getJobQueue();

    // Use atomic operation - retryJob only succeeds for stalled jobs
    const success = await jobQueue.retryJob(jobId);
    if (!success) {
      // Re-fetch to provide accurate error message (avoids TOCTOU race condition)
      const job = await jobQueue.getJob(jobId);
      if (!job) {
        throw new NotFoundError('Job');
      }
      // Job exists but has wrong status
      throw new ValidationError('Only stalled jobs can be retried');
    }

    return c.json({ success: true });
  })
  // Cancel a pending or stalled job
  .delete('/:id', async (c) => {
    const jobId = c.req.param('id');
    const jobQueue = getJobQueue();

    // Use atomic operation - cancelJob only succeeds for pending or stalled jobs
    const success = await jobQueue.cancelJob(jobId);
    if (!success) {
      // Re-fetch to provide accurate error message (avoids TOCTOU race condition)
      const job = await jobQueue.getJob(jobId);
      if (!job) {
        throw new NotFoundError('Job');
      }
      // Job exists but has wrong status
      throw new ValidationError('Only pending or stalled jobs can be canceled');
    }

    return c.json({ success: true });
  });

export { jobs };
