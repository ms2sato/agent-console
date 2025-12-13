import { Hono } from 'hono';
import type {
  WorkerServerMessage,
  AgentActivityState,
  DashboardServerMessage,
  GitDiffWorker,
} from '@agent-console/shared';
import type { WSContext } from 'hono/ws';
import { sessionManager } from '../services/session-manager.js';
import { handleWorkerMessage } from './worker-handler.js';
import { handleGitDiffConnection, handleGitDiffMessage } from './git-diff-handler.js';

// Track connected dashboard clients for broadcasting
const dashboardClients = new Set<WSContext>();

// Set up global activity callback to broadcast to all dashboard clients
sessionManager.setGlobalActivityCallback((sessionId, workerId, state) => {
  const msg: DashboardServerMessage = {
    type: 'worker-activity',
    sessionId,
    workerId,
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
              workers: s.workers
                .filter(w => w.type === 'agent')
                .map(w => ({
                  id: w.id,
                  activityState: sessionManager.getWorkerActivityState(s.id, w.id),
                })),
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

  // WebSocket endpoint for worker connection
  app.get(
    '/ws/session/:sessionId/worker/:workerId',
    upgradeWebSocket((c) => {
      const sessionId = c.req.param('sessionId');
      const workerId = c.req.param('workerId');

      // Track current baseCommit for git-diff workers (can be updated via set-base-commit message)
      let currentGitDiffBaseCommit: string | null = null;

      return {
        onOpen(_event: unknown, ws: WSContext) {
          const session = sessionManager.getSession(sessionId);
          if (!session) {
            const errorMsg: WorkerServerMessage = {
              type: 'exit',
              exitCode: 1,
              signal: null,
            };
            ws.send(JSON.stringify(errorMsg));
            ws.close();
            return;
          }

          const worker = session.workers.find(w => w.id === workerId);
          if (!worker) {
            const errorMsg: WorkerServerMessage = {
              type: 'exit',
              exitCode: 1,
              signal: null,
            };
            ws.send(JSON.stringify(errorMsg));
            ws.close();
            return;
          }

          // Handle git-diff workers differently
          if (worker.type === 'git-diff') {
            currentGitDiffBaseCommit = (worker as GitDiffWorker).baseCommit;
            handleGitDiffConnection(
              ws,
              sessionId,
              workerId,
              session.locationPath,
              currentGitDiffBaseCommit
            );
            return;
          }

          // PTY-based worker handling (agent/terminal)
          console.log(`Worker WebSocket connected: session=${sessionId}, worker=${workerId}`);

          // Helper to safely send WebSocket messages with buffering
          let outputBuffer = '';
          let flushTimer: ReturnType<typeof setTimeout> | null = null;
          const FLUSH_INTERVAL = 50; // ms

          const flushBuffer = () => {
            if (outputBuffer.length > 0) {
              try {
                ws.send(JSON.stringify({ type: 'output', data: outputBuffer }));
              } catch (error) {
                console.error(`[WS] Error sending to worker ${workerId}:`, error);
              }
              outputBuffer = '';
            }
            flushTimer = null;
          };

          const safeSend = (msg: WorkerServerMessage) => {
            if (msg.type === 'output') {
              // Buffer output messages
              outputBuffer += msg.data;
              if (!flushTimer) {
                flushTimer = setTimeout(flushBuffer, FLUSH_INTERVAL);
              }
            } else {
              // Send other messages immediately
              try {
                ws.send(JSON.stringify(msg));
              } catch (error) {
                console.error(`[WS] Error sending to worker ${workerId}:`, error);
              }
            }
          };

          // Attach callbacks to receive real-time output
          sessionManager.attachWorkerCallbacks(sessionId, workerId, {
            onData: (data) => {
              safeSend({ type: 'output', data });
            },
            onExit: (exitCode, signal) => {
              safeSend({ type: 'exit', exitCode, signal });
            },
            onActivityChange: (state: AgentActivityState) => {
              safeSend({ type: 'activity', state });
            },
          });

          // Send buffered output (history) on reconnection
          const history = sessionManager.getWorkerOutputBuffer(sessionId, workerId);
          if (history) {
            safeSend({ type: 'history', data: history });
          }

          // Send current activity state on connection (for agent workers)
          if (worker.type === 'agent') {
            const activityState = sessionManager.getWorkerActivityState(sessionId, workerId);
            if (activityState && activityState !== 'unknown') {
              safeSend({ type: 'activity', state: activityState });
            }
          }
        },
        onMessage(event: { data: string | ArrayBuffer }, ws: WSContext) {
          const data = typeof event.data === 'string'
            ? event.data
            : new TextDecoder().decode(event.data);

          // Get session to check worker type
          const session = sessionManager.getSession(sessionId);
          if (!session) return;

          const worker = session.workers.find(w => w.id === workerId);
          if (!worker) return;

          // Handle git-diff messages differently
          if (worker.type === 'git-diff') {
            handleGitDiffMessage(
              ws,
              sessionId,
              workerId,
              session.locationPath,
              currentGitDiffBaseCommit || (worker as GitDiffWorker).baseCommit,
              data,
              (newBaseCommit) => {
                currentGitDiffBaseCommit = newBaseCommit;
              }
            );
            return;
          }

          // PTY-based worker message handling
          handleWorkerMessage(ws, sessionId, workerId, data);
        },
        onClose() {
          console.log(`Worker WebSocket disconnected: session=${sessionId}, worker=${workerId}`);
          // Detach callbacks but keep worker alive (only for PTY workers)
          sessionManager.detachWorkerCallbacks(sessionId, workerId);
        },
        onError(event: Event) {
          console.error(`Worker WebSocket error: session=${sessionId}, worker=${workerId}:`, event);
        },
      };
    })
  );
}
