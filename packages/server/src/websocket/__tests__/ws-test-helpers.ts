/**
 * Shared cast helpers for WebSocket route/handler tests.
 *
 * These exist because the real types (`WSContext`, `pino.Logger`,
 * `UpgradeWebSocket`) have many required properties/overloads that a test
 * double never needs. Callers pass only the subset they use, as an object
 * literal, so TypeScript's excess-property check still catches typos --
 * the whole reason to prefer this over `as unknown as`.
 */
import type { WSContext } from 'hono/ws';
import type pino from 'pino';
import type { setupWebSocketRoutes } from '../routes.js';

/**
 * WSContext (hono/ws) has many required properties (binaryType, url,
 * protocol, etc.) that a test double never needs. Callers pass only the
 * subset they use, as an object literal, to keep the excess-property check.
 */
export function asWSContext<T extends Partial<WSContext>>(stub: T): WSContext & T {
  return stub as WSContext & T;
}

/** pino.Logger has many required properties a test double never needs. */
export function asPinoLogger<T extends Partial<pino.Logger>>(stub: T): pino.Logger & T {
  return stub as pino.Logger & T;
}

type UpgradeWebSocketParam = Parameters<typeof setupWebSocketRoutes>[1];

/**
 * UpgradeWebSocket (hono/ws) has overloaded call signatures with incompatible
 * return types (MiddlewareHandler vs Promise<Response>), so a passthrough stub
 * cannot satisfy the interface without casting through unknown. This helper
 * centralizes that cast.
 */
export function asUpgradeWebSocket(fn: (...args: never[]) => unknown): UpgradeWebSocketParam {
  return fn as unknown as UpgradeWebSocketParam;
}
