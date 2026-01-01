/**
 * App WebSocket singleton module.
 * Manages a single WebSocket connection for real-time state synchronization.
 *
 * @see docs/websocket-reconnection.md for design rationale
 */
import { APP_SERVER_MESSAGE_TYPES, WS_CLOSE_CODE, type AppServerMessage, type AppClientMessage } from '@agent-console/shared';
import { getAppWsUrl } from './websocket-url.js';

// Store state type
export interface AppWebSocketState {
  connected: boolean;
  sessionsSynced: boolean;
  agentsSynced: boolean;
  repositoriesSynced: boolean;
}

// Connection state
let ws: WebSocket | null = null;
let state: AppWebSocketState = {
  connected: false,
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

// Reconnection settings
const INITIAL_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 30000;
const JITTER_FACTOR = 0.3;
const MAX_RETRY_COUNT = 100; // ~50 minutes at 30s max delay

// Close codes that should not trigger reconnection
const NO_RECONNECT_CLOSE_CODES = [
  WS_CLOSE_CODE.NORMAL_CLOSURE,
  WS_CLOSE_CODE.GOING_AWAY,
  WS_CLOSE_CODE.POLICY_VIOLATION,
] as const;

/**
 * Determine if reconnection should be attempted for the given close code.
 * Add new codes to NO_RECONNECT_CLOSE_CODES to automatically update this logic.
 */
function isReconnectCode(code: number): boolean {
  // Cast array to readonly number[] to allow includes() with external close codes.
  // The literal types in NO_RECONNECT_CLOSE_CODES are preserved for type safety elsewhere.
  return !(NO_RECONNECT_CLOSE_CODES as readonly number[]).includes(code);
}

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

function getReconnectDelay(count: number): number {
  const baseDelay = Math.min(
    INITIAL_RETRY_DELAY * Math.pow(2, count),
    MAX_RETRY_DELAY
  );
  const jitter = baseDelay * JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.round(baseDelay + jitter);
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
      console.error('[WebSocket] Invalid message type:', parsed);
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
    console.error('[WebSocket] Failed to parse message:', e);
  }
}

function scheduleReconnect() {
  // Clear any existing timeout to prevent memory leak
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }

  // Stop retrying after max attempts
  if (retryCount >= MAX_RETRY_COUNT) {
    console.error('[WebSocket] Max retry attempts reached, giving up');
    return;
  }

  const delay = getReconnectDelay(retryCount);
  console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${retryCount + 1})`);

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
      setState({ connected: true });
      console.log('[WebSocket] Connected');
    };

    ws.onmessage = handleMessage;

    ws.onclose = (event: CloseEvent) => {
      // Reset all sync states on disconnect to ensure fresh sync on reconnection.
      // This prevents Dashboard from being stuck in stale state after reconnect.
      syncPending = false;
      setState({ connected: false, sessionsSynced: false, agentsSynced: false, repositoriesSynced: false });
      console.log(`[WebSocket] Disconnected (code: ${event.code}, reason: ${event.reason || 'none'})`);

      if (!isReconnectCode(event.code)) {
        console.log('[WebSocket] Normal closure, not reconnecting');
        return;
      }

      scheduleReconnect();
    };

    ws.onerror = (error) => {
      console.error('[WebSocket] Error:', error);
    };
  } catch (error) {
    console.error('[WebSocket] Failed to create connection:', error);
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
    console.log('[WebSocket] Sync already pending, skipping request');
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
  state = { connected: false, sessionsSynced: false, agentsSynced: false, repositoriesSynced: false };
  messageListeners.clear();
  stateListeners.clear();
}
