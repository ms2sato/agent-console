/**
 * Local Job Queue with SQLite persistence.
 *
 * Provides guaranteed delivery for background task processing.
 * Jobs are persisted to SQLite and automatically retried until
 * successful or max attempts reached.
 *
 * Features:
 * - SQLite persistence via Kysely
 * - Event-driven processing (no polling)
 * - Exponential backoff retry
 * - Concurrency control
 * - Management API for viewing/retrying/canceling jobs
 */
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../database/schema.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('job-queue');

// =============================================================================
// Types
// =============================================================================

/**
 * Handler function for processing jobs.
 * @template T - The payload type for this job type
 */
export type JobHandler<T = unknown> = (payload: T) => Promise<void>;

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
 * Job record as stored in SQLite.
 */
export interface JobRecord {
  id: string;
  type: string;
  payload: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  next_retry_at: number;
  last_error: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

/**
 * Options for enqueuing a job.
 */
export interface EnqueueOptions {
  /** Higher priority jobs are processed first. Default: 0 */
  priority?: number;
  /** Maximum retry attempts before marking as stalled. Default: 5 */
  maxAttempts?: number;
  /** Custom job ID. If not provided, a UUID is generated. */
  jobId?: string;
}

/**
 * Options for querying jobs.
 */
export interface GetJobsOptions {
  /** Filter by status */
  status?: JobStatus;
  /** Filter by job type */
  type?: string;
  /** Maximum number of jobs to return. Default: 50 */
  limit?: number;
  /** Number of jobs to skip. Default: 0 */
  offset?: number;
}

/**
 * Job statistics by status.
 */
export interface JobStats {
  pending: number;
  processing: number;
  completed: number;
  stalled: number;
}

/**
 * Options for creating a JobQueue instance.
 */
export interface JobQueueOptions {
  /** Maximum concurrent job processing. Default: 4 */
  concurrency?: number;
}

// =============================================================================
// Test-Only API
// =============================================================================

/**
 * Interface for testing internals.
 * Only available when NODE_ENV === 'test'.
 */
export interface JobQueueTestAPI {
  claimNextJob(): Promise<JobRecord | null>;
  calculateBackoff(attempts: number): number;
  retryTimers: Map<string, Timer>;
}

// =============================================================================
// JobQueue Class
// =============================================================================

/**
 * Local Job Queue with SQLite persistence.
 *
 * This queue manages concurrency in-memory and is designed for single Node.js/Bun
 * process deployments. It is not suitable for multi-process or distributed scenarios.
 * For distributed job processing, consider external job queue systems like BullMQ.
 */
export class JobQueue {
  private db: Kysely<Database>;
  private handlers = new Map<string, JobHandler>();
  private emitter = new EventEmitter();
  private processing = 0;
  private concurrency: number;
  private retryTimers = new Map<string, Timer>();
  private running = false;

  // Retry configuration
  private readonly backoffBase = 1000; // 1 second
  private readonly backoffMax = 5 * 60_000; // 5 minutes max

  // Default job configuration
  private readonly defaultMaxAttempts = 5;
  private readonly defaultConcurrency = 4;

  constructor(db: Kysely<Database>, options?: JobQueueOptions) {
    this.db = db;
    this.concurrency = options?.concurrency ?? this.defaultConcurrency;
    logger.info({ concurrency: this.concurrency }, 'JobQueue initialized');
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Register a handler for a job type.
   * @param type - The job type identifier
   * @param handler - The function to process jobs of this type
   */
  registerHandler<T>(type: string, handler: JobHandler<T>): void {
    this.handlers.set(type, handler as JobHandler);
    logger.debug({ type }, 'Job handler registered');
  }

  /**
   * Add a job to the queue.
   * @param type - The job type (must have a registered handler)
   * @param payload - The job payload (will be JSON serialized)
   * @param options - Optional enqueue options
   * @returns The job ID
   */
  async enqueue(type: string, payload: unknown, options?: EnqueueOptions): Promise<string> {
    const id = options?.jobId ?? randomUUID();
    const now = Date.now();

    await this.db
      .insertInto('jobs')
      .values({
        id,
        type,
        payload: JSON.stringify(payload),
        status: JOB_STATUS.PENDING,
        priority: options?.priority ?? 0,
        attempts: 0,
        max_attempts: options?.maxAttempts ?? this.defaultMaxAttempts,
        next_retry_at: now,
        last_error: null,
        created_at: now,
        started_at: null,
        completed_at: null,
      })
      .execute();

    logger.info({ jobId: id, type, priority: options?.priority ?? 0 }, 'Job enqueued');
    this.emitter.emit('job:added');
    return id;
  }

  /**
   * Start processing jobs.
   * Recovers any jobs that were processing when the server crashed.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('JobQueue already running');
      return;
    }

    this.running = true;

    // Recover jobs that were processing when server crashed
    const result = await this.db
      .updateTable('jobs')
      .set({
        status: JOB_STATUS.PENDING,
        next_retry_at: Date.now(),
      })
      .where('status', '=', JOB_STATUS.PROCESSING)
      .executeTakeFirst();

    if (result.numUpdatedRows > 0n) {
      logger.info({ count: Number(result.numUpdatedRows) }, 'Recovered crashed jobs');
    }

    // Set up event listeners
    this.emitter.on('job:added', () => this.tryProcess());
    this.emitter.on('job:completed', () => this.tryProcess());

    // Schedule retries for pending jobs with future next_retry_at
    await this.scheduleAllRetries();

    // Start processing immediately available jobs
    this.tryProcess();

    logger.info('JobQueue started');
  }

  /**
   * Stop processing jobs.
   * Clears all retry timers and removes event listeners.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;

    // Clear all retry timers
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.emitter.removeAllListeners();

    logger.info('JobQueue stopped');
  }

  // ===========================================================================
  // Management API
  // ===========================================================================

  /**
   * Get a list of jobs with optional filtering.
   */
  async getJobs(options?: GetJobsOptions): Promise<JobRecord[]> {
    let query = this.db.selectFrom('jobs').selectAll();

    if (options?.status) {
      query = query.where('status', '=', options.status);
    }
    if (options?.type) {
      query = query.where('type', '=', options.type);
    }

    query = query.orderBy('created_at', 'desc');

    // Apply limit. When offset is provided without limit, use a default of 50
    const effectiveLimit = options?.limit ?? (options?.offset !== undefined ? 50 : undefined);
    if (effectiveLimit !== undefined) {
      query = query.limit(effectiveLimit);
    }
    if (options?.offset) {
      query = query.offset(options.offset);
    }

    const rows = await query.execute();
    return rows as JobRecord[];
  }

  /**
   * Count jobs with optional filtering.
   * Used for pagination total count.
   */
  async countJobs(options?: Pick<GetJobsOptions, 'status' | 'type'>): Promise<number> {
    let query = this.db.selectFrom('jobs').select(this.db.fn.count<number>('id').as('count'));

    if (options?.status) {
      query = query.where('status', '=', options.status);
    }
    if (options?.type) {
      query = query.where('type', '=', options.type);
    }

    const result = await query.executeTakeFirst();
    return result?.count ?? 0;
  }

  /**
   * Get a single job by ID.
   */
  async getJob(id: string): Promise<JobRecord | null> {
    const row = await this.db
      .selectFrom('jobs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return (row as JobRecord) ?? null;
  }

  /**
   * Get job statistics by status.
   */
  async getStats(): Promise<JobStats> {
    const rows = await this.db
      .selectFrom('jobs')
      .select(['status', this.db.fn.count<number>('id').as('count')])
      .groupBy('status')
      .execute();

    const stats: JobStats = { pending: 0, processing: 0, completed: 0, stalled: 0 };
    for (const row of rows) {
      if (row.status in stats) {
        stats[row.status as keyof JobStats] = row.count;
      }
    }
    return stats;
  }

  /**
   * Retry a stalled job.
   * Resets the job to pending status with zero attempts.
   * @returns true if job was found and retried, false otherwise
   */
  async retryJob(id: string): Promise<boolean> {
    const result = await this.db
      .updateTable('jobs')
      .set({
        status: JOB_STATUS.PENDING,
        attempts: 0,
        next_retry_at: Date.now(),
        last_error: null,
      })
      .where('id', '=', id)
      .where('status', '=', JOB_STATUS.STALLED)
      .executeTakeFirst();

    if (result.numUpdatedRows > 0n) {
      logger.info({ jobId: id }, 'Job manually retried');
      this.emitter.emit('job:added');
      return true;
    }
    return false;
  }

  /**
   * Cancel a pending or stalled job.
   * @returns true if job was found and canceled, false otherwise
   */
  async cancelJob(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('jobs')
      .where('id', '=', id)
      .where('status', 'in', [JOB_STATUS.PENDING, JOB_STATUS.STALLED])
      .executeTakeFirst();

    if (result.numDeletedRows > 0n) {
      // Clear any retry timer for this job
      const timer = this.retryTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.retryTimers.delete(id);
      }
      logger.info({ jobId: id }, 'Job canceled');
      return true;
    }
    return false;
  }

  // ===========================================================================
  // Internal Processing
  // ===========================================================================

  /**
   * Attempt to process pending jobs up to the concurrency limit.
   */
  private tryProcess(): void {
    if (!this.running) {
      return;
    }

    const processNext = async () => {
      while (this.processing < this.concurrency && this.running) {
        const job = await this.claimNextJob();
        if (!job) break;

        this.processing++;
        this.processJob(job).finally(() => {
          this.processing--;
          this.emitter.emit('job:completed');
        });
      }
    };

    processNext().catch((err) => {
      logger.error({ err }, 'Error in tryProcess');
    });
  }

  /**
   * Claim the next available job for processing.
   * Uses a single UPDATE with RETURNING to atomically find and claim a job.
   */
  private async claimNextJob(): Promise<JobRecord | null> {
    const now = Date.now();

    // Atomically find and claim the next available job in a single statement
    // Using raw SQL for UPDATE ... RETURNING with subquery
    const result = await sql<JobRecord>`
      UPDATE jobs
      SET status = ${JOB_STATUS.PROCESSING}, started_at = ${now}
      WHERE id = (
        SELECT id FROM jobs
        WHERE status = ${JOB_STATUS.PENDING} AND next_retry_at <= ${now}
        ORDER BY priority DESC, next_retry_at ASC
        LIMIT 1
      )
      RETURNING *
    `.execute(this.db);

    return result.rows[0] ?? null;
  }

  /**
   * Process a single job.
   */
  private async processJob(job: JobRecord): Promise<void> {
    const handler = this.handlers.get(job.type);

    if (!handler) {
      await this.handleFailure(job, new Error(`No handler registered for job type: ${job.type}`));
      return;
    }

    try {
      const payload = JSON.parse(job.payload);
      logger.debug({ jobId: job.id, type: job.type }, 'Processing job');
      await handler(payload);
      await this.markCompleted(job.id);
      logger.info({ jobId: job.id, type: job.type }, 'Job completed');
    } catch (error) {
      await this.handleFailure(job, error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Mark a job as completed.
   */
  private async markCompleted(id: string): Promise<void> {
    await this.db
      .updateTable('jobs')
      .set({
        status: JOB_STATUS.COMPLETED,
        completed_at: Date.now(),
      })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Handle a job failure.
   * Either schedules a retry or marks the job as stalled.
   */
  private async handleFailure(job: JobRecord, error: Error): Promise<void> {
    const attempts = job.attempts + 1;
    const now = Date.now();

    logger.warn(
      { jobId: job.id, type: job.type, attempts, error: error.message },
      'Job failed'
    );

    if (attempts >= job.max_attempts) {
      // Max attempts reached - mark as stalled
      await this.db
        .updateTable('jobs')
        .set({
          status: JOB_STATUS.STALLED,
          attempts,
          last_error: error.message,
        })
        .where('id', '=', job.id)
        .execute();
      logger.error({ jobId: job.id, type: job.type, attempts }, 'Job stalled after max attempts');
    } else {
      // Schedule retry with exponential backoff
      const backoff = this.calculateBackoff(attempts);
      const nextRetryAt = now + backoff;

      await this.db
        .updateTable('jobs')
        .set({
          status: JOB_STATUS.PENDING,
          attempts,
          next_retry_at: nextRetryAt,
          last_error: error.message,
        })
        .where('id', '=', job.id)
        .execute();

      this.scheduleRetry(job.id, backoff);
      logger.debug(
        { jobId: job.id, type: job.type, attempts, backoffMs: backoff },
        'Job scheduled for retry'
      );
    }
  }

  /**
   * Calculate exponential backoff delay.
   * @param attempts - Number of attempts so far
   * @returns Delay in milliseconds
   */
  private calculateBackoff(attempts: number): number {
    // Exponential backoff: 1s, 2s, 4s, 8s, ... up to max
    const backoff = this.backoffBase * Math.pow(2, attempts - 1);
    return Math.min(backoff, this.backoffMax);
  }

  /**
   * Schedule a retry for a job after a delay.
   */
  private scheduleRetry(jobId: string, delay: number): void {
    // Clear existing timer if any
    const existing = this.retryTimers.get(jobId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.retryTimers.delete(jobId);
      this.emitter.emit('job:added');
    }, delay);

    this.retryTimers.set(jobId, timer);
  }

  /**
   * Schedule retries for all pending jobs with future next_retry_at.
   * Called on startup to resume processing after server restart.
   */
  private async scheduleAllRetries(): Promise<void> {
    const now = Date.now();
    const pendingJobs = await this.db
      .selectFrom('jobs')
      .select(['id', 'next_retry_at'])
      .where('status', '=', JOB_STATUS.PENDING)
      .where('next_retry_at', '>', now)
      .execute();

    for (const job of pendingJobs) {
      this.scheduleRetry(job.id, job.next_retry_at - now);
    }

    if (pendingJobs.length > 0) {
      logger.debug({ count: pendingJobs.length }, 'Scheduled pending retries');
    }
  }

  // ===========================================================================
  // Test-Only API
  // ===========================================================================

  /**
   * Access to internal state for testing purposes.
   * @internal This property is for testing only. Do not use in production code.
   */
  get __testOnly(): JobQueueTestAPI {
    return {
      claimNextJob: this.claimNextJob.bind(this),
      calculateBackoff: this.calculateBackoff.bind(this),
      retryTimers: this.retryTimers,
    };
  }
}
