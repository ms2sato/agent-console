import { serveStatic, upgradeWebSocket, websocket } from 'hono/bun';
import { Hono } from 'hono';
import { pinoLogger } from 'hono-pino';
import { api } from './routes/api.js';
import { setupWebSocketRoutes } from './websocket/routes.js';
import { onApiError } from './lib/error-handler.js';
import { serverConfig } from './lib/server-config.js';
import { rootLogger, createLogger } from './lib/logger.js';
import { initializeDatabase, closeDatabase } from './database/connection.js';
import { getConfigDir } from './lib/config.js';
import { initializeJobQueue, registerJobHandlers, resetJobQueue } from './jobs/index.js';
import { initializeSessionManager } from './services/session-manager.js';
import { initializeRepositoryManager } from './services/repository-manager.js';
import { createSessionRepository } from './repositories/index.js';
import * as fs from 'fs';
import * as path from 'path';

const logger = createLogger('server');

// Log server PID on startup for debugging
logger.info({ pid: process.pid }, 'Server process starting');

/**
 * Graceful shutdown: stop job queue and close database.
 */
async function shutdown(): Promise<void> {
  await resetJobQueue();
  await closeDatabase();
}

// Global error handlers to log crashes before process exits
process.on('uncaughtException', async (error) => {
  logger.fatal({ pid: process.pid, err: error }, 'Uncaught Exception');
  try {
    await shutdown();
  } catch (shutdownError) {
    logger.error({ err: shutdownError }, 'Error during shutdown after uncaught exception');
  }
  process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
  logger.fatal({ pid: process.pid, reason, promise }, 'Unhandled Rejection');
  try {
    await shutdown();
  } catch (shutdownError) {
    logger.error({ err: shutdownError }, 'Error during shutdown after unhandled rejection');
  }
  process.exit(1);
});

// Log when server receives termination signals
process.on('SIGTERM', async () => {
  logger.info({ pid: process.pid }, 'Server received SIGTERM');
  await shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info({ pid: process.pid }, 'Server received SIGINT');
  await shutdown();
  process.exit(0);
});

const app = new Hono();

// Production mode: serve static files
const isProduction = serverConfig.NODE_ENV === 'production';

// Global error handler
app.onError(onApiError);

// HTTP request logging middleware
app.use(
  '*',
  pinoLogger({
    pino: rootLogger.child({ service: 'http' }),
  })
);

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

// Mount API routes
app.route('/api', api);

const PORT = Number(serverConfig.PORT);

// Initialize database before starting server and setting up WebSocket routes
try {
  await initializeDatabase();
  logger.info('Database initialized successfully');
} catch (error) {
  logger.fatal({ err: error }, 'Failed to initialize database');
  console.error('\nDATABASE INITIALIZATION FAILED\n');
  console.error('The database could not be initialized. This may be due to:');
  console.error('  - Corrupted database file');
  console.error('  - Insufficient disk space');
  console.error('  - Permission issues\n');
  console.error('To reset the database, delete the file:');
  console.error(`  rm ${getConfigDir()}/data.db\n`);
  process.exit(1);
}

// Initialize job queue after database initialization
const jobQueue = initializeJobQueue();
try {
  registerJobHandlers(jobQueue);
  await jobQueue.start();
  logger.info('JobQueue initialized and started');
} catch (error) {
  logger.fatal({ err: error }, 'Failed to initialize job queue');
  process.exit(1);
}

// Initialize services with explicit dependencies
const sessionRepository = await createSessionRepository();
await initializeSessionManager({ sessionRepository, jobQueue });
await initializeRepositoryManager({ jobQueue });
logger.info('Services initialized');

// Setup WebSocket routes AFTER service initialization but BEFORE SPA fallback
// WebSocket routes are not caught by the catch-all SPA handler
await setupWebSocketRoutes(app, upgradeWebSocket);

// Static file serving (production only)
// NOTE: Must be registered AFTER WebSocket routes to avoid catching /ws/* paths
if (isProduction) {
  const __dirname = path.dirname(new URL(import.meta.url).pathname);
  const publicDir = path.join(__dirname, './public');

  // Serve static files from public directory
  app.use('/*', serveStatic({ root: publicDir }));

  // SPA fallback: serve index.html for any non-API/WS routes
  app.get('*', (c) => {
    const indexPath = path.join(publicDir, 'index.html');
    const html = fs.readFileSync(indexPath, 'utf-8');
    return c.html(html);
  });
}

logger.info(
  { port: PORT, env: isProduction ? 'production' : 'development', pid: process.pid },
  'Server starting'
);

const server = Bun.serve({
  fetch: app.fetch,
  port: PORT,
  hostname: serverConfig.HOST,
  websocket,
});

logger.info({ port: server.port }, 'Server listening');
