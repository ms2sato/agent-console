/**
 * Application Context for Dependency Injection.
 *
 * This module provides centralized dependency management for the server.
 * All stateful services are created once and passed explicitly to routes and handlers.
 *
 * Benefits:
 * - Eliminates global singletons for better testability
 * - Makes dependencies explicit in constructors/factories
 * - Enables proper test isolation with in-memory databases
 */

import type { Kysely } from 'kysely';
import type { Database } from './database/schema.js';
import type { JobQueue } from './jobs/job-queue.js';
import type { SessionRepository } from './repositories/session-repository.js';
import type { SessionManager } from './services/session-manager.js';
import type { RepositoryManager } from './services/repository-manager.js';
import type { NotificationManager } from './services/notifications/notification-manager.js';
import type { SystemCapabilitiesService } from './services/system-capabilities-service.js';
import { initializeDatabase, createDatabaseForTest, closeDatabase, getGlobalDatabase } from './database/connection.js';
import { JobQueue as JobQueueClass } from './jobs/job-queue.js';
import { registerJobHandlers } from './jobs/handlers.js';
import { SqliteSessionRepository } from './repositories/sqlite-session-repository.js';
import { SqliteRepositoryRepository } from './repositories/sqlite-repository-repository.js';
import { SessionManager as SessionManagerClass } from './services/session-manager.js';
import { RepositoryManager as RepositoryManagerClass } from './services/repository-manager.js';
import { NotificationManager as NotificationManagerClass } from './services/notifications/notification-manager.js';
import { SlackHandler } from './services/notifications/slack-handler.js';
import { SystemCapabilitiesService as SystemCapabilitiesServiceClass } from './services/system-capabilities-service.js';
import { createLogger } from './lib/logger.js';

const logger = createLogger('app-context');

/**
 * Application context containing all stateful dependencies.
 *
 * All services are initialized once at startup and passed explicitly
 * to routes and handlers via Hono context variables.
 */
export interface AppContext {
  /** Kysely database instance */
  db: Kysely<Database>;

  /** Background job queue for async task processing */
  jobQueue: JobQueue;

  /** Session persistence repository */
  sessionRepository: SessionRepository;

  /** Session and worker lifecycle management */
  sessionManager: SessionManager;

  /** Repository registration and management */
  repositoryManager: RepositoryManager;

  /** Notification orchestration for outbound integrations */
  notificationManager: NotificationManager;

  /** System capabilities (VS Code availability, etc.) */
  systemCapabilities: SystemCapabilitiesService;

  // Note: inboundIntegration is planned but not yet implemented
}

/**
 * Options for creating the application context.
 */
export interface CreateAppContextOptions {
  /** Database path. Use ':memory:' for in-memory database (tests). */
  dbPath?: string;
  /** Job queue concurrency (default: 4) */
  jobConcurrency?: number;
}

/**
 * Create the application context for production.
 *
 * Initializes all services in the correct order:
 * 1. Database connection
 * 2. Job queue (depends on db)
 * 3. Repositories (depend on db)
 * 4. Managers (depend on repositories and job queue)
 * 5. Wire cross-dependencies between managers
 * 6. Notification services
 *
 * @param options - Configuration options
 * @returns Initialized application context
 */
export async function createAppContext(
  options?: CreateAppContextOptions
): Promise<AppContext> {
  const dbPath = options?.dbPath;
  const jobConcurrency = options?.jobConcurrency ?? 4;

  // 1. Initialize database
  const db = await initializeDatabase(dbPath);
  logger.info({ dbPath: dbPath ?? 'default' }, 'Database initialized');

  // 2. Create job queue
  const jobQueue = new JobQueueClass(db, { concurrency: jobConcurrency });
  registerJobHandlers(jobQueue);
  await jobQueue.start();
  logger.info('JobQueue initialized and started');

  // 3. Create repositories
  const sessionRepository = new SqliteSessionRepository(db);
  const repositoryRepository = new SqliteRepositoryRepository(db);

  // 4. Create managers
  const sessionManager = await SessionManagerClass.create({
    sessionRepository,
    jobQueue,
  });

  const repositoryManager = await RepositoryManagerClass.create({
    repository: repositoryRepository,
    jobQueue,
  });

  // 5. Wire cross-dependencies between managers
  repositoryManager.setDependencyCallbacks({
    getSessionsUsingRepository: (repoId) =>
      sessionManager.getSessionsUsingRepository(repoId),
  });

  sessionManager.setRepositoryCallbacks({
    getRepository: (repoId) => repositoryManager.getRepository(repoId),
    isInitialized: () => true, // Always true once context is created
  });

  // 6. Create notification services
  const slackHandler = new SlackHandler();
  const notificationManager = new NotificationManagerClass(slackHandler);

  // Wire notification callbacks
  notificationManager.setSessionExistsCallback((sessionId) =>
    sessionManager.getSession(sessionId) !== undefined
  );

  // 7. Detect system capabilities
  const systemCapabilities = new SystemCapabilitiesServiceClass();
  await systemCapabilities.detect();

  logger.info('All services initialized');

  return {
    db,
    jobQueue,
    sessionRepository,
    sessionManager,
    repositoryManager,
    notificationManager,
    systemCapabilities,
  };
}

/**
 * Options for creating a test context.
 */
export interface CreateTestContextOptions {
  /** Custom session repository for mocking */
  sessionRepository?: SessionRepository;
  /** Custom notification manager for mocking */
  notificationManager?: NotificationManager;
  /** Custom system capabilities service for mocking */
  systemCapabilities?: SystemCapabilitiesService;
  /** Skip job queue start (useful for isolated unit tests) */
  skipJobQueueStart?: boolean;
}

/**
 * Create an application context for tests.
 *
 * Uses an in-memory SQLite database for isolation.
 * Allows injecting test doubles for specific services.
 *
 * @param overrides - Optional test doubles to inject
 * @returns Test application context
 */
export async function createTestContext(
  overrides?: CreateTestContextOptions
): Promise<AppContext> {
  // Use standalone in-memory database for test isolation
  // This does NOT modify the global db variable, preventing test interference
  const db = await createDatabaseForTest();

  // Create job queue
  const jobQueue = new JobQueueClass(db, { concurrency: 1 });
  registerJobHandlers(jobQueue);
  if (!overrides?.skipJobQueueStart) {
    await jobQueue.start();
  }

  // Use provided or create new session repository
  const sessionRepository =
    overrides?.sessionRepository ?? new SqliteSessionRepository(db);
  const repositoryRepository = new SqliteRepositoryRepository(db);

  // Create managers
  const sessionManager = await SessionManagerClass.create({
    sessionRepository,
    jobQueue,
  });

  const repositoryManager = await RepositoryManagerClass.create({
    repository: repositoryRepository,
    jobQueue,
  });

  // Wire cross-dependencies
  repositoryManager.setDependencyCallbacks({
    getSessionsUsingRepository: (repoId) =>
      sessionManager.getSessionsUsingRepository(repoId),
  });

  sessionManager.setRepositoryCallbacks({
    getRepository: (repoId) => repositoryManager.getRepository(repoId),
    isInitialized: () => true,
  });

  // Use provided or create new notification manager
  const notificationManager =
    overrides?.notificationManager ??
    new NotificationManagerClass(new SlackHandler());

  notificationManager.setSessionExistsCallback((sessionId) =>
    sessionManager.getSession(sessionId) !== undefined
  );

  // Use provided or detect system capabilities
  let systemCapabilities: SystemCapabilitiesService;
  if (overrides?.systemCapabilities) {
    systemCapabilities = overrides.systemCapabilities;
  } else {
    systemCapabilities = new SystemCapabilitiesServiceClass();
    await systemCapabilities.detect();
  }

  return {
    db,
    jobQueue,
    sessionRepository,
    sessionManager,
    repositoryManager,
    notificationManager,
    systemCapabilities,
  };
}

/**
 * Options for shutting down the application context.
 */
export interface ShutdownAppContextOptions {
  /**
   * If true, reset singleton instances (SessionManager, RepositoryManager, etc.).
   * This is typically needed for tests to allow reinitializing singletons.
   * Default: false (production behavior - singletons are not reset)
   */
  resetSingletons?: boolean;
}

/**
 * Shutdown and clean up all services in the application context.
 *
 * Should be called during server shutdown or after tests.
 *
 * @param context - The application context to shut down
 * @param options - Optional shutdown configuration
 */
export async function shutdownAppContext(
  context: AppContext,
  options?: ShutdownAppContextOptions
): Promise<void> {
  // Stop job queue
  await context.jobQueue.stop();

  // Dispose notification manager
  context.notificationManager.dispose();

  // Close database connection
  // Check if context.db is the same as global db to avoid double-destroy
  const isGlobalDb = context.db === getGlobalDatabase();

  if (isGlobalDb) {
    // Global db: always use closeDatabase() to ensure destroy + nullify
    // This prevents holding a destroyed instance in the global variable
    await closeDatabase();
  } else {
    // Test DB (separate instance): destroy directly
    await context.db.destroy();

    // If resetSingletons is requested, also close the global db
    if (options?.resetSingletons) {
      await closeDatabase();
    }
  }

  // Reset singletons if requested (typically for tests or dev server restart)
  if (options?.resetSingletons) {
    const { resetSessionManager } = await import('./services/session-manager.js');
    const { resetRepositoryManager } = await import('./services/repository-manager.js');
    const { shutdownNotificationServices } = await import('./services/notifications/index.js');
    const { resetSystemCapabilities } = await import('./services/system-capabilities-service.js');

    resetSessionManager();
    resetRepositoryManager();
    shutdownNotificationServices();
    resetSystemCapabilities();
  }

  logger.info('Application context shut down');
}

/**
 * Hono bindings for AppContext.
 *
 * Usage:
 * ```ts
 * const app = new Hono<AppBindings>();
 * app.use('*', async (c, next) => {
 *   c.set('appContext', appContext);
 *   await next();
 * });
 *
 * // In route handlers:
 * app.get('/api/sessions', (c) => {
 *   const { sessionManager } = c.get('appContext');
 *   // ...
 * });
 * ```
 */
export interface AppBindings {
  Variables: {
    appContext: AppContext;
  };
}
