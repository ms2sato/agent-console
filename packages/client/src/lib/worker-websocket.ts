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
  SDK_WORKER_SERVER_MESSAGE_TYPES,
  WS_CLOSE_CODE,
  type WorkerServerMessage,
  type WorkerClientMessage,
  type GitDiffServerMessage,
  type GitDiffClientMessage,
  type SdkWorkerServerMessage,
  type SdkWorkerClientMessage,
  type SDKMessage,
  type AgentActivityState,
  type GitDiffData,
  type GitDiffTarget,
  type WorkerErrorCode,
  type ExpandedLineChunk,
} from '@agent-console/shared';
import { getWorkerWsUrl } from './websocket-url.js';
import { clearTerminalState } from './terminal-state-cache.js';

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

/**
 * Validate that a parsed message is a valid SdkWorkerServerMessage.
 */
function isValidSdkMessage(msg: unknown): msg is SdkWorkerServerMessage {
  if (typeof msg !== 'object' || msg === null) {
    return false;
  }
  const { type } = msg as { type?: unknown };
  return typeof type === 'string' && type in SDK_WORKER_SERVER_MESSAGE_TYPES;
}

// Connection state for a single worker
export interface WorkerConnectionState {
  connected: boolean;
  // For git-diff workers
  diffData?: GitDiffData | null;
  diffError?: string | null;
  diffLoading?: boolean;
  expandedLines?: Map<string, ExpandedLineChunk[]>;
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
  // Flag to indicate truncation recovery is in progress
  // Used to prevent saving stale terminal state during cache clear
  truncationInProgress: boolean;
}

// Callbacks for terminal/agent workers
export interface TerminalWorkerCallbacks {
  type: 'terminal' | 'agent';
  onOutput: (data: string, offset: number) => void;
  onHistory: (data: string, offset: number) => void;
  onExit: (exitCode: number, signal: string | null) => void;
  onActivity?: (state: AgentActivityState) => void;
  onError?: (message: string, code?: WorkerErrorCode) => void;
  onOutputTruncated?: (message: string) => void;
}

// Callbacks for git-diff workers
export interface GitDiffWorkerCallbacks {
  type: 'git-diff';
  onDiffData?: (data: GitDiffData) => void;
  onDiffError?: (error: string) => void;
}

// Callbacks for SDK workers (Claude Code SDK-based)
export interface SdkWorkerCallbacks {
  type: 'sdk';
  onMessage: (message: SDKMessage) => void;
  onActivity?: (state: AgentActivityState) => void;
  onExit?: (exitCode: number, signal: string | null) => void;
  onError?: (message: string, code?: WorkerErrorCode) => void;
  onMessageHistory?: (messages: SDKMessage[], lastUuid: string | null) => void;
  onServerRestarted?: (serverPid: number) => void;
}

type WorkerCallbacks = TerminalWorkerCallbacks | GitDiffWorkerCallbacks | SdkWorkerCallbacks;

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

  const conn: WorkerConnection = {
    ws,
    state: initialState,
    callbacks,
    retryCount,
    retryTimeout: null,
    sessionId,
    workerId,
    truncationInProgress: false,
  };
  connections.set(key, conn);
  // Notify subscribers that the connection state is now available.
  updateState(key, {});

  setupWebSocketHandlers(key, ws, callbacks);
}

/**
 * Handle incoming WebSocket message for terminal/agent workers.
 */
function handleTerminalMessage(
  msg: WorkerServerMessage,
  callbacks: TerminalWorkerCallbacks,
  sessionId: string,
  workerId: string
): void {
  const key = getConnectionKey(sessionId, workerId);

  switch (msg.type) {
    case 'output':
      callbacks.onOutput(msg.data, msg.offset);
      break;
    case 'history':
      callbacks.onHistory(msg.data, msg.offset);
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
    case 'output-truncated': {
      // Set truncation flag to prevent save manager from saving stale state
      const conn = connections.get(key);
      if (conn) {
        conn.truncationInProgress = true;
      }

      // Clear terminal cache since offsets are now invalid after truncation
      clearTerminalState(sessionId, workerId)
        .then(() => {
          const currentConn = connections.get(key);
          if (currentConn) {
            currentConn.truncationInProgress = false;
          }
        })
        .catch((err) => {
          console.error('[WorkerWS] Failed to clear terminal cache on truncation:', err);
          const currentConn = connections.get(key);
          if (currentConn) {
            currentConn.truncationInProgress = false;
          }
        });

      // Notify the terminal component about the truncation
      callbacks.onOutputTruncated?.(msg.message);
      break;
    }
    case 'server-restarted':
      // Server restart notification - cache invalidation is handled elsewhere
      // (via setCurrentServerPid in app initialization)
      console.log('[WorkerWS] Server restarted notification received, serverPid:', msg.serverPid);
      break;
    default: {
      // Exhaustive check: TypeScript will error if a new message type is added
      // but not handled in this switch statement
      const _exhaustive: never = msg;
      console.error('[WorkerWS] Unknown terminal message type:', _exhaustive);
    }
  }
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
    default: {
      // Exhaustive check: TypeScript will error if a new message type is added
      // but not handled in this switch statement
      const _exhaustive: never = msg;
      console.error('[WorkerWS] Unknown git-diff message type:', _exhaustive);
    }
  }
}

/**
 * Handle incoming WebSocket message for SDK workers.
 */
function handleSdkMessage(msg: SdkWorkerServerMessage, callbacks: SdkWorkerCallbacks): void {
  switch (msg.type) {
    case 'sdk-message':
      callbacks.onMessage(msg.message);
      break;
    case 'activity':
      callbacks.onActivity?.(msg.state);
      break;
    case 'exit':
      callbacks.onExit?.(msg.exitCode, msg.signal);
      break;
    case 'error':
      callbacks.onError?.(msg.message, msg.code);
      break;
    case 'message-history':
      callbacks.onMessageHistory?.(msg.messages, msg.lastUuid);
      break;
    case 'server-restarted':
      callbacks.onServerRestarted?.(msg.serverPid);
      break;
    default: {
      // Exhaustive check: TypeScript will error if a new message type is added
      // but not handled in this switch statement
      const _exhaustive: never = msg;
      console.error('[WorkerWS] Unknown SDK message type:', _exhaustive);
    }
  }
}

/**
 * Set up WebSocket event handlers.
 */
function setupWebSocketHandlers(key: string, ws: WebSocket, callbacks: WorkerCallbacks): void {
  ws.onopen = () => {
    const conn = connections.get(key);

    if (conn) {
      conn.retryCount = 0; // Reset retry count on successful connection
    }
    updateState(key, { connected: true });
    if (callbacks.type === 'git-diff') {
      updateState(key, { diffLoading: true });
    }

    // Note: History request is NOT sent automatically here.
    // Terminal.tsx is responsible for requesting history with the appropriate fromOffset
    // (either 0 for fresh load, or cached.offset for incremental sync after cache restoration).
  };

  ws.onmessage = (event) => {
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
      } else if (currentCallbacks.type === 'sdk') {
        if (!isValidSdkMessage(parsed)) {
          console.error('[WorkerWS] Invalid SDK message type:', parsed);
          return;
        }
        handleSdkMessage(parsed, currentCallbacks);
      } else {
        if (!isValidWorkerMessage(parsed)) {
          console.error('[WorkerWS] Invalid worker message type:', parsed);
          return;
        }
        handleTerminalMessage(parsed, currentCallbacks, currentConn.sessionId, currentConn.workerId);
      }
    } catch (e) {
      console.error('[WorkerWS] Failed to parse message:', e);
      if (currentCallbacks.type === 'git-diff') {
        updateState(key, { diffError: 'Failed to parse server message', diffLoading: false });
      }
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
    // This avoids unnecessary connection churn when component remounts
    // Note: History request is NOT sent automatically here.
    // Terminal.tsx is responsible for requesting history with the appropriate fromOffset.
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
    ...(callbacks.type === 'git-diff' ? { diffData: null, diffError: null, diffLoading: true } : {}),
  };

  const conn: WorkerConnection = {
    ws,
    state: initialState,
    callbacks,
    retryCount: 0,
    retryTimeout: null,
    sessionId,
    workerId,
    truncationInProgress: false,
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
 * @param fromOffset If specified, request only data after this offset (incremental sync)
 * @returns true if sent, false if not connected
 */
export function requestHistory(sessionId: string, workerId: string, fromOffset?: number): boolean {
  return sendTerminalMessage(sessionId, workerId, {
    type: 'request-history',
    fromOffset: fromOffset ?? 0
  });
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

export function requestFileLines(sessionId: string, workerId: string, path: string, startLine: number, endLine: number, ref: GitDiffTarget): boolean {
  return sendGitDiffMessage(sessionId, workerId, { type: 'get-file-lines', path, startLine, endLine, ref });
}

/**
 * Send a message to an SDK worker.
 * @returns true if sent, false if not connected
 */
export function sendSdkMessage(sessionId: string, workerId: string, msg: SdkWorkerClientMessage): boolean {
  const key = getConnectionKey(sessionId, workerId);
  const conn = connections.get(key);

  if (conn && conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

// Convenience methods for SDK workers

/**
 * Send a user message to an SDK worker.
 * @returns true if sent, false if not connected
 */
export function sendUserMessage(sessionId: string, workerId: string, content: string): boolean {
  return sendSdkMessage(sessionId, workerId, { type: 'user-message', content });
}

/**
 * Cancel the current query in an SDK worker.
 * @returns true if sent, false if not connected
 */
export function cancelQuery(sessionId: string, workerId: string): boolean {
  return sendSdkMessage(sessionId, workerId, { type: 'cancel' });
}

/**
 * Request message history from an SDK worker.
 * @param lastUuid If specified, request only messages after this UUID (incremental sync)
 * @returns true if sent, false if not connected
 */
export function requestSdkHistory(sessionId: string, workerId: string, lastUuid?: string): boolean {
  return sendSdkMessage(sessionId, workerId, { type: 'request-history', lastUuid });
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
 * Check if truncation recovery is in progress for a worker.
 * Used by terminal-state-save-manager to skip saving during truncation.
 */
export function isTruncationInProgress(sessionId: string, workerId: string): boolean {
  const key = getConnectionKey(sessionId, workerId);
  const conn = connections.get(key);
  return conn?.truncationInProgress ?? false;
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
