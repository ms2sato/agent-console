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
  /**
   * Private-use code (RFC 6455 4000-4999 range): the server closed a worker
   * socket because the worker restarted and the client must reconnect onto the
   * new incarnation to pick up the new generation epoch. A dedicated code is
   * required because `NORMAL_CLOSURE` (1000) is in the client's
   * `NO_RECONNECT_CLOSE_CODES` (deliberate-close semantics, e.g. SESSION_DELETED)
   * and would suppress the reconnect. This code is NOT in that set, so the
   * client reconnects and re-requests history. See terminal-history-paging.md §3.4/§4.5.
   */
  WORKER_RESTARTED: 4001,
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
