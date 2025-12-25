import { Hono } from 'hono';
import type {
  WorkerServerMessage,
  WorkerErrorCode,
  AgentActivityState,
  AppServerMessage,
  GitDiffWorker,
} from '@agent-console/shared';
import { WS_READY_STATE, WS_CLOSE_CODE } from '@agent-console/shared';
import type { WSContext } from 'hono/ws';
import { getSessionManager } from '../services/session-manager.js';
import { getAgentManager } from '../services/agent-manager.js';
import { getRepositoryManager } from '../services/repository-manager.js';
import { createWorkerMessageHandler } from './worker-handler.js';
import { handleGitDiffConnection, handleGitDiffMessage, handleGitDiffDisconnection } from './git-diff-handler.js';
import { createLogger } from '../lib/logger.js';
import { serverConfig } from '../lib/server-config.js';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UpgradeWebSocketFn = (handler: (c: any) => any) => any;

export async function setupWebSocketRoutes(
  app: Hono,
  upgradeWebSocket: UpgradeWebSocketFn
) {
  // Get properly initialized SessionManager (with SQLite repository and JobQueue)
  const sessionManager = getSessionManager();

  // Create worker message handler with the properly initialized sessionManager
  const handleWorkerMessage = createWorkerMessageHandler({ sessionManager });

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
  const agentManager = await getAgentManager();
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

  // Set up repository lifecycle callbacks to broadcast to all app clients
  const repositoryManager = getRepositoryManager();
  repositoryManager.setLifecycleCallbacks({
    onRepositoryCreated: (repository) => {
      logger.debug({ repositoryId: repository.id }, 'Broadcasting repository-created');
      broadcastToApp({ type: 'repository-created', repository });
    },
    onRepositoryUpdated: (repository) => {
      logger.debug({ repositoryId: repository.id }, 'Broadcasting repository-updated');
      broadcastToApp({ type: 'repository-updated', repository });
    },
    onRepositoryDeleted: (repositoryId) => {
      logger.debug({ repositoryId }, 'Broadcasting repository-deleted');
      broadcastToApp({ type: 'repository-deleted', repositoryId });
    },
  });

  // Create dependency object for app handlers
  const appDeps = {
    getAllSessions: () => sessionManager.getAllSessions(),
    getWorkerActivityState: (sessionId: string, workerId: string) => sessionManager.getWorkerActivityState(sessionId, workerId),
    getAllAgents: async () => {
      const agentManager = await getAgentManager();
      return agentManager.getAllAgents();
    },
    getAllRepositories: () => {
      const repositoryManager = getRepositoryManager();
      return repositoryManager.getAllRepositories();
    },
    logger,
  };

  // Create app message handler with dependencies
  const handleAppMessage = createAppMessageHandler(appDeps);

  // App WebSocket endpoint for real-time state synchronization
  app.get(
    '/ws/app',
    upgradeWebSocket(() => {
      return {
        onOpen(_event: unknown, ws: WSContext) {
          logger.info('App WebSocket connected, sending initial sync');

          // Wait for ALL sync operations to complete before adding to appClients
          // This prevents race conditions where broadcasts arrive before initial sync
          Promise.all([
            sendSessionsSync(ws, appDeps),
            getAgentManager().then((agentManager) => {
              const allAgents = agentManager.getAllAgents();
              const agentsSyncMsg: AppServerMessage = {
                type: 'agents-sync',
                agents: allAgents,
              };
              ws.send(JSON.stringify(agentsSyncMsg));
              logger.debug({ agentCount: allAgents.length }, 'Sent agents-sync');
            }),
            // getRepositoryManager is sync, wrap in Promise.resolve for consistency
            Promise.resolve().then(() => {
              const repoManager = getRepositoryManager();
              const allRepositories = repoManager.getAllRepositories();
              const repositoriesSyncMsg: AppServerMessage = {
                type: 'repositories-sync',
                repositories: allRepositories,
              };
              ws.send(JSON.stringify(repositoriesSyncMsg));
              logger.debug({ repoCount: allRepositories.length }, 'Sent repositories-sync');
            }),
          ]).then(() => {
            // Add to broadcast list AFTER all sync messages sent
            appClients.add(ws);
            logger.debug({ clientCount: appClients.size }, 'App WebSocket ready for broadcasts');
          }).catch((err) => {
            logger.error({ err }, 'Failed to send initial sync');
          });
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
      // Track connection ID for this WebSocket (used to detach callbacks on close)
      let connectionId: string | null = null;

      // Helper function to set up PTY worker handlers after async restore
      // The order is critical to prevent duplicates and lost data:
      // 1. Get current offset BEFORE registering callbacks (marks the boundary)
      // 2. Register callbacks for NEW output (after the offset)
      // 3. Send history UP TO the offset we recorded
      async function setupPtyWorkerHandlers(ws: WSContext, workerType: string) {
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
          // Check if WebSocket is still open
          const readyState = getWebSocketReadyState(ws);
          if (readyState !== undefined && readyState !== WS_READY_STATE.OPEN) {
            return; // Don't send to closing/closed WebSocket
          }

          if (msg.type === 'output') {
            // Buffer output messages
            outputBuffer += msg.data;

            // Flush immediately if buffer exceeds threshold (prevents unbounded memory growth)
            if (outputBuffer.length >= serverConfig.WORKER_OUTPUT_FLUSH_THRESHOLD) {
              flushBuffer();
              return;
            }

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

        // Register callbacks for new output
        connectionId = sessionManager.attachWorkerCallbacks(sessionId, workerId, {
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

        // Send full history on initial connection with timeout protection
        const INITIAL_HISTORY_TIMEOUT_MS = 15000; // 15s for initial connection (may be large file/slow disk)
        const timeoutPromise = new Promise<null>((_, reject) => {
          setTimeout(() => reject(new Error('Initial history request timeout')), INITIAL_HISTORY_TIMEOUT_MS);
        });

        try {
          const historyResult = await Promise.race([
            sessionManager.getWorkerOutputHistory(sessionId, workerId, 0),
            timeoutPromise
          ]);

          if (historyResult) {
            if (historyResult.data) {
              safeSend({ type: 'history', data: historyResult.data });
            }
          } else {
            // Fallback to in-memory buffer if file not available
            const history = sessionManager.getWorkerOutputBuffer(sessionId, workerId);
            if (history) {
              safeSend({ type: 'history', data: history });
            }
          }
        } catch (err) {
          logger.error({ sessionId, workerId, err }, 'Error loading initial history');
          // Fallback to in-memory buffer on timeout or error
          const history = sessionManager.getWorkerOutputBuffer(sessionId, workerId);
          if (history) {
            safeSend({ type: 'history', data: history });
          } else {
            // No history available - send error
            safeSend({
              type: 'error',
              message: 'Loading terminal history timed out. Try refreshing the page.',
              code: 'HISTORY_LOAD_FAILED'
            });
          }
        }

        // Send current activity state on connection (for agent workers)
        if (workerType === 'agent') {
          const activityState = sessionManager.getWorkerActivityState(sessionId, workerId);
          if (activityState && activityState !== 'unknown') {
            safeSend({ type: 'activity', state: activityState });
          }
        }
      }

      /**
       * Send error message to client before closing connection.
       * Error message includes a user-friendly message and optional error code.
       */
      function sendErrorAndClose(
        ws: WSContext,
        message: string,
        code: WorkerErrorCode,
        closeCode: number = WS_CLOSE_CODE.NORMAL_CLOSURE
      ): void {
        try {
          // Send error message first so client knows what went wrong
          const errorMsg: WorkerServerMessage = { type: 'error', message, code };
          ws.send(JSON.stringify(errorMsg));
          // Then send exit message for proper cleanup
          const exitMsg: WorkerServerMessage = { type: 'exit', exitCode: 1, signal: null };
          ws.send(JSON.stringify(exitMsg));
          ws.close(closeCode, message);
        } catch {
          // Ignore send/close errors (connection may already be closed)
        }
      }

      return {
        onOpen(_event: unknown, ws: WSContext) {
          const session = sessionManager.getSession(sessionId);
          if (!session) {
            sendErrorAndClose(ws, 'Session not found', 'WORKER_NOT_FOUND');
            return;
          }

          const worker = session.workers.find(w => w.id === workerId);
          if (!worker) {
            sendErrorAndClose(ws, 'Worker not found', 'WORKER_NOT_FOUND');
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
                ws.close(WS_CLOSE_CODE.INTERNAL_ERROR, 'Git diff connection failed');
              } catch {
                // Ignore send/close errors (connection may already be closed)
              }
            });
            return;
          }

          // PTY-based worker handling (agent/terminal)
          // Restore worker if it doesn't exist internally (e.g., after server restart)
          // Note: restoreWorker is async, so we handle it with .then()/.catch()
          sessionManager.restoreWorker(sessionId, workerId).then(async (restoredWorker) => {
            if (!restoredWorker) {
              logger.warn({ sessionId, workerId }, 'Failed to restore PTY worker');
              // restoreWorker returns null for: path not found, worker not found, or git-diff workers
              sendErrorAndClose(ws, 'Worker activation failed. Session path may no longer exist.', 'PATH_NOT_FOUND');
              return;
            }

            await setupPtyWorkerHandlers(ws, restoredWorker.type);
          }).catch((err) => {
            logger.error({ sessionId, workerId, err }, 'Error restoring PTY worker');
            sendErrorAndClose(ws, 'Worker activation error', 'ACTIVATION_FAILED', WS_CLOSE_CODE.INTERNAL_ERROR);
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

          // PTY-based worker: Check for request-history message first
          try {
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed === 'object' && parsed.type === 'request-history') {
              // Handle request-history: send full history to client with timeout
              const HISTORY_REQUEST_TIMEOUT_MS = 5000;

              const timeoutPromise = new Promise<null>((_, reject) => {
                setTimeout(() => reject(new Error('History request timeout')), HISTORY_REQUEST_TIMEOUT_MS);
              });

              Promise.race([
                sessionManager.getWorkerOutputHistory(sessionId, workerId, 0),
                timeoutPromise
              ])
                .then((historyResult) => {
                  if (historyResult) {
                    const historyMsg: WorkerServerMessage = {
                      type: 'history',
                      data: historyResult.data,
                    };
                    ws.send(JSON.stringify(historyMsg));
                    logger.debug({ sessionId, workerId, dataLength: historyResult.data.length }, 'Sent history on request');
                  } else {
                    // Fallback to in-memory buffer
                    const history = sessionManager.getWorkerOutputBuffer(sessionId, workerId);
                    if (history) {
                      const historyMsg: WorkerServerMessage = {
                        type: 'history',
                        data: history,
                      };
                      ws.send(JSON.stringify(historyMsg));
                      logger.debug({ sessionId, workerId, dataLength: history.length }, 'Sent buffer history on request');
                    } else {
                      // No history available - send error
                      const errorMsg: WorkerServerMessage = {
                        type: 'error',
                        message: 'Terminal history not available. The session may have been recently created.',
                        code: 'HISTORY_LOAD_FAILED'
                      };
                      ws.send(JSON.stringify(errorMsg));
                      logger.warn({ sessionId, workerId }, 'No history available for request-history');
                    }
                  }
                })
                .catch((err) => {
                  logger.error({ sessionId, workerId, err }, 'Error sending history on request');
                  // Send error to client
                  try {
                    const errorMsg: WorkerServerMessage = {
                      type: 'error',
                      message: err.message === 'History request timeout'
                        ? 'Loading terminal history timed out. Try switching to another worker and back, or refresh the page.'
                        : 'Failed to load terminal history. Try switching workers or refreshing.',
                      code: 'HISTORY_LOAD_FAILED'
                    };
                    ws.send(JSON.stringify(errorMsg));
                  } catch {
                    // Connection may be closed
                  }
                });
              return;
            }
          } catch {
            // Not JSON or invalid - fall through to regular handler
          }

          // PTY-based worker message handling (input, resize, image)
          handleWorkerMessage(ws, sessionId, workerId, data);
        },
        onClose() {
          logger.info({ sessionId, workerId, connectionId }, 'Worker WebSocket disconnected');

          // Check if this was a git-diff worker
          const session = sessionManager.getSession(sessionId);
          const worker = session?.workers.find(w => w.id === workerId);

          if (worker?.type === 'git-diff') {
            // Stop file watching for git-diff workers
            handleGitDiffDisconnection(sessionId, workerId).catch((err) => {
              logger.error({ sessionId, workerId, err }, 'Error handling git-diff disconnection');
            });
          } else if (connectionId) {
            // Detach this connection's callbacks but keep worker alive (only for PTY workers)
            // Other connections (browser tabs) will continue receiving output
            sessionManager.detachWorkerCallbacks(sessionId, workerId, connectionId);
          }
        },
        onError(event: Event) {
          logger.error({ sessionId, workerId, connectionId, event }, 'Worker WebSocket error');

          // Clean up resources on error to prevent leaks
          const session = sessionManager.getSession(sessionId);
          const worker = session?.workers.find(w => w.id === workerId);

          if (worker?.type === 'git-diff') {
            // Stop file watching for git-diff workers on error
            handleGitDiffDisconnection(sessionId, workerId).catch((err) => {
              logger.error({ sessionId, workerId, err }, 'Error cleaning up git-diff on WebSocket error');
            });
          } else if (worker && connectionId) {
            // Detach this connection's callbacks for PTY workers (agent/terminal)
            sessionManager.detachWorkerCallbacks(sessionId, workerId, connectionId);
          }
        },
      };
    })
  );
}
