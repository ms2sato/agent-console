/**
 * Worker WebSocket manager module.
 * Manages WebSocket connections for git-diff workers.
 * Follows the same singleton pattern as app-websocket.ts.
 *
 * Terminal/agent PTY transport used to live here too, but the next renderer's
 * poc-terminal-store owns its own WebSocket (issue #941 removed the legacy
 * renderer; #961 removed the orphaned terminal transport). git-diff is the only
 * worker type routed through this module now.
 *
 * Key design decisions:
 * - Each worker has its own WebSocket connection (different from app-websocket which is single)
 * - Connections are managed by workerId in a Map
 * - Uses useSyncExternalStore pattern for React integration
 * - Automatically handles wss:// vs ws:// based on page protocol
 */
import {
  GIT_DIFF_SERVER_MESSAGE_TYPES,
  WS_CLOSE_CODE,
  type GitDiffServerMessage,
  type GitDiffClientMessage,
  type GitDiffData,
  type GitDiffTarget,
  type ExpandedLineChunk,
  type ReviewAnnotationSet,
} from '@agent-console/shared';
import { getWorkerWsUrl } from './websocket-url.js';
import { getReconnectDelay, shouldReconnect } from './websocket-reconnect.js';
import { logger } from './logger.js';

const MAX_RETRY_COUNT = 100;

/**
 * Validate that a parsed message is a valid GitDiffServerMessage.
 */
function isValidGitDiffMessage(msg: unknown): msg is GitDiffServerMessage {
  if (typeof msg !== 'object' || msg === null) {
    return false;
  }
  const { type } = msg as { type?: unknown };
  return typeof type === 'string' && type in GIT_DIFF_SERVER_MESSAGE_TYPES;
}

// Connection state for a single worker
export interface WorkerConnectionState {
  connected: boolean;
  // For git-diff workers
  diffData?: GitDiffData | null;
  diffError?: string | null;
  diffLoading?: boolean;
  expandedLines?: Map<string, ExpandedLineChunk[]>;
  annotationSet?: ReviewAnnotationSet | null;
}

// Internal connection data
interface WorkerConnection {
  ws: WebSocket;
  state: WorkerConnectionState;
  callbacks: WorkerCallbacks;
  // Reconnection state
  retryCount: number;
  retryTimeout: ReturnType<typeof setTimeout> | null;
  sessionId: string;
  workerId: string;
}

// Callbacks for git-diff workers (the only worker type routed through this module).
export interface GitDiffWorkerCallbacks {
  type: 'git-diff';
  onDiffData?: (data: GitDiffData) => void;
  onDiffError?: (error: string) => void;
}

type WorkerCallbacks = GitDiffWorkerCallbacks;

// Connection storage
const connections = new Map<string, WorkerConnection>();

// Global listeners for useSyncExternalStore subscriptions
const stateListeners = new Set<() => void>();

// Default state for disconnected workers (cached to avoid infinite loop in useSyncExternalStore)
const DEFAULT_DISCONNECTED_STATE: WorkerConnectionState = Object.freeze({ connected: false });

/**
 * Generate a unique key for a worker connection.
 */
function getConnectionKey(sessionId: string, workerId: string): string {
  return `${sessionId}:${workerId}`;
}

/**
 * Update connection state and notify listeners.
 */
function updateState(key: string, partial: Partial<WorkerConnectionState>): void {
  const conn = connections.get(key);
  if (!conn) return;

  conn.state = { ...conn.state, ...partial };
  stateListeners.forEach(fn => fn());
}

/**
 * Schedule reconnection for a worker WebSocket.
 */
function scheduleReconnect(key: string): void {
  const conn = connections.get(key);
  if (!conn) return;

  // Clear any existing timeout
  if (conn.retryTimeout) {
    clearTimeout(conn.retryTimeout);
    conn.retryTimeout = null;
  }

  // Stop retrying after max attempts and clean up to prevent stuck state
  if (conn.retryCount >= MAX_RETRY_COUNT) {
    logger.error(`[WorkerWS] Max retry attempts reached for ${key}, giving up`);
    // Clean up the failed connection to allow future connect() calls to work
    connections.delete(key);
    return;
  }

  const delay = getReconnectDelay(conn.retryCount);
  logger.debug(`[WorkerWS] Reconnecting ${key} in ${delay}ms (attempt ${conn.retryCount + 1})`);

  conn.retryTimeout = setTimeout(() => {
    const currentConn = connections.get(key);
    if (!currentConn) return;

    currentConn.retryCount++;
    // Reconnect using stored session/worker IDs and callbacks
    reconnect(currentConn.sessionId, currentConn.workerId, currentConn.callbacks);
  }, delay);
}

/**
 * Internal reconnect function that preserves connection state.
 */
function reconnect(sessionId: string, workerId: string, callbacks: WorkerCallbacks): void {
  const key = getConnectionKey(sessionId, workerId);
  const existingConn = connections.get(key);

  // Re-check if connection was deleted (session may have been deleted during timeout)
  if (!existingConn) {
    logger.debug(`[WorkerWS] Skipping reconnect for ${key}: connection no longer exists`);
    return;
  }

  // Preserve retry state
  const retryCount = existingConn.retryCount;

  // CRITICAL: Close old WebSocket before creating new one to prevent memory leak
  // Remove event handlers first to prevent stale state updates during close
  const oldWs = existingConn.ws;
  if (oldWs.readyState !== WebSocket.CLOSED && oldWs.readyState !== WebSocket.CLOSING) {
    oldWs.onopen = null;
    oldWs.onmessage = null;
    oldWs.onerror = null;
    oldWs.onclose = null;
    oldWs.close();
  }

  const wsUrl = getWorkerWsUrl(sessionId, workerId);
  const ws = new WebSocket(wsUrl);

  const initialState: WorkerConnectionState = {
    connected: false,
    diffData: null,
    diffError: null,
    diffLoading: true,
  };

  const conn: WorkerConnection = {
    ws,
    state: initialState,
    callbacks,
    retryCount,
    retryTimeout: null,
    sessionId,
    workerId,
  };
  connections.set(key, conn);
  // Notify subscribers that the connection state is now available.
  updateState(key, {});

  setupWebSocketHandlers(key, ws);
}

/**
 * Handle incoming WebSocket message for git-diff workers.
 */
function handleGitDiffMessage(key: string, msg: GitDiffServerMessage, callbacks: GitDiffWorkerCallbacks): void {
  switch (msg.type) {
    case 'diff-data':
      updateState(key, { diffData: msg.data, diffError: null, diffLoading: false, expandedLines: new Map() });
      callbacks.onDiffData?.(msg.data);
      break;
    case 'diff-error':
      updateState(key, { diffData: null, diffError: msg.error, diffLoading: false });
      callbacks.onDiffError?.(msg.error);
      break;
    case 'file-lines': {
      const conn = connections.get(key);
      const currentExpanded = conn?.state.expandedLines ?? new Map<string, ExpandedLineChunk[]>();
      const newMap = new Map(currentExpanded);
      const chunks = newMap.get(msg.path) ?? [];
      // Deduplicate: replace chunk with same startLine, otherwise append
      const existingIndex = chunks.findIndex(c => c.startLine === msg.startLine);
      if (existingIndex >= 0) {
        const newChunks = [...chunks];
        newChunks[existingIndex] = { startLine: msg.startLine, lines: msg.lines };
        newMap.set(msg.path, newChunks);
      } else {
        newMap.set(msg.path, [...chunks, { startLine: msg.startLine, lines: msg.lines }]);
      }
      updateState(key, { expandedLines: newMap });
      break;
    }
    case 'annotations-updated': {
      updateState(key, { annotationSet: msg.annotations });
      break;
    }
    default: {
      // Exhaustive check: TypeScript will error if a new message type is added
      // but not handled in this switch statement
      const _exhaustive: never = msg;
      logger.error('[WorkerWS] Unknown git-diff message type:', _exhaustive);
    }
  }
}

/**
 * Set up WebSocket event handlers. The handlers read the current callbacks from
 * the connection map (they may be swapped via connect() on remount), so no
 * callbacks argument is threaded here.
 */
function setupWebSocketHandlers(key: string, ws: WebSocket): void {
  ws.onopen = () => {
    const conn = connections.get(key);

    if (conn) {
      conn.retryCount = 0; // Reset retry count on successful connection
    }
    updateState(key, { connected: true, diffLoading: true });
  };

  ws.onmessage = (event) => {
    // Get current callbacks from connection (may be updated via updateCallbacks)
    const currentConn = connections.get(key);
    if (!currentConn) return;
    const currentCallbacks = currentConn.callbacks;

    try {
      const parsed: unknown = JSON.parse(event.data);

      if (!isValidGitDiffMessage(parsed)) {
        logger.error('[WorkerWS] Invalid git-diff message type:', parsed);
        updateState(key, { diffError: 'Invalid server message', diffLoading: false });
        return;
      }
      handleGitDiffMessage(key, parsed, currentCallbacks);
    } catch (e) {
      logger.error('[WorkerWS] Failed to parse message:', e);
      updateState(key, { diffError: 'Failed to parse server message', diffLoading: false });
    }
  };

  ws.onclose = (event: CloseEvent) => {
    updateState(key, { connected: false });
    logger.debug(`[WorkerWS] Disconnected: ${key} (code: ${event.code}, reason: ${event.reason || 'none'})`);

    // Check if connection was explicitly disconnected (removed from map)
    const conn = connections.get(key);
    if (!conn) {
      return; // Connection was intentionally closed, don't reconnect
    }

    if (!shouldReconnect(event.code)) {
      logger.debug(`[WorkerWS] Normal closure for ${key}, not reconnecting`);
      return;
    }

    scheduleReconnect(key);
  };

  ws.onerror = (error) => {
    logger.error('[WorkerWS] Error:', error);
    const currentConn = connections.get(key);
    if (currentConn) {
      updateState(key, { diffError: 'WebSocket connection error', diffLoading: false });
    }
  };
}

/**
 * Connect to a worker WebSocket.
 * Safe to call multiple times - will not create duplicate connections.
 *
 * @returns true if a new connection was created, false if already connected
 */
export function connect(
  sessionId: string,
  workerId: string,
  callbacks: WorkerCallbacks
): boolean {
  const key = getConnectionKey(sessionId, workerId);

  // Check existing connection
  const existing = connections.get(key);
  if (existing) {
    // Skip if already connecting
    if (existing.ws.readyState === WebSocket.CONNECTING) {
      // Connection is still being established - just update callbacks
      existing.callbacks = callbacks;
      return false;
    }

    // If connection is open, update callbacks and return
    // This avoids unnecessary connection churn when component remounts.
    if (existing.ws.readyState === WebSocket.OPEN) {
      // Update callbacks for the new component instance
      existing.callbacks = callbacks;

      return false;
    }
    // If socket is closing, abandon it and create new one
    if (existing.ws.readyState === WebSocket.CLOSING) {
      // Clear retry timeout if any
      if (existing.retryTimeout) {
        clearTimeout(existing.retryTimeout);
      }
    }
  }

  const wsUrl = getWorkerWsUrl(sessionId, workerId);
  const ws = new WebSocket(wsUrl);

  const initialState: WorkerConnectionState = {
    connected: false,
    diffData: null,
    diffError: null,
    diffLoading: true,
  };

  const conn: WorkerConnection = {
    ws,
    state: initialState,
    callbacks,
    retryCount: 0,
    retryTimeout: null,
    sessionId,
    workerId,
  };
  connections.set(key, conn);
  // Notify subscribers that the connection state is now available.
  updateState(key, {});

  setupWebSocketHandlers(key, ws);

  return true;
}

/**
 * Disconnect a worker WebSocket.
 * Cancels any pending reconnection attempts.
 */
export function disconnect(sessionId: string, workerId: string): void {
  const key = getConnectionKey(sessionId, workerId);
  const conn = connections.get(key);

  if (conn) {
    // Cancel any pending reconnection
    if (conn.retryTimeout) {
      clearTimeout(conn.retryTimeout);
      conn.retryTimeout = null;
    }
    if (conn.ws.readyState !== WebSocket.CLOSED && conn.ws.readyState !== WebSocket.CLOSING) {
      conn.ws.close(WS_CLOSE_CODE.NORMAL_CLOSURE);
    }
    connections.delete(key);
  }
}

/**
 * Update callbacks for an existing connection.
 * This allows updating callbacks without triggering reconnection.
 */
export function updateCallbacks(sessionId: string, workerId: string, callbacks: WorkerCallbacks): void {
  const key = getConnectionKey(sessionId, workerId);
  const conn = connections.get(key);
  if (conn) {
    conn.callbacks = callbacks;
  }
}

/**
 * Send a message to a git-diff worker.
 * @returns true if sent, false if not connected
 */
export function sendGitDiffMessage(sessionId: string, workerId: string, msg: GitDiffClientMessage): boolean {
  const key = getConnectionKey(sessionId, workerId);
  const conn = connections.get(key);

  if (conn && conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify(msg));
    if (msg.type === 'refresh' || msg.type === 'set-base-commit' || msg.type === 'set-target-commit') {
      updateState(key, { diffLoading: true, diffError: null });
    }
    return true;
  }

  // Set error state when send fails for operations that would set loading
  if (msg.type === 'refresh' || msg.type === 'set-base-commit' || msg.type === 'set-target-commit') {
    updateState(key, { diffError: 'Connection lost. Please try again.', diffLoading: false });
  }
  return false;
}

// Convenience methods for git-diff workers
export function refreshDiff(sessionId: string, workerId: string): boolean {
  return sendGitDiffMessage(sessionId, workerId, { type: 'refresh' });
}

export function requestAnnotations(sessionId: string, workerId: string): boolean {
  return sendGitDiffMessage(sessionId, workerId, { type: 'get-annotations' });
}

export function setBaseCommit(sessionId: string, workerId: string, ref: string): boolean {
  return sendGitDiffMessage(sessionId, workerId, { type: 'set-base-commit', ref });
}

export function setTargetCommit(sessionId: string, workerId: string, ref: GitDiffTarget): boolean {
  return sendGitDiffMessage(sessionId, workerId, { type: 'set-target-commit', ref });
}

export function requestFileLines(sessionId: string, workerId: string, path: string, startLine: number, endLine: number, ref: GitDiffTarget): boolean {
  return sendGitDiffMessage(sessionId, workerId, { type: 'get-file-lines', path, startLine, endLine, ref });
}

/**
 * Subscribe to state changes for worker connections (for useSyncExternalStore).
 * @returns Unsubscribe function
 */
export function subscribeState(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/**
 * Get current state snapshot for a specific worker (for useSyncExternalStore).
 */
export function getState(sessionId: string, workerId: string): WorkerConnectionState {
  const key = getConnectionKey(sessionId, workerId);
  const conn = connections.get(key);

  if (conn) {
    return conn.state;
  }

  // Return cached default state to avoid infinite loop in useSyncExternalStore
  // (getSnapshot must return the same reference when state hasn't changed)
  return DEFAULT_DISCONNECTED_STATE;
}

/**
 * Check if a worker is connected.
 */
export function isConnected(sessionId: string, workerId: string): boolean {
  const key = getConnectionKey(sessionId, workerId);
  const conn = connections.get(key);
  return conn?.ws.readyState === WebSocket.OPEN;
}

/**
 * Disconnect all worker WebSockets for a given session.
 * Call this when a session is deleted to clean up connections.
 */
export function disconnectSession(sessionId: string): void {
  const prefix = `${sessionId}:`;
  for (const [key, conn] of connections.entries()) {
    if (key.startsWith(prefix)) {
      // Cancel any pending reconnection
      if (conn.retryTimeout) {
        clearTimeout(conn.retryTimeout);
        conn.retryTimeout = null;
      }
      if (conn.ws.readyState !== WebSocket.CLOSED && conn.ws.readyState !== WebSocket.CLOSING) {
        conn.ws.close(WS_CLOSE_CODE.NORMAL_CLOSURE);
      }
      connections.delete(key);
    }
  }
}

/**
 * Reset module state for testing.
 * @internal
 */
export function _reset(): void {
  for (const conn of connections.values()) {
    // Cancel any pending reconnection
    if (conn.retryTimeout) {
      clearTimeout(conn.retryTimeout);
    }
    if (conn.ws.readyState !== WebSocket.CLOSED && conn.ws.readyState !== WebSocket.CLOSING) {
      conn.ws.close();
    }
  }
  connections.clear();
  stateListeners.clear();
}
