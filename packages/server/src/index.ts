import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { api } from './routes/api.js';
import { setupWebSocketRoutes } from './websocket/routes.js';
import { onApiError } from './lib/error-handler.js';

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// Global error handler
app.onError(onApiError);

// Middleware
app.use('*', logger());
app.use('*', cors({
  origin: ['http://localhost:5173'], // Vite dev server
}));

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

// Mount API routes
app.route('/api', api);

// Setup WebSocket routes
setupWebSocketRoutes(app, upgradeWebSocket);

const PORT = Number(process.env.PORT) || 3457;

console.log(`Server starting on http://localhost:${PORT}`);

const server = serve({
  fetch: app.fetch,
  port: PORT,
});

injectWebSocket(server);

export default app;
