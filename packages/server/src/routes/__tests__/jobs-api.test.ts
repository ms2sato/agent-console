import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { initializeDatabase, closeDatabase } from '../../database/connection.js';
import { initializeJobQueue, resetJobQueue, type JobQueue } from '../../jobs/index.js';
import { api } from '../api.js';
import { onApiError } from '../../lib/error-handler.js';

describe('Jobs API', () => {
  let app: Hono;
  let testJobQueue: JobQueue;

  beforeEach(async () => {
    // Initialize in-memory database first
    await initializeDatabase(':memory:');

    // Initialize the singleton job queue
    testJobQueue = initializeJobQueue();

    // Create Hono app with error handler
    app = new Hono();
    app.onError(onApiError);
    app.route('/api', api);
  });

  afterEach(async () => {
    await resetJobQueue();
    await closeDatabase();
  });

  // ===========================================================================
  // GET /api/jobs
  // ===========================================================================

  describe('GET /api/jobs', () => {
    it('should return empty list when no jobs', async () => {
      const res = await app.request('/api/jobs');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { jobs: unknown[]; total: number };
      expect(body.jobs).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('should return job list with correct format (camelCase)', async () => {
      const jobId = await testJobQueue.enqueue('test:type', { foo: 'bar' }, { priority: 5, maxAttempts: 3 });

      const res = await app.request('/api/jobs');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { jobs: Array<{
        id: string;
        type: string;
        payload: unknown;
        status: string;
        priority: number;
        attempts: number;
        maxAttempts: number;
        nextRetryAt: number;
        lastError: string | null;
        createdAt: number;
        startedAt: number | null;
        completedAt: number | null;
      }>; total: number };

      expect(body.jobs.length).toBe(1);
      expect(body.total).toBe(1);

      const job = body.jobs[0];
      expect(job.id).toBe(jobId);
      expect(job.type).toBe('test:type');
      expect(job.payload).toEqual({ foo: 'bar' });
      expect(job.status).toBe('pending');
      expect(job.priority).toBe(5);
      expect(job.attempts).toBe(0);
      expect(job.maxAttempts).toBe(3);
      expect(typeof job.nextRetryAt).toBe('number');
      expect(job.lastError).toBeNull();
      expect(typeof job.createdAt).toBe('number');
      expect(job.startedAt).toBeNull();
      expect(job.completedAt).toBeNull();
    });

    it('should filter by status', async () => {
      // Create jobs and complete them
      testJobQueue.registerHandler('test:type', async () => {});
      await testJobQueue.enqueue('test:type', { n: 1 });
      await testJobQueue.enqueue('test:type', { n: 2 });

      await testJobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Stop queue before adding pending job to prevent immediate processing
      await testJobQueue.stop();

      // Enqueue a new pending job (won't be processed since queue is stopped)
      await testJobQueue.enqueue('test:type', { n: 3 });

      const completedRes = await app.request('/api/jobs?status=completed');
      expect(completedRes.status).toBe(200);
      const completedBody = (await completedRes.json()) as { jobs: unknown[]; total: number };
      expect(completedBody.jobs.length).toBe(2);
      expect(completedBody.total).toBe(2);

      const pendingRes = await app.request('/api/jobs?status=pending');
      expect(pendingRes.status).toBe(200);
      const pendingBody = (await pendingRes.json()) as { jobs: unknown[]; total: number };
      expect(pendingBody.jobs.length).toBe(1);
      expect(pendingBody.total).toBe(1);
    });

    it('should filter by type', async () => {
      await testJobQueue.enqueue('type:a', { n: 1 });
      await testJobQueue.enqueue('type:b', { n: 2 });
      await testJobQueue.enqueue('type:a', { n: 3 });

      const typeARes = await app.request('/api/jobs?type=type:a');
      expect(typeARes.status).toBe(200);
      const typeABody = (await typeARes.json()) as { jobs: unknown[]; total: number };
      expect(typeABody.jobs.length).toBe(2);
      expect(typeABody.total).toBe(2);

      const typeBRes = await app.request('/api/jobs?type=type:b');
      expect(typeBRes.status).toBe(200);
      const typeBBody = (await typeBRes.json()) as { jobs: unknown[]; total: number };
      expect(typeBBody.jobs.length).toBe(1);
      expect(typeBBody.total).toBe(1);
    });

    it('should respect limit and offset pagination', async () => {
      // Create 5 jobs
      for (let i = 0; i < 5; i++) {
        await testJobQueue.enqueue('test:type', { n: i });
      }

      // Get first 2
      const limitRes = await app.request('/api/jobs?limit=2');
      expect(limitRes.status).toBe(200);
      const limitBody = (await limitRes.json()) as { jobs: unknown[]; total: number };
      expect(limitBody.jobs.length).toBe(2);
      expect(limitBody.total).toBe(5); // Total should be all jobs

      // Get next 2 with offset
      const offsetRes = await app.request('/api/jobs?limit=2&offset=2');
      expect(offsetRes.status).toBe(200);
      const offsetBody = (await offsetRes.json()) as { jobs: unknown[]; total: number };
      expect(offsetBody.jobs.length).toBe(2);
      expect(offsetBody.total).toBe(5);
    });

    it('should return correct total count with filters', async () => {
      testJobQueue.registerHandler('type:complete', async () => {});
      await testJobQueue.enqueue('type:complete', {});
      await testJobQueue.enqueue('type:pending', {});

      await testJobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const res = await app.request('/api/jobs?status=completed&limit=1');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { jobs: unknown[]; total: number };
      expect(body.jobs.length).toBe(1);
      expect(body.total).toBe(1);
    });

    it('should return 400 for invalid limit', async () => {
      const res = await app.request('/api/jobs?limit=0');
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('limit');
    });

    it('should return 400 for limit greater than 1000', async () => {
      const res = await app.request('/api/jobs?limit=1001');
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('limit');
    });

    it('should return 400 for negative offset', async () => {
      const res = await app.request('/api/jobs?offset=-1');
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('offset');
    });

    it('should return 400 for non-numeric limit', async () => {
      const res = await app.request('/api/jobs?limit=abc');
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('limit');
    });
  });

  // ===========================================================================
  // GET /api/jobs/stats
  // ===========================================================================

  describe('GET /api/jobs/stats', () => {
    it('should return all zeroes when no jobs', async () => {
      const res = await app.request('/api/jobs/stats');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { pending: number; processing: number; completed: number; stalled: number };
      expect(body).toEqual({
        pending: 0,
        processing: 0,
        completed: 0,
        stalled: 0,
      });
    });

    it('should return correct counts by status', async () => {
      // Register handlers
      testJobQueue.registerHandler('succeed', async () => {});
      testJobQueue.registerHandler('fail', async () => {
        throw new Error('Always fails');
      });

      // Create jobs
      await testJobQueue.enqueue('succeed', {}); // Will complete
      await testJobQueue.enqueue('succeed', {}); // Will complete
      await testJobQueue.enqueue('fail', {}, { maxAttempts: 1 }); // Will stall
      await testJobQueue.enqueue('fail', {}, { maxAttempts: 1 }); // Will stall

      await testJobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 150));

      const res = await app.request('/api/jobs/stats');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { pending: number; processing: number; completed: number; stalled: number };
      expect(body.completed).toBe(2);
      expect(body.stalled).toBe(2);
      expect(body.processing).toBe(0);
    });
  });

  // ===========================================================================
  // GET /api/jobs/:id
  // ===========================================================================

  describe('GET /api/jobs/:id', () => {
    it('should return job with parsed payload', async () => {
      const jobId = await testJobQueue.enqueue('test:type', { nested: { value: 123 } });

      const res = await app.request(`/api/jobs/${jobId}`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        id: string;
        type: string;
        payload: unknown;
        status: string;
      };
      expect(body.id).toBe(jobId);
      expect(body.type).toBe('test:type');
      expect(body.payload).toEqual({ nested: { value: 123 } });
      expect(body.status).toBe('pending');
    });

    it('should return 404 for non-existent job', async () => {
      const res = await app.request('/api/jobs/non-existent-id');
      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Job');
    });
  });

  // ===========================================================================
  // POST /api/jobs/:id/retry
  // ===========================================================================

  describe('POST /api/jobs/:id/retry', () => {
    it('should retry a stalled job (returns success)', async () => {
      // Register handler that always fails
      testJobQueue.registerHandler('fail', async () => {
        throw new Error('Always fails');
      });

      // Create job that will stall
      const jobId = await testJobQueue.enqueue('fail', {}, { maxAttempts: 1 });

      await testJobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify it's stalled
      let job = await testJobQueue.getJob(jobId);
      expect(job?.status).toBe('stalled');

      // Stop processing before retrying
      await testJobQueue.stop();

      // Retry it
      const res = await app.request(`/api/jobs/${jobId}/retry`, { method: 'POST' });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);

      // Verify it's pending again
      job = await testJobQueue.getJob(jobId);
      expect(job?.status).toBe('pending');
      expect(job?.attempts).toBe(0);
    });

    it('should return 404 for non-existent job', async () => {
      const res = await app.request('/api/jobs/non-existent-id/retry', { method: 'POST' });
      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Job');
    });

    it('should return 400 for pending job', async () => {
      const jobId = await testJobQueue.enqueue('test:type', {});

      const res = await app.request(`/api/jobs/${jobId}/retry`, { method: 'POST' });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('stalled');
    });

    it('should return 400 for processing job', async () => {
      // Create a job that takes time to process
      let resolveHandler: () => void;
      const handlerPromise = new Promise<void>((resolve) => {
        resolveHandler = resolve;
      });

      testJobQueue.registerHandler('slow', async () => {
        await handlerPromise;
      });

      const jobId = await testJobQueue.enqueue('slow', {});
      await testJobQueue.start();

      // Wait a bit for processing to start
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify it's processing
      const job = await testJobQueue.getJob(jobId);
      expect(job?.status).toBe('processing');

      // Try to retry
      const res = await app.request(`/api/jobs/${jobId}/retry`, { method: 'POST' });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('stalled');

      // Clean up
      resolveHandler!();
    });

    it('should return 400 for completed job', async () => {
      testJobQueue.registerHandler('test:type', async () => {});
      const jobId = await testJobQueue.enqueue('test:type', {});

      await testJobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify it's completed
      const job = await testJobQueue.getJob(jobId);
      expect(job?.status).toBe('completed');

      const res = await app.request(`/api/jobs/${jobId}/retry`, { method: 'POST' });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('stalled');
    });
  });

  // ===========================================================================
  // DELETE /api/jobs/:id
  // ===========================================================================

  describe('DELETE /api/jobs/:id', () => {
    it('should cancel a pending job', async () => {
      const jobId = await testJobQueue.enqueue('test:type', {});

      const res = await app.request(`/api/jobs/${jobId}`, { method: 'DELETE' });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);

      // Verify job is deleted
      const job = await testJobQueue.getJob(jobId);
      expect(job).toBeNull();
    });

    it('should cancel a stalled job', async () => {
      // Register handler that always fails
      testJobQueue.registerHandler('fail', async () => {
        throw new Error('Always fails');
      });

      const jobId = await testJobQueue.enqueue('fail', {}, { maxAttempts: 1 });

      await testJobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify it's stalled
      let job = await testJobQueue.getJob(jobId);
      expect(job?.status).toBe('stalled');

      // Cancel it
      const res = await app.request(`/api/jobs/${jobId}`, { method: 'DELETE' });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);

      // Verify job is deleted
      job = await testJobQueue.getJob(jobId);
      expect(job).toBeNull();
    });

    it('should return 404 for non-existent job', async () => {
      const res = await app.request('/api/jobs/non-existent-id', { method: 'DELETE' });
      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Job');
    });

    it('should return 400 for processing job', async () => {
      // Create a job that takes time to process
      let resolveHandler: () => void;
      const handlerPromise = new Promise<void>((resolve) => {
        resolveHandler = resolve;
      });

      testJobQueue.registerHandler('slow', async () => {
        await handlerPromise;
      });

      const jobId = await testJobQueue.enqueue('slow', {});
      await testJobQueue.start();

      // Wait a bit for processing to start
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify it's processing
      const job = await testJobQueue.getJob(jobId);
      expect(job?.status).toBe('processing');

      // Try to delete
      const res = await app.request(`/api/jobs/${jobId}`, { method: 'DELETE' });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('pending or stalled');

      // Clean up
      resolveHandler!();
    });

    it('should return 400 for completed job', async () => {
      testJobQueue.registerHandler('test:type', async () => {});
      const jobId = await testJobQueue.enqueue('test:type', {});

      await testJobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify it's completed
      const job = await testJobQueue.getJob(jobId);
      expect(job?.status).toBe('completed');

      const res = await app.request(`/api/jobs/${jobId}`, { method: 'DELETE' });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('pending or stalled');
    });

    it('should handle job status changing during cancel attempt (TOCTOU)', async () => {
      // This test verifies the atomic cancel pattern handles race conditions:
      // The job status may change between the cancel attempt and the error check
      let jobStarted = false;
      let allowCompletion: () => void;
      const completionPromise = new Promise<void>((resolve) => {
        allowCompletion = resolve;
      });

      testJobQueue.registerHandler('slow', async () => {
        jobStarted = true;
        await completionPromise;
      });

      const jobId = await testJobQueue.enqueue('slow', {});
      await testJobQueue.start();

      // Wait for job to start processing
      while (!jobStarted) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Complete the job - this simulates a race where job finishes
      // while we're about to cancel
      allowCompletion!();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Job should now be completed
      const job = await testJobQueue.getJob(jobId);
      expect(job?.status).toBe('completed');

      // Attempt to cancel (will fail because job is completed)
      const res = await app.request(`/api/jobs/${jobId}`, { method: 'DELETE' });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      // Should indicate wrong status, not "job not found"
      expect(body.error).toContain('pending or stalled');
    });
  });

  // ===========================================================================
  // TOCTOU Race Condition Tests
  // ===========================================================================

  describe('TOCTOU handling', () => {
    it('should return accurate error when retry fails due to status change', async () => {
      // Create a job that will complete while we verify the error handling
      testJobQueue.registerHandler('test:type', async () => {});

      const jobId = await testJobQueue.enqueue('test:type', {});
      await testJobQueue.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Job should now be completed (not stalled)
      const job = await testJobQueue.getJob(jobId);
      expect(job?.status).toBe('completed');

      // Retry should fail with correct error message
      const res = await app.request(`/api/jobs/${jobId}/retry`, { method: 'POST' });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      // Should indicate "only stalled can be retried", not "job not found"
      expect(body.error).toContain('stalled');
    });
  });
});
