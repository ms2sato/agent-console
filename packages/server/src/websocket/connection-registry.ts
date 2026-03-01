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
    // Track by session
    let sessionConns = this.workerConnectionsBySession.get(sessionId);
    if (!sessionConns) {
      sessionConns = new Set();
      this.workerConnectionsBySession.set(sessionId, sessionConns);
    }
    sessionConns.add(ws);

    // Track by session+worker
    const workerKey = `${sessionId}\0${workerId}`;
    let workerConns = this.workerConnections.get(workerKey);
    if (!workerConns) {
      workerConns = new Set();
      this.workerConnections.set(workerKey, workerConns);
    }
    workerConns.add(ws);

    // Track reverse mapping for reliable cleanup in removeSessionConnections
    this.workerIdByConnection.set(ws, workerId);
  }

  removeWorkerConnection(sessionId: string, workerId: string, ws: WSContext): void {
    // Remove from session tracking
    const sessionConns = this.workerConnectionsBySession.get(sessionId);
    if (sessionConns) {
      sessionConns.delete(ws);
      if (sessionConns.size === 0) {
        this.workerConnectionsBySession.delete(sessionId);
      }
    }

    // Remove from per-worker tracking
    const workerKey = `${sessionId}\0${workerId}`;
    const workerConns = this.workerConnections.get(workerKey);
    if (workerConns) {
      workerConns.delete(ws);
      if (workerConns.size === 0) {
        this.workerConnections.delete(workerKey);
      }
    }

    // Remove associated metadata and reverse mapping
    this.connectionMetadata.delete(ws);
    this.workerIdByConnection.delete(ws);
  }

  getWorkerConnectionsBySession(sessionId: string): ReadonlySet<WSContext> | undefined {
    return this.workerConnectionsBySession.get(sessionId);
  }

  removeSessionConnections(sessionId: string): void {
    const sessionConns = this.workerConnectionsBySession.get(sessionId);
    if (sessionConns) {
      // Clean up per-worker tracking, metadata, and reverse mapping for each connection
      for (const ws of sessionConns) {
        // Use workerIdByConnection (always set in addWorkerConnection) to find the workerId.
        // This ensures cleanup works even when connectionMetadata was never set.
        const workerId = this.workerIdByConnection.get(ws);
        if (workerId) {
          const workerKey = `${sessionId}\0${workerId}`;
          const workerConns = this.workerConnections.get(workerKey);
          if (workerConns) {
            workerConns.delete(ws);
            if (workerConns.size === 0) {
              this.workerConnections.delete(workerKey);
            }
          }
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
}
