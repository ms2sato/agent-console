import { serveStatic, upgradeWebSocket, websocket } from 'hono/bun';
import { Hono } from 'hono';
import { pinoLogger } from 'hono-pino';
import { api } from './routes/api.js';
import { webhooks } from './routes/webhooks.js';
import { setupWebSocketRoutes, broadcastToApp } from './websocket/routes.js';
import { onApiError } from './lib/error-handler.js';
import { serverConfig } from './lib/server-config.js';
import { rootLogger, createLogger } from './lib/logger.js';
import { getConfigDir } from './lib/config.js';
import { createAppContext, shutdownAppContext, type AppContext } from './app-context.js';
// Import singleton setters to populate existing singletons from AppContext
import { setSessionManager } from './services/session-manager.js';
import { setRepositoryManager } from './services/repository-manager.js';
import { setNotificationManager } from './services/notifications/index.js';
import { setSystemCapabilities } from './services/system-capabilities-service.js';
import { initializeInboundIntegration } from './services/inbound/index.js';
import * as fs from 'fs';
import * as path from 'path';

const logger = createLogger('server');

// Log server PID on startup for debugging
logger.info({ pid: process.pid }, 'Server process starting');

// Application context - initialized before server starts
let appContext: AppContext | null = null;

/**
 * Graceful shutdown: stop all services and close connections.
 */
async function shutdown(): Promise<void> {
  if (appContext) {
    await shutdownAppContext(appContext);
    appContext = null;
  }
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

const PORT = Number(serverConfig.PORT);

// Production mode: serve static files
const isProduction = serverConfig.NODE_ENV === 'production';

// Initialize all services via AppContext BEFORE creating the Hono app
// This ensures services are available when routes are registered
try {
  appContext = await createAppContext();
  logger.info('Application context initialized');
} catch (error) {
  logger.fatal({ err: error }, 'Failed to initialize application context');
  console.error('\nAPPLICATION INITIALIZATION FAILED\n');
  console.error('The application could not be initialized. This may be due to:');
  console.error('  - Corrupted database file');
  console.error('  - Insufficient disk space');
  console.error('  - Permission issues\n');
  console.error('To reset the database, delete the file:');
  console.error(`  rm ${getConfigDir()}/data.db\n`);
  process.exit(1);
}

// Populate existing singletons from AppContext for backward compatibility
// This allows existing code using getSessionManager(), etc. to continue working
setSessionManager(appContext.sessionManager);
setRepositoryManager(appContext.repositoryManager);
setNotificationManager(appContext.notificationManager);
setSystemCapabilities(appContext.systemCapabilities);
logger.info('Singletons populated from AppContext');

// Create Hono app
// Note: AppBindings type is available for routes that want to use c.get('appContext'),
// but for Phase 1 we keep using the singleton shims for backward compatibility.
const app = new Hono();

// Global error handler
app.onError(onApiError);

// HTTP request logging middleware
app.use(
  '*',
  pinoLogger({
    pino: rootLogger.child({ service: 'http' }),
  })
);

// Note: In Phase 2, we'll add middleware to inject AppContext into Hono request context:
// app.use('*', async (c, next) => { c.set('appContext', appContext); await next(); });
// For Phase 1, routes continue using singleton shims (getSessionManager(), etc.)

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

// Mount API routes
app.route('/api', api);
// Mount webhook routes
app.route('/webhooks', webhooks);

initializeInboundIntegration({
  jobQueue: appContext.jobQueue,
  sessionManager: appContext.sessionManager,
  repositoryManager: appContext.repositoryManager,
  broadcastToApp,
});
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
