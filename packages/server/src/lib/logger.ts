import pino from 'pino';
import { serverConfig } from './server-config.js';

/**
 * Pure environment-branching decision for pino configuration.
 *
 * Extracted from `rootLogger`'s construction so the decision can be unit
 * tested directly, without needing to introspect pino's internal transport
 * worker-thread spawning (see `logger.test.ts`).
 *
 * - `production`: JSON output, no transport, logger enabled.
 * - `test` (`NODE_ENV==='test'`, Bun's `bun test` default): the pino-pretty
 *   transport is NOT constructed (no worker thread spawns) and the logger is
 *   disabled entirely, minimizing log noise during test runs.
 * - development (unset or any other value): pretty-printed transport,
 *   logger enabled. Matches the original default `bun run dev` behavior.
 *
 * @internal Exported for testing
 */
export function resolveLoggerConfig(nodeEnv: string | undefined): {
  isDev: boolean;
  isTest: boolean;
  isProduction: boolean;
  enabled: boolean;
  level: 'debug' | 'info';
  transport: pino.TransportSingleOptions | undefined;
} {
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';
  const isDev = !isProduction && !isTest;

  return {
    isDev,
    isTest,
    isProduction,
    enabled: !isTest,
    level: isDev ? 'debug' : 'info',
    transport: isDev
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  };
}

const loggerConfig = resolveLoggerConfig(serverConfig.NODE_ENV);

/**
 * Root logger instance configured based on environment.
 * - Development: Pretty printed output with colors
 * - Test: Disabled (no transport, no output) to avoid pino-pretty's
 *   worker-thread spawn and log noise during `bun test` runs
 * - Production: JSON output for machine parsing
 */
export const rootLogger = pino({
  level: serverConfig.LOG_LEVEL || loggerConfig.level,
  enabled: loggerConfig.enabled,
  transport: loggerConfig.transport,
});

/**
 * Create a child logger for a specific service.
 * @param service - The service name to include in all log entries
 */
export const createLogger = (service: string) => rootLogger.child({ service });
