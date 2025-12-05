import { Hono } from 'hono';
import type { TerminalServerMessage, ClaudeActivityState, DashboardServerMessage } from '@agents-web-console/shared';
import type { WSContext } from 'hono/ws';
import { sessionManager } from '../services/session-manager.js';
import { shellManager } from '../services/shell-manager.js';
import { handleTerminalMessage } from './terminal-handler.js';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UpgradeWebSocketFn = (handler: (c: any) => any) => any;

export function setupWebSocketRoutes(
  app: Hono,
  upgradeWebSocket: UpgradeWebSocketFn
) {
  // Dashboard WebSocket endpoint for real-time updates
  app.get(
    '/ws/dashboard',
    upgradeWebSocket(() => {
      return {
        onOpen(_event: unknown, ws: WSContext) {
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
        onClose(_event: unknown, ws: WSContext) {
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
        onOpen(_event: unknown, ws: WSContext) {
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
        onMessage(event: { data: string | Buffer }, ws: WSContext) {
          const data = typeof event.data === 'string' ? event.data : event.data.toString();
          handleTerminalMessage(ws, sessionId, data);
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
        onOpen(_event: unknown, ws: WSContext) {
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
        onMessage(event: { data: string | Buffer }, ws: WSContext) {
          if (sessionId) {
            const data = typeof event.data === 'string' ? event.data : event.data.toString();
            handleTerminalMessage(ws, sessionId, data);
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

  // Shell WebSocket (regular terminal)
  // Creates a new shell instance for the given working directory
  app.get(
    '/ws/shell',
    upgradeWebSocket((c) => {
      const cwd = c.req.query('cwd') || process.cwd();
      let shellId: string | null = null;

      return {
        onOpen(_event: unknown, ws: WSContext) {
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
        onMessage(event: { data: string | Buffer }) {
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
}
