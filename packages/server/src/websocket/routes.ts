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
import { getNotificationManager } from '../services/notifications/index.js';
import { createWorkerMessageHandler } from './worker-handler.js';
import { handleGitDiffConnection, handleGitDiffMessage, handleGitDiffDisconnection } from './git-diff-handler.js';
import { createLogger } from '../lib/logger.js';
import { serverConfig } from '../lib/server-config.js';
import { sendSessionsSync, createAppMessageHandler } from './app-handler.js';
import { setOutputTruncatedCallback } from '../lib/worker-output-file.js';

const logger = createLogger('websocket');

// Track connected app clients for broadcasting
const appClients = new Set<WSContext>();

// Clients still syncing initial state - broadcasts are queued until sync completes
const syncingClients = new Set<WSContext>();
const clientQueues = new Map<WSContext, AppServerMessage[]>();

// Queue messages for clients that are still syncing initial state
// Messages will be replayed after sync completes to prevent lost events
const syncingClientQueues = new Map<WSContext, AppServerMessage[]>();

// Maximum number of messages to queue per client to prevent memory issues
const MAX_SYNC_QUEUE_SIZE = 100;

// Track Worker WebSocket connections by session for session deletion notification
const workerConnectionsBySession = new Map<string, Set<WSContext>>();

// Track Worker WebSocket connections by session+worker for per-worker notifications (e.g., output truncation)
const workerConnections = new Map<string, Set<WSContext>>();

/**
 * Safely get the WebSocket ready state from a WSContext.
 * Returns undefined if readyState is not accessible.
 */
function getWebSocketReadyState(client: WSContext): number | undefined {
  const rawClient = client as { readyState?: unknown };
  if (typeof rawClient.readyState === 'number') {
    return rawClient.readyState;
  }
  return undefined;
}

/**
 * Remove a client from all tracking sets/maps.
 */
function cleanupClient(client: WSContext): void {
  appClients.delete(client);
  syncingClients.delete(client);
  syncingClientQueues.delete(client);
  clientQueues.delete(client);
}

/**
 * Broadcast a message to all connected app clients.
 * Used for real-time updates like session lifecycle events and async operation results.
 * Messages are queued for clients that are still syncing initial state.
 */
export function broadcastToApp(msg: AppServerMessage): void {
  const msgStr = JSON.stringify(msg);
  const deadClients: WSContext[] = [];

  for (const client of appClients) {
    // Queue messages for clients that are still syncing initial state
    if (syncingClients.has(client)) {
      const queue = syncingClientQueues.get(client);
      if (queue) {
        // Limit queue size to prevent memory issues
        if (queue.length < MAX_SYNC_QUEUE_SIZE) {
          queue.push(msg);
        } else {
          logger.warn({ queueSize: queue.length }, 'Sync queue full, dropping message');
        }
      }
      continue;
    }

    // Skip clients not in OPEN state
    const readyState = getWebSocketReadyState(client);
    if (readyState !== undefined && readyState !== WS_READY_STATE.OPEN) {
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
      cleanupClient(client);
    }
    logger.debug({ removed: deadClients.length, remaining: appClients.size }, 'Cleaned up dead app clients');
  }
}

/**
 * Notify all Worker WebSocket connections for a session that the session has been deleted.
 * Sends error message with SESSION_DELETED code, exit message, and closes the connections.
 * Called by SessionManager before deleting the session.
 */
export function notifySessionDeleted(sessionId: string): void {
  const connections = workerConnectionsBySession.get(sessionId);
  if (!connections || connections.size === 0) {
    logger.debug({ sessionId }, 'No worker connections to notify for session deletion');
    return;
  }

  const connectionCount = connections.size;

  for (const ws of connections) {
    try {
      // Send error message first so client knows what went wrong
      const errorMsg: WorkerServerMessage = {
        type: 'error',
        message: 'Session has been deleted',
        code: 'SESSION_DELETED',
      };
      ws.send(JSON.stringify(errorMsg));

      // Then send exit message for proper cleanup
      const exitMsg: WorkerServerMessage = { type: 'exit', exitCode: 1, signal: null };
      ws.send(JSON.stringify(exitMsg));

      // Close the WebSocket
      ws.close(WS_CLOSE_CODE.NORMAL_CLOSURE, 'Session deleted');
    } catch (err) {
      // Connection may already be closed, log and continue
      logger.debug({ sessionId, err }, 'Error notifying worker connection of session deletion');
    }
  }

  // Remove the session from tracking
  workerConnectionsBySession.delete(sessionId);

  logger.info({ sessionId, notifiedConnections: connectionCount }, 'Notified worker connections of session deletion');
}

/**
 * Notify all Worker WebSocket connections for a specific worker that output was truncated.
 * Sends output-truncated message to inform the client that history was trimmed.
 *
 * Registered as callback in setupWebSocketRoutes() to avoid circular dependency.
 * Called by WorkerOutputFileManager when output file exceeds size limits.
 */
function notifyWorkerOutputTruncated(sessionId: string, workerId: string): void {
  const key = `${sessionId}:${workerId}`;
  const connections = workerConnections.get(key);
  if (!connections || connections.size === 0) {
    logger.debug({ sessionId, workerId }, 'No worker connections to notify for output truncation');
    return;
  }

  const msg: WorkerServerMessage = {
    type: 'output-truncated',
    message: 'Output history truncated due to size limits',
  };
  const msgStr = JSON.stringify(msg);

  for (const ws of connections) {
    try {
      ws.send(msgStr);
    } catch (e) {
      logger.warn({ sessionId, workerId, err: e }, 'Failed to send truncation notification');
    }
  }

  logger.debug({ sessionId, workerId, connectionCount: connections.size }, 'Sent truncation notification');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UpgradeWebSocketFn = (handler: (c: any) => any) => any;

export async function setupWebSocketRoutes(
  app: Hono,
  upgradeWebSocket: UpgradeWebSocketFn
) {
  // Register output truncation callback to avoid circular dependency
  // worker-output-file.ts needs to notify clients but can't import routes.ts directly
  setOutputTruncatedCallback(notifyWorkerOutputTruncated);

  // Get properly initialized SessionManager (with SQLite repository and JobQueue)
  const sessionManager = getSessionManager();

  // Create worker message handler with the properly initialized sessionManager
  const handleWorkerMessage = createWorkerMessageHandler({ sessionManager });

  // Set up session exists callback for notification manager
  // This allows debounce callbacks to validate session existence without circular dependencies
  try {
    const notificationManager = getNotificationManager();
    notificationManager.setSessionExistsCallback((sessionId) => {
      return sessionManager.getSession(sessionId) !== undefined;
    });
  } catch {
    // NotificationManager not initialized yet, skip
  }

  // Set up global activity callback to broadcast to all app clients
  sessionManager.setGlobalActivityCallback((sessionId, workerId, state) => {
    broadcastToApp({
      type: 'worker-activity',
      sessionId,
      workerId,
      activityState: state,
    });

    // Send notification for activity state changes
    try {
      const notificationManager = getNotificationManager();
      const session = sessionManager.getSession(sessionId);
      if (session) {
        const worker = session.workers.find(w => w.id === workerId);
        if (worker) {
          notificationManager.onActivityChange(
            {
              id: sessionId,
              title: session.title,
              worktreeId: session.type === 'worktree' ? session.worktreeId : null,
              repositoryId: session.type === 'worktree' ? session.repositoryId : null,
            },
            { id: workerId },
            state
          );
        }
      }
    } catch {
      // NotificationManager not initialized yet, skip
    }
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

          // Add to clients immediately but mark as syncing to prevent race conditions
          // This ensures lifecycle events that occur during sync are properly queued
          appClients.add(ws);
          syncingClients.add(ws);
          syncingClientQueues.set(ws, []);

          // Send all sync operations
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
            // Replay queued messages that were broadcast during sync
            const queuedMessages = syncingClientQueues.get(ws);
            if (queuedMessages && queuedMessages.length > 0) {
              logger.debug({ count: queuedMessages.length }, 'Replaying queued messages after sync');
              for (const queuedMsg of queuedMessages) {
                try {
                  ws.send(JSON.stringify(queuedMsg));
                } catch (e) {
                  logger.warn({ err: e }, 'Failed to send queued message');
                  break; // Stop if connection has issues
                }
              }
            }
            syncingClientQueues.delete(ws);
            syncingClients.delete(ws);

            // Flush queued messages that arrived during sync
            const queue = clientQueues.get(ws);
            if (queue && queue.length > 0) {
              for (const queuedMsg of queue) {
                try {
                  ws.send(JSON.stringify(queuedMsg));
                } catch (e) {
                  logger.warn({ err: e }, 'Failed to send queued message to app client');
                }
              }
              logger.debug({ queuedCount: queue.length }, 'Flushed queued messages after sync');
            }
            clientQueues.delete(ws);

            logger.debug({ clientCount: appClients.size }, 'App WebSocket ready for broadcasts');
          }).catch((err) => {
            // On error, clean up syncing state (client will be fully removed on close/error)
            syncingClients.delete(ws);
            syncingClientQueues.delete(ws);
            clientQueues.delete(ws);
            logger.error({ err }, 'Failed to send initial sync');
          });
        },
        onMessage(event: { data: string | ArrayBuffer }, ws: WSContext) {
          handleAppMessage(ws, event.data);
        },
        onClose(_event: unknown, ws: WSContext) {
          cleanupClient(ws);
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
      async function setupPtyWorkerHandlers(ws: WSContext, workerType: string, connectionStartTime: number) {
        logger.info({ sessionId, workerId, workerType }, 'Worker WebSocket connected');

        // Helper to safely send WebSocket messages with buffering
        let outputBuffer = '';
        let lastOffset: number = 0;
        let flushTimer: ReturnType<typeof setTimeout> | null = null;
        const FLUSH_INTERVAL = 50; // ms

        const flushBuffer = () => {
          if (outputBuffer.length > 0) {
            try {
              ws.send(JSON.stringify({ type: 'output', data: outputBuffer, offset: lastOffset }));
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
            lastOffset = msg.offset;

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
          onData: (data, offset) => {
            safeSend({ type: 'output', data, offset });
          },
          onExit: (exitCode, signal) => {
            safeSend({ type: 'exit', exitCode, signal });
          },
          onActivityChange: (state: AgentActivityState) => {
            safeSend({ type: 'activity', state });
          },
        });

        // History is now sent on-demand via request-history message (Pull model)
        // Client should send request-history when the tab becomes visible and needs history

        // Send current activity state on connection (for agent workers)
        if (workerType === 'agent') {
          const activityState = sessionManager.getWorkerActivityState(sessionId, workerId);
          if (activityState && activityState !== 'unknown') {
            safeSend({ type: 'activity', state: activityState });
          }
        }

        // Log total connection time
        const connectionEndTime = performance.now();
        const totalConnectionDuration = connectionEndTime - connectionStartTime;
        logger.info(
          { sessionId, workerId, workerType, durationMs: totalConnectionDuration.toFixed(2) },
          'Worker WebSocket connection completed'
        );
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
          const connectionStartTime = performance.now();
          logger.info({ sessionId, workerId }, 'Worker WebSocket connection started');

          // Track this connection for session deletion notification
          let sessionConnections = workerConnectionsBySession.get(sessionId);
          if (!sessionConnections) {
            sessionConnections = new Set();
            workerConnectionsBySession.set(sessionId, sessionConnections);
          }
          sessionConnections.add(ws);

          // Track this connection for per-worker notifications (e.g., output truncation)
          const workerKey = `${sessionId}:${workerId}`;
          let workerConns = workerConnections.get(workerKey);
          if (!workerConns) {
            workerConns = new Set();
            workerConnections.set(workerKey, workerConns);
          }
          workerConns.add(ws);

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
          sessionManager.restoreWorker(sessionId, workerId).then(async (result) => {
            if (!result.success) {
              logger.warn({ sessionId, workerId, errorCode: result.errorCode }, 'Failed to restore PTY worker');
              sendErrorAndClose(ws, result.message, result.errorCode);
              return;
            }

            await setupPtyWorkerHandlers(ws, result.worker.type, connectionStartTime);
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
              // Handle request-history: send history to client with timeout and line limit
              const HISTORY_REQUEST_TIMEOUT_MS = 5000;
              // Extract fromOffset from the request (optional, defaults to 0)
              const fromOffset = typeof parsed.fromOffset === 'number' ? parsed.fromOffset : 0;

              const timeoutPromise = new Promise<null>((_, reject) => {
                setTimeout(() => reject(new Error('History request timeout')), HISTORY_REQUEST_TIMEOUT_MS);
              });

              // If fromOffset > 0, we're doing incremental sync (no line limit)
              // If fromOffset === 0, we're doing initial load (apply line limit)
              const maxLines = fromOffset === 0 ? serverConfig.WORKER_OUTPUT_INITIAL_HISTORY_LINES : undefined;

              Promise.race([
                sessionManager.getWorkerOutputHistory(
                  sessionId,
                  workerId,
                  fromOffset,
                  maxLines
                ),
                timeoutPromise
              ])
                .then((historyResult) => {
                  if (historyResult) {
                    const historyMsg: WorkerServerMessage = {
                      type: 'history',
                      data: historyResult.data,
                      offset: historyResult.offset,
                    };
                    ws.send(JSON.stringify(historyMsg));
                    logger.debug({ sessionId, workerId, dataLength: historyResult.data.length, offset: historyResult.offset, fromOffset }, 'Sent history on request');
                  } else {
                    // Fallback to in-memory buffer (only for initial load)
                    if (fromOffset === 0) {
                      const history = sessionManager.getWorkerOutputBuffer(sessionId, workerId);
                      if (history) {
                        const historyMsg: WorkerServerMessage = {
                          type: 'history',
                          data: history,
                          offset: Buffer.byteLength(history, 'utf-8'),
                        };
                        ws.send(JSON.stringify(historyMsg));
                        logger.debug({ sessionId, workerId, dataLength: history.length }, 'Sent buffer history on request');
                      } else {
                        // No history available - send empty history with offset 0
                        const historyMsg: WorkerServerMessage = {
                          type: 'history',
                          data: '',
                          offset: 0,
                        };
                        ws.send(JSON.stringify(historyMsg));
                        logger.debug({ sessionId, workerId }, 'Sent empty history on request');
                      }
                    } else {
                      // Incremental sync with no new data - send empty with current offset
                      const historyMsg: WorkerServerMessage = {
                        type: 'history',
                        data: '',
                        offset: fromOffset,
                      };
                      ws.send(JSON.stringify(historyMsg));
                      logger.debug({ sessionId, workerId, fromOffset }, 'Sent empty incremental history on request');
                    }
                  }
                })
                .catch((err) => {
                  const isTimeout = err.message === 'History request timeout';

                  if (isTimeout) {
                    // Timeout is not a fatal error - worker is still operational.
                    // Send empty history with timedOut flag so client can decide how to proceed.
                    // Client can show a warning toast but continue using the terminal.
                    logger.warn({ sessionId, workerId }, 'History request timed out, sending empty history with timeout flag');
                    try {
                      const historyMsg: WorkerServerMessage = {
                        type: 'history',
                        data: '',
                        offset: fromOffset,
                        timedOut: true,
                      };
                      ws.send(JSON.stringify(historyMsg));
                    } catch {
                      // Connection may be closed
                    }
                  } else {
                    // Non-timeout errors are actual failures
                    logger.error({ sessionId, workerId, err }, 'Error sending history on request');
                    try {
                      const errorMsg: WorkerServerMessage = {
                        type: 'error',
                        message: 'Failed to load terminal history. Try switching workers or refreshing.',
                        code: 'HISTORY_LOAD_FAILED'
                      };
                      ws.send(JSON.stringify(errorMsg));
                    } catch {
                      // Connection may be closed
                    }
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
        onClose(_event: unknown, ws: WSContext) {
          logger.info({ sessionId, workerId, connectionId }, 'Worker WebSocket disconnected');

          // Remove from session connection tracking
          const sessionConnections = workerConnectionsBySession.get(sessionId);
          if (sessionConnections) {
            sessionConnections.delete(ws);
            if (sessionConnections.size === 0) {
              workerConnectionsBySession.delete(sessionId);
            }
          }

          // Remove from per-worker connection tracking
          const workerKey = `${sessionId}:${workerId}`;
          const workerConns = workerConnections.get(workerKey);
          if (workerConns) {
            workerConns.delete(ws);
            if (workerConns.size === 0) {
              workerConnections.delete(workerKey);
            }
          }

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
        onError(event: Event, ws: WSContext) {
          logger.error({ sessionId, workerId, connectionId, event }, 'Worker WebSocket error');

          // Remove from session connection tracking
          const sessionConnections = workerConnectionsBySession.get(sessionId);
          if (sessionConnections) {
            sessionConnections.delete(ws);
            if (sessionConnections.size === 0) {
              workerConnectionsBySession.delete(sessionId);
            }
          }

          // Remove from per-worker connection tracking
          const workerKey = `${sessionId}:${workerId}`;
          const workerConns = workerConnections.get(workerKey);
          if (workerConns) {
            workerConns.delete(ws);
            if (workerConns.size === 0) {
              workerConnections.delete(workerKey);
            }
          }

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
