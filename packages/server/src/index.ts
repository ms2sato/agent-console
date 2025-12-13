import { serveStatic, upgradeWebSocket, websocket } from 'hono/bun';
import { Hono } from 'hono';
import { pinoLogger } from 'hono-pino';
import { api } from './routes/api.js';
import { setupWebSocketRoutes } from './websocket/routes.js';
import { onApiError } from './lib/error-handler.js';
import { serverConfig } from './lib/server-config.js';
import { rootLogger, createLogger } from './lib/logger.js';
import * as fs from 'fs';
import * as path from 'path';

const logger = createLogger('server');

// Log server PID on startup for debugging
logger.info({ pid: process.pid }, 'Server process starting');

// Global error handlers to log crashes before process exits
process.on('uncaughtException', (error) => {
  logger.fatal({ pid: process.pid, err: error }, 'Uncaught Exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({ pid: process.pid, reason, promise }, 'Unhandled Rejection');
  process.exit(1);
});

// Log when server receives termination signals
process.on('SIGTERM', () => {
  logger.info({ pid: process.pid }, 'Server received SIGTERM');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info({ pid: process.pid }, 'Server received SIGINT');
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

// Setup WebSocket routes
setupWebSocketRoutes(app, upgradeWebSocket);

// Static file serving (production only)
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

const PORT = Number(serverConfig.PORT);

logger.info(
  { port: PORT, env: isProduction ? 'production' : 'development', pid: process.pid },
  'Server starting'
);

const server = Bun.serve({
  fetch: app.fetch,
  port: PORT,
  websocket,
});

logger.info({ port: server.port }, 'Server listening');
