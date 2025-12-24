import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { JobQueue, type JobRecord } from '../job-queue.js';

describe('JobQueue', () => {
  let jobQueue: JobQueue;

  beforeEach(() => {
    // Use in-memory SQLite database for tests
    // This avoids conflicts with memfs mocks from other tests
    jobQueue = new JobQueue(':memory:');
  });

  afterEach(async () => {
    await jobQueue.stop();
    jobQueue.close();
  });

  // ===========================================================================
  // Enqueue Tests
  // ===========================================================================

  describe('enqueue', () => {
    it('should add job with pending status', () => {
      const id = jobQueue.enqueue('test:job', { foo: 'bar' });
      const job = jobQueue.getJob(id);

      expect(job).not.toBeNull();
      expect(job?.status).toBe('pending');
      expect(job?.type).toBe('test:job');
      expect(JSON.parse(job?.payload ?? '{}')).toEqual({ foo: 'bar' });
    });

    it('should generate unique job IDs', () => {
      const id1 = jobQueue.enqueue('test:job', { n: 1 });
      const id2 = jobQueue.enqueue('test:job', { n: 2 });

      expect(id1).not.toBe(id2);
    });

    it('should respect priority option', () => {
      const lowId = jobQueue.enqueue('test:job', {}, { priority: 0 });
      const highId = jobQueue.enqueue('test:job', {}, { priority: 10 });

      const lowJob = jobQueue.getJob(lowId);
      const highJob = jobQueue.getJob(highId);

      expect(lowJob?.priority).toBe(0);
      expect(highJob?.priority).toBe(10);
    });

    it('should respect maxAttempts option', () => {
      const id = jobQueue.enqueue('test:job', {}, { maxAttempts: 3 });
      const job = jobQueue.getJob(id);

      expect(job?.max_attempts).toBe(3);
    });

    it('should set default maxAttempts to 5', () => {
      const id = jobQueue.enqueue('test:job', {});
      const job = jobQueue.getJob(id);

      expect(job?.max_attempts).toBe(5);
    });

    it('should set created_at timestamp', () => {
      const before = Date.now();
      const id = jobQueue.enqueue('test:job', {});
      const after = Date.now();

      const job = jobQueue.getJob(id);
      expect(job?.created_at).toBeGreaterThanOrEqual(before);
      expect(job?.created_at).toBeLessThanOrEqual(after);
    });
  });

  // ===========================================================================
  // Processing Tests
  // ===========================================================================

  describe('processing', () => {
    it('should process pending jobs', async () => {
      let processed = false;
      jobQueue.registerHandler('test:job', async () => {
        processed = true;
      });

      jobQueue.enqueue('test:job', {});
      await jobQueue.start();

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(processed).toBe(true);
    });

    it('should pass payload to handler', async () => {
      let receivedPayload: unknown;
      jobQueue.registerHandler<{ value: number }>('test:job', async (payload) => {
        receivedPayload = payload;
      });

      jobQueue.enqueue('test:job', { value: 42 });
      await jobQueue.start();

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(receivedPayload).toEqual({ value: 42 });
    });

    it('should mark job as completed after successful processing', async () => {
      jobQueue.registerHandler('test:job', async () => {
        // Success
      });

      const id = jobQueue.enqueue('test:job', {});
      await jobQueue.start();

      await new Promise((resolve) => setTimeout(resolve, 100));

      const job = jobQueue.getJob(id);
      expect(job?.status).toBe('completed');
      expect(job?.completed_at).not.toBeNull();
    });

    it('should process multiple jobs', async () => {
      const processed: number[] = [];
      jobQueue.registerHandler<{ n: number }>('test:job', async (payload) => {
        processed.push(payload.n);
      });

      jobQueue.enqueue('test:job', { n: 1 });
      jobQueue.enqueue('test:job', { n: 2 });
      jobQueue.enqueue('test:job', { n: 3 });

      await jobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(processed.sort()).toEqual([1, 2, 3]);
    });

    it('should process higher priority jobs first', async () => {
      // Close the default queue and create one with concurrency 1
      await jobQueue.stop();
      jobQueue.close();
      jobQueue = new JobQueue(':memory:', { concurrency: 1 });

      const processed: number[] = [];
      jobQueue.registerHandler<{ n: number }>('test:job', async (payload) => {
        processed.push(payload.n);
      });

      // Enqueue low priority first
      jobQueue.enqueue('test:job', { n: 1 }, { priority: 0 });
      jobQueue.enqueue('test:job', { n: 2 }, { priority: 10 }); // High priority
      jobQueue.enqueue('test:job', { n: 3 }, { priority: 5 }); // Medium priority

      await jobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Higher priority should be processed first
      expect(processed[0]).toBe(2); // priority 10
      expect(processed[1]).toBe(3); // priority 5
      expect(processed[2]).toBe(1); // priority 0
    });

    it('should respect concurrency limit', async () => {
      // Close the default queue and create one with concurrency 2
      await jobQueue.stop();
      jobQueue.close();
      jobQueue = new JobQueue(':memory:', { concurrency: 2 });

      let concurrent = 0;
      let maxConcurrent = 0;

      jobQueue.registerHandler('test:job', async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 50));
        concurrent--;
      });

      jobQueue.enqueue('test:job', {});
      jobQueue.enqueue('test:job', {});
      jobQueue.enqueue('test:job', {});
      jobQueue.enqueue('test:job', {});

      await jobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(maxConcurrent).toBe(2);
    });
  });

  // ===========================================================================
  // Retry Tests
  // ===========================================================================

  describe('retry behavior', () => {
    it('should retry failed job', async () => {
      let attempts = 0;
      jobQueue.registerHandler('test:job', async () => {
        attempts++;
        if (attempts < 2) {
          throw new Error('Temporary failure');
        }
      });

      const id = jobQueue.enqueue('test:job', {}, { maxAttempts: 3 });
      await jobQueue.start();

      // Wait for initial attempt and retry
      await new Promise((resolve) => setTimeout(resolve, 2500));

      expect(attempts).toBe(2);
      const job = jobQueue.getJob(id);
      expect(job?.status).toBe('completed');
    });

    it('should record last_error on failure', async () => {
      jobQueue.registerHandler('test:job', async () => {
        throw new Error('Test error message');
      });

      const id = jobQueue.enqueue('test:job', {}, { maxAttempts: 1 });
      await jobQueue.start();

      await new Promise((resolve) => setTimeout(resolve, 100));

      const job = jobQueue.getJob(id);
      expect(job?.last_error).toBe('Test error message');
    });

    it('should mark job as stalled after max attempts', async () => {
      let attempts = 0;
      jobQueue.registerHandler('test:job', async () => {
        attempts++;
        throw new Error('Persistent failure');
      });

      const id = jobQueue.enqueue('test:job', {}, { maxAttempts: 2 });
      await jobQueue.start();

      // Wait for all attempts
      await new Promise((resolve) => setTimeout(resolve, 3000));

      expect(attempts).toBe(2);
      const job = jobQueue.getJob(id);
      expect(job?.status).toBe('stalled');
      expect(job?.attempts).toBe(2);
    });

    it('should use exponential backoff', async () => {
      const timestamps: number[] = [];
      let attempts = 0;

      jobQueue.registerHandler('test:job', async () => {
        timestamps.push(Date.now());
        attempts++;
        if (attempts < 3) {
          throw new Error('Failure');
        }
      });

      jobQueue.enqueue('test:job', {}, { maxAttempts: 3 });
      await jobQueue.start();

      // Wait for retries (1s + 2s = 3s, plus some buffer)
      await new Promise((resolve) => setTimeout(resolve, 4000));

      expect(timestamps.length).toBe(3);

      // First retry after ~1 second
      const delay1 = timestamps[1] - timestamps[0];
      expect(delay1).toBeGreaterThanOrEqual(900);
      expect(delay1).toBeLessThan(1500);

      // Second retry after ~2 seconds
      const delay2 = timestamps[2] - timestamps[1];
      expect(delay2).toBeGreaterThanOrEqual(1800);
      expect(delay2).toBeLessThan(2500);
    });
  });

  // ===========================================================================
  // Recovery Tests
  // ===========================================================================

  describe('crash recovery', () => {
    it('should recover processing jobs on start', async () => {
      // Create a job and manually set it to processing (simulating a crash)
      const id = jobQueue.enqueue('test:job', {});

      // Simulate crash by directly updating the database
      const db = (jobQueue as unknown as { db: { run: (sql: string, params: unknown[]) => void } }).db;
      db.run('UPDATE jobs SET status = ? WHERE id = ?', ['processing', id]);

      // Verify it's in processing state
      let job = jobQueue.getJob(id);
      expect(job?.status).toBe('processing');

      // Register handler and start (which should recover)
      let processed = false;
      jobQueue.registerHandler('test:job', async () => {
        processed = true;
      });

      await jobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Job should have been recovered and processed
      job = jobQueue.getJob(id);
      expect(job?.status).toBe('completed');
      expect(processed).toBe(true);
    });
  });

  // ===========================================================================
  // Management API Tests
  // ===========================================================================

  describe('getJobs', () => {
    it('should return all jobs', () => {
      jobQueue.enqueue('type1', {});
      jobQueue.enqueue('type2', {});
      jobQueue.enqueue('type1', {});

      const jobs = jobQueue.getJobs();
      expect(jobs.length).toBe(3);
    });

    it('should filter by status', async () => {
      jobQueue.registerHandler('test:job', async () => {});

      jobQueue.enqueue('test:job', {});
      jobQueue.enqueue('test:job', {});

      await jobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const completed = jobQueue.getJobs({ status: 'completed' });
      expect(completed.length).toBe(2);

      const pending = jobQueue.getJobs({ status: 'pending' });
      expect(pending.length).toBe(0);
    });

    it('should filter by type', () => {
      jobQueue.enqueue('type1', {});
      jobQueue.enqueue('type2', {});
      jobQueue.enqueue('type1', {});

      const type1Jobs = jobQueue.getJobs({ type: 'type1' });
      expect(type1Jobs.length).toBe(2);

      const type2Jobs = jobQueue.getJobs({ type: 'type2' });
      expect(type2Jobs.length).toBe(1);
    });

    it('should respect limit and offset', () => {
      jobQueue.enqueue('test:job', { n: 1 });
      jobQueue.enqueue('test:job', { n: 2 });
      jobQueue.enqueue('test:job', { n: 3 });

      const limited = jobQueue.getJobs({ limit: 2 });
      expect(limited.length).toBe(2);

      const offset = jobQueue.getJobs({ limit: 2, offset: 1 });
      expect(offset.length).toBe(2);
    });
  });

  describe('getJob', () => {
    it('should return job by id', () => {
      const id = jobQueue.enqueue('test:job', { value: 123 });
      const job = jobQueue.getJob(id);

      expect(job).not.toBeNull();
      expect(job?.id).toBe(id);
    });

    it('should return null for non-existent id', () => {
      const job = jobQueue.getJob('non-existent-id');
      expect(job).toBeNull();
    });
  });

  describe('countJobs', () => {
    it('should return total count of all jobs', () => {
      jobQueue.enqueue('type1', {});
      jobQueue.enqueue('type2', {});
      jobQueue.enqueue('type1', {});

      const count = jobQueue.countJobs();
      expect(count).toBe(3);
    });

    it('should filter by status', async () => {
      jobQueue.registerHandler('test:job', async () => {});

      jobQueue.enqueue('test:job', {});
      jobQueue.enqueue('test:job', {});

      await jobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const completedCount = jobQueue.countJobs({ status: 'completed' });
      expect(completedCount).toBe(2);

      const pendingCount = jobQueue.countJobs({ status: 'pending' });
      expect(pendingCount).toBe(0);
    });

    it('should filter by type', () => {
      jobQueue.enqueue('type1', {});
      jobQueue.enqueue('type2', {});
      jobQueue.enqueue('type1', {});

      const type1Count = jobQueue.countJobs({ type: 'type1' });
      expect(type1Count).toBe(2);

      const type2Count = jobQueue.countJobs({ type: 'type2' });
      expect(type2Count).toBe(1);
    });

    it('should filter by both status and type', async () => {
      jobQueue.registerHandler('type1', async () => {});
      jobQueue.registerHandler('type2', async () => {
        throw new Error('Always fails');
      });

      jobQueue.enqueue('type1', {});
      jobQueue.enqueue('type1', {});
      jobQueue.enqueue('type2', {}, { maxAttempts: 1 });

      await jobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const completedType1 = jobQueue.countJobs({ status: 'completed', type: 'type1' });
      expect(completedType1).toBe(2);

      const stalledType2 = jobQueue.countJobs({ status: 'stalled', type: 'type2' });
      expect(stalledType2).toBe(1);
    });

    it('should return zero for empty queue', () => {
      const count = jobQueue.countJobs();
      expect(count).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return correct counts', async () => {
      // Create handler that fails once
      let failCount = 0;
      jobQueue.registerHandler('test:job', async () => {
        failCount++;
        if (failCount <= 2) {
          throw new Error('Fail');
        }
      });

      // Create jobs with different outcomes
      jobQueue.enqueue('test:job', {}, { maxAttempts: 1 }); // Will stall
      jobQueue.enqueue('test:job', {}, { maxAttempts: 1 }); // Will stall
      jobQueue.enqueue('test:job', {}); // Will succeed after 2 fails

      await jobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 200));

      const stats = jobQueue.getStats();
      expect(stats.stalled).toBe(2);
      expect(stats.completed).toBe(1);
      expect(stats.processing).toBe(0);
    });

    it('should return zeros for empty queue', () => {
      const stats = jobQueue.getStats();
      expect(stats).toEqual({
        pending: 0,
        processing: 0,
        completed: 0,
        stalled: 0,
      });
    });
  });

  describe('retryJob', () => {
    it('should reset stalled job to pending', async () => {
      jobQueue.registerHandler('test:job', async () => {
        throw new Error('Always fails');
      });

      const id = jobQueue.enqueue('test:job', {}, { maxAttempts: 1 });
      await jobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify it's stalled
      let job = jobQueue.getJob(id);
      expect(job?.status).toBe('stalled');

      // Stop the queue before retrying to prevent immediate processing
      await jobQueue.stop();

      // Retry it
      const success = jobQueue.retryJob(id);
      expect(success).toBe(true);

      job = jobQueue.getJob(id);
      expect(job?.status).toBe('pending');
      expect(job?.attempts).toBe(0);
      expect(job?.last_error).toBeNull();
    });

    it('should return false for non-stalled job', () => {
      const id = jobQueue.enqueue('test:job', {});
      const success = jobQueue.retryJob(id);
      expect(success).toBe(false);
    });

    it('should return false for non-existent job', () => {
      const success = jobQueue.retryJob('non-existent');
      expect(success).toBe(false);
    });
  });

  describe('cancelJob', () => {
    it('should remove pending job', () => {
      const id = jobQueue.enqueue('test:job', {});

      const success = jobQueue.cancelJob(id);
      expect(success).toBe(true);

      const job = jobQueue.getJob(id);
      expect(job).toBeNull();
    });

    it('should remove stalled job', async () => {
      jobQueue.registerHandler('test:job', async () => {
        throw new Error('Fail');
      });

      const id = jobQueue.enqueue('test:job', {}, { maxAttempts: 1 });
      await jobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const success = jobQueue.cancelJob(id);
      expect(success).toBe(true);

      const job = jobQueue.getJob(id);
      expect(job).toBeNull();
    });

    it('should not cancel completed job', async () => {
      jobQueue.registerHandler('test:job', async () => {});

      const id = jobQueue.enqueue('test:job', {});
      await jobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const success = jobQueue.cancelJob(id);
      expect(success).toBe(false);

      const job = jobQueue.getJob(id);
      expect(job).not.toBeNull();
      expect(job?.status).toBe('completed');
    });

    it('should not cancel processing job', async () => {
      let resolveHandler: () => void;
      const handlerPromise = new Promise<void>((resolve) => {
        resolveHandler = resolve;
      });

      jobQueue.registerHandler('test:job', async () => {
        await handlerPromise; // Block until we allow completion
      });

      const id = jobQueue.enqueue('test:job', {});
      await jobQueue.start();

      // Wait for job to start processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      const job = jobQueue.getJob(id);
      expect(job?.status).toBe('processing');

      // Try to cancel while processing
      const success = jobQueue.cancelJob(id);
      expect(success).toBe(false);

      // Verify job still exists
      expect(jobQueue.getJob(id)).not.toBeNull();

      // Complete the job
      resolveHandler!();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(jobQueue.getJob(id)?.status).toBe('completed');
    });

    it('should return false for non-existent job', () => {
      const success = jobQueue.cancelJob('non-existent');
      expect(success).toBe(false);
    });
  });

  // ===========================================================================
  // Handler Tests
  // ===========================================================================

  describe('handler registration', () => {
    it('should handle job with registered handler', async () => {
      let handled = false;
      jobQueue.registerHandler('custom:type', async () => {
        handled = true;
      });

      jobQueue.enqueue('custom:type', {});
      await jobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(handled).toBe(true);
    });

    it('should fail job with unregistered handler', async () => {
      const id = jobQueue.enqueue('unknown:type', {}, { maxAttempts: 1 });
      await jobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const job = jobQueue.getJob(id);
      expect(job?.status).toBe('stalled');
      expect(job?.last_error).toContain('No handler registered');
    });
  });

  // ===========================================================================
  // Concurrent Job Claiming Tests
  // ===========================================================================

  describe('concurrent job claiming', () => {
    it('should handle concurrent job claiming safely', async () => {
      // Close the default queue and create one with higher concurrency
      await jobQueue.stop();
      jobQueue.close();
      jobQueue = new JobQueue(':memory:', { concurrency: 10 });

      const processedJobs: string[] = [];
      jobQueue.registerHandler<{ id: string }>('test:job', async (payload) => {
        processedJobs.push(payload.id);
        // Simulate some work
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      // Create 3 jobs
      const job1 = jobQueue.enqueue('test:job', { id: 'job1' });
      const job2 = jobQueue.enqueue('test:job', { id: 'job2' });
      const job3 = jobQueue.enqueue('test:job', { id: 'job3' });

      // Use Promise.all to start the queue, which will claim jobs concurrently
      await jobQueue.start();

      // Wait for all jobs to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify each job is only claimed once (no duplicates)
      expect(processedJobs.length).toBe(3);
      expect(processedJobs).toContain('job1');
      expect(processedJobs).toContain('job2');
      expect(processedJobs).toContain('job3');

      // Verify all jobs are completed
      expect(jobQueue.getJob(job1)?.status).toBe('completed');
      expect(jobQueue.getJob(job2)?.status).toBe('completed');
      expect(jobQueue.getJob(job3)?.status).toBe('completed');
    });

    it('should not allow duplicate claims when claimNextJob is called concurrently', async () => {
      // Close the default queue and create a fresh one
      await jobQueue.stop();
      jobQueue.close();
      jobQueue = new JobQueue(':memory:', { concurrency: 1 });

      // Create 3 jobs
      jobQueue.enqueue('test:job', { id: 1 });
      jobQueue.enqueue('test:job', { id: 2 });
      jobQueue.enqueue('test:job', { id: 3 });

      // Access private method for testing atomicity
      const claimNextJob = (
        jobQueue as unknown as { claimNextJob: () => JobRecord | null }
      ).claimNextJob.bind(jobQueue);

      // Call claimNextJob concurrently using Promise.all
      const claims = await Promise.all([
        Promise.resolve(claimNextJob()),
        Promise.resolve(claimNextJob()),
        Promise.resolve(claimNextJob()),
      ]);

      // Each claim should return a unique job (no duplicates)
      const claimedIds = claims.filter((c) => c !== null).map((c) => c!.id);
      const uniqueIds = new Set(claimedIds);

      expect(claimedIds.length).toBe(uniqueIds.size);
    });
  });

  // ===========================================================================
  // Invalid Payload Tests
  // ===========================================================================

  describe('invalid payload handling', () => {
    it('should handle invalid JSON payload', async () => {
      // Create a job with valid JSON first
      const id = jobQueue.enqueue('test:job', { valid: true }, { maxAttempts: 1 });

      // Directly update the database with invalid JSON
      const db = (
        jobQueue as unknown as { db: { run: (sql: string, params: unknown[]) => void } }
      ).db;
      db.run('UPDATE jobs SET payload = ? WHERE id = ?', ['not valid json {{{', id]);

      jobQueue.registerHandler('test:job', async () => {
        // This should not be called because parsing will fail
      });

      await jobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const job = jobQueue.getJob(id);
      expect(job?.status).toBe('stalled');
      expect(job?.last_error).toContain('JSON');
    });
  });

  // ===========================================================================
  // Non-Error Throw Tests
  // ===========================================================================

  describe('non-Error throws', () => {
    it('should handle non-Error throws from handler', async () => {
      jobQueue.registerHandler('throws-string', async () => {
        throw 'This is a string error';
      });

      const id = jobQueue.enqueue('throws-string', {}, { maxAttempts: 1 });
      await jobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const job = jobQueue.getJob(id);
      expect(job?.status).toBe('stalled');
      expect(job?.last_error).toContain('This is a string error');
    });

    it('should handle undefined throws from handler', async () => {
      jobQueue.registerHandler('throws-undefined', async () => {
        throw undefined;
      });

      const id = jobQueue.enqueue('throws-undefined', {}, { maxAttempts: 1 });
      await jobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const job = jobQueue.getJob(id);
      expect(job?.status).toBe('stalled');
      expect(job?.last_error).toBe('undefined');
    });

    it('should handle null throws from handler', async () => {
      jobQueue.registerHandler('throws-null', async () => {
        throw null;
      });

      const id = jobQueue.enqueue('throws-null', {}, { maxAttempts: 1 });
      await jobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const job = jobQueue.getJob(id);
      expect(job?.status).toBe('stalled');
      expect(job?.last_error).toBe('null');
    });

    it('should handle object throws from handler', async () => {
      jobQueue.registerHandler('throws-object', async () => {
        throw { code: 'ERR_TEST', message: 'test object error' };
      });

      const id = jobQueue.enqueue('throws-object', {}, { maxAttempts: 1 });
      await jobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const job = jobQueue.getJob(id);
      expect(job?.status).toBe('stalled');
      // Object.toString() is used via String()
      expect(job?.last_error).not.toBeNull();
    });
  });

  // ===========================================================================
  // Backoff Ceiling Tests
  // ===========================================================================

  describe('exponential backoff', () => {
    it('should cap exponential backoff at 5 minutes', () => {
      // Access private method for testing
      const calculateBackoff = (
        jobQueue as unknown as { calculateBackoff: (attempts: number) => number }
      ).calculateBackoff.bind(jobQueue);

      // After many attempts, backoff should be capped at 5 minutes (300000ms)
      const backoff = calculateBackoff(20);
      expect(backoff).toBe(5 * 60 * 1000);
    });

    it('should use exponential backoff for early attempts', () => {
      const calculateBackoff = (
        jobQueue as unknown as { calculateBackoff: (attempts: number) => number }
      ).calculateBackoff.bind(jobQueue);

      // First attempt: 1s * 2^0 = 1000ms
      expect(calculateBackoff(1)).toBe(1000);
      // Second attempt: 1s * 2^1 = 2000ms
      expect(calculateBackoff(2)).toBe(2000);
      // Third attempt: 1s * 2^2 = 4000ms
      expect(calculateBackoff(3)).toBe(4000);
      // Fourth attempt: 1s * 2^3 = 8000ms
      expect(calculateBackoff(4)).toBe(8000);
    });

    it('should not exceed 5 minutes for any attempt count', () => {
      const calculateBackoff = (
        jobQueue as unknown as { calculateBackoff: (attempts: number) => number }
      ).calculateBackoff.bind(jobQueue);

      const maxBackoff = 5 * 60 * 1000;

      // Test various high attempt counts
      for (const attempts of [10, 15, 20, 50, 100]) {
        expect(calculateBackoff(attempts)).toBe(maxBackoff);
      }
    });
  });

  // ===========================================================================
  // Cancel During Retry Tests
  // ===========================================================================

  describe('cancel during retry wait', () => {
    it('should not process job canceled while waiting for retry', async () => {
      let attempts = 0;
      jobQueue.registerHandler('retry-job', async () => {
        attempts++;
        if (attempts < 2) {
          throw new Error('Temporary failure');
        }
      });

      // Create a job that will fail once and be scheduled for retry
      const id = jobQueue.enqueue('retry-job', {}, { maxAttempts: 3 });
      await jobQueue.start();

      // Wait for initial failure and retry scheduling
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify job is pending (waiting for retry)
      let job = jobQueue.getJob(id);
      expect(job?.status).toBe('pending');
      expect(job?.attempts).toBe(1);
      expect(attempts).toBe(1);

      // Cancel the job while it's waiting for retry
      const canceled = jobQueue.cancelJob(id);
      expect(canceled).toBe(true);

      // Wait past the retry time (default backoff is 1s for first retry)
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Verify job was not processed again
      expect(attempts).toBe(1);

      // Verify job is deleted
      job = jobQueue.getJob(id);
      expect(job).toBeNull();
    });

    it('should clear retry timer when job is canceled', async () => {
      let attempts = 0;
      jobQueue.registerHandler('retry-job', async () => {
        attempts++;
        throw new Error('Always fails');
      });

      const id = jobQueue.enqueue('retry-job', {}, { maxAttempts: 5 });
      await jobQueue.start();

      // Wait for initial failure
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Get the retry timers map
      const retryTimers = (jobQueue as unknown as { retryTimers: Map<string, Timer> })
        .retryTimers;

      // Verify timer is set
      expect(retryTimers.has(id)).toBe(true);

      // Cancel the job
      jobQueue.cancelJob(id);

      // Verify timer is cleared
      expect(retryTimers.has(id)).toBe(false);
    });
  });

  // ===========================================================================
  // Stop/Start Tests
  // ===========================================================================

  describe('stop and start', () => {
    it('should stop processing new jobs', async () => {
      let processed = false;
      jobQueue.registerHandler('test:job', async () => {
        processed = true;
      });

      await jobQueue.start();
      await jobQueue.stop();

      jobQueue.enqueue('test:job', {});
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(processed).toBe(false);
    });

    it('should be idempotent', async () => {
      await jobQueue.start();
      await jobQueue.start(); // Should not throw
      await jobQueue.stop();
      await jobQueue.stop(); // Should not throw
    });
  });
});
