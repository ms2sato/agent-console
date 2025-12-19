/**
 * WebSocket close codes as defined in RFC 6455
 * @see https://datatracker.ietf.org/doc/html/rfc6455#section-7.4.1
 */
export const WS_CLOSE_CODE = {
  /** Normal closure; the connection successfully completed */
  NORMAL_CLOSURE: 1000,
  /** Going away (e.g., browser navigating away from page) */
  GOING_AWAY: 1001,
  /** Abnormal closure (connection lost without close frame) */
  ABNORMAL_CLOSURE: 1006,
  /** Policy violation */
  POLICY_VIOLATION: 1008,
  /** Internal error; server encountered unexpected condition */
  INTERNAL_ERROR: 1011,
} as const;

export type WsCloseCode = (typeof WS_CLOSE_CODE)[keyof typeof WS_CLOSE_CODE];

/**
 * WebSocket ready states
 * These mirror the standard WebSocket.CONNECTING, OPEN, CLOSING, CLOSED constants
 */
export const WS_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

export type WsReadyState = (typeof WS_READY_STATE)[keyof typeof WS_READY_STATE];
