/**
 * Shared WebSocket reconnection utilities.
 * Used by both app-websocket and worker-websocket modules.
 *
 * Provides exponential backoff with jitter and close code classification.
 */
import { WS_CLOSE_CODE } from '@agent-console/shared';

// Reconnection timing constants
export const INITIAL_RETRY_DELAY = 1000;
export const MAX_RETRY_DELAY = 30000;
const JITTER_FACTOR = 0.3;

// Close codes that should not trigger reconnection
const NO_RECONNECT_CLOSE_CODES = [
  WS_CLOSE_CODE.NORMAL_CLOSURE,
  WS_CLOSE_CODE.GOING_AWAY,
  WS_CLOSE_CODE.POLICY_VIOLATION,
] as const;

/**
 * Calculate reconnection delay with exponential backoff and jitter.
 *
 * @param retryCount - The current retry attempt number (0-based)
 * @returns Delay in milliseconds before next reconnection attempt
 */
export function getReconnectDelay(retryCount: number): number {
  const baseDelay = Math.min(
    INITIAL_RETRY_DELAY * Math.pow(2, retryCount),
    MAX_RETRY_DELAY
  );
  const jitter = baseDelay * JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.round(baseDelay + jitter);
}

/**
 * Determine if reconnection should be attempted for the given close code.
 * Returns false for codes that indicate intentional closure (normal, going away, policy violation).
 *
 * @param code - The WebSocket close code
 * @returns true if reconnection should be attempted
 */
export function shouldReconnect(code: number): boolean {
  // Cast array to readonly number[] to allow includes() with external close codes.
  // The literal types in NO_RECONNECT_CLOSE_CODES are preserved for type safety elsewhere.
  return !(NO_RECONNECT_CLOSE_CODES as readonly number[]).includes(code);
}
