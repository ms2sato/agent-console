import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { api } from './routes/api.js';
import { setupWebSocketRoutes } from './websocket/routes.js';
import { onApiError } from './lib/error-handler.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

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
  const publicDir = path.join(__dirname, './public');

  // Serve static files from public directory (use absolute path)
  app.use('/*', serveStatic({
    root: publicDir,
    rewriteRequestPath: (p) => p, // Don't rewrite, use path as-is
  }));

  // SPA fallback: serve index.html for any non-API/WS routes
  app.get('*', (c) => {
    const indexPath = path.join(publicDir, 'index.html');
    const html = fs.readFileSync(indexPath, 'utf-8');
    return c.html(html);
  });
}

const PORT = Number(process.env.PORT) || 3457;

console.log(`Server starting on http://localhost:${PORT} (${isProduction ? 'production' : 'development'})`);

const server = serve({
  fetch: app.fetch,
  port: PORT,
});

injectWebSocket(server);

export default app;
