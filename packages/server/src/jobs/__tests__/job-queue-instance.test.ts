import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  initializeJobQueue,
  getJobQueue,
  resetJobQueue,
  isJobQueueInitialized,
} from '../job-queue-instance.js';
import { initializeDatabase, closeDatabase } from '../../database/connection.js';

describe('JobQueue Instance Management', () => {
  beforeEach(async () => {
    // Initialize in-memory database before each test
    await initializeDatabase(':memory:');
  });

  afterEach(async () => {
    // Clean up after each test
    await resetJobQueue();
    await closeDatabase();
  });

  describe('initializeJobQueue', () => {
    it('should create and return a JobQueue instance', () => {
      const jobQueue = initializeJobQueue();

      expect(jobQueue).toBeDefined();
      expect(typeof jobQueue.enqueue).toBe('function');
      expect(typeof jobQueue.start).toBe('function');
      expect(typeof jobQueue.stop).toBe('function');
    });

    it('should throw if already initialized', () => {
      initializeJobQueue();

      expect(() => initializeJobQueue()).toThrow('JobQueue already initialized');
    });

    it('should accept concurrency option', () => {
      const jobQueue = initializeJobQueue({ concurrency: 2 });

      expect(jobQueue).toBeDefined();
    });

    it('should use default concurrency when options is empty object', () => {
      const jobQueue = initializeJobQueue({});

      expect(jobQueue).toBeDefined();
    });
  });

  describe('getJobQueue', () => {
    it('should return the initialized instance', () => {
      const initialized = initializeJobQueue();
      const retrieved = getJobQueue();

      expect(retrieved).toBe(initialized);
    });

    it('should throw if not initialized', async () => {
      // Close database and reset to ensure clean state
      await resetJobQueue();

      expect(() => getJobQueue()).toThrow(
        'JobQueue not initialized. Call initializeJobQueue() first.'
      );
    });
  });

  describe('isJobQueueInitialized', () => {
    it('should return false before initialization', async () => {
      // Ensure not initialized
      await resetJobQueue();

      expect(isJobQueueInitialized()).toBe(false);
    });

    it('should return true after initialization', () => {
      initializeJobQueue();

      expect(isJobQueueInitialized()).toBe(true);
    });

    it('should return false after reset', async () => {
      initializeJobQueue();
      await resetJobQueue();

      expect(isJobQueueInitialized()).toBe(false);
    });
  });

  describe('resetJobQueue', () => {
    it('should reset the instance', async () => {
      initializeJobQueue();
      expect(isJobQueueInitialized()).toBe(true);

      await resetJobQueue();

      expect(isJobQueueInitialized()).toBe(false);
    });

    it('should allow re-initialization after reset', async () => {
      initializeJobQueue();
      await resetJobQueue();

      const newInstance = initializeJobQueue();

      expect(newInstance).toBeDefined();
      expect(isJobQueueInitialized()).toBe(true);
    });

    it('should be safe to call when not initialized', async () => {
      // Should not throw
      await resetJobQueue();

      expect(isJobQueueInitialized()).toBe(false);
    });

    it('should call stop() on the instance', async () => {
      const jobQueue = initializeJobQueue();

      // Spy on stop method
      const originalStop = jobQueue.stop.bind(jobQueue);
      const stopMock = mock(async () => originalStop());

      jobQueue.stop = stopMock;

      await resetJobQueue();

      expect(stopMock).toHaveBeenCalledTimes(1);
    });
  });
});
