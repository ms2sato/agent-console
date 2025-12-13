import pino from 'pino';
import { serverConfig } from './server-config.js';

const isDev = serverConfig.NODE_ENV !== 'production';

/**
 * Root logger instance configured based on environment.
 * - Development: Pretty printed output with colors
 * - Production: JSON output for machine parsing
 */
export const rootLogger = pino({
  level: serverConfig.LOG_LEVEL || (isDev ? 'debug' : 'info'),
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
});

/**
 * Create a child logger for a specific service.
 * @param service - The service name to include in all log entries
 */
export const createLogger = (service: string) => rootLogger.child({ service });
