import { Hono } from 'hono';
import type {
  WorkerServerMessage,
  AgentActivityState,
  AppServerMessage,
  GitDiffWorker,
} from '@agent-console/shared';
import { WS_READY_STATE } from '@agent-console/shared';
import type { WSContext } from 'hono/ws';
import { sessionManager } from '../services/session-manager.js';
import { agentManager } from '../services/agent-manager.js';
import { handleWorkerMessage } from './worker-handler.js';
import { handleGitDiffConnection, handleGitDiffMessage, handleGitDiffDisconnection } from './git-diff-handler.js';
import { createLogger } from '../lib/logger.js';
import { sendSessionsSync, createAppMessageHandler } from './app-handler.js';

const logger = createLogger('websocket');

// Track connected app clients for broadcasting
const appClients = new Set<WSContext>();

/**
 * Safely get the WebSocket ready state from a WSContext.
 * Returns undefined if readyState is not accessible (instead of using unsafe 'any' cast).
 */
function getWebSocketReadyState(client: WSContext): number | undefined {
  // Type-safe check for readyState property
  if ('readyState' in client && typeof (client as { readyState?: unknown }).readyState === 'number') {
    return (client as { readyState: number }).readyState;
  }
  return undefined;
}

// Helper to broadcast message to all app clients
function broadcastToApp(msg: AppServerMessage): void {
  const msgStr = JSON.stringify(msg);
  const deadClients: WSContext[] = [];

  for (const client of appClients) {
    // Skip clients that are not in OPEN state
    const readyState = getWebSocketReadyState(client);
    if (typeof readyState === 'number' && readyState !== WS_READY_STATE.OPEN) {
      deadClients.push(client);
      continue;
    }

    try {
      client.send(msgStr);
    } catch (e) {
      logger.warn({ err: e }, 'Failed to send to app client, removing');
      deadClients.push(client);
    }
  }

  // Clean up dead clients
  if (deadClients.length > 0) {
    for (const client of deadClients) {
      appClients.delete(client);
    }
    logger.debug({ removed: deadClients.length, remaining: appClients.size }, 'Cleaned up dead app clients');
  }
}

// Set up global activity callback to broadcast to all app clients
sessionManager.setGlobalActivityCallback((sessionId, workerId, state) => {
  broadcastToApp({
    type: 'worker-activity',
    sessionId,
    workerId,
    activityState: state,
  });
});

// Set up session lifecycle callbacks to broadcast to all app clients
sessionManager.setSessionLifecycleCallbacks({
  onSessionCreated: (session) => {
    logger.debug({ sessionId: session.id }, 'Broadcasting session-created');
    broadcastToApp({ type: 'session-created', session });
  },
  onSessionUpdated: (session) => {
    logger.debug({ sessionId: session.id }, 'Broadcasting session-updated');
    broadcastToApp({ type: 'session-updated', session });
  },
  onSessionDeleted: (sessionId) => {
    logger.debug({ sessionId }, 'Broadcasting session-deleted');
    broadcastToApp({ type: 'session-deleted', sessionId });
  },
});

// Set up agent lifecycle callbacks to broadcast to all app clients
agentManager.setLifecycleCallbacks({
  onAgentCreated: (agent) => {
    logger.debug({ agentId: agent.id }, 'Broadcasting agent-created');
    broadcastToApp({ type: 'agent-created', agent });
  },
  onAgentUpdated: (agent) => {
    logger.debug({ agentId: agent.id }, 'Broadcasting agent-updated');
    broadcastToApp({ type: 'agent-updated', agent });
  },
  onAgentDeleted: (agentId) => {
    logger.debug({ agentId }, 'Broadcasting agent-deleted');
    broadcastToApp({ type: 'agent-deleted', agentId });
  },
});

// Create app message handler with dependencies
const handleAppMessage = createAppMessageHandler({
  getAllSessions: () => sessionManager.getAllSessions(),
  getWorkerActivityState: (sessionId, workerId) => sessionManager.getWorkerActivityState(sessionId, workerId),
  logger,
});

// Create dependency object for sendSessionsSync
const appDeps = {
  getAllSessions: () => sessionManager.getAllSessions(),
  getWorkerActivityState: (sessionId: string, workerId: string) => sessionManager.getWorkerActivityState(sessionId, workerId),
  logger,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UpgradeWebSocketFn = (handler: (c: any) => any) => any;

export function setupWebSocketRoutes(
  app: Hono,
  upgradeWebSocket: UpgradeWebSocketFn
) {
  // App WebSocket endpoint for real-time state synchronization
  app.get(
    '/ws/app',
    upgradeWebSocket(() => {
      return {
        onOpen(_event: unknown, ws: WSContext) {
          logger.info('App WebSocket connected, sending initial sync');

          // Send current state of all sessions on connect
          // IMPORTANT: Send sync BEFORE adding to appClients to prevent race condition
          // where a session-created broadcast arrives before sessions-sync
          sendSessionsSync(ws, appDeps);

          // Send current state of all agents
          const allAgents = agentManager.getAllAgents();
          const agentsSyncMsg: AppServerMessage = {
            type: 'agents-sync',
            agents: allAgents,
          };
          ws.send(JSON.stringify(agentsSyncMsg));
          logger.debug({ agentCount: allAgents.length }, 'Sent agents-sync');

          // Add to broadcast list AFTER sending sync to ensure correct message ordering
          appClients.add(ws);
          logger.debug({ clientCount: appClients.size }, 'App WebSocket ready for broadcasts');
        },
        onMessage(event: { data: string | ArrayBuffer }, ws: WSContext) {
          handleAppMessage(ws, event.data);
        },
        onClose(_event: unknown, ws: WSContext) {
          // Remove from broadcast list to prevent memory leak
          appClients.delete(ws);
          logger.info({ clientCount: appClients.size }, 'App WebSocket disconnected');
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

      // Helper function to set up PTY worker handlers after async restore
      function setupPtyWorkerHandlers(ws: WSContext, workerType: string) {
        logger.info({ sessionId, workerId, workerType }, 'Worker WebSocket connected');

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
        if (workerType === 'agent') {
          const activityState = sessionManager.getWorkerActivityState(sessionId, workerId);
          if (activityState && activityState !== 'unknown') {
            safeSend({ type: 'activity', state: activityState });
          }
        }
      }

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
              // Send error to client and close WebSocket on critical connection errors
              try {
                ws.send(JSON.stringify({ type: 'diff-error', error: 'Connection failed' }));
                ws.close();
              } catch {
                // Ignore send/close errors (connection may already be closed)
              }
            });
            return;
          }

          // PTY-based worker handling (agent/terminal)
          // Restore worker if it doesn't exist internally (e.g., after server restart)
          // Note: restoreWorker is async, so we handle it with .then()/.catch()
          sessionManager.restoreWorker(sessionId, workerId).then((restoredWorker) => {
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

            setupPtyWorkerHandlers(ws, worker.type);
          }).catch((err) => {
            logger.error({ sessionId, workerId, err }, 'Error restoring PTY worker');
            const errorMsg: WorkerServerMessage = {
              type: 'exit',
              exitCode: 1,
              signal: null,
            };
            ws.send(JSON.stringify(errorMsg));
            ws.close();
          });
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
              // Send error to client (but don't close connection for message errors)
              try {
                ws.send(JSON.stringify({ type: 'diff-error', error: 'Failed to process message' }));
              } catch {
                // Ignore send errors (connection may be closed)
              }
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

          // Clean up resources on error to prevent leaks
          const session = sessionManager.getSession(sessionId);
          const worker = session?.workers.find(w => w.id === workerId);

          if (worker?.type === 'git-diff') {
            // Stop file watching for git-diff workers on error
            handleGitDiffDisconnection(sessionId, workerId).catch((err) => {
              logger.error({ sessionId, workerId, err }, 'Error cleaning up git-diff on WebSocket error');
            });
          } else if (worker) {
            // Detach callbacks for PTY workers (agent/terminal)
            sessionManager.detachWorkerCallbacks(sessionId, workerId);
          }
        },
      };
    })
  );
}
