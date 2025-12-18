/**
 * App WebSocket singleton module.
 * Manages a single WebSocket connection for real-time state synchronization.
 *
 * @see docs/websocket-reconnection.md for design rationale
 */
import { APP_MESSAGE_TYPES, type AppServerMessage } from '@agent-console/shared';

// Store state type
export interface AppWebSocketState {
  connected: boolean;
  sessionsSynced: boolean;
  agentsSynced: boolean;
}

// Connection state
let ws: WebSocket | null = null;
let state: AppWebSocketState = {
  connected: false,
  sessionsSynced: false,
  agentsSynced: false,
};
let retryCount = 0;
let retryTimeout: ReturnType<typeof setTimeout> | null = null;

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
// 1000: Normal closure
// 1001: Going away (browser navigating away)
// 1008: Policy violation
const NO_RECONNECT_CLOSE_CODES = [1000, 1001, 1008];

/**
 * Validate that a parsed message has a valid type.
 * Uses APP_MESSAGE_TYPES from shared package as single source of truth.
 */
function isValidMessage(msg: unknown): msg is AppServerMessage {
  if (typeof msg !== 'object' || msg === null) {
    return false;
  }
  const { type } = msg as { type?: unknown };
  return typeof type === 'string' && type in APP_MESSAGE_TYPES;
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
    // Track initial sync reception
    if (parsed.type === 'sessions-sync') {
      setState({ sessionsSynced: true });
    }
    if (parsed.type === 'agents-sync') {
      setState({ agentsSynced: true });
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

  // Use wss:// for HTTPS, ws:// for HTTP
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/app`;

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      retryCount = 0;
      setState({ connected: true });
      console.log('[WebSocket] Connected');
    };

    ws.onmessage = handleMessage;

    ws.onclose = (event: CloseEvent) => {
      setState({ connected: false });
      console.log(`[WebSocket] Disconnected (code: ${event.code}, reason: ${event.reason || 'none'})`);

      // Don't reconnect for clean closures or policy violations
      if (NO_RECONNECT_CLOSE_CODES.includes(event.code)) {
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
    ws.close(1000); // Normal closure
  }
  ws = null;
  setState({ connected: false });
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
  state = { connected: false, sessionsSynced: false, agentsSynced: false };
  messageListeners.clear();
  stateListeners.clear();
}
