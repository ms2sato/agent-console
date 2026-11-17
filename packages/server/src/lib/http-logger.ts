import type { Context } from 'hono';
import { pinoLogger } from 'hono-pino';
import type { Logger } from 'pino';
import { resolveHttpResLevel } from './http-log-level.js';

const REDACTED = '[REDACTED]';
const SENSITIVE_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization', 'set-cookie']);

/** Replace credential header values with a fixed marker, keeping the keys. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? REDACTED : value;
  }
  return result;
}

export function onReqBindings(c: Context) {
  return {
    req: { url: c.req.path, method: c.req.method, headers: redactHeaders(c.req.header()) },
  };
}

export function onResBindings(c: Context) {
  return {
    res: { status: c.res.status, headers: redactHeaders(Object.fromEntries(c.res.headers)) },
  };
}

export function createHttpLogger(rootLogger: Logger) {
  return pinoLogger({
    pino: rootLogger.child({ service: 'http' }),
    http: {
      onResLevel: (c) => resolveHttpResLevel(c.res.status),
      onReqBindings,
      onResBindings,
    },
  });
}
