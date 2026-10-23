import type { WSContext } from 'hono/ws';
import type { AppServerMessage } from '@agent-console/shared';
import { socketKey, type SocketKey } from './socket-key.js';

/**
 * Maximum number of messages to queue per client during initial sync.
 * If exceeded, the client is forcibly disconnected to prevent memory issues.
 */
const MAX_SYNC_QUEUE_SIZE = 100;

/**
 * Metadata stored for each worker WebSocket connection.
 * Used for callback detachment on close/error.
 */
export interface WorkerConnectionMetadata {
  sessionId: string;
  workerId: string;
  connectionId: string;
}

/**
 * Encapsulates all mutable WebSocket connection state.
 *
 * Previously this state lived in module-level variables (Sets and Maps),
 * making testing impossible and creating hidden global state. This class
 * makes the state explicit, injectable, and testable.
 */
export class WebSocketConnectionRegistry {
  // Every collection is keyed by the stable socket (see socket-key.ts), never by the per-event WSContext.
  // Where something must be sent, the open-time WSContext is stored as the value.

  // App WebSocket clients
  private readonly appClients = new Map<SocketKey, WSContext>();
  private readonly syncingClients = new Set<SocketKey>();
  private readonly syncingClientQueues = new Map<SocketKey, AppServerMessage[]>();

  // Worker WebSocket connections
  private readonly workerConnectionsBySession = new Map<string, Map<SocketKey, WSContext>>();
  private readonly workerConnections = new Map<string, Map<SocketKey, WSContext>>();
  private readonly connectionMetadata = new Map<SocketKey, WorkerConnectionMetadata>();
  /** Reverse mapping from socket to workerId, set unconditionally in addWorkerConnection.
   *  Ensures removeSessionConnections can always find the workerId for cleanup
   *  even when connectionMetadata has not been set. */
  private readonly workerIdByConnection = new Map<SocketKey, string>();

  // --- App Client Management ---

  addAppClient(ws: WSContext): void {
    this.appClients.set(socketKey(ws), ws);
  }

  removeAppClient(ws: WSContext): void {
    const key = socketKey(ws);
    this.appClients.delete(key);
    this.syncingClients.delete(key);
    this.syncingClientQueues.delete(key);
  }

  /** A snapshot of the connected clients' send handles (safe to mutate the registry while iterating it). */
  getAppClients(): ReadonlySet<WSContext> {
    return new Set(this.appClients.values());
  }

  get appClientCount(): number {
    return this.appClients.size;
  }

  // --- Syncing State Management ---

  startSyncing(ws: WSContext): void {
    const key = socketKey(ws);
    this.syncingClients.add(key);
    this.syncingClientQueues.set(key, []);
  }

  stopSyncing(ws: WSContext): void {
    const key = socketKey(ws);
    this.syncingClients.delete(key);
    this.syncingClientQueues.delete(key);
  }

  isSyncing(ws: WSContext): boolean {
    return this.syncingClients.has(socketKey(ws));
  }

  getSyncQueue(ws: WSContext): AppServerMessage[] | undefined {
    return this.syncingClientQueues.get(socketKey(ws));
  }

  /**
   * Queue a message for a syncing client.
   * Returns 'queued' if the message was added, 'overflow' if the queue is full.
   */
  queueSyncMessage(ws: WSContext, msg: AppServerMessage): 'queued' | 'overflow' {
    const queue = this.syncingClientQueues.get(socketKey(ws));
    if (!queue) return 'overflow';

    if (queue.length < MAX_SYNC_QUEUE_SIZE) {
      queue.push(msg);
      return 'queued';
    }
    return 'overflow';
  }

  // --- Worker Connection Management (by session) ---

  addWorkerConnection(sessionId: string, workerId: string, ws: WSContext): void {
    const key = socketKey(ws);
    this.getOrCreateMap(this.workerConnectionsBySession, sessionId).set(key, ws);
    this.getOrCreateMap(this.workerConnections, `${sessionId}\0${workerId}`).set(key, ws);
    this.workerIdByConnection.set(key, workerId);
  }

  removeWorkerConnection(sessionId: string, workerId: string, ws: WSContext): void {
    const key = socketKey(ws);
    this.deleteFromMap(this.workerConnectionsBySession, sessionId, key);
    this.deleteFromMap(this.workerConnections, `${sessionId}\0${workerId}`, key);
    this.connectionMetadata.delete(key);
    this.workerIdByConnection.delete(key);
  }

  /** A snapshot of the session's worker connections' send handles, or undefined when there are none. */
  getWorkerConnectionsBySession(sessionId: string): ReadonlySet<WSContext> | undefined {
    const conns = this.workerConnectionsBySession.get(sessionId);
    return conns ? new Set(conns.values()) : undefined;
  }

  removeSessionConnections(sessionId: string): void {
    const sessionConns = this.workerConnectionsBySession.get(sessionId);
    if (sessionConns) {
      for (const key of sessionConns.keys()) {
        const workerId = this.workerIdByConnection.get(key);
        if (workerId) {
          this.deleteFromMap(this.workerConnections, `${sessionId}\0${workerId}`, key);
        }
        this.connectionMetadata.delete(key);
        this.workerIdByConnection.delete(key);
      }
    }
    this.workerConnectionsBySession.delete(sessionId);
  }

  /** A snapshot of the worker's connections' send handles, or undefined when there are none. */
  getWorkerConnections(sessionId: string, workerId: string): ReadonlySet<WSContext> | undefined {
    const conns = this.workerConnections.get(`${sessionId}\0${workerId}`);
    return conns ? new Set(conns.values()) : undefined;
  }

  // --- Connection Metadata Management ---

  setConnectionMetadata(ws: WSContext, metadata: WorkerConnectionMetadata): void {
    this.connectionMetadata.set(socketKey(ws), metadata);
  }

  getConnectionMetadata(ws: WSContext): WorkerConnectionMetadata | undefined {
    return this.connectionMetadata.get(socketKey(ws));
  }

  removeConnectionMetadata(ws: WSContext): void {
    this.connectionMetadata.delete(socketKey(ws));
  }

  // --- Private Helpers ---

  private getOrCreateMap<K>(map: Map<K, Map<SocketKey, WSContext>>, key: K): Map<SocketKey, WSContext> {
    let inner = map.get(key);
    if (!inner) {
      inner = new Map();
      map.set(key, inner);
    }
    return inner;
  }

  private deleteFromMap<K>(map: Map<K, Map<SocketKey, WSContext>>, key: K, socket: SocketKey): void {
    const inner = map.get(key);
    if (inner) {
      inner.delete(socket);
      if (inner.size === 0) {
        map.delete(key);
      }
    }
  }
}
