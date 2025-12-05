import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import type { TerminalServerMessage, CreateWorktreeRequest, ClaudeActivityState, DashboardServerMessage } from '@agents-web-console/shared';
import type { WSContext } from 'hono/ws';
import { sessionManager } from './services/session-manager.js';
import { repositoryManager } from './services/repository-manager.js';
import { worktreeService } from './services/worktree-service.js';
import { shellManager } from './services/shell-manager.js';
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
  return c.json({ message: 'Agents Web Console API' });
});

// Get server config
app.get('/api/config', (c) => {
  return c.json({ homeDir: homedir() });
});

// Get all sessions
app.get('/api/sessions', (c) => {
  const sessions = sessionManager.getAllSessions();
  return c.json({ sessions });
});

// Create a new session
app.post('/api/sessions', async (c) => {
  const body = await c.req.json<{
    worktreePath?: string;
    repositoryId?: string;
    continueConversation?: boolean;
  }>();
  const {
    worktreePath = process.cwd(),
    repositoryId = 'default',
    continueConversation = false,
  } = body;

  // Create session without WebSocket initially
  // The WebSocket connection will attach to it later
  const session = sessionManager.createSession(
    worktreePath,
    repositoryId,
    () => {}, // onData placeholder - will be replaced by WebSocket
    () => {}, // onExit placeholder - will be replaced by WebSocket
    continueConversation
  );

  return c.json({ session }, 201);
});

// Get session metadata (for reconnection UI)
app.get('/api/sessions/:id/metadata', (c) => {
  const sessionId = c.req.param('id');

  // First check if session is active
  const activeSession = sessionManager.getSession(sessionId);
  if (activeSession) {
    return c.json({
      id: activeSession.id,
      worktreePath: activeSession.worktreePath,
      repositoryId: activeSession.repositoryId,
      isActive: true,
    });
  }

  // Check persisted metadata for dead sessions
  const metadata = sessionManager.getSessionMetadata(sessionId);
  if (metadata) {
    return c.json({
      id: metadata.id,
      worktreePath: metadata.worktreePath,
      repositoryId: metadata.repositoryId,
      isActive: false,
    });
  }

  return c.json({ error: 'Session not found' }, 404);
});

// Restart a dead session (reuse same session ID)
app.post('/api/sessions/:id/restart', async (c) => {
  const sessionId = c.req.param('id');
  const body = await c.req.json<{ continueConversation?: boolean }>();
  const { continueConversation = false } = body;

  const session = sessionManager.restartSession(
    sessionId,
    () => {}, // onData placeholder - will be replaced by WebSocket
    () => {}, // onExit placeholder - will be replaced by WebSocket
    continueConversation
  );

  if (!session) {
    return c.json({ error: 'Session not found or already active' }, 404);
  }

  return c.json({ session });
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
  const rawWorktreePath = pathMatch ? decodeURIComponent(pathMatch[1]) : '';

  if (!rawWorktreePath) {
    return c.json({ error: 'worktree path is required' }, 400);
  }

  // Canonicalize path to prevent path traversal attacks
  const worktreePath = resolvePath(rawWorktreePath);

  // Verify this is actually a worktree of this repository
  if (!worktreeService.isWorktreeOf(repo.path, worktreePath)) {
    return c.json({ error: 'Invalid worktree path for this repository' }, 400);
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

// ========== Dashboard WebSocket ==========
// Track connected dashboard clients for broadcasting
const dashboardClients = new Set<WSContext>();

// Set up global activity callback to broadcast to all dashboard clients
sessionManager.setGlobalActivityCallback((sessionId, state) => {
  const msg: DashboardServerMessage = {
    type: 'session-activity',
    sessionId,
    activityState: state,
  };
  const msgStr = JSON.stringify(msg);
  for (const client of dashboardClients) {
    try {
      client.send(msgStr);
    } catch (e) {
      console.error('Failed to send to dashboard client:', e);
    }
  }
});

// Dashboard WebSocket endpoint for real-time updates
app.get(
  '/ws/dashboard',
  upgradeWebSocket(() => {
    return {
      onOpen(_event, ws) {
        dashboardClients.add(ws);
        console.log(`Dashboard WebSocket connected (${dashboardClients.size} clients)`);

        // Send current state of all sessions on connect
        const allSessions = sessionManager.getAllSessions();
        const syncMsg: DashboardServerMessage = {
          type: 'sessions-sync',
          sessions: allSessions.map(s => ({
            id: s.id,
            activityState: s.activityState ?? 'unknown',
          })),
        };
        ws.send(JSON.stringify(syncMsg));
        console.log(`Sent sessions-sync with ${allSessions.length} sessions`);
      },
      onClose(_event, ws) {
        dashboardClients.delete(ws);
        console.log(`Dashboard WebSocket disconnected (${dashboardClients.size} clients)`);
      },
    };
  })
);

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
          },
          (state: ClaudeActivityState) => {
            const msg: TerminalServerMessage = { type: 'activity', state };
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

        // Send current activity state on connection
        const activityState = sessionManager.getActivityState(sessionId);
        if (activityState && activityState !== 'unknown') {
          const activityMsg: TerminalServerMessage = { type: 'activity', state: activityState };
          ws.send(JSON.stringify(activityMsg));
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

        // Attach activity change callback
        sessionManager.attachCallbacks(
          sessionId,
          (data) => {
            const msg: TerminalServerMessage = { type: 'output', data };
            ws.send(JSON.stringify(msg));
          },
          (exitCode, signal) => {
            const msg: TerminalServerMessage = { type: 'exit', exitCode, signal };
            ws.send(JSON.stringify(msg));
          },
          (state: ClaudeActivityState) => {
            const msg: TerminalServerMessage = { type: 'activity', state };
            ws.send(JSON.stringify(msg));
          }
        );

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

// ========== Shell WebSocket (regular terminal) ==========
// Creates a new shell instance for the given session's working directory
app.get(
  '/ws/shell',
  upgradeWebSocket((c) => {
    const cwd = c.req.query('cwd') || process.cwd();
    let shellId: string | null = null;

    return {
      onOpen(_event, ws) {
        shellId = shellManager.createShell(
          cwd,
          (data) => {
            const msg: TerminalServerMessage = { type: 'output', data };
            ws.send(JSON.stringify(msg));
          },
          (exitCode, signal) => {
            const msg: TerminalServerMessage = { type: 'exit', exitCode, signal };
            ws.send(JSON.stringify(msg));
          }
        );
        console.log(`Shell WebSocket connected: ${shellId}`);
      },
      onMessage(event) {
        if (!shellId) return;

        try {
          const msgStr = typeof event.data === 'string' ? event.data : event.data.toString();
          const parsed = JSON.parse(msgStr);

          switch (parsed.type) {
            case 'input':
              shellManager.writeInput(shellId, parsed.data);
              break;
            case 'resize':
              shellManager.resize(shellId, parsed.cols, parsed.rows);
              break;
          }
        } catch (e) {
          console.error('Invalid shell message:', e);
        }
      },
      onClose() {
        if (shellId) {
          shellManager.destroyShell(shellId);
          console.log(`Shell WebSocket disconnected: ${shellId}`);
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
