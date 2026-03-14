/**
 * App WebSocket singleton module.
 * Manages a single WebSocket connection for real-time state synchronization.
 *
 * @see docs/websocket-reconnection.md for design rationale
 */
import { APP_SERVER_MESSAGE_TYPES, WS_CLOSE_CODE, type AppServerMessage, type AppClientMessage } from '@agent-console/shared';
import { getAppWsUrl } from './websocket-url.js';
import { getReconnectDelay, shouldReconnect } from './websocket-reconnect.js';
import { logger } from './logger.js';

// Store state type
export interface AppWebSocketState {
  connected: boolean;
  /** True once the WebSocket has successfully connected at least once in this session */
  hasEverConnected: boolean;
  sessionsSynced: boolean;
  agentsSynced: boolean;
  repositoriesSynced: boolean;
}

// Connection state
let ws: WebSocket | null = null;
let state: AppWebSocketState = {
  connected: false,
  hasEverConnected: false,
  sessionsSynced: false,
  agentsSynced: false,
  repositoriesSynced: false,
};
let retryCount = 0;
let retryTimeout: ReturnType<typeof setTimeout> | null = null;
// Track if a sync request is pending to prevent duplicate requests during rapid navigation
let syncPending = false;

// Listeners
type MessageListener = (msg: AppServerMessage) => void;
type StateListener = () => void;

const messageListeners = new Set<MessageListener>();
const stateListeners = new Set<StateListener>();

// Policy violation subscribers for auth-related WebSocket closures
const policyViolationListeners = new Set<() => void>();

/** @internal Exported for testing */
export const MAX_RETRY_COUNT = 100; // ~50 minutes at 30s max delay
/** @internal Exported for testing */
export const LAST_RESORT_RETRY_DELAY = 60000; // 60s fixed interval after max retries exhausted

/**
 * Validate that a parsed message has a valid type.
 * Uses APP_MESSAGE_TYPES from shared package as single source of truth.
 */
function isValidMessage(msg: unknown): msg is AppServerMessage {
  if (typeof msg !== 'object' || msg === null) {
    return false;
  }
  const { type } = msg as { type?: unknown };
  return typeof type === 'string' && type in APP_SERVER_MESSAGE_TYPES;
}

function hasStateChanged(prev: AppWebSocketState, next: AppWebSocketState): boolean {
  return (Object.keys(next) as Array<keyof AppWebSocketState>).some(
    key => prev[key] !== next[key]
  );
}

function setState(partial: Partial<AppWebSocketState>) {
  const prevState = state;
  state = { ...state, ...partial };
  // Only notify if state actually changed
  if (hasStateChanged(prevState, state)) {
    stateListeners.forEach(fn => fn());
  }
}

function handleMessage(event: MessageEvent) {
  try {
    const parsed: unknown = JSON.parse(event.data);
    if (!isValidMessage(parsed)) {
      logger.error('[WebSocket] Invalid message type:', parsed);
      return;
    }

    // Track initial sync reception and clear pending state
    if (parsed.type === 'sessions-sync') {
      syncPending = false;
      setState({ sessionsSynced: true });
    }
    if (parsed.type === 'agents-sync') {
      setState({ agentsSynced: true });
    }
    if (parsed.type === 'repositories-sync') {
      setState({ repositoriesSynced: true });
    }
    messageListeners.forEach(fn => fn(parsed));
  } catch (e) {
    logger.error('[WebSocket] Failed to parse message:', e);
  }
}

function scheduleReconnect() {
  // Clear any existing timeout to prevent memory leak
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }

  // After max attempts, switch to last-resort mode with a fixed long interval
  if (retryCount >= MAX_RETRY_COUNT) {
    logger.warn(`[WebSocket] Entering last-resort reconnection mode (every ${LAST_RESORT_RETRY_DELAY / 1000}s)`);
    retryTimeout = setTimeout(() => {
      connect();
    }, LAST_RESORT_RETRY_DELAY);
    return;
  }

  const delay = getReconnectDelay(retryCount);
  logger.debug(`[WebSocket] Reconnecting in ${delay}ms (attempt ${retryCount + 1})`);

  retryTimeout = setTimeout(() => {
    retryCount++;
    connect();
  }, delay);
}

/**
 * Connect to the app WebSocket.
 * Safe to call multiple times - will not create duplicate connections.
 */
export function connect(): void {
  // Skip if already connecting or connected
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  // If socket is closing, abandon it and create new one
  if (ws && ws.readyState === WebSocket.CLOSING) {
    ws = null;
  }

  try {
    ws = new WebSocket(getAppWsUrl());

    ws.onopen = () => {
      retryCount = 0;
      setState({ connected: true, hasEverConnected: true });
      logger.debug('[WebSocket] Connected');
    };

    ws.onmessage = handleMessage;

    ws.onclose = (event: CloseEvent) => {
      // Reset all sync states on disconnect to ensure fresh sync on reconnection.
      // This prevents Dashboard from being stuck in stale state after reconnect.
      syncPending = false;
      setState({ connected: false, sessionsSynced: false, agentsSynced: false, repositoriesSynced: false });
      logger.debug(`[WebSocket] Disconnected (code: ${event.code}, reason: ${event.reason || 'none'})`);

      if (event.code === WS_CLOSE_CODE.POLICY_VIOLATION) {
        policyViolationListeners.forEach(fn => {
          fn();
        });
      }

      if (!shouldReconnect(event.code)) {
        logger.debug('[WebSocket] Normal closure, not reconnecting');
        return;
      }

      scheduleReconnect();
    };

    ws.onerror = (error) => {
      logger.error('[WebSocket] Error:', error);
    };
  } catch (error) {
    logger.error('[WebSocket] Failed to create connection:', error);
    ws = null;
    setState({ connected: false });
    scheduleReconnect();
  }
}

/**
 * Disconnect from the app WebSocket.
 * Cancels any pending reconnection attempts.
 */
export function disconnect(): void {
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }
  if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
    ws.close(WS_CLOSE_CODE.NORMAL_CLOSURE);
  }
  ws = null;
  setState({ connected: false });
}

/**
 * Send a message to the app WebSocket.
 * @returns true if the message was sent, false if the WebSocket is not connected
 */
function send(msg: AppClientMessage): boolean {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

/**
 * Emit a session-deleted event locally without waiting for WebSocket.
 * Used for optimistic UI updates after successful API calls.
 * This allows immediate UI feedback while the WebSocket event may arrive later.
 * The event is processed idempotently - duplicate deletions are safely ignored.
 *
 * @param sessionId - The ID of the deleted session
 */
export function emitSessionDeleted(sessionId: string): void {
  const msg: AppServerMessage = { type: 'session-deleted', sessionId };
  messageListeners.forEach(fn => fn(msg));
}

/**
 * Request a full session sync from the server.
 * Use this when the Dashboard mounts and the WebSocket is already connected.
 * Resets sessionsSynced to false to show loading state until sync is received.
 *
 * Skips if a sync request is already pending to prevent duplicate requests
 * during rapid navigation (Dashboard → Away → Dashboard).
 *
 * @returns true if the request was sent, false if not connected or already pending
 */
export function requestSync(): boolean {
  if (syncPending) {
    logger.debug('[WebSocket] Sync already pending, skipping request');
    return false;
  }

  const sent = send({ type: 'request-sync' });
  if (sent) {
    syncPending = true;
    setState({ sessionsSynced: false });
  }
  return sent;
}

/**
 * Register a callback to be called when the WebSocket closes with POLICY_VIOLATION (1008).
 * Used for redirecting to login when auth session is invalidated.
 * @returns Unsubscribe function
 */
export function onPolicyViolation(callback: () => void): () => void {
  policyViolationListeners.add(callback);
  return () => policyViolationListeners.delete(callback);
}

/**
 * Subscribe to WebSocket messages.
 * @returns Unsubscribe function
 */
export function subscribe(listener: MessageListener): () => void {
  messageListeners.add(listener);
  return () => messageListeners.delete(listener);
}

/**
 * Subscribe to state changes (for useSyncExternalStore).
 * @returns Unsubscribe function
 */
export function subscribeState(listener: StateListener): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/**
 * Get current state snapshot (for useSyncExternalStore).
 */
export function getState(): AppWebSocketState {
  return state;
}

/**
 * Reset module state for testing.
 * @internal
 */
export function _reset(): void {
  disconnect();
  retryCount = 0;
  syncPending = false;
  policyViolationListeners.clear();
  state = { connected: false, hasEverConnected: false, sessionsSynced: false, agentsSynced: false, repositoriesSynced: false };
  messageListeners.clear();
  stateListeners.clear();
}

/**
 * Set retry count for testing.
 * @internal
 */
export function _setRetryCount(count: number): void {
  retryCount = count;
}
