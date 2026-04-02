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
import type { AgentManager } from './services/agent-manager.js';
import type { TimerManager } from './services/timer-manager.js';
import type { SystemCapabilitiesService } from './services/system-capabilities-service.js';
import type { WorktreeService } from './services/worktree-service.js';
import type { RepositorySlackIntegrationService } from './services/notifications/repository-slack-integration-service.js';
import type { AuthUser } from '@agent-console/shared';
import type { UserMode } from './services/user-mode.js';
import type { AnnotationService } from './services/annotation-service.js';
import type { InterSessionMessageService } from './services/inter-session-message-service.js';
import type { InboundIntegrationInstance, InboundIntegrationOptions } from './services/inbound/index.js';
import { initializeInboundIntegration } from './services/inbound/index.js';
import { initializeDatabase, createDatabaseForTest, closeDatabase, getGlobalDatabase } from './database/connection.js';
import { JobQueue as JobQueueClass } from './jobs/job-queue.js';
import { registerJobHandlers } from './jobs/handlers.js';
import { SqliteSessionRepository } from './repositories/sqlite-session-repository.js';
import { SqliteRepositoryRepository } from './repositories/sqlite-repository-repository.js';
import { SessionManager as SessionManagerClass } from './services/session-manager.js';
import { RepositoryManager as RepositoryManagerClass } from './services/repository-manager.js';
import { NotificationManager as NotificationManagerClass } from './services/notifications/notification-manager.js';
import { SlackHandler } from './services/notifications/slack-handler.js';
import { AgentManager as AgentManagerClass } from './services/agent-manager.js';
import { SqliteAgentRepository } from './repositories/sqlite-agent-repository.js';
import { SqliteUserRepository } from './repositories/sqlite-user-repository.js';
import { SystemCapabilitiesService as SystemCapabilitiesServiceClass } from './services/system-capabilities-service.js';
import { SingleUserMode, MultiUserMode } from './services/user-mode.js';
import { bunPtyProvider } from './lib/pty-provider.js';
import { serverConfig } from './lib/server-config.js';
import { createLogger } from './lib/logger.js';
import { TimerManager as TimerManagerClass } from './services/timer-manager.js';
import { writePtyNotification } from './lib/pty-notification.js';
import { WorktreeService as WorktreeServiceClass } from './services/worktree-service.js';
import { RepositorySlackIntegrationService as RepositorySlackIntegrationServiceClass } from './services/notifications/repository-slack-integration-service.js';
import { AnnotationService as AnnotationServiceClass } from './services/annotation-service.js';
import { InterSessionMessageService as InterSessionMessageServiceClass } from './services/inter-session-message-service.js';
import { WorkerOutputFileManager } from './lib/worker-output-file.js';
import { MemoService } from './services/memo-service.js';

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

  /** Agent definition management (built-in + custom agents) */
  agentManager: AgentManager;

  /** Worktree management (create, remove, list, hooks) */
  worktreeService: WorktreeService;

  /** Repository-level Slack integration CRUD */
  repositorySlackIntegrationService: RepositorySlackIntegrationService;

  /** User authentication and PTY spawning mode */
  userMode: UserMode;

  /** Periodic timer management (in-memory, volatile) */
  timerManager: TimerManager;

  /** In-memory review annotation store */
  annotationService: AnnotationService;

  /** Inter-session message file management */
  interSessionMessageService: InterSessionMessageService;

  /** Memo file management */
  memoService: MemoService;

  /** Inbound integration for processing external events (webhooks) */
  inboundIntegration: InboundIntegrationInstance;
}

/**
 * Options for creating the application context.
 */
export interface CreateAppContextOptions {
  /** Database path. Use ':memory:' for in-memory database (tests). */
  dbPath?: string;
  /** Job queue concurrency (default: 4) */
  jobConcurrency?: number;
  /** Callback to broadcast messages to app WebSocket clients */
  broadcastToApp?: InboundIntegrationOptions['broadcastToApp'];
}

/**
 * Create the application context for production.
 *
 * Initializes all services in the correct order:
 * 1. Database connection
 * 2. Job queue (depends on db)
 * 3. Repositories (depend on db)
 * 4. Agent manager (depends on repository)
 * 5. Notification services
 * 6. Managers (depend on repositories, job queue, and services above)
 * 7. Wire cross-dependencies between managers
 * 8. Inbound integration
 * 9. System capabilities
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

  // 2. Create job queue and worker output file manager
  const workerOutputFileManager = new WorkerOutputFileManager();
  const jobQueue = new JobQueueClass(db, { concurrency: jobConcurrency });
  registerJobHandlers(jobQueue, workerOutputFileManager);
  await jobQueue.start();
  logger.info('JobQueue initialized and started');

  // 3. Create repositories and services that depend only on db
  const sessionRepository = new SqliteSessionRepository(db);
  const repositoryRepository = new SqliteRepositoryRepository(db);
  const worktreeService = new WorktreeServiceClass({ db });
  const annotationService = new AnnotationServiceClass();
  const interSessionMessageService = new InterSessionMessageServiceClass();
  const memoService = new MemoService();

  // 4. Create agent manager (needed by SessionManager)
  const agentRepository = new SqliteAgentRepository(db);
  const agentManager = await AgentManagerClass.create(agentRepository);

  // 5. Create notification services (needed by SessionManager)
  const repositorySlackIntegrationService = new RepositorySlackIntegrationServiceClass(db);
  const slackHandler = new SlackHandler(repositorySlackIntegrationService);
  const notificationManager = new NotificationManagerClass(slackHandler);

  // 5.5. Create user mode (determines auth + PTY spawning strategy)
  const userRepository = new SqliteUserRepository(db);
  const userMode = serverConfig.AUTH_MODE === 'multi-user'
    ? await MultiUserMode.create(bunPtyProvider, userRepository)
    : await SingleUserMode.create(bunPtyProvider, userRepository);
  logger.info({ authMode: serverConfig.AUTH_MODE }, 'User mode initialized');

  // 6. Create managers (with injected dependencies)
  const sessionManager = await SessionManagerClass.create({
    userMode,
    userRepository,
    sessionRepository,
    jobQueue,
    agentManager,
    notificationManager,
    annotationService,
    workerOutputFileManager,
    interSessionMessageService,
    memoService,
  });

  const repositoryManager = await RepositoryManagerClass.create({
    repository: repositoryRepository,
    jobQueue,
  });

  // 6.5. Create timer manager (in-memory, volatile)
  const timerManager = new TimerManagerClass((timer) => {
    try {
      const writeInput = (data: string) =>
        sessionManager.writeWorkerInput(timer.sessionId, timer.workerId, data);
      writePtyNotification({
        kind: 'internal-timer',
        tag: 'internal:timer',
        fields: {
          timerId: timer.id,
          action: timer.action,
          fireCount: String(timer.fireCount),
        },
        intent: 'inform',
        writeInput,
      });
    } catch (err) {
      logger.warn(
        { timerId: timer.id, sessionId: timer.sessionId, err },
        'Failed to deliver timer notification',
      );
    }
  });

  // 6.6. Wire timer cleanup into session lifecycle
  sessionManager.setTimerCleanupCallback((sessionId) => {
    timerManager.deleteTimersBySession(sessionId);
  });

  // 7. Wire cross-dependencies between managers
  repositoryManager.setDependencyCallbacks({
    getSessionsUsingRepository: (repoId) =>
      sessionManager.getSessionsUsingRepository(repoId),
  });

  sessionManager.setRepositoryCallbacks({
    getRepository: (repoId) => repositoryManager.getRepository(repoId),
    isInitialized: () => true, // Always true once context is created
    getWorktreeIndexNumber: (path) => worktreeService.getWorktreeIndexNumber(path),
  });

  // Wire notification callbacks
  notificationManager.setSessionExistsCallback((sessionId) =>
    sessionManager.getSession(sessionId) !== undefined
  );

  // 8. Initialize inbound integration
  const inboundIntegration = initializeInboundIntegration({
    db,
    jobQueue,
    sessionManager,
    repositoryManager,
    broadcastToApp: options?.broadcastToApp ?? (() => {}),
  });

  // 9. Detect system capabilities
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
    agentManager,
    worktreeService,
    repositorySlackIntegrationService,
    annotationService,
    interSessionMessageService,
    memoService,
    userMode,
    timerManager,
    inboundIntegration,
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
  /** Custom user mode for mocking */
  userMode?: UserMode;
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

  // Create job queue and worker output file manager
  const workerOutputFileManager = new WorkerOutputFileManager();
  const jobQueue = new JobQueueClass(db, { concurrency: 1 });
  registerJobHandlers(jobQueue, workerOutputFileManager);
  if (!overrides?.skipJobQueueStart) {
    await jobQueue.start();
  }

  // Use provided or create new session repository
  const sessionRepository =
    overrides?.sessionRepository ?? new SqliteSessionRepository(db);
  const repositoryRepository = new SqliteRepositoryRepository(db);
  const worktreeService = new WorktreeServiceClass({ db });
  const annotationService = new AnnotationServiceClass();
  const interSessionMessageService = new InterSessionMessageServiceClass();
  const memoService = new MemoService();

  // Create agent manager (needed by SessionManager)
  const agentRepository = new SqliteAgentRepository(db);
  const agentManager = await AgentManagerClass.create(agentRepository);

  // Use provided or create new notification manager (needed by SessionManager)
  const repositorySlackIntegrationService = new RepositorySlackIntegrationServiceClass(db);
  const notificationManager =
    overrides?.notificationManager ??
    new NotificationManagerClass(new SlackHandler(repositorySlackIntegrationService));

  // Create user mode
  const userRepository = new SqliteUserRepository(db);
  let userMode: UserMode;
  if (overrides?.userMode) {
    userMode = overrides.userMode;
  } else {
    userMode = await SingleUserMode.create(bunPtyProvider, userRepository);
  }

  // Create managers (with injected dependencies)
  const sessionManager = await SessionManagerClass.create({
    userMode,
    userRepository,
    sessionRepository,
    jobQueue,
    agentManager,
    notificationManager,
    annotationService,
    workerOutputFileManager,
    interSessionMessageService,
    memoService,
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
    getWorktreeIndexNumber: (path) => worktreeService.getWorktreeIndexNumber(path),
  });

  notificationManager.setSessionExistsCallback((sessionId) =>
    sessionManager.getSession(sessionId) !== undefined
  );

  // Create timer manager (no-op callback for tests)
  const timerManager = new TimerManagerClass(() => {});

  // Wire timer cleanup into session lifecycle
  sessionManager.setTimerCleanupCallback((sessionId) => {
    timerManager.deleteTimersBySession(sessionId);
  });

  // Initialize inbound integration
  const inboundIntegration = initializeInboundIntegration({
    db,
    jobQueue,
    sessionManager,
    repositoryManager,
    broadcastToApp: () => {},
  });

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
    agentManager,
    worktreeService,
    repositorySlackIntegrationService,
    annotationService,
    interSessionMessageService,
    memoService,
    userMode,
    timerManager,
    inboundIntegration,
  };
}

/**
 * Shutdown and clean up all services in the application context.
 *
 * Should be called during server shutdown or after tests.
 *
 * @param context - The application context to shut down
 */
export async function shutdownAppContext(
  context: AppContext,
): Promise<void> {
  // Dispose timer manager
  context.timerManager.disposeAll();

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
    /** Authenticated user identity, set by auth middleware */
    authUser: AuthUser;
  };
}
