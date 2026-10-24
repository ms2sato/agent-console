import type { WSContext } from 'hono/ws';

/**
 * The identity of one WebSocket connection, stable across every callback of that connection.
 *
 * Measured 2026-10-24, hono 4.11.9, real `Bun.serve` + `hono/bun` `upgradeWebSocket`, one native
 * client doing open, two messages, close: the adapter builds a NEW `WSContext` for each of `open`, `message`
 * and `close` (`createWSContext(ws)` in each handler), so the four contexts were 4 distinct objects. Their
 * `raw` (the Bun `ServerWebSocket`) was the same object every time. A `Map` or `Set` keyed by the `WSContext`
 * that `onOpen` received therefore never matches the one `onMessage` / `onClose` receive.
 *
 * Every collection that tracks a connection is keyed by `socketKey(ws)`. The `WSContext` itself is kept as the
 * VALUE where something must be sent: any context of the same connection sends through the same `raw`, so the
 * open-time context stays a valid send handle for the connection's lifetime.
 *
 * Fallback: a context without an object `raw` (a unit-test double that predates this helper) is its own key,
 * which preserves the old behaviour for fixtures that hand one object to every callback.
 */
export type SocketKey = object;

export function socketKey(ws: WSContext): SocketKey {
  const raw = ws.raw;
  return typeof raw === 'object' && raw !== null ? raw : ws;
}

/**
 * The live ready state of the connection. The adapter snapshots `readyState` into a context when it is created,
 * so a stored open-time context reports OPEN forever; the live value is on `ws.raw.readyState`. Returns
 * undefined when neither exposes a numeric state.
 */
export function liveReadyState(ws: WSContext): number | undefined {
  const raw = ws.raw as { readyState?: unknown } | null | undefined;
  if (raw && typeof raw.readyState === 'number') return raw.readyState;
  return typeof ws.readyState === 'number' ? ws.readyState : undefined;
}
