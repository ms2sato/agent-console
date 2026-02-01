/**
 * SDK Worker WebSocket message types.
 * Used for Claude Code SDK-based workers that produce structured messages
 * instead of raw terminal output.
 */

/**
 * SDK message from Claude Code SDK query().
 * This is the raw message type yielded by the SDK's async generator.
 * We store and forward these as-is rather than transforming them,
 * keeping the protocol simple and forward-compatible.
 */
export interface SDKMessage {
  type: string;
  uuid?: string;
  [key: string]: unknown;
}

// ============================================================
// WebSocket Messages for SDK Worker
// ============================================================

/**
 * Valid message types for SdkWorkerServerMessage.
 * Single source of truth for both type definitions and runtime validation.
 */
export const SDK_WORKER_SERVER_MESSAGE_TYPES = {
  'sdk-message': 1,
  'activity': 2,
  'exit': 3,
  'error': 4,
  'message-history': 5,
  'server-restarted': 6,
} as const;

export type SdkWorkerServerMessageType = keyof typeof SDK_WORKER_SERVER_MESSAGE_TYPES;

/** Server → Client messages */
export type SdkWorkerServerMessage =
  | { type: 'sdk-message'; message: SDKMessage }
  | { type: 'activity'; state: import('./worker.js').AgentActivityState }
  | { type: 'exit'; exitCode: number; signal: string | null }
  | { type: 'error'; message: string; code?: import('./session.js').WorkerErrorCode }
  | { type: 'message-history'; messages: SDKMessage[]; lastUuid: string | null }
  | { type: 'server-restarted'; serverPid: number };

/**
 * Valid message types for SdkWorkerClientMessage.
 */
export const SDK_WORKER_CLIENT_MESSAGE_TYPES = {
  'user-message': 1,
  'cancel': 2,
  'request-history': 3,
} as const;

export type SdkWorkerClientMessageType = keyof typeof SDK_WORKER_CLIENT_MESSAGE_TYPES;

/** Client → Server messages */
export type SdkWorkerClientMessage =
  | { type: 'user-message'; content: string }
  | { type: 'cancel' }
  | { type: 'request-history'; lastUuid?: string };
