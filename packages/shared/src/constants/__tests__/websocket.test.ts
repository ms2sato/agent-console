import { describe, it, expect } from 'bun:test';
import { WS_CLOSE_CODE, WS_READY_STATE } from '../websocket.js';

describe('WS_CLOSE_CODE', () => {
  it('maps the RFC 6455 standard codes', () => {
    expect(WS_CLOSE_CODE.NORMAL_CLOSURE).toBe(1000);
    expect(WS_CLOSE_CODE.GOING_AWAY).toBe(1001);
    expect(WS_CLOSE_CODE.ABNORMAL_CLOSURE).toBe(1006);
    expect(WS_CLOSE_CODE.POLICY_VIOLATION).toBe(1008);
    expect(WS_CLOSE_CODE.INTERNAL_ERROR).toBe(1011);
  });

  it('defines WORKER_RESTARTED as a private-use (4000-4999) code, distinct from NORMAL_CLOSURE', () => {
    // The worker-restart close must be reconnectable on the client, so it must
    // NOT collide with NORMAL_CLOSURE (which the client treats as no-reconnect).
    expect(WS_CLOSE_CODE.WORKER_RESTARTED).toBe(4001);
    expect(WS_CLOSE_CODE.WORKER_RESTARTED).toBeGreaterThanOrEqual(4000);
    expect(WS_CLOSE_CODE.WORKER_RESTARTED).toBeLessThanOrEqual(4999);
    expect(WS_CLOSE_CODE.WORKER_RESTARTED).not.toBe(WS_CLOSE_CODE.NORMAL_CLOSURE);
  });
});

describe('WS_READY_STATE', () => {
  it('mirrors the standard WebSocket ready states', () => {
    expect(WS_READY_STATE.CONNECTING).toBe(0);
    expect(WS_READY_STATE.OPEN).toBe(1);
    expect(WS_READY_STATE.CLOSING).toBe(2);
    expect(WS_READY_STATE.CLOSED).toBe(3);
  });
});
