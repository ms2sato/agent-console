import { Hono } from 'hono';
import type {
  WorkerServerMessage,
  WorkerErrorCode,
  AgentActivityState,
  AppServerMessage,
  GitDiffWorker,
} from '@agent-console/shared';
import { WS_READY_STATE, WS_CLOSE_CODE, SCHEMA_VERSION } from '@agent-console/shared';
import type { WSContext, WSMessageReceive } from 'hono/ws';
import type { UpgradeWebSocket } from 'hono/ws';
import type { AppContext } from '../app-context.js';
import { createWorkerMessageHandler } from './worker-handler.js';
import { handleHistoryRangeRequest } from './history-range-handler.js';
import { handleGitDiffConnection, handleGitDiffMessage, handleGitDiffDisconnection, updateGitDiffBaseCommit, initializeGitDiffHandlers } from './git-diff-handler.js';
import { getCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { AUTH_COOKIE_NAME } from '../lib/auth-constants.js';
import { createLogger } from '../lib/logger.js';
import { getServerPid } from '../lib/config.js';
import { serverConfig } from '../lib/server-config.js';
import { sendSessionsSync, createAppMessageHandler } from './app-handler.js';
import { BufferedWebSocketSender } from './buffered-ws-sender.js';
import { WebSocketConnectionRegistry } from './connection-registry.js';
import { withRepositoryRemote } from '../lib/repository-remote.js';
import { resolveSpawnUsername } from '../services/resolve-spawn-username.js';

const logger = createLogger('websocket');

/**
 * Extract string or ArrayBuffer data from a WebSocket message event.
 * WSMessageReceive includes Blob and SharedArrayBuffer which don't occur
 * with Bun's WebSocket adapter, but we handle them for type safety.
 */
export function extractMessageData(data: WSMessageReceive): string | ArrayBuffer {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return data;
  // SharedArrayBuffer - copy to ArrayBuffer for compatibility
  // This path is not expected with Bun's WebSocket adapter
  if (data instanceof SharedArrayBuffer) {
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(new Uint8Array(data));
    return copy;
  }
  // Blob - shouldn't happen with Bun, but handle defensively
  return '';
}

// Module-level registry instance used by exported functions.
// Initialized once in setupWebSocketRoutes() and shared by broadcastToApp/notifySessionDeleted.
let registry = new WebSocketConnectionRegistry();

// Store the server PID at module load time for server restart detection
const currentServerPid = getServerPid();

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
 * Broadcast a message to all connected app clients.
 * Used for real-time updates like session lifecycle events and async operation results.
 * Messages are queued for clients that are still syncing initial state.
 */
export function broadcastToApp(msg: AppServerMessage): void {
  const msgStr = JSON.stringify(msg);
  const deadClients: WSContext[] = [];

  for (const client of registry.getAppClients()) {
    // Queue messages for clients that are still syncing initial state
    if (registry.isSyncing(client)) {
      const result = registry.queueSyncMessage(client, msg);
      if (result === 'overflow') {
        // Queue overflow: too many events during initial sync.
        // Close the connection to force a full reconnect + fresh sync,
        // rather than silently dropping messages and leaving the client stale.
        const queue = registry.getSyncQueue(client);
        logger.warn({ queueSize: queue?.length ?? 0 }, 'Sync queue overflow, forcing client reconnect for full re-sync');
        registry.removeAppClient(client);
        try {
          client.close(WS_CLOSE_CODE.INTERNAL_ERROR, 'Sync queue overflow');
        } catch {
          // Connection may already be closed
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
      registry.removeAppClient(client);
    }
    logger.debug({ removed: deadClients.length, remaining: registry.appClientCount }, 'Cleaned up dead app clients');
  }
}

/**
 * Notify all Worker WebSocket connections for a session about a lifecycle event
 * (deletion, pause, etc.). Sends an error message with the given code, an exit message,
 * and closes all connections for the session.
 */
function notifySessionWorkerConnections(
  sessionId: string,
  options: {
    errorMessage: string;
    errorCode: WorkerErrorCode;
    exitCode: number;
    closeReason: string;
    logAction: string;
  }
): void {
  const connections = registry.getWorkerConnectionsBySession(sessionId);
  if (!connections || connections.size === 0) {
    logger.debug({ sessionId, action: options.logAction }, 'No worker connections to notify');
    return;
  }

  const connectionCount = connections.size;

  for (const ws of connections) {
    try {
      const errorMsg: WorkerServerMessage = {
        type: 'error',
        message: options.errorMessage,
        code: options.errorCode,
      };
      ws.send(JSON.stringify(errorMsg));

      const exitMsg: WorkerServerMessage = { type: 'exit', exitCode: options.exitCode, signal: null };
      ws.send(JSON.stringify(exitMsg));

      ws.close(WS_CLOSE_CODE.NORMAL_CLOSURE, options.closeReason);
    } catch (err) {
      logger.debug({ sessionId, err }, `Error notifying worker connection of session ${options.logAction}`);
    }
  }

  registry.removeSessionConnections(sessionId);

  logger.info({ sessionId, notifiedConnections: connectionCount }, `Notified worker connections of session ${options.logAction}`);
}

/**
 * Notify all Worker WebSocket connections for a session that the session has been deleted.
 * Called by SessionManager before deleting the session.
 */
export function notifySessionDeleted(sessionId: string): void {
  notifySessionWorkerConnections(sessionId, {
    errorMessage: 'Session has been deleted',
    errorCode: 'SESSION_DELETED',
    exitCode: 1,
    closeReason: 'Session deleted',
    logAction: 'deletion',
  });
}

/**
 * Notify all Worker WebSocket connections for a session that the session has been paused.
 * Called by SessionManager before pausing the session.
 */
export function notifySessionPaused(sessionId: string): void {
  notifySessionWorkerConnections(sessionId, {
    errorMessage: 'Session has been paused',
    errorCode: 'SESSION_PAUSED',
    exitCode: 0,
    closeReason: 'Session paused',
    logAction: 'pause',
  });
}

/**
 * Close all open Worker WebSocket connections for a worker with the dedicated
 * `WORKER_RESTARTED` (4001) code, forcing a reconnect. Used on worker restart:
 * restart installs a new worker object without rebinding already-attached
 * sockets' callbacks, so an attached client would otherwise never receive a
 * new-epoch message. The reconnect lands on the new incarnation and gets the new
 * epoch via the initial `history` response (terminal-history-paging.md §3.4 / §4.5).
 *
 * The code must NOT be `NORMAL_CLOSURE` (1000): the client treats 1000 as a
 * deliberate no-reconnect close (SESSION_DELETED semantics; see
 * `websocket-reconnect.ts` NO_RECONNECT_CLOSE_CODES), which would strand the
 * terminal at "disconnected". 4001 is outside that set, so the client reconnects.
 */
function closeWorkerSocketsForRestart(sessionId: string, workerId: string): void {
  const connections = registry.getWorkerConnections(sessionId, workerId);
  if (!connections || connections.size === 0) {
    return;
  }

  // Snapshot before closing — onClose mutates the registry set.
  for (const ws of Array.from(connections)) {
    try {
      ws.close(WS_CLOSE_CODE.WORKER_RESTARTED, 'worker restarted');
    } catch (e) {
      logger.warn({ sessionId, workerId, err: e }, 'Failed to close worker socket on restart');
    }
  }

  logger.info({ sessionId, workerId, connectionCount: connections.size }, 'Closed worker sockets for restart');
}

/**
 * Names of all required callback configuration calls that must complete
 * before WebSocket connections can be properly handled.
 * Used by assertFullyInitialized() to detect missing initialization steps.
 */
const REQUIRED_INIT_STEPS = [
  'setSessionExistsCallback',
  'setGlobalActivityCallback',
  'setGlobalWorkerExitCallback',
  'setSessionLifecycleCallbacks',
  'setWebSocketCallbacks',
  'setupPtyExitCallback',
  'setAgentLifecycleCallbacks',
  'setEmbeddedAgentLifecycleCallbacks',
  'setRepositoryLifecycleCallbacks',
] as const;

/**
 * Assert that all required initialization steps have been completed.
 * Throws a clear error if any step was missed, enabling early failure
 * instead of silent misbehavior when a callback is not wired up.
 */
function assertFullyInitialized(completedSteps: Set<string>): void {
  const missingSteps = REQUIRED_INIT_STEPS.filter(step => !completedSteps.has(step));
  if (missingSteps.length > 0) {
    throw new Error(
      `WebSocket routes initialization incomplete. Missing steps: ${missingSteps.join(', ')}. ` +
      'All callback configurations must be set before WebSocket connections are accepted.'
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function setupWebSocketRoutes(
  app: Hono<any>,
  // Uses Hono's UpgradeWebSocket type directly from hono/ws.
  // The `any` type parameter matches Hono's own export: `UpgradeWebSocket<any>`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upgradeWebSocket: UpgradeWebSocket<any>,
  appContext: AppContext,
  /** Optional registry injection for testing. Production uses the module-level instance. */
  registryOverride?: WebSocketConnectionRegistry
) {
  // Replace the module-level registry if an override is provided (for testing)
  if (registryOverride) {
    registry = registryOverride;
  } else {
    // Fresh registry for each setup call (important for test isolation when no override)
    registry = new WebSocketConnectionRegistry();
  }

  const { sessionManager, notificationManager, agentManager, embeddedAgentManager, repositoryManager, annotationService } = appContext;

  // Initialize git-diff handlers with injected dependencies
  const { getDiffData, getFileLines, resolveRef, resolveBaseSpec, startWatching, stopWatching } = await import('../services/git-diff-service.js');
  initializeGitDiffHandlers({
    getDiffData,
    resolveRef,
    resolveBaseSpec,
    startWatching,
    stopWatching,
    getFileLines,
    annotationService,
  });

  // Track which initialization steps have been completed
  const completedSteps = new Set<string>();

  // Create worker message handler with the properly initialized sessionManager
  const handleWorkerMessage = createWorkerMessageHandler({ sessionManager });

  // Set up session exists callback for notification manager
  // This allows debounce callbacks to validate session existence without circular dependencies
  notificationManager.setSessionExistsCallback((sessionId) => {
    return sessionManager.getSession(sessionId) !== undefined;
  });
  completedSteps.add('setSessionExistsCallback');

  // Set up global activity callback to broadcast to all app clients
  sessionManager.setGlobalActivityCallback((sessionId, workerId, state) => {
    broadcastToApp({
      type: 'worker-activity',
      sessionId,
      workerId,
      activityState: state,
    });

    // Send notification for activity state changes
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
  });
  completedSteps.add('setGlobalActivityCallback');

  // Set up global worker exit callback to send notifications
  sessionManager.setGlobalWorkerExitCallback((sessionId, workerId, exitCode, _reason) => {
    const session = sessionManager.getSession(sessionId);
    if (session) {
      notificationManager.onWorkerExit(
        {
          id: sessionId,
          title: session.title,
          worktreeId: session.type === 'worktree' ? session.worktreeId : null,
          repositoryId: session.type === 'worktree' ? session.repositoryId : null,
        },
        { id: workerId },
        exitCode
      );
    }
  });
  completedSteps.add('setGlobalWorkerExitCallback');

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
    onWorkerActivated: (sessionId, workerId) => {
      logger.debug({ sessionId, workerId }, 'Broadcasting worker-activated');
      broadcastToApp({ type: 'worker-activated', sessionId, workerId });
    },
    onWorkerRestarted: (sessionId, workerId, activityState) => {
      logger.debug({ sessionId, workerId }, 'Broadcasting worker-restarted');
      broadcastToApp({ type: 'worker-restarted', sessionId, workerId, activityState });
      // Force any attached worker sockets to reconnect onto the new incarnation
      // so they receive the new epoch (the app-ws event above is a UX fast-path
      // only and can be missed). See terminal-history-paging.md §3.4 / §4.5.
      closeWorkerSocketsForRestart(sessionId, workerId);
    },
    onSessionPaused: (session) => {
      logger.debug({ sessionId: session.id }, 'Broadcasting session-paused');
      broadcastToApp({ type: 'session-paused', session });
    },
    onSessionResumed: (session, activityStates) => {
      logger.debug({ sessionId: session.id }, 'Broadcasting session-resumed');
      broadcastToApp({ type: 'session-resumed', session, activityStates });
    },
    onDiffBaseCommitChanged: (sessionId, workerId, newBaseCommit) => {
      logger.debug({ sessionId, workerId }, 'Updating git-diff base commit via WebSocket');
      updateGitDiffBaseCommit(workerId, newBaseCommit).catch((err) => {
        logger.error({ sessionId, workerId, err }, 'Failed to update diff base commit via WebSocket');
      });
    },
    onMemoUpdated: (sessionId, content) => {
      logger.debug({ sessionId }, 'Broadcasting memo-updated');
      broadcastToApp({ type: 'memo-updated', sessionId, content });
    },
  });
  completedSteps.add('setSessionLifecycleCallbacks');

  // Wire WebSocket callbacks to break circular dependency
  // SessionManager needs these to notify clients during session deletion and message broadcast
  sessionManager.setWebSocketCallbacks({
    notifySessionDeleted,
    notifySessionPaused,
    broadcastToApp,
  });
  completedSteps.add('setWebSocketCallbacks');

  // Set up PTY exit callback to broadcast session activation state changes
  sessionManager.setupPtyExitCallback();
  completedSteps.add('setupPtyExitCallback');

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
  completedSteps.add('setAgentLifecycleCallbacks');

  // Set up embedded-agent lifecycle callbacks to broadcast to all app clients
  embeddedAgentManager.setLifecycleCallbacks({
    onEmbeddedAgentCreated: (embeddedAgent) => {
      logger.debug({ embeddedAgentId: embeddedAgent.id }, 'Broadcasting embedded-agent-created');
      broadcastToApp({ type: 'embedded-agent-created', embeddedAgent });
    },
    onEmbeddedAgentUpdated: (embeddedAgent) => {
      logger.debug({ embeddedAgentId: embeddedAgent.id }, 'Broadcasting embedded-agent-updated');
      broadcastToApp({ type: 'embedded-agent-updated', embeddedAgent });
    },
    onEmbeddedAgentDeleted: (embeddedAgentId) => {
      logger.debug({ embeddedAgentId }, 'Broadcasting embedded-agent-deleted');
      broadcastToApp({ type: 'embedded-agent-deleted', embeddedAgentId });
    },
  });
  completedSteps.add('setEmbeddedAgentLifecycleCallbacks');

  // Set up repository lifecycle callbacks to broadcast to all app clients
  // Created/updated callbacks are async to enrich with remoteUrl before broadcasting
  repositoryManager.setLifecycleCallbacks({
    onRepositoryCreated: async (repository) => {
      const enriched = await withRepositoryRemote(repository);
      logger.debug({ repositoryId: repository.id }, 'Broadcasting repository-created');
      broadcastToApp({ type: 'repository-created', repository: enriched });
    },
    onRepositoryUpdated: async (repository) => {
      const enriched = await withRepositoryRemote(repository);
      logger.debug({ repositoryId: repository.id }, 'Broadcasting repository-updated');
      broadcastToApp({ type: 'repository-updated', repository: enriched });
    },
    onRepositoryDeleted: (repositoryId) => {
      logger.debug({ repositoryId }, 'Broadcasting repository-deleted');
      broadcastToApp({ type: 'repository-deleted', repositoryId });
    },
  });
  completedSteps.add('setRepositoryLifecycleCallbacks');

  // Verify all initialization steps completed before accepting connections
  assertFullyInitialized(completedSteps);

  // Create dependency object for app handlers
  const appDeps = {
    getAllSessions: () => sessionManager.getAllSessions(),
    getAllPausedSessions: () => sessionManager.getAllPausedSessions(),
    getWorkerActivityState: (sessionId: string, workerId: string) => sessionManager.getWorkerActivityState(sessionId, workerId),
    getAllAgents: async () => agentManager.getAllAgents(),
    getAllRepositories: () => repositoryManager.getAllRepositories(),
    logger,
  };

  // Create app message handler with dependencies
  const handleAppMessage = createAppMessageHandler(appDeps);

  /**
   * HTTP-level auth guard for WebSocket routes.
   * Rejects unauthenticated requests with 401 BEFORE the WebSocket upgrade,
   * preventing unauthorized connections from being established.
   * In single-user mode, authenticate() always returns a user so this never blocks.
   */
  function wsAuthGuard(c: Context, next: () => Promise<void>): Response | Promise<void> {
    const authUser = appContext.userMode.authenticate(() => getCookie(c, AUTH_COOKIE_NAME));
    if (!authUser) {
      return c.text('Authentication required', 401);
    }
    return next();
  }

  // App WebSocket endpoint for real-time state synchronization
  app.get(
    '/ws/app',
    wsAuthGuard,
    upgradeWebSocket((_c) => {
      return {
        onOpen(_event: Event, ws: WSContext) {
          // Advertise the wire-schema version as the very first frame, before
          // any sync data, so the client can detect a server/client schema
          // mismatch and reload before it attempts to parse newer payloads.
          // Guard the send: if the socket is already closing this must not throw
          // and abort the rest of onOpen (client registration + initial sync).
          try {
            ws.send(JSON.stringify({ type: 'schema-version', version: SCHEMA_VERSION }));
          } catch (e) {
            logger.warn({ err: e }, 'Failed to send schema-version frame');
          }

          logger.info('App WebSocket connected, sending initial sync');

          // Add to clients immediately but mark as syncing to prevent race conditions
          // This ensures lifecycle events that occur during sync are properly queued
          registry.addAppClient(ws);
          registry.startSyncing(ws);

          // Send all sync operations
          Promise.all([
            sendSessionsSync(ws, appDeps),
            Promise.resolve().then(() => {
              const allAgents = agentManager.getAllAgents();
              const agentsSyncMsg: AppServerMessage = {
                type: 'agents-sync',
                agents: allAgents,
              };
              ws.send(JSON.stringify(agentsSyncMsg));
              logger.debug({ agentCount: allAgents.length }, 'Sent agents-sync');
            }),
            Promise.resolve().then(async () => {
              const allRepositories = repositoryManager.getAllRepositories();
              const enrichedRepositories = await Promise.all(allRepositories.map(withRepositoryRemote));
              const repositoriesSyncMsg: AppServerMessage = {
                type: 'repositories-sync',
                repositories: enrichedRepositories,
              };
              ws.send(JSON.stringify(repositoriesSyncMsg));
              logger.debug({ repoCount: enrichedRepositories.length }, 'Sent repositories-sync');
            }),
          ]).then(() => {
            // Replay queued messages that were broadcast during sync
            const queuedMessages = registry.getSyncQueue(ws);
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
            registry.stopSyncing(ws);

            logger.debug({ clientCount: registry.appClientCount }, 'App WebSocket ready for broadcasts');
          }).catch((err) => {
            // On error, clean up syncing state (client will be fully removed on close/error)
            registry.stopSyncing(ws);
            logger.error({ err }, 'Failed to send initial sync');
          });
        },
        onMessage(event: MessageEvent<WSMessageReceive>, ws: WSContext) {
          handleAppMessage(ws, extractMessageData(event.data));
        },
        onClose(_event: CloseEvent, ws: WSContext) {
          registry.removeAppClient(ws);
          logger.info({ clientCount: registry.appClientCount }, 'App WebSocket disconnected');
        },
      };
    })
  );

  // WebSocket endpoint for worker connection
  app.get(
    '/ws/session/:sessionId/worker/:workerId',
    wsAuthGuard,
    upgradeWebSocket((c) => {
      const sessionId = c.req.param('sessionId');
      const workerId = c.req.param('workerId');

      // Track connection ID for this WebSocket (used to detach callbacks on close)
      let connectionId: string | null = null;

      // Buffered sender for this connection, stored in outer scope so onClose/onError can dispose it
      let sender: BufferedWebSocketSender | null = null;

      // Flag to prevent setupPtyWorkerHandlers from running after WebSocket is already closed
      let connectionClosed = false;

      // Helper function to set up stream-worker (PTY or embedded-agent) handlers
      // after async activation/restore. Shared by both worker shapes because
      // the byte-offset/epoch/connectionCallbacks framing is content-agnostic
      // (isStreamWorker, worker-types.ts).
      // The order is critical to prevent duplicates and lost data:
      // 1. Get current offset BEFORE registering callbacks (marks the boundary)
      // 2. Register callbacks for NEW output (after the offset)
      // 3. Send history UP TO the offset we recorded
      // @param wasRestored - true if PTY was restored (was hibernated), false if already active.
      //   Always false for embedded-agent workers (no restore path — every
      //   activation is restart-semantics; a fresh epoch, not an explicit
      //   server-restarted push, is what tells the client to invalidate cache).
      async function setupStreamWorkerHandlers(ws: WSContext, workerType: string, connectionStartTime: number, wasRestored: boolean) {
        if (connectionClosed) {
          return;
        }

        logger.info({ sessionId, workerId, workerType, wasRestored }, 'Worker WebSocket connected');

        // Create buffered sender for this connection
        sender = new BufferedWebSocketSender(
          ws,
          () => getWebSocketReadyState(ws),
          logger,
          workerId,
          50, // flush interval (ms)
          serverConfig.WORKER_OUTPUT_FLUSH_THRESHOLD,
        );

        // Register callbacks for new output
        connectionId = sessionManager.attachWorkerCallbacks(sessionId, workerId, {
          onData: (data, offset, epoch) => {
            sender?.send({ type: 'output', data, offset, epoch });
          },
          onExit: (exitCode, signal, reason) => {
            sender?.send({ type: 'exit', exitCode, signal, reason });
          },
          onActivityChange: (state: AgentActivityState) => {
            sender?.send({ type: 'activity', state });
          },
        });

        // Store connection metadata for cleanup in onClose/onError
        // This ensures callbacks are cleaned up even if close happens before connectionId is set in outer scope
        if (connectionId) {
          registry.setConnectionMetadata(ws, { sessionId, workerId, connectionId });
        }

        // If worker was restored (PTY was hibernated and is now active), send server-restarted notification
        // This tells the client to invalidate cached terminal state and request fresh history
        if (wasRestored) {
          sender?.send({ type: 'server-restarted', serverPid: currentServerPid });
          logger.info({ sessionId, workerId, serverPid: currentServerPid }, 'Sent server-restarted notification');
        }

        // History is now sent on-demand via request-history message (Pull model)
        // Client should send request-history when the tab becomes visible and needs history

        // Send current activity state on connection (for agent / embedded-agent
        // workers). Embedded-agent activity is loop-emitted and broadcast at
        // the END of activate() (see EmbeddedAgentWorkerService), which
        // happens BEFORE this connection's callbacks are attached above — a
        // freshly-connecting client would otherwise miss that broadcast, so
        // the current state is pushed explicitly here.
        if (workerType === 'agent' || workerType === 'embedded-agent') {
          const activityState = sessionManager.getWorkerActivityState(sessionId, workerId);
          if (activityState) {
            sender?.send({ type: 'activity', state: activityState });
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

      /**
       * Send a non-fatal error message to the client WITHOUT closing the
       * socket. Used for embedded-agent activation failures and message
       * rejections (turn-in-progress, unsupported PTY messages) — per the
       * architect pre-directive (#1021), every spec error-table row must be
       * user-readable and must NOT silently close the connection.
       */
      function sendWorkerError(ws: WSContext, message: string, code: WorkerErrorCode): void {
        try {
          const errorMsg: WorkerServerMessage = { type: 'error', message, code };
          ws.send(JSON.stringify(errorMsg));
        } catch {
          // Ignore send errors (connection may already be closed)
        }
      }

      /**
       * Clean up all resources for a worker WebSocket connection.
       * Shared by onClose and onError to avoid duplicated cleanup logic.
       * @returns The effective connection ID used for callback detachment (for logging)
       */
      function cleanupWorkerConnection(ws: WSContext, sid: string, wid: string): string | null {
        connectionClosed = true;

        // Dispose buffered sender to clear flush timer and prevent stale sends
        sender?.dispose();

        // Get connection ID from metadata map as well as closure variable
        // This ensures cleanup works even if close/error happens during async setup
        const metadata = registry.getConnectionMetadata(ws);
        const effectiveConnectionId = connectionId || metadata?.connectionId || null;

        // Remove from connection tracking (both session-level, worker-level, and metadata)
        registry.removeWorkerConnection(sid, wid, ws);

        // Detach worker-specific resources (git-diff file watcher or PTY callbacks)
        const session = sessionManager.getSession(sid);
        const worker = session?.workers.find(w => w.id === wid);

        if (worker?.type === 'git-diff') {
          handleGitDiffDisconnection(sid, wid).catch((err) => {
            logger.error({ sessionId: sid, workerId: wid, err }, 'Error cleaning up git-diff on WebSocket close/error');
          });
        } else if (effectiveConnectionId) {
          // Detach this connection's callbacks but keep worker alive (only for PTY workers)
          // Other connections (browser tabs) will continue receiving output
          sessionManager.detachWorkerCallbacks(sid, wid, effectiveConnectionId);
        }

        return effectiveConnectionId;
      }

      return {
        onOpen(_event: Event, ws: WSContext) {
          const connectionStartTime = performance.now();
          logger.info({ sessionId, workerId }, 'Worker WebSocket connection started');

          // Track this connection for session deletion notification and per-worker notifications
          registry.addWorkerConnection(sessionId, workerId, ws);

          const session = sessionManager.getSession(sessionId);
          if (!session) {
            sendErrorAndClose(ws, 'Session not found', 'SESSION_DELETED');
            return;
          }

          const worker = session.workers.find(w => w.id === workerId);
          if (!worker) {
            sendErrorAndClose(ws, 'Worker not found', 'WORKER_NOT_FOUND');
            return;
          }

          // Handle git-diff workers differently
          if (worker.type === 'git-diff') {
            // Issue #869 / CodeRabbit lesson from PR #874: resolve the
            // session's effective spawn user (the worktree-owning OS user),
            // NOT the authenticated viewer. For shared sessions the spawn
            // user is the shared account; using the viewer's identity would
            // reintroduce dubious-ownership errors on user-owned worktrees.
            // The auth guard (`wsAuthGuard`) above guarantees the viewer is
            // authenticated; the username threaded to git is the worktree
            // owner's, not the viewer's.
            (async () => {
              const spawnUsername = await resolveSpawnUsername(
                session.createdBy,
                appContext.userRepository,
              );
              await handleGitDiffConnection(
                ws,
                sessionId,
                workerId,
                session.locationPath,
                (worker as GitDiffWorker).baseCommit,
                spawnUsername,
              );
            })().catch((err) => {
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

          // Handle embedded-agent workers differently: activate the loop
          // subprocess (idempotent no-op if already activated -- Phase 2's
          // in-flight guard already makes concurrent opens await the same
          // promise, so no extra guard is needed here) instead of restoring a
          // PTY. Every spec error-table row for activation failure (dangling
          // definition, dangling apiKeyRef, missing session.createdBy, ...)
          // must be user-readable in the UI and must NOT close the socket
          // silently (architect pre-directive #2, Issue #1021).
          if (worker.type === 'embedded-agent') {
            (async () => {
              try {
                await sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logger.warn({ sessionId, workerId, err }, 'Embedded-agent activation failed');
                if (!connectionClosed) {
                  sendWorkerError(ws, message, 'ACTIVATION_FAILED');
                }
                return;
              }

              if (connectionClosed) {
                return;
              }

              // wasRestored is always false here: embedded-agent has no revive
              // path (every activation is restart-semantics), so the client
              // learns about a reset conversation via the fresh epoch minted
              // in activate(), not an explicit server-restarted push.
              await setupStreamWorkerHandlers(ws, worker.type, connectionStartTime, false);
            })().catch((err) => {
              logger.error({ sessionId, workerId, err }, 'Error activating embedded-agent worker');
            });
            return;
          }

          // PTY-based worker handling (agent/terminal)
          // Restore worker if it doesn't exist internally (e.g., after server restart)
          // Note: restoreWorker is async, so we handle it with .then()/.catch()
          sessionManager.restoreWorker(sessionId, workerId).then(async (result) => {
            if (connectionClosed) {
              return;
            }

            if (!result.success) {
              logger.warn({ sessionId, workerId, errorCode: result.errorCode }, 'Failed to restore PTY worker');
              sendErrorAndClose(ws, result.message, result.errorCode);
              return;
            }

            await setupStreamWorkerHandlers(ws, result.worker.type, connectionStartTime, result.wasRestored);
          }).catch((err) => {
            logger.error({ sessionId, workerId, err }, 'Error restoring PTY worker');
            sendErrorAndClose(ws, 'Worker activation error', 'ACTIVATION_FAILED', WS_CLOSE_CODE.INTERNAL_ERROR);
          });
        },
        onMessage(event: MessageEvent<WSMessageReceive>, ws: WSContext) {
          const rawData = extractMessageData(event.data);
          const data = typeof rawData === 'string'
            ? rawData
            : new TextDecoder().decode(rawData);

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

              // Epoch for the fallback / timeout paths that do not read the
              // manifest. Successful reads carry the manifest epoch instead.
              const fallbackEpoch = sessionManager.getWorkerEpoch(sessionId, workerId) ?? 0;

              const timeoutPromise = new Promise<null>((_, reject) => {
                setTimeout(() => reject(new Error('History request timeout')), HISTORY_REQUEST_TIMEOUT_MS);
              });

              // Line cap: the initial-load limit for fromOffset 0, and the
              // recent-window fallback cap for the archived-out / stale branches
              // of an incremental read (§3.1).
              const maxLines = serverConfig.WORKER_OUTPUT_INITIAL_HISTORY_LINES;

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
                      startOffset: historyResult.startOffset,
                      epoch: historyResult.epoch,
                    };
                    ws.send(JSON.stringify(historyMsg));
                    logger.debug({ sessionId, workerId, dataLength: historyResult.data.length, offset: historyResult.offset, startOffset: historyResult.startOffset, fromOffset }, 'Sent history on request');
                  } else {
                    // Fallback to in-memory buffer (only for initial load)
                    if (fromOffset === 0) {
                      const history = sessionManager.getWorkerOutputBuffer(sessionId, workerId);
                      if (history) {
                        const byteLength = Buffer.byteLength(history, 'utf-8');
                        const historyMsg: WorkerServerMessage = {
                          type: 'history',
                          data: history,
                          offset: byteLength,
                          startOffset: 0,
                          epoch: fallbackEpoch,
                        };
                        ws.send(JSON.stringify(historyMsg));
                        logger.debug({ sessionId, workerId, dataLength: history.length }, 'Sent buffer history on request');
                      } else {
                        // No history available - send empty history with offset 0
                        const historyMsg: WorkerServerMessage = {
                          type: 'history',
                          data: '',
                          offset: 0,
                          startOffset: 0,
                          epoch: fallbackEpoch,
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
                        startOffset: fromOffset,
                        epoch: fallbackEpoch,
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
                        startOffset: fromOffset,
                        epoch: fallbackEpoch,
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

            // Backwards range fetch (§5.1): served on the same socket, with its
            // own boundary validation, 5s timeout guard, and HISTORY_LOAD_FAILED
            // error path — all inside the dedicated handler.
            if (parsed && typeof parsed === 'object' && parsed.type === 'request-history-range') {
              void handleHistoryRangeRequest(
                ws,
                sessionId,
                workerId,
                parsed as Record<string, unknown>,
                sessionManager,
              );
              return;
            }

            // embedded-agent workers accept a distinct client message set
            // (EmbeddedAgentClientMessage) and explicitly reject PTY-only
            // messages instead of silently no-op'ing them. request-history /
            // request-history-range are shared (handled above, before this
            // branch) since the byte-offset/epoch history machinery is
            // content-agnostic (isStreamWorker).
            //
            // Deviation from the literal spec text: the spec's WS section says
            // to add "valibot schemas alongside the existing ones" for these
            // message types, but there is no WorkerClientMessageSchema (or any
            // valibot schema) for the existing input/resize/request-history
            // message shapes anywhere in packages/shared/src/schemas/ -- those
            // are hand-validated in worker-handler.ts's validateWorkerMessage.
            // Per this repo's Q1.5 rule (code is reality, cite it over the
            // doc), embedded-agent client messages are validated the same
            // hand-written way here, for consistency with their siblings.
            if (worker.type === 'embedded-agent' && parsed && typeof parsed === 'object') {
              const embeddedParsed = parsed as Record<string, unknown>;

              if (embeddedParsed.type === 'embedded-user-message') {
                if (typeof embeddedParsed.text !== 'string') {
                  logger.warn({ sessionId, workerId }, 'Invalid embedded-user-message: text must be a string');
                  return;
                }
                const text = embeddedParsed.text;
                void sessionManager.sendEmbeddedAgentUserMessage(sessionId, workerId, text).then((result) => {
                  if (!result.ok) {
                    const code: WorkerErrorCode = result.error === 'turn in progress'
                      ? 'TURN_IN_PROGRESS'
                      : 'ACTIVATION_FAILED';
                    sendWorkerError(ws, result.error, code);
                  }
                }).catch((err) => {
                  logger.error({ sessionId, workerId, err }, 'Error forwarding embedded-user-message');
                  sendWorkerError(ws, 'Failed to send message', 'ACTIVATION_FAILED');
                });
                return;
              }

              if (embeddedParsed.type === 'embedded-cancel') {
                const forwarded = sessionManager.cancelEmbeddedAgentTurn(sessionId, workerId);
                if (!forwarded) {
                  logger.debug({ sessionId, workerId }, 'embedded-cancel had no effect (worker not activated)');
                }
                return;
              }

              if (embeddedParsed.type === 'input' || embeddedParsed.type === 'resize') {
                sendWorkerError(ws, 'embedded-agent workers do not support PTY input/resize', 'UNSUPPORTED_OPERATION');
                return;
              }

              // Unknown/other type for an embedded-agent worker: fall through
              // to the default handling below (log + ignore), consistent with
              // how the PTY-side handleWorkerMessage treats unknown types.
            }
          } catch {
            // Not JSON or invalid - fall through to regular handler
          }

          // PTY-based worker message handling (input, resize, image)
          handleWorkerMessage(ws, sessionId, workerId, data);
        },
        onClose(_event: CloseEvent, ws: WSContext) {
          const effectiveConnectionId = cleanupWorkerConnection(ws, sessionId, workerId);
          logger.info({ sessionId, workerId, connectionId: effectiveConnectionId }, 'Worker WebSocket disconnected');
        },
        onError(event: Event, ws: WSContext) {
          const effectiveConnectionId = cleanupWorkerConnection(ws, sessionId, workerId);
          logger.error({ sessionId, workerId, connectionId: effectiveConnectionId, event }, 'Worker WebSocket error');
        },
      };
    })
  );
}
