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
  type WorkerServerMessage,
  type WorkerClientMessage,
  type GitDiffServerMessage,
  type GitDiffClientMessage,
  type AgentActivityState,
  type GitDiffData,
  type GitDiffTarget,
} from '@agent-console/shared';
import { getWorkerWsUrl } from './websocket-url.js';

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
  stateListeners: Set<() => void>;
}

// Callbacks for terminal/agent workers
export interface TerminalWorkerCallbacks {
  type: 'terminal' | 'agent';
  onOutput: (data: string) => void;
  onHistory: (data: string) => void;
  onExit: (exitCode: number, signal: string | null) => void;
  onActivity?: (state: AgentActivityState) => void;
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
  conn.stateListeners.forEach(fn => fn());
}

/**
 * Handle incoming WebSocket message for terminal/agent workers.
 */
function handleTerminalMessage(_key: string, msg: WorkerServerMessage, callbacks: TerminalWorkerCallbacks): void {
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

  // Skip if already connected
  const existing = connections.get(key);
  if (existing && (existing.ws.readyState === WebSocket.CONNECTING || existing.ws.readyState === WebSocket.OPEN)) {
    return false;
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
    stateListeners: new Set(),
  };
  connections.set(key, conn);

  ws.onopen = () => {
    updateState(key, { connected: true });
    if (callbacks.type === 'git-diff') {
      updateState(key, { diffLoading: true });
    }
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
      } else {
        if (!isValidWorkerMessage(parsed)) {
          console.error('[WorkerWS] Invalid worker message type:', parsed);
          return;
        }
        handleTerminalMessage(key, parsed, currentCallbacks);
      }
    } catch (e) {
      console.error('[WorkerWS] Failed to parse message:', e);
      if (currentCallbacks.type === 'git-diff') {
        updateState(key, { diffError: 'Failed to parse server message', diffLoading: false });
      }
    }
  };

  ws.onclose = () => {
    updateState(key, { connected: false });
  };

  ws.onerror = (error) => {
    console.error('[WorkerWS] Error:', error);
    // Get current callbacks from connection
    const currentConn = connections.get(key);
    if (currentConn?.callbacks.type === 'git-diff') {
      updateState(key, { diffError: 'WebSocket connection error', diffLoading: false });
    }
  };

  return true;
}

/**
 * Disconnect a worker WebSocket.
 */
export function disconnect(sessionId: string, workerId: string): void {
  const key = getConnectionKey(sessionId, workerId);
  const conn = connections.get(key);

  if (conn) {
    if (conn.ws.readyState !== WebSocket.CLOSED && conn.ws.readyState !== WebSocket.CLOSING) {
      conn.ws.close();
    }
    // Clear all listeners before removing connection to prevent memory leaks
    conn.stateListeners.clear();
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
      updateState(key, { diffLoading: true });
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
 * Subscribe to state changes for a specific worker (for useSyncExternalStore).
 * @returns Unsubscribe function
 */
export function subscribeState(sessionId: string, workerId: string, listener: () => void): () => void {
  const key = getConnectionKey(sessionId, workerId);
  const conn = connections.get(key);

  if (conn) {
    conn.stateListeners.add(listener);
    return () => conn.stateListeners.delete(listener);
  }

  // If no connection yet, return no-op unsubscribe
  return () => {};
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

  // Return default disconnected state
  return { connected: false };
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
 * Reset module state for testing.
 * @internal
 */
export function _reset(): void {
  for (const conn of connections.values()) {
    if (conn.ws.readyState !== WebSocket.CLOSED && conn.ws.readyState !== WebSocket.CLOSING) {
      conn.ws.close();
    }
  }
  connections.clear();
}
