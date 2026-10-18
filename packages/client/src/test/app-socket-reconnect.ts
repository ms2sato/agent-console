import { act } from '@testing-library/react';
import { spyOn } from 'bun:test';
import { MockWebSocket } from './mock-websocket';

/** Reconnect delays are at least this long; React's own timers are not. */
const RECONNECT_DELAY_FLOOR_MS = 500;

/**
 * Drops the app socket with an abnormal close and lets the module's own
 * scheduled reconnect fire, then opens the new socket: the production path of
 * `lib/app-websocket.ts` (close handler -> `scheduleReconnect` -> `connect`),
 * with `MockWebSocket` standing in for the network. The reconnect timer is
 * identified by its delay (jitter pinned) and invoked directly instead of
 * waiting for it.
 */
export function dropAndReopenAppSocket(): void {
  const randomSpy = spyOn(Math, 'random').mockReturnValue(0.5);
  const timeoutSpy = spyOn(globalThis, 'setTimeout');
  try {
    const before = timeoutSpy.mock.calls.length;
    const ws = MockWebSocket.getLastInstance();
    if (!ws) throw new Error('Expected an app socket to exist before it is dropped');
    act(() => {
      ws.simulateClose(1006);
    });
    const reconnect = timeoutSpy.mock.calls
      .slice(before)
      .find((call) => typeof call[0] === 'function' && Number(call[1]) >= RECONNECT_DELAY_FLOOR_MS);
    if (!reconnect) throw new Error('The close did not schedule a reconnect');
    act(() => {
      (reconnect[0] as () => void)();
      MockWebSocket.getLastInstance()?.simulateOpen();
    });
  } finally {
    timeoutSpy.mockRestore();
    randomSpy.mockRestore();
  }
}
