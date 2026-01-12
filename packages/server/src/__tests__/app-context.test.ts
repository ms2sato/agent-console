import { describe, it, expect, afterEach } from 'bun:test';
import {
  createAppContext,
  createTestContext,
  shutdownAppContext,
  type AppContext,
} from '../app-context.js';

describe('AppContext', () => {
  let appContext: AppContext | null = null;

  afterEach(async () => {
    if (appContext) {
      // Reset singletons to allow next test to reinitialize
      await shutdownAppContext(appContext, { resetSingletons: true });
      appContext = null;
    }
  });

  describe('createTestContext', () => {
    it('should create an AppContext with all required services', async () => {
      appContext = await createTestContext();

      expect(appContext.db).toBeDefined();
      expect(appContext.jobQueue).toBeDefined();
      expect(appContext.sessionRepository).toBeDefined();
      expect(appContext.sessionManager).toBeDefined();
      expect(appContext.repositoryManager).toBeDefined();
      expect(appContext.notificationManager).toBeDefined();
    });

    it('should use in-memory database for isolation', async () => {
      appContext = await createTestContext();

      // Verify database is usable
      const result = await appContext.db
        .selectFrom('sessions')
        .selectAll()
        .execute();

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0); // Fresh database
    });

    it('should allow custom sessionRepository override', async () => {
      // Create a mock session repository
      const mockRepository = {
        findAll: async () => [],
        findById: async () => null,
        findByServerPid: async () => [],
        save: async () => {},
        saveAll: async () => {},
        delete: async () => {},
      };

      appContext = await createTestContext({
        sessionRepository: mockRepository,
      });

      // Verify the mock was used
      expect(appContext.sessionRepository).toBe(mockRepository);
    });

    it('should skip job queue start when requested', async () => {
      appContext = await createTestContext({
        skipJobQueueStart: true,
      });

      // Context should still be created successfully
      expect(appContext.jobQueue).toBeDefined();
    });
  });

  describe('shutdownAppContext', () => {
    it('should clean up all resources', async () => {
      appContext = await createTestContext();

      // Shutdown should complete without errors
      // Reset singletons to allow creating a new context
      await shutdownAppContext(appContext, { resetSingletons: true });
      appContext = null;

      // Database should be closed (creating new one should work)
      const newContext = await createTestContext();
      expect(newContext.db).toBeDefined();
      // Clean up the new context
      await shutdownAppContext(newContext, { resetSingletons: true });
    });

    it('should reset global database when resetSingletons is true', async () => {
      // This test verifies that the global db variable is reset after shutdown,
      // which is important for dev server restart and test re-execution.
      // Uses in-memory database to avoid file system side effects.
      const context1 = await createAppContext({ dbPath: ':memory:' });

      // Verify first context works
      const result1 = await context1.db
        .selectFrom('sessions')
        .selectAll()
        .execute();
      expect(Array.isArray(result1)).toBe(true);

      // Shutdown with resetSingletons: true should reset global db
      await shutdownAppContext(context1, { resetSingletons: true });

      // Create a second context - this should work because global db was reset
      // If global db was not reset, initializeDatabase would return the destroyed db
      const context2 = await createAppContext({ dbPath: ':memory:' });

      // Verify second context works (not a destroyed database)
      const result2 = await context2.db
        .selectFrom('sessions')
        .selectAll()
        .execute();
      expect(Array.isArray(result2)).toBe(true);

      // Clean up
      await shutdownAppContext(context2, { resetSingletons: true });
    });
  });

  describe('service wiring', () => {
    it('should wire cross-dependencies between managers', async () => {
      appContext = await createTestContext();

      // SessionManager should have repository callbacks set
      // We can verify this indirectly by checking that toPublicSession works
      // (it uses repositoryCallbacks to get repository name)
      const sessions = appContext.sessionManager.getAllSessions();
      expect(Array.isArray(sessions)).toBe(true);
    });

    it('should wire notification manager callbacks', async () => {
      appContext = await createTestContext();

      // NotificationManager should be fully initialized
      // We can verify by calling methods that require callbacks
      // cleanupSession should not throw
      expect(() => {
        appContext!.notificationManager.cleanupSession('non-existent');
      }).not.toThrow();
    });
  });
});
