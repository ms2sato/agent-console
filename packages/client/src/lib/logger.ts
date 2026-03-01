/**
 * Dev-gated logger for the client application.
 *
 * - debug/info: Only log in development mode (suppressed in production builds)
 * - warn/error: Always log (these indicate real issues even in production)
 *
 * Uses import.meta.env.DEV (Vite) with process.env.NODE_ENV fallback (Bun test runtime).
 */
const isDev = import.meta.env?.DEV ?? (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production');

export const logger = {
  debug: (...args: unknown[]) => { if (isDev) console.log(...args); },
  info: (...args: unknown[]) => { if (isDev) console.info(...args); },
  warn: (...args: unknown[]) => { console.warn(...args); },
  error: (...args: unknown[]) => { console.error(...args); },
};
