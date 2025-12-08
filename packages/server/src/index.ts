import { serveStatic, upgradeWebSocket, websocket } from 'hono/bun';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { api } from './routes/api.js';
import { setupWebSocketRoutes } from './websocket/routes.js';
import { onApiError } from './lib/error-handler.js';
import * as fs from 'fs';
import * as path from 'path';

// Timestamp helper for logging
const timestamp = () => new Date().toISOString();

// Log server PID on startup for debugging
console.log(`[${timestamp()}] Server process starting (PID: ${process.pid})`);

// Global error handlers to log crashes before process exits
process.on('uncaughtException', (error) => {
  console.error(`[${timestamp()}] [FATAL] Uncaught Exception (PID: ${process.pid}):`, error);
  console.error('Stack:', error.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`[${timestamp()}] [FATAL] Unhandled Rejection (PID: ${process.pid}) at:`, promise);
  console.error('Reason:', reason);
  process.exit(1);
});

// Log when server receives termination signals
process.on('SIGTERM', () => {
  console.log(`[${timestamp()}] Server received SIGTERM (PID: ${process.pid})`);
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log(`[${timestamp()}] Server received SIGINT (PID: ${process.pid})`);
  process.exit(0);
});

const app = new Hono();

// Production mode: serve static files
const isProduction = process.env.NODE_ENV === 'production';

// Global error handler
app.onError(onApiError);

// Middleware
app.use('*', logger());

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

const PORT = Number(process.env.PORT) || 3457;

console.log(`[${timestamp()}] Server starting on http://localhost:${PORT} (${isProduction ? 'production' : 'development'}) (PID: ${process.pid})`);

const server = Bun.serve({
  fetch: app.fetch,
  port: PORT,
  websocket,
});

console.log(`[${timestamp()}] Server listening on http://localhost:${server.port}`);
