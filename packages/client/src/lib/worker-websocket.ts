/**
 * Worker WebSocket manager module.
 * Manages WebSocket connections for individual workers (terminal, agent, git-diff).
 * Follows the same singleton pattern as app-websocket.ts.
 *
 * Key design decisions:
 * - Each worker has its own WebSocket connection (different from app-websocket which is single)
 * - Connections are managed by workerId in a Map
 * - Uses useSyncExternalStore pattern for React integration
 * - Automatically handles wss:// vs ws:// based on page protocol
 */
import {
  WORKER_SERVER_MESSAGE_TYPES,
  GIT_DIFF_SERVER_MESSAGE_TYPES,
  WS_CLOSE_CODE,
  type WorkerServerMessage,
  type WorkerClientMessage,
  type GitDiffServerMessage,
  type GitDiffClientMessage,
  type AgentActivityState,
  type GitDiffData,
  type GitDiffTarget,
  type WorkerErrorCode,
} from '@agent-console/shared';
import { getWorkerWsUrl } from './websocket-url.js';

// Reconnection settings (same as app-websocket.ts)
const INITIAL_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 30000;
const JITTER_FACTOR = 0.3;
const MAX_RETRY_COUNT = 100;

// Close codes that should not trigger reconnection
const NO_RECONNECT_CLOSE_CODES = [
  WS_CLOSE_CODE.NORMAL_CLOSURE,
  WS_CLOSE_CODE.GOING_AWAY,
  WS_CLOSE_CODE.POLICY_VIOLATION,
] as const;

/**
 * Determine if reconnection should be attempted for the given close code.
 */
function isReconnectCode(code: number): boolean {
  return !(NO_RECONNECT_CLOSE_CODES as readonly number[]).includes(code);
}

/**
 * Calculate reconnection delay with exponential backoff and jitter.
 */
function getReconnectDelay(count: number): number {
  const baseDelay = Math.min(
    INITIAL_RETRY_DELAY * Math.pow(2, count),
    MAX_RETRY_DELAY
  );
  const jitter = baseDelay * JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.round(baseDelay + jitter);
}

/**
 * Validate that a parsed message is a valid WorkerServerMessage.
 */
function isValidWorkerMessage(msg: unknown): msg is WorkerServerMessage {
  if (typeof msg !== 'object' || msg === null) {
    return false;
  }
  const { type } = msg as { type?: unknown };
  return typeof type === 'string' && type in WORKER_SERVER_MESSAGE_TYPES;
}

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
}

// Internal connection data
interface WorkerConnection {
  ws: WebSocket;
  state: WorkerConnectionState;
  callbacks: WorkerCallbacks;
  // Reconnection state
  retryCount: number;
  retryTimeout: ReturnType<typeof setTimeout> | null;
  // History request debounce
  historyRequestTimeout: ReturnType<typeof setTimeout> | null;
  sessionId: string;
  workerId: string;
  // Terminal history data for diff calculation (persists across tab switches)
  lastHistoryData: string;
}

// Callbacks for terminal/agent workers
export interface TerminalWorkerCallbacks {
  type: 'terminal' | 'agent';
  onOutput: (data: string) => void;
  onHistory: (data: string) => void;
  onExit: (exitCode: number, signal: string | null) => void;
  onActivity?: (state: AgentActivityState) => void;
  onError?: (message: string, code?: WorkerErrorCode) => void;
}

// Callbacks for git-diff workers
export interface GitDiffWorkerCallbacks {
  type: 'git-diff';
  onDiffData?: (data: GitDiffData) => void;
  onDiffError?: (error: string) => void;
}

type WorkerCallbacks = TerminalWorkerCallbacks | GitDiffWorkerCallbacks;

// Connection storage
const connections = new Map<string, WorkerConnection>();

// Global listeners for useSyncExternalStore subscriptions
const stateListeners = new Set<() => void>();

// Default state for disconnected workers (cached to avoid infinite loop in useSyncExternalStore)
const DEFAULT_DISCONNECTED_STATE: WorkerConnectionState = Object.freeze({ connected: false });

// --- Visibility-based connection management ---

// Track connections disconnected due to visibility change
const visibilityDisconnectedKeys = new Set<string>();

// Store connection info for reconnection after visibility change
interface VisibilityDisconnectedInfo {
  callbacks: WorkerCallbacks;
  sessionId: string;
  workerId: string;
}
const visibilityDisconnectedCallbacks = new Map<string, VisibilityDisconnectedInfo>();

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
    console.error(`[WorkerWS] Max retry attempts reached for ${key}, giving up`);
    // Clean up the failed connection to allow future connect() calls to work
    connections.delete(key);
    return;
  }

  const delay = getReconnectDelay(conn.retryCount);
  console.log(`[WorkerWS] Reconnecting ${key} in ${delay}ms (attempt ${conn.retryCount + 1})`);

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
    console.log(`[WorkerWS] Skipping reconnect for ${key}: connection no longer exists`);
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
    ...(callbacks.type === 'git-diff' ? { diffData: null, diffError: null, diffLoading: true } : {}),
  };

  // Preserve lastHistoryData from existing connection for diff calculation
  const lastHistoryData = existingConn.lastHistoryData;

  const conn: WorkerConnection = {
    ws,
    state: initialState,
    callbacks,
    retryCount,
    retryTimeout: null,
    historyRequestTimeout: null,
    sessionId,
    workerId,
    lastHistoryData,
  };
  connections.set(key, conn);
  // Notify subscribers that the connection state is now available.
  updateState(key, {});

  setupWebSocketHandlers(key, ws, callbacks);
}

/**
 * Handle incoming WebSocket message for terminal/agent workers.
 */
function handleTerminalMessage(msg: WorkerServerMessage, callbacks: TerminalWorkerCallbacks): void {
  switch (msg.type) {
    case 'output':
      callbacks.onOutput(msg.data);
      break;
    case 'history':
      callbacks.onHistory(msg.data);
      break;
    case 'exit':
      callbacks.onExit(msg.exitCode, msg.signal);
      break;
    case 'activity':
      callbacks.onActivity?.(msg.state);
      break;
    case 'error':
      callbacks.onError?.(msg.message, msg.code);
      break;
  }
}

/**
 * Handle incoming WebSocket message for git-diff workers.
 */
function handleGitDiffMessage(key: string, msg: GitDiffServerMessage, callbacks: GitDiffWorkerCallbacks): void {
  switch (msg.type) {
    case 'diff-data':
      updateState(key, { diffData: msg.data, diffError: null, diffLoading: false });
      callbacks.onDiffData?.(msg.data);
      break;
    case 'diff-error':
      updateState(key, { diffData: null, diffError: msg.error, diffLoading: false });
      callbacks.onDiffError?.(msg.error);
      break;
  }
}

/**
 * Set up WebSocket event handlers.
 */
function setupWebSocketHandlers(key: string, ws: WebSocket, callbacks: WorkerCallbacks): void {
  ws.onopen = () => {
    const conn = connections.get(key);
    const [sessionId, workerId] = key.split(':');
    console.log(`[Perf] ${new Date().toISOString()} - ${sessionId}/${workerId} - WorkerWebSocket connection established (onopen)`);

    if (conn) {
      conn.retryCount = 0; // Reset retry count on successful connection
    }
    updateState(key, { connected: true });
    if (callbacks.type === 'git-diff') {
      updateState(key, { diffLoading: true });
    }
    // Note: Do NOT send request-history here on initial connection.
    // The server automatically sends history when a client connects.
    // Tab switch (remount with existing OPEN connection) handles history request in connect().
    console.log(`[WorkerWS] Connected: ${key}`);
  };

  ws.onmessage = (event) => {
    const messageStart = performance.now();
    const [sessionId, workerId] = key.split(':');
    const dataLength = typeof event.data === 'string' ? event.data.length : 0;
    console.log('[WorkerWS] Message received:', {
      sessionId,
      workerId,
      dataLength,
      time: messageStart
    });

    // Get current callbacks from connection (may be updated via updateCallbacks)
    const currentConn = connections.get(key);
    if (!currentConn) return;
    const currentCallbacks = currentConn.callbacks;

    try {
      const parsed: unknown = JSON.parse(event.data);

      if (currentCallbacks.type === 'git-diff') {
        if (!isValidGitDiffMessage(parsed)) {
          console.error('[WorkerWS] Invalid git-diff message type:', parsed);
          updateState(key, { diffError: 'Invalid server message', diffLoading: false });
          return;
        }
        handleGitDiffMessage(key, parsed, currentCallbacks);
      } else {
        if (!isValidWorkerMessage(parsed)) {
          console.error('[WorkerWS] Invalid worker message type:', parsed);
          return;
        }
        handleTerminalMessage(parsed, currentCallbacks);
      }
    } catch (e) {
      console.error('[WorkerWS] Failed to parse message:', e);
      if (currentCallbacks.type === 'git-diff') {
        updateState(key, { diffError: 'Failed to parse server message', diffLoading: false });
      }
    }

    const messageEnd = performance.now();
    const duration = messageEnd - messageStart;
    if (duration > 100) { // Log slow messages (>100ms)
      console.warn('[WorkerWS] SLOW message handler:', {
        sessionId,
        workerId,
        duration,
        dataLength
      });
    }
  };

  ws.onclose = (event: CloseEvent) => {
    updateState(key, { connected: false });
    console.log(`[WorkerWS] Disconnected: ${key} (code: ${event.code}, reason: ${event.reason || 'none'})`);

    // Check if connection was explicitly disconnected (removed from map)
    const conn = connections.get(key);
    if (!conn) {
      return; // Connection was intentionally closed, don't reconnect
    }

    if (!isReconnectCode(event.code)) {
      console.log(`[WorkerWS] Normal closure for ${key}, not reconnecting`);
      return;
    }

    scheduleReconnect(key);
  };

  ws.onerror = (error) => {
    console.error('[WorkerWS] Error:', error);
    // Get current callbacks from connection
    const currentConn = connections.get(key);
    if (currentConn?.callbacks.type === 'git-diff') {
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

  console.log(`[Perf] ${new Date().toISOString()} - ${sessionId}/${workerId} - WorkerWebSocket connect() called`);

  // Check existing connection
  const existing = connections.get(key);
  if (existing) {
    // Skip if already connecting
    if (existing.ws.readyState === WebSocket.CONNECTING) {
      // Connection is still being established - just update callbacks
      console.log(`[Perf] ${new Date().toISOString()} - ${sessionId}/${workerId} - WorkerWebSocket already connecting, updating callbacks only`);
      existing.callbacks = callbacks;
      return false;
    }

    // If connection is open, update callbacks and request fresh history
    // This avoids unnecessary connection churn when component remounts
    if (existing.ws.readyState === WebSocket.OPEN) {
      // Update callbacks for the new component instance
      console.log(`[Perf] ${new Date().toISOString()} - ${sessionId}/${workerId} - WorkerWebSocket already open, requesting history`);
      existing.callbacks = callbacks;

      // Debounce history requests to prevent rapid duplicate requests
      // Clear any pending history request
      if (existing.historyRequestTimeout) {
        clearTimeout(existing.historyRequestTimeout);
      }

      // Request fresh history from server after debounce delay
      const HISTORY_REQUEST_DEBOUNCE_MS = 100;
      existing.historyRequestTimeout = setTimeout(() => {
        existing.historyRequestTimeout = null;
        // Check if connection is still open before sending
        if (existing.ws.readyState === WebSocket.OPEN) {
          existing.ws.send(JSON.stringify({ type: 'request-history' }));
        }
      }, HISTORY_REQUEST_DEBOUNCE_MS);

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

  console.log(`[Perf] ${new Date().toISOString()} - ${sessionId}/${workerId} - WorkerWebSocket creating new WebSocket`);
  const wsUrl = getWorkerWsUrl(sessionId, workerId);
  const ws = new WebSocket(wsUrl);

  const initialState: WorkerConnectionState = {
    connected: false,
    ...(callbacks.type === 'git-diff' ? { diffData: null, diffError: null, diffLoading: true } : {}),
  };

  const conn: WorkerConnection = {
    ws,
    state: initialState,
    callbacks,
    retryCount: 0,
    retryTimeout: null,
    historyRequestTimeout: null,
    sessionId,
    workerId,
    lastHistoryData: '',
  };
  connections.set(key, conn);
  // Notify subscribers that the connection state is now available.
  updateState(key, {});

  setupWebSocketHandlers(key, ws, callbacks);

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
    // Cancel any pending history request
    if (conn.historyRequestTimeout) {
      clearTimeout(conn.historyRequestTimeout);
      conn.historyRequestTimeout = null;
    }
    if (conn.ws.readyState !== WebSocket.CLOSED && conn.ws.readyState !== WebSocket.CLOSING) {
      conn.ws.close(WS_CLOSE_CODE.NORMAL_CLOSURE);
    }
    // Clear visibility tracking data
    visibilityDisconnectedKeys.delete(key);
    visibilityDisconnectedCallbacks.delete(key);
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
 * Send a message to a terminal/agent worker.
 * @returns true if sent, false if not connected
 */
export function sendTerminalMessage(sessionId: string, workerId: string, msg: WorkerClientMessage): boolean {
  const key = getConnectionKey(sessionId, workerId);
  const conn = connections.get(key);

  if (conn && conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
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
  return false;
}

// Convenience methods for terminal workers
export function sendInput(sessionId: string, workerId: string, data: string): boolean {
  return sendTerminalMessage(sessionId, workerId, { type: 'input', data });
}

export function sendResize(sessionId: string, workerId: string, cols: number, rows: number): boolean {
  return sendTerminalMessage(sessionId, workerId, { type: 'resize', cols, rows });
}

export function sendImage(sessionId: string, workerId: string, data: string, mimeType: string): boolean {
  return sendTerminalMessage(sessionId, workerId, { type: 'image', data, mimeType });
}

/**
 * Request history data from the server.
 * Used when a previously invisible tab becomes visible for the first time.
 * @returns true if sent, false if not connected
 */
export function requestHistory(sessionId: string, workerId: string): boolean {
  return sendTerminalMessage(sessionId, workerId, { type: 'request-history' });
}

// Convenience methods for git-diff workers
export function refreshDiff(sessionId: string, workerId: string): boolean {
  return sendGitDiffMessage(sessionId, workerId, { type: 'refresh' });
}

export function setBaseCommit(sessionId: string, workerId: string, ref: string): boolean {
  return sendGitDiffMessage(sessionId, workerId, { type: 'set-base-commit', ref });
}

export function setTargetCommit(sessionId: string, workerId: string, ref: GitDiffTarget): boolean {
  return sendGitDiffMessage(sessionId, workerId, { type: 'set-target-commit', ref });
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
 * Get the last history data for a worker (for diff calculation).
 * Returns empty string if connection doesn't exist.
 */
export function getLastHistoryData(sessionId: string, workerId: string): string {
  const key = getConnectionKey(sessionId, workerId);
  const conn = connections.get(key);
  return conn?.lastHistoryData ?? '';
}

/**
 * Set the last history data for a worker (for diff calculation).
 * Call this after processing history to enable accurate diff on next update.
 */
export function setLastHistoryData(sessionId: string, workerId: string, data: string): void {
  const key = getConnectionKey(sessionId, workerId);
  const conn = connections.get(key);
  if (conn) {
    conn.lastHistoryData = data;
  }
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
      // Cancel any pending history request
      if (conn.historyRequestTimeout) {
        clearTimeout(conn.historyRequestTimeout);
        conn.historyRequestTimeout = null;
      }
      if (conn.ws.readyState !== WebSocket.CLOSED && conn.ws.readyState !== WebSocket.CLOSING) {
        conn.ws.close(WS_CLOSE_CODE.NORMAL_CLOSURE);
      }
      // Clear visibility tracking data
      visibilityDisconnectedKeys.delete(key);
      visibilityDisconnectedCallbacks.delete(key);
      connections.delete(key);
    }
  }
}

// --- Visibility change handler ---

/**
 * Handle page visibility change.
 * Disconnects all worker WebSockets when page is hidden (to save resources).
 * Reconnects with full history when page becomes visible.
 *
 * NOTE: This function is currently disabled. See the event listener registration below.
 */
// @ts-expect-error: Function intentionally unused - kept for potential re-enablement
function _handleVisibilityChange(): void {
  if (document.visibilityState === 'hidden') {
    // Store connection info and disconnect all workers
    for (const [key, conn] of connections.entries()) {
      visibilityDisconnectedCallbacks.set(key, {
        callbacks: conn.callbacks,
        sessionId: conn.sessionId,
        workerId: conn.workerId,
      });
      visibilityDisconnectedKeys.add(key);

      // Cancel any pending reconnection
      if (conn.retryTimeout) {
        clearTimeout(conn.retryTimeout);
        conn.retryTimeout = null;
      }

      // Close the WebSocket (use NORMAL_CLOSURE - browser WebSocket API doesn't allow 1001 GOING_AWAY)
      if (conn.ws.readyState !== WebSocket.CLOSED && conn.ws.readyState !== WebSocket.CLOSING) {
        // Remove event handlers first to prevent onclose from triggering reconnect
        conn.ws.onopen = null;
        conn.ws.onmessage = null;
        conn.ws.onerror = null;
        conn.ws.onclose = null;
        conn.ws.close(WS_CLOSE_CODE.NORMAL_CLOSURE);
      }

      // Keep the connection entry with disconnected state (preserve listeners)
      updateState(key, { connected: false });
    }

    console.log(`[WorkerWS] Page hidden, disconnected ${visibilityDisconnectedKeys.size} worker(s)`);
  } else if (document.visibilityState === 'visible') {
    // Reconnect workers that were disconnected due to visibility change
    const keysToReconnect = [...visibilityDisconnectedKeys];
    visibilityDisconnectedKeys.clear();

    for (const key of keysToReconnect) {
      const info = visibilityDisconnectedCallbacks.get(key);
      if (!info) continue;

      visibilityDisconnectedCallbacks.delete(key);

      // Check if connection still exists (component may have unmounted)
      const existingConn = connections.get(key);
      if (!existingConn) {
        console.log(`[WorkerWS] Skipping visibility reconnect for ${key}: connection no longer exists`);
        continue;
      }

      console.log(`[WorkerWS] Page visible, reconnecting ${key}`);
      reconnect(info.sessionId, info.workerId, info.callbacks);
    }
  }
}

// Register visibility change listener once
if (typeof document !== 'undefined') {
  // DISABLED: Preserve terminal history and avoid reconnection overhead
  // Visibility disconnection was causing performance issues when switching browser tabs.
  // Terminal history is preserved in xterm.js memory, so reconnection is unnecessary.
  // To re-enable, uncomment and rename _handleVisibilityChange back to handleVisibilityChange:
  // document.addEventListener('visibilitychange', _handleVisibilityChange);
}

/**
 * Clear visibility tracking for a specific worker.
 * Call this when Terminal component unmounts to prevent stale reconnection.
 */
export function clearVisibilityTracking(sessionId: string, workerId: string): void {
  const key = getConnectionKey(sessionId, workerId);
  visibilityDisconnectedKeys.delete(key);
  visibilityDisconnectedCallbacks.delete(key);
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
    // Cancel any pending history request
    if (conn.historyRequestTimeout) {
      clearTimeout(conn.historyRequestTimeout);
    }
    if (conn.ws.readyState !== WebSocket.CLOSED && conn.ws.readyState !== WebSocket.CLOSING) {
      conn.ws.close();
    }
  }
  connections.clear();
  stateListeners.clear();
  visibilityDisconnectedKeys.clear();
  visibilityDisconnectedCallbacks.clear();
}
