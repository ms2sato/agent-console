/**
 * Shared cast helpers for WebSocket route/handler tests.
 *
 * These exist because the real types (`WSContext`, `pino.Logger`,
 * `UpgradeWebSocket`) have many required properties/overloads that a test
 * double never needs. Callers pass only the subset they use, as an object
 * literal, so TypeScript's excess-property check still catches typos.
 *
 * Non-generic by design (Architect ruling): a generic `<T extends
 * Partial<WSContext>>(stub: T): WSContext & T` shape does NOT reliably
 * reject a misspelled member -- it only degenerates into catching it in the
 * single-similarly-named-member case (TS2561), not in general. `T &
 * Partial<X>` and `NoInfer<T> & Partial<X>` were also measured and rejected.
 * Callers that need typed access to a stub's mock members (bun's
 * `.mock.calls`, `.mockImplementation`, etc.) or to plain-data extra
 * properties (`sentMessages`, `closeCalls`) must capture those as their own
 * variables BEFORE building the literal, and read them back from that
 * captured variable -- never through this helper's return type.
 */
import type { WSContext } from 'hono/ws';
import type pino from 'pino';
import type { setupWebSocketRoutes } from '../routes.js';

/**
 * WSContext (hono/ws) has many required properties (binaryType, url,
 * protocol, etc.) that a test double never needs. Callers pass only the
 * subset they use, as an object literal, to keep the excess-property check.
 */
export function asWSContext(stub: Partial<WSContext>): WSContext {
  return stub as WSContext;
}

/** pino.Logger has many required properties a test double never needs. */
export function asPinoLogger(stub: Partial<pino.Logger>): pino.Logger {
  return stub as pino.Logger;
}

type UpgradeWebSocketParam = Parameters<typeof setupWebSocketRoutes>[1];

/**
 * UpgradeWebSocket (hono/ws) has overloaded call signatures with incompatible
 * return types (MiddlewareHandler vs Promise<Response>), so a passthrough stub
 * cannot satisfy the interface without a cast. This helper centralizes that
 * cast.
 *
 * Measured: a direct `as UpgradeWebSocketParam` (no `unknown` intermediate)
 * compiles clean under `bun run typecheck` (full monorepo) for every call
 * site in this test suite -- the `unknown` intermediate is not required here.
 */
export function asUpgradeWebSocket(fn: (...args: never[]) => unknown): UpgradeWebSocketParam {
  return fn as UpgradeWebSocketParam;
}
