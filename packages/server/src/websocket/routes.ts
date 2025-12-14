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
import { handleGitDiffConnection, handleGitDiffMessage, handleGitDiffDisconnection } from './git-diff-handler.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('websocket');

// Track connected dashboard clients for broadcasting
const dashboardClients = new Set<WSContext>();

// Helper to broadcast message to all dashboard clients
function broadcastToDashboard(msg: DashboardServerMessage): void {
  const msgStr = JSON.stringify(msg);
  for (const client of dashboardClients) {
    try {
      client.send(msgStr);
    } catch (e) {
      logger.warn({ err: e }, 'Failed to send to dashboard client');
    }
  }
}

// Set up global activity callback to broadcast to all dashboard clients
sessionManager.setGlobalActivityCallback((sessionId, workerId, state) => {
  broadcastToDashboard({
    type: 'worker-activity',
    sessionId,
    workerId,
    activityState: state,
  });
});

// Set up session lifecycle callbacks to broadcast to all dashboard clients
sessionManager.setSessionLifecycleCallbacks({
  onSessionCreated: (session) => {
    logger.debug({ sessionId: session.id }, 'Broadcasting session-created');
    broadcastToDashboard({ type: 'session-created', session });
  },
  onSessionUpdated: (session) => {
    logger.debug({ sessionId: session.id }, 'Broadcasting session-updated');
    broadcastToDashboard({ type: 'session-updated', session });
  },
  onSessionDeleted: (sessionId) => {
    logger.debug({ sessionId }, 'Broadcasting session-deleted');
    broadcastToDashboard({ type: 'session-deleted', sessionId });
  },
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
          logger.info({ clientCount: dashboardClients.size }, 'Dashboard WebSocket connected');

          // Send current state of all sessions on connect
          const allSessions = sessionManager.getAllSessions();

          // Collect activity states for all agent workers
          const activityStates: { sessionId: string; workerId: string; activityState: import('@agent-console/shared').AgentActivityState }[] = [];
          for (const session of allSessions) {
            for (const worker of session.workers) {
              if (worker.type === 'agent') {
                const state = sessionManager.getWorkerActivityState(session.id, worker.id);
                if (state) {
                  activityStates.push({
                    sessionId: session.id,
                    workerId: worker.id,
                    activityState: state,
                  });
                }
              }
            }
          }

          const syncMsg: DashboardServerMessage = {
            type: 'sessions-sync',
            sessions: allSessions,
            activityStates,
          };
          ws.send(JSON.stringify(syncMsg));
          logger.debug({ sessionCount: allSessions.length }, 'Sent sessions-sync');
        },
        onClose(_event: unknown, ws: WSContext) {
          dashboardClients.delete(ws);
          logger.info({ clientCount: dashboardClients.size }, 'Dashboard WebSocket disconnected');
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
            ).catch((err) => {
              logger.error({ sessionId, workerId, err }, 'Error handling git-diff connection');
            });
            return;
          }

          // PTY-based worker handling (agent/terminal)
          // Restore worker if it doesn't exist internally (e.g., after server restart)
          const restoredWorker = sessionManager.restoreWorker(sessionId, workerId);
          if (!restoredWorker) {
            logger.warn({ sessionId, workerId }, 'Failed to restore PTY worker');
            const errorMsg: WorkerServerMessage = {
              type: 'exit',
              exitCode: 1,
              signal: null,
            };
            ws.send(JSON.stringify(errorMsg));
            ws.close();
            return;
          }

          logger.info({ sessionId, workerId, workerType: worker.type }, 'Worker WebSocket connected');

          // Helper to safely send WebSocket messages with buffering
          let outputBuffer = '';
          let flushTimer: ReturnType<typeof setTimeout> | null = null;
          const FLUSH_INTERVAL = 50; // ms

          const flushBuffer = () => {
            if (outputBuffer.length > 0) {
              try {
                ws.send(JSON.stringify({ type: 'output', data: outputBuffer }));
              } catch (error) {
                logger.warn({ workerId, err: error }, 'Error flushing output buffer to worker');
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
                logger.warn({ workerId, err: error }, 'Error sending message to worker');
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
              data
            ).catch((err) => {
              logger.error({ sessionId, workerId, err }, 'Error handling git-diff message');
            });
            return;
          }

          // PTY-based worker message handling
          handleWorkerMessage(ws, sessionId, workerId, data);
        },
        onClose() {
          logger.info({ sessionId, workerId }, 'Worker WebSocket disconnected');

          // Check if this was a git-diff worker
          const session = sessionManager.getSession(sessionId);
          const worker = session?.workers.find(w => w.id === workerId);

          if (worker?.type === 'git-diff') {
            // Stop file watching for git-diff workers
            handleGitDiffDisconnection(sessionId, workerId).catch((err) => {
              logger.error({ sessionId, workerId, err }, 'Error handling git-diff disconnection');
            });
          } else {
            // Detach callbacks but keep worker alive (only for PTY workers)
            sessionManager.detachWorkerCallbacks(sessionId, workerId);
          }
        },
        onError(event: Event) {
          logger.error({ sessionId, workerId, event }, 'Worker WebSocket error');
        },
      };
    })
  );
}
