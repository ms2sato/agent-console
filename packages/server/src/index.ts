import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

const app = new Hono();

// Middleware
app.use('*', logger());
app.use('*', cors({
  origin: ['http://localhost:5173'], // Vite dev server
}));

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

// API routes placeholder
app.get('/api', (c) => {
  return c.json({ message: 'Claude Code Web Console API' });
});

const PORT = Number(process.env.PORT) || 3457;

console.log(`Server starting on http://localhost:${PORT}`);

serve({
  fetch: app.fetch,
  port: PORT,
});

export default app;
