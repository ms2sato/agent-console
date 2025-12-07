import { Hono } from 'hono';
import type { TerminalServerMessage, ClaudeActivityState, DashboardServerMessage } from '@agent-console/shared';
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

          // Helper to safely send WebSocket messages with buffering
          let outputBuffer = '';
          let flushTimer: ReturnType<typeof setTimeout> | null = null;
          const FLUSH_INTERVAL = 50; // ms

          const flushBuffer = () => {
            if (outputBuffer.length > 0 && ws.readyState === 1) {
              try {
                ws.send(JSON.stringify({ type: 'output', data: outputBuffer }));
              } catch (error) {
                console.error(`[WS] Error sending to session ${sessionId}:`, error);
              }
              outputBuffer = '';
            }
            flushTimer = null;
          };

          const safeSend = (msg: TerminalServerMessage) => {
            if (msg.type === 'output') {
              // Buffer output messages
              outputBuffer += msg.data;
              if (!flushTimer) {
                flushTimer = setTimeout(flushBuffer, FLUSH_INTERVAL);
              }
            } else {
              // Send other messages immediately
              if (ws.readyState === 1) {
                try {
                  ws.send(JSON.stringify(msg));
                } catch (error) {
                  console.error(`[WS] Error sending to session ${sessionId}:`, error);
                }
              }
            }
          };

          // Attach callbacks to receive real-time output
          sessionManager.attachCallbacks(
            sessionId,
            (data) => {
              safeSend({ type: 'output', data });
            },
            (exitCode, signal) => {
              safeSend({ type: 'exit', exitCode, signal });
            },
            (state: ClaudeActivityState) => {
              safeSend({ type: 'activity', state });
            }
          );

          // Send buffered output (history) on reconnection
          const history = sessionManager.getOutputBuffer(sessionId);
          if (history) {
            safeSend({ type: 'history', data: history });
          }

          // Send current activity state on connection
          const activityState = sessionManager.getActivityState(sessionId);
          if (activityState && activityState !== 'unknown') {
            safeSend({ type: 'activity', state: activityState });
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
        onError(event: Event) {
          console.error(`Terminal WebSocket error for session ${sessionId}:`, event);
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
