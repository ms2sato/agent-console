import type { WSContext } from 'hono/ws';
import type { AppServerMessage } from '@agent-console/shared';

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
  // App WebSocket clients
  private readonly appClients = new Set<WSContext>();
  private readonly syncingClients = new Set<WSContext>();
  private readonly syncingClientQueues = new Map<WSContext, AppServerMessage[]>();

  // Worker WebSocket connections
  private readonly workerConnectionsBySession = new Map<string, Set<WSContext>>();
  private readonly workerConnections = new Map<string, Set<WSContext>>();
  private readonly connectionMetadata = new Map<WSContext, WorkerConnectionMetadata>();
  /** Reverse mapping from WebSocket to workerId, set unconditionally in addWorkerConnection.
   *  Ensures removeSessionConnections can always find the workerId for cleanup
   *  even when connectionMetadata has not been set. */
  private readonly workerIdByConnection = new Map<WSContext, string>();

  // --- App Client Management ---

  addAppClient(ws: WSContext): void {
    this.appClients.add(ws);
  }

  removeAppClient(ws: WSContext): void {
    this.appClients.delete(ws);
    this.syncingClients.delete(ws);
    this.syncingClientQueues.delete(ws);
  }

  getAppClients(): ReadonlySet<WSContext> {
    return this.appClients;
  }

  get appClientCount(): number {
    return this.appClients.size;
  }

  // --- Syncing State Management ---

  startSyncing(ws: WSContext): void {
    this.syncingClients.add(ws);
    this.syncingClientQueues.set(ws, []);
  }

  stopSyncing(ws: WSContext): void {
    this.syncingClients.delete(ws);
    this.syncingClientQueues.delete(ws);
  }

  isSyncing(ws: WSContext): boolean {
    return this.syncingClients.has(ws);
  }

  getSyncQueue(ws: WSContext): AppServerMessage[] | undefined {
    return this.syncingClientQueues.get(ws);
  }

  /**
   * Queue a message for a syncing client.
   * Returns 'queued' if the message was added, 'overflow' if the queue is full.
   */
  queueSyncMessage(ws: WSContext, msg: AppServerMessage): 'queued' | 'overflow' {
    const queue = this.syncingClientQueues.get(ws);
    if (!queue) return 'overflow';

    if (queue.length < MAX_SYNC_QUEUE_SIZE) {
      queue.push(msg);
      return 'queued';
    }
    return 'overflow';
  }

  // --- Worker Connection Management (by session) ---

  addWorkerConnection(sessionId: string, workerId: string, ws: WSContext): void {
    this.getOrCreateSet(this.workerConnectionsBySession, sessionId).add(ws);
    this.getOrCreateSet(this.workerConnections, `${sessionId}\0${workerId}`).add(ws);
    this.workerIdByConnection.set(ws, workerId);
  }

  removeWorkerConnection(sessionId: string, workerId: string, ws: WSContext): void {
    this.deleteFromSet(this.workerConnectionsBySession, sessionId, ws);
    this.deleteFromSet(this.workerConnections, `${sessionId}\0${workerId}`, ws);
    this.connectionMetadata.delete(ws);
    this.workerIdByConnection.delete(ws);
  }

  getWorkerConnectionsBySession(sessionId: string): ReadonlySet<WSContext> | undefined {
    return this.workerConnectionsBySession.get(sessionId);
  }

  removeSessionConnections(sessionId: string): void {
    const sessionConns = this.workerConnectionsBySession.get(sessionId);
    if (sessionConns) {
      for (const ws of sessionConns) {
        const workerId = this.workerIdByConnection.get(ws);
        if (workerId) {
          this.deleteFromSet(this.workerConnections, `${sessionId}\0${workerId}`, ws);
        }
        this.connectionMetadata.delete(ws);
        this.workerIdByConnection.delete(ws);
      }
    }
    this.workerConnectionsBySession.delete(sessionId);
  }

  getWorkerConnections(sessionId: string, workerId: string): ReadonlySet<WSContext> | undefined {
    const key = `${sessionId}\0${workerId}`;
    return this.workerConnections.get(key);
  }

  // --- Connection Metadata Management ---

  setConnectionMetadata(ws: WSContext, metadata: WorkerConnectionMetadata): void {
    this.connectionMetadata.set(ws, metadata);
  }

  getConnectionMetadata(ws: WSContext): WorkerConnectionMetadata | undefined {
    return this.connectionMetadata.get(ws);
  }

  removeConnectionMetadata(ws: WSContext): void {
    this.connectionMetadata.delete(ws);
  }

  // --- Private Helpers ---

  private getOrCreateSet<K>(map: Map<K, Set<WSContext>>, key: K): Set<WSContext> {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    return set;
  }

  private deleteFromSet<K>(map: Map<K, Set<WSContext>>, key: K, ws: WSContext): void {
    const set = map.get(key);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        map.delete(key);
      }
    }
  }
}
