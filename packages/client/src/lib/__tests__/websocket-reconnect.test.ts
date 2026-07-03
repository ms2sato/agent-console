import { describe, it, expect } from 'bun:test';
import { WS_CLOSE_CODE } from '@agent-console/shared';
import { shouldReconnect } from '../websocket-reconnect.js';

describe('shouldReconnect', () => {
  it('does NOT reconnect on deliberate-close codes', () => {
    expect(shouldReconnect(WS_CLOSE_CODE.NORMAL_CLOSURE)).toBe(false); // 1000
    expect(shouldReconnect(WS_CLOSE_CODE.GOING_AWAY)).toBe(false); // 1001
    expect(shouldReconnect(WS_CLOSE_CODE.POLICY_VIOLATION)).toBe(false); // 1008
  });

  it('reconnects on WORKER_RESTARTED (4001) — it is NOT a no-reconnect code', () => {
    // Regression guard: the restart close code must be reconnectable so the
    // client reattaches to the new incarnation and picks up the new epoch.
    // If someone adds 4001 to NO_RECONNECT_CLOSE_CODES, this fails.
    expect(WS_CLOSE_CODE.WORKER_RESTARTED).toBe(4001);
    expect(shouldReconnect(WS_CLOSE_CODE.WORKER_RESTARTED)).toBe(true);
  });

  it('reconnects on abnormal / transient closures', () => {
    expect(shouldReconnect(WS_CLOSE_CODE.ABNORMAL_CLOSURE)).toBe(true); // 1006
    expect(shouldReconnect(WS_CLOSE_CODE.INTERNAL_ERROR)).toBe(true); // 1011
  });
});
