import type { WSContext } from 'hono/ws';
import type { SDKMessage, SdkWorkerClientMessage, SdkWorkerServerMessage, AgentActivityState } from '@agent-console/shared';
import type { InternalSdkWorker, SdkWorkerCallbacks } from '../services/worker-types.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('sdk-worker-handler');

// Track active connections by workerId
interface ConnectionState {
  ws: WSContext;
  connectionId: string;
}

const activeConnections = new Map<string, Set<ConnectionState>>();

/**
 * Send a typed message to the WebSocket client.
 */
function sendMessage(ws: WSContext, msg: SdkWorkerServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch (e) {
    log.warn({ err: e }, 'Failed to send SDK worker message');
  }
}

/**
 * Handle SDK worker WebSocket connection.
 */
export async function handleSdkWorkerConnection(
  ws: WSContext,
  sessionId: string,
  workerId: string,
  worker: InternalSdkWorker,
  attachCallbacks: (callbacks: SdkWorkerCallbacks) => string | null
): Promise<void> {
  log.info({ sessionId, workerId }, 'SDK worker WebSocket connected');

  // Attach callbacks for real-time messages
  const connectionId = attachCallbacks({
    onMessage: (message: SDKMessage) => {
      sendMessage(ws, { type: 'sdk-message', message });
    },
    onActivityChange: (state: AgentActivityState) => {
      sendMessage(ws, { type: 'activity', state });
    },
    onExit: (exitCode: number, signal: string | null) => {
      sendMessage(ws, { type: 'exit', exitCode, signal });
    },
  });

  if (!connectionId) {
    sendMessage(ws, { type: 'error', message: 'Failed to attach callbacks' });
    return;
  }

  // Store connection for cleanup
  let connections = activeConnections.get(workerId);
  if (!connections) {
    connections = new Set();
    activeConnections.set(workerId, connections);
  }
  connections.add({ ws, connectionId });

  // Send current activity state
  if (worker.activityState !== 'unknown') {
    sendMessage(ws, { type: 'activity', state: worker.activityState });
  }
}

/**
 * Handle SDK worker WebSocket message.
 */
export async function handleSdkWorkerMessage(
  ws: WSContext,
  sessionId: string,
  workerId: string,
  message: string,
  getWorker: () => InternalSdkWorker | null,
  runQuery: (workerId: string, prompt: string) => Promise<void>,
  cancelQuery: (workerId: string) => void,
  restoreMessages?: () => Promise<SDKMessage[] | null>,
): Promise<void> {
  try {
    const parsed: SdkWorkerClientMessage = JSON.parse(message);

    switch (parsed.type) {
      case 'user-message': {
        const worker = getWorker();
        if (!worker) {
          sendMessage(ws, { type: 'error', message: 'Worker not found' });
          return;
        }
        if (worker.isRunning) {
          sendMessage(ws, { type: 'error', message: 'Worker is busy' });
          return;
        }
        // Run query in background (don't await - it streams messages via callbacks)
        runQuery(workerId, parsed.content).catch((err) => {
          log.error({ sessionId, workerId, err }, 'SDK query error');
          sendMessage(ws, { type: 'error', message: 'Failed to execute query' });
        });
        break;
      }
      case 'cancel': {
        cancelQuery(workerId);
        break;
      }
      case 'request-history': {
        const worker = getWorker();
        if (!worker) {
          sendMessage(ws, { type: 'error', message: 'Worker not found' });
          return;
        }
        // Restore messages from file if needed (lazy loading after server restart)
        let allMessages = worker.messages;
        if (allMessages.length === 0 && restoreMessages) {
          const restored = await restoreMessages();
          if (restored) {
            allMessages = restored;
          }
        }
        // Send message history from cursor
        const lastUuid = parsed.lastUuid;
        let messages: SDKMessage[];
        if (lastUuid) {
          const idx = allMessages.findIndex(m => m.uuid === lastUuid);
          messages = idx >= 0 ? allMessages.slice(idx + 1) : allMessages;
        } else {
          messages = allMessages;
        }
        const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
        sendMessage(ws, {
          type: 'message-history',
          messages,
          lastUuid: lastMsg?.uuid ?? null,
        });
        break;
      }
      default: {
        const _exhaustive: never = parsed;
        log.error({ messageType: (_exhaustive as SdkWorkerClientMessage).type }, 'Unknown SDK worker message type');
        sendMessage(ws, { type: 'error', message: 'Unknown message type' });
      }
    }
  } catch (e) {
    log.error({ err: e }, 'Invalid SDK worker message');
    sendMessage(ws, { type: 'error', message: 'Invalid message format' });
  }
}

/**
 * Handle SDK worker WebSocket disconnection.
 */
export function handleSdkWorkerDisconnection(
  sessionId: string,
  workerId: string,
  ws: WSContext,
  detachCallbacks: (connectionId: string) => boolean
): void {
  log.info({ sessionId, workerId }, 'SDK worker WebSocket disconnected');

  const connections = activeConnections.get(workerId);
  if (connections) {
    for (const conn of connections) {
      if (conn.ws === ws) {
        detachCallbacks(conn.connectionId);
        connections.delete(conn);
        break;
      }
    }
    if (connections.size === 0) {
      activeConnections.delete(workerId);
    }
  }
}
