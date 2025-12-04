import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { TerminalServerMessage } from '@agents-web-console/shared';
import { sessionManager } from './services/session-manager.js';
import {
  handleTerminalMessage,
} from './websocket/terminal-handler.js';

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// Middleware
app.use('*', logger());
app.use('*', cors({
  origin: ['http://localhost:5173'], // Vite dev server
}));

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

// API routes
app.get('/api', (c) => {
  return c.json({ message: 'Claude Code Web Console API' });
});

// Get all sessions
app.get('/api/sessions', (c) => {
  const sessions = sessionManager.getAllSessions();
  return c.json({ sessions });
});

// Create a new session (for Phase 1, we'll use a simple approach)
app.post('/api/sessions', async (c) => {
  const body = await c.req.json<{ worktreePath: string; repositoryId?: string }>();
  const { worktreePath, repositoryId = 'default' } = body;

  if (!worktreePath) {
    return c.json({ error: 'worktreePath is required' }, 400);
  }

  // Create session without WebSocket initially
  // The WebSocket connection will attach to it later
  const session = sessionManager.createSession(
    worktreePath,
    repositoryId,
    () => {}, // onData placeholder - will be replaced by WebSocket
    () => {}  // onExit placeholder - will be replaced by WebSocket
  );

  return c.json({ session }, 201);
});

// WebSocket endpoint for terminal
app.get(
  '/ws/terminal/:sessionId',
  upgradeWebSocket((c) => {
    const sessionId = c.req.param('sessionId');

    return {
      onOpen(_event, ws) {
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          const errorMsg: TerminalServerMessage = {
            type: 'exit',
            exitCode: 1,
            signal: null,
          };
          ws.send(JSON.stringify(errorMsg));
          ws.close();
          return;
        }

        console.log(`Terminal WebSocket connected for session: ${sessionId}`);

        // Send buffered output (history) on reconnection
        const history = sessionManager.getOutputBuffer(sessionId);
        if (history) {
          const historyMsg: TerminalServerMessage = {
            type: 'history',
            data: history,
          };
          ws.send(JSON.stringify(historyMsg));
        }
      },
      onMessage(event, ws) {
        handleTerminalMessage(ws, sessionId, event.data.toString());
      },
      onClose() {
        console.log(`Terminal WebSocket disconnected for session: ${sessionId}`);
        // Note: We don't kill the session here - it persists for reconnection
      },
    };
  })
);

// Simple WebSocket endpoint that creates a session and connects immediately
// This is for Phase 1 single-session testing
app.get(
  '/ws/terminal-new',
  upgradeWebSocket((c) => {
    const cwd = c.req.query('cwd') || process.cwd();
    let sessionId: string | null = null;

    return {
      onOpen(_event, ws) {
        // Create a new session when WebSocket connects
        const session = sessionManager.createSession(
          cwd,
          'default',
          (data) => {
            const msg: TerminalServerMessage = { type: 'output', data };
            ws.send(JSON.stringify(msg));
          },
          (exitCode, signal) => {
            const msg: TerminalServerMessage = { type: 'exit', exitCode, signal };
            ws.send(JSON.stringify(msg));
          }
        );
        sessionId = session.id;
        console.log(`New terminal session created: ${sessionId}`);
      },
      onMessage(event, ws) {
        if (sessionId) {
          handleTerminalMessage(ws, sessionId, event.data.toString());
        }
      },
      onClose() {
        if (sessionId) {
          console.log(`Terminal disconnected, session preserved: ${sessionId}`);
          // Don't kill session - it persists for reconnection
        }
      },
    };
  })
);

const PORT = Number(process.env.PORT) || 3457;

console.log(`Server starting on http://localhost:${PORT}`);

const server = serve({
  fetch: app.fetch,
  port: PORT,
});

injectWebSocket(server);

export default app;
