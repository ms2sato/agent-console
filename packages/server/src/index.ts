import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { TerminalServerMessage, CreateWorktreeRequest } from '@agents-web-console/shared';
import { sessionManager } from './services/session-manager.js';
import { repositoryManager } from './services/repository-manager.js';
import { worktreeService } from './services/worktree-service.js';
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

// Create a new session
app.post('/api/sessions', async (c) => {
  const body = await c.req.json<{ worktreePath?: string; repositoryId?: string }>();
  const { worktreePath = process.cwd(), repositoryId = 'default' } = body;

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

// Delete a session
app.delete('/api/sessions/:id', (c) => {
  const sessionId = c.req.param('id');
  const success = sessionManager.killSession(sessionId);

  if (!success) {
    return c.json({ error: 'Session not found' }, 404);
  }

  return c.json({ success: true });
});

// ========== Repository API ==========

// Get all repositories
app.get('/api/repositories', (c) => {
  const repositories = repositoryManager.getAllRepositories();
  return c.json({ repositories });
});

// Register a repository
app.post('/api/repositories', async (c) => {
  const body = await c.req.json<{ path: string }>();
  const { path } = body;

  if (!path) {
    return c.json({ error: 'path is required' }, 400);
  }

  try {
    const repository = repositoryManager.registerRepository(path);
    return c.json({ repository }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 400);
  }
});

// Unregister a repository
app.delete('/api/repositories/:id', (c) => {
  const repoId = c.req.param('id');
  const success = repositoryManager.unregisterRepository(repoId);

  if (!success) {
    return c.json({ error: 'Repository not found' }, 404);
  }

  return c.json({ success: true });
});

// ========== Worktree API ==========

// Get worktrees for a repository
app.get('/api/repositories/:id/worktrees', (c) => {
  const repoId = c.req.param('id');
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    return c.json({ error: 'Repository not found' }, 404);
  }

  const worktrees = worktreeService.listWorktrees(repo.path, repoId);
  return c.json({ worktrees });
});

// Create a worktree
app.post('/api/repositories/:id/worktrees', async (c) => {
  const repoId = c.req.param('id');
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    return c.json({ error: 'Repository not found' }, 404);
  }

  const body = await c.req.json<CreateWorktreeRequest>();
  const { branch, baseBranch, autoStartSession } = body;

  if (!branch) {
    return c.json({ error: 'branch is required' }, 400);
  }

  const result = await worktreeService.createWorktree(repo.path, branch, baseBranch);

  if (result.error) {
    return c.json({ error: result.error }, 400);
  }

  // Get the created worktree info
  const worktrees = worktreeService.listWorktrees(repo.path, repoId);
  const worktree = worktrees.find(wt => wt.path === result.worktreePath);

  // Optionally start a session
  let session = null;
  if (autoStartSession && worktree) {
    session = sessionManager.createSession(
      worktree.path,
      repoId,
      () => {},
      () => {}
    );
  }

  return c.json({ worktree, session }, 201);
});

// Delete a worktree
app.delete('/api/repositories/:id/worktrees/*', async (c) => {
  const repoId = c.req.param('id');
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    return c.json({ error: 'Repository not found' }, 404);
  }

  // Get worktree path from URL (everything after /worktrees/)
  const url = new URL(c.req.url);
  const pathMatch = url.pathname.match(/\/worktrees\/(.+)$/);
  const worktreePath = pathMatch ? decodeURIComponent(pathMatch[1]) : '';

  if (!worktreePath) {
    return c.json({ error: 'worktree path is required' }, 400);
  }

  // Check for force flag in query
  const force = c.req.query('force') === 'true';

  // Kill any sessions running in this worktree
  const sessions = sessionManager.getAllSessions();
  for (const session of sessions) {
    if (session.worktreePath === worktreePath) {
      if (!force) {
        return c.json({
          error: 'Session is running in this worktree. Use force=true to terminate.',
          sessionId: session.id
        }, 409);
      }
      sessionManager.killSession(session.id);
    }
  }

  const result = await worktreeService.removeWorktree(repo.path, worktreePath, force);

  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }

  return c.json({ success: true });
});

// Get branches for a repository
app.get('/api/repositories/:id/branches', (c) => {
  const repoId = c.req.param('id');
  const repo = repositoryManager.getRepository(repoId);

  if (!repo) {
    return c.json({ error: 'Repository not found' }, 404);
  }

  const branches = worktreeService.listBranches(repo.path);
  return c.json(branches);
});

// WebSocket endpoint for terminal (reconnect to existing session)
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

        // Attach callbacks to receive real-time output
        sessionManager.attachCallbacks(
          sessionId,
          (data) => {
            const msg: TerminalServerMessage = { type: 'output', data };
            ws.send(JSON.stringify(msg));
          },
          (exitCode, signal) => {
            const msg: TerminalServerMessage = { type: 'exit', exitCode, signal };
            ws.send(JSON.stringify(msg));
          }
        );

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
        // Detach callbacks but keep session alive
        sessionManager.detachCallbacks(sessionId);
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
