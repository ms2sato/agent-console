/**
 * Local Job Queue with SQLite persistence.
 *
 * Provides guaranteed delivery for background task processing.
 * Jobs are persisted to SQLite and automatically retried until
 * successful or max attempts reached.
 *
 * Features:
 * - SQLite persistence via bun:sqlite
 * - Event-driven processing (no polling)
 * - Exponential backoff retry
 * - Concurrency control
 * - Management API for viewing/retrying/canceling jobs
 */
import { Database } from 'bun:sqlite';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
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
// JobQueue Class
// =============================================================================

export class JobQueue {
  private db: Database;
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

  constructor(dbPath: string, options?: JobQueueOptions) {
    this.db = new Database(dbPath);
    this.concurrency = options?.concurrency ?? this.defaultConcurrency;
    this.initSchema();
    logger.info({ dbPath, concurrency: this.concurrency }, 'JobQueue initialized');
  }

  /**
   * Initialize the database schema for jobs.
   */
  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        next_retry_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER
      )
    `);
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_jobs_pending ON jobs(status, priority DESC, next_retry_at)`
    );
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type)`);
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
  enqueue(type: string, payload: unknown, options?: EnqueueOptions): string {
    const id = randomUUID();
    const now = Date.now();

    this.db.run(
      `
      INSERT INTO jobs (id, type, payload, priority, max_attempts, next_retry_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      [
        id,
        type,
        JSON.stringify(payload),
        options?.priority ?? 0,
        options?.maxAttempts ?? this.defaultMaxAttempts,
        now,
        now,
      ]
    );

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
    const recovered = this.db.run(
      `
      UPDATE jobs
      SET status = 'pending', next_retry_at = ?
      WHERE status = 'processing'
    `,
      [Date.now()]
    );

    if (recovered.changes > 0) {
      logger.info({ count: recovered.changes }, 'Recovered crashed jobs');
    }

    // Set up event listeners
    this.emitter.on('job:added', () => this.tryProcess());
    this.emitter.on('job:completed', () => this.tryProcess());

    // Schedule retries for pending jobs with future next_retry_at
    this.scheduleAllRetries();

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

  /**
   * Close the database connection.
   * Should be called during server shutdown after stop().
   */
  close(): void {
    this.db.close();
    logger.info('JobQueue database closed');
  }

  // ===========================================================================
  // Management API
  // ===========================================================================

  /**
   * Get a list of jobs with optional filtering.
   */
  getJobs(options?: GetJobsOptions): JobRecord[] {
    let sql = 'SELECT * FROM jobs WHERE 1=1';
    const params: (string | number)[] = [];

    if (options?.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }
    if (options?.type) {
      sql += ' AND type = ?';
      params.push(options.type);
    }

    sql += ' ORDER BY created_at DESC';

    // Apply limit. When offset is provided without limit, use a default of 50
    // to prevent unbounded query results
    const effectiveLimit = options?.limit ?? (options?.offset !== undefined ? 50 : undefined);
    if (effectiveLimit !== undefined) {
      sql += ' LIMIT ?';
      params.push(effectiveLimit);
    }
    if (options?.offset) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }

    return this.db.query(sql).all(...params) as JobRecord[];
  }

  /**
   * Count jobs with optional filtering.
   * Used for pagination total count.
   */
  countJobs(options?: Pick<GetJobsOptions, 'status' | 'type'>): number {
    let sql = 'SELECT COUNT(*) as count FROM jobs WHERE 1=1';
    const params: string[] = [];

    if (options?.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }
    if (options?.type) {
      sql += ' AND type = ?';
      params.push(options.type);
    }

    const result = this.db.query(sql).get(...params) as { count: number };
    return result.count;
  }

  /**
   * Get a single job by ID.
   */
  getJob(id: string): JobRecord | null {
    return this.db.query('SELECT * FROM jobs WHERE id = ?').get(id) as JobRecord | null;
  }

  /**
   * Get job statistics by status.
   */
  getStats(): JobStats {
    const result = this.db
      .query(
        `
      SELECT status, COUNT(*) as count FROM jobs GROUP BY status
    `
      )
      .all() as { status: string; count: number }[];

    const stats: JobStats = { pending: 0, processing: 0, completed: 0, stalled: 0 };
    for (const row of result) {
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
  retryJob(id: string): boolean {
    const result = this.db.run(
      `
      UPDATE jobs
      SET status = 'pending', attempts = 0, next_retry_at = ?, last_error = NULL
      WHERE id = ? AND status = 'stalled'
    `,
      [Date.now(), id]
    );

    if (result.changes > 0) {
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
  cancelJob(id: string): boolean {
    const result = this.db.run(
      `
      DELETE FROM jobs WHERE id = ? AND status IN ('pending', 'stalled')
    `,
      [id]
    );

    if (result.changes > 0) {
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

    while (this.processing < this.concurrency) {
      const job = this.claimNextJob();
      if (!job) break;

      this.processing++;
      this.processJob(job).finally(() => {
        this.processing--;
        this.emitter.emit('job:completed');
      });
    }
  }

  /**
   * Claim the next available job for processing.
   * Uses a single UPDATE with RETURNING to atomically find and claim a job.
   */
  private claimNextJob(): JobRecord | null {
    const now = Date.now();

    // Atomically find and claim the next available job in a single statement
    const job = this.db
      .query(
        `
      UPDATE jobs
      SET status = 'processing', started_at = ?
      WHERE id = (
        SELECT id FROM jobs
        WHERE status = 'pending' AND next_retry_at <= ?
        ORDER BY priority DESC, next_retry_at ASC
        LIMIT 1
      )
      RETURNING *
    `
      )
      .get(now, now) as JobRecord | null;

    return job;
  }

  /**
   * Process a single job.
   */
  private async processJob(job: JobRecord): Promise<void> {
    const handler = this.handlers.get(job.type);

    if (!handler) {
      this.handleFailure(job, new Error(`No handler registered for job type: ${job.type}`));
      return;
    }

    try {
      const payload = JSON.parse(job.payload);
      logger.debug({ jobId: job.id, type: job.type }, 'Processing job');
      await handler(payload);
      this.markCompleted(job.id);
      logger.info({ jobId: job.id, type: job.type }, 'Job completed');
    } catch (error) {
      this.handleFailure(job, error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Mark a job as completed.
   */
  private markCompleted(id: string): void {
    this.db.run(
      `
      UPDATE jobs
      SET status = 'completed', completed_at = ?
      WHERE id = ?
    `,
      [Date.now(), id]
    );
  }

  /**
   * Handle a job failure.
   * Either schedules a retry or marks the job as stalled.
   */
  private handleFailure(job: JobRecord, error: Error): void {
    const attempts = job.attempts + 1;
    const now = Date.now();

    logger.warn(
      { jobId: job.id, type: job.type, attempts, error: error.message },
      'Job failed'
    );

    if (attempts >= job.max_attempts) {
      // Max attempts reached - mark as stalled
      this.db.run(
        `
        UPDATE jobs
        SET status = 'stalled', attempts = ?, last_error = ?
        WHERE id = ?
      `,
        [attempts, error.message, job.id]
      );
      logger.error({ jobId: job.id, type: job.type, attempts }, 'Job stalled after max attempts');
    } else {
      // Schedule retry with exponential backoff
      const backoff = this.calculateBackoff(attempts);
      const nextRetryAt = now + backoff;

      this.db.run(
        `
        UPDATE jobs
        SET status = 'pending', attempts = ?, next_retry_at = ?, last_error = ?
        WHERE id = ?
      `,
        [attempts, nextRetryAt, error.message, job.id]
      );

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
  private scheduleAllRetries(): void {
    const now = Date.now();
    const pendingJobs = this.db
      .query(
        `
      SELECT id, next_retry_at FROM jobs
      WHERE status = 'pending' AND next_retry_at > ?
    `
      )
      .all(now) as { id: string; next_retry_at: number }[];

    for (const job of pendingJobs) {
      this.scheduleRetry(job.id, job.next_retry_at - now);
    }

    if (pendingJobs.length > 0) {
      logger.debug({ count: pendingJobs.length }, 'Scheduled pending retries');
    }
  }
}
